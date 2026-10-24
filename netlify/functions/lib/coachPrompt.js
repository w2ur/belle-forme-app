/**
 * The user the prompt is about, as the template tokens need them.
 *
 * Declared here rather than imported because this module is the edge bundle's
 * pure core and imports nothing from `src/`: `coachPromptInputs.js` resolves the
 * real one from the profile (`resolvePersona`, `src/lib/persona.js`) and a test
 * pins that this fallback equals what that function returns for an empty
 * profile.
 */
export const FALLBACK_PERSONA = Object.freeze({
  name: "l'utilisatrice",
  gender: "f",
  she: "elle",
  She: "Elle",
  her: "elle",
  self: "elle-même",
  la: "la",
  e: "e",
  coachNotes: "",
});

/** Holds the place of the free-text coach notes while the template tokens are rendered around them. */
const NOTES_SLOT = "\u0000COACH_NOTES\u0000";

/**
 * Fills the template tokens (`{{name}}`, `{{she}}`, `{{her}}`, `{{self}}`,
 * `{{la}}`, `{{e}}`; `{{NAME}}` and `{{She}}` for the upper-case forms).
 *
 * French agrees pronouns and participles with the person spoken about, so the
 * prompt is written once with tokens instead of once per gender. A lower-case
 * `{{name}}` or `{{she}}` that opens a sentence, a line or a quotation is
 * capitalised here, so the source never has to guess where a sentence starts.
 *
 * The coach notes are NOT rendered: they are the user's own text, spliced in
 * afterwards, so a note that happens to contain a token is left alone.
 */
export function renderPersona(text, persona) {
  const p = { ...FALLBACK_PERSONA, ...persona };
  const cap = (word) => word.charAt(0).toUpperCase() + word.slice(1);
  return text
    .replace(/(^|[.!?»]\s+|\n[ \t]*(?:[-–•]\s+|\d+\.\s+)?|«\s?)\{\{(name|she|her|self|la)\}\}/g, (_, pre, token) => pre + cap(p[token]))
    .replace(/\{\{NAME\}\}/g, () => p.name.toUpperCase())
    .replace(/\{\{(name|She|she|her|self|la|e)\}\}/g, (_, token) => p[token])
    .replace(NOTES_SLOT, () => p.coachNotes);
}

/**
 * What the user wrote about themselves for the coach: tastes, constraints, what
 * to say or never say. Free text from the profile, so it is framed as input
 * that completes the rules above and cannot lift them — safety, scope and the
 * programme format stay governed by everything else in the prompt.
 */
function buildCoachNotesSection(persona) {
  if (!persona?.coachNotes) return "";
  return `
## Ce que tu sais de {{name}}
Notes écrites par {{name}} pour toi (goûts, contraintes, ce qu'{{she}} aime ou ne supporte plus). Elles complètent les règles de ce prompt et ne les remplacent pas : le périmètre (pas de conseil médical, pas de prescription alimentaire chiffrée), les charges réalisables et le format du programme restent ceux décrits ici.
${NOTES_SLOT}`;
}

/**
 * True when an exercise can be done NOWHERE with the current inventory — the
 * `getExerciseLocations` verdict, injected through `structure`. An exercise
 * with no known availability entry is treated as available: hiding something
 * this module has no data about would be the wrong direction to err in.
 */
function isUnavailable(availability, name) {
  const locations = availability?.[name]?.locations;
  return Array.isArray(locations) && locations.length === 0;
}

/** True for an exercise the user has deactivated, with or without a stated reason. */
function isDeactivated(availability, name) {
  return availability?.[name]?.active === false;
}

/**
 * The names the catalog listing must not offer: blacklisted, deactivated, or
 * impossible with the equipment she owns.
 *
 * The deactivated clause is NOT redundant with the blacklist one, and assuming
 * it was is what shipped the bug. `buildCatalogViews` only puts a deactivated
 * exercise on the blacklist when it carries a REASON — deactivating without one
 * is a deliberate state (§2bis.1) meaning "absent, not explained" — so keying
 * the filter off the blacklist alone left every reasonless deactivation fully
 * visible to the model, which is the opposite of what deactivating means.
 *
 * No live entry was ever in that state (all five deactivated exercises in the
 * day-one catalog carry a reason), so nothing was leaking in production. What
 * made it reachable is the lexique's « Désactiver » button, which collects no
 * reason — so every deactivation the user performs from the list lands here.
 */
function isOffered(availability, blacklistedNames, name) {
  return (
    !blacklistedNames.has(name) &&
    !isDeactivated(availability, name) &&
    !isUnavailable(availability, name)
  );
}

/**
 * Every exercise the coach may actually prescribe: the catalog, minus the
 * blacklist, minus anything the equipment makes impossible.
 *
 * Exported because the plan schema's `enum` has to be THIS set and no other
 * (`buildPlanJsonSchema`, `src/lib/planSchema.js`). The belt — the catalog
 * rendered into the prompt — and the suspenders — the enum the API enforces —
 * reading from two separate computations is exactly how a prompt drifts from
 * its validator. A name shown to the model but absent from the enum is
 * unpickable with nothing on screen to explain why; a name in the enum but
 * filtered out of the prompt makes a blacklisted movement emittable. A parity
 * test asserts the two agree in both directions.
 */
export function offeredExerciseNames(availability, blacklist) {
  const blacklistedNames = new Set(
    (Array.isArray(blacklist) ? blacklist : []).map((entry) => entry.name)
  );
  return Object.keys(availability ?? {}).filter((name) =>
    isOffered(availability, blacklistedNames, name)
  );
}

/**
 * Renders the model-facing exercise catalog, WITHOUT any blacklisted name and
 * WITHOUT any exercise the equipment makes impossible.
 *
 * `constraints.md`'s ruling that blacklisted exercises "stay in the exercise
 * list and the manual picker" governs the React UI, a different
 * consumer than this string — filtering here does not violate that ruling.
 * The catalog array passed in (`muscleGroups`) is never mutated; only the
 * rendered prompt text omits the filtered names.
 *
 * A group whose every offered exercise is doable at the gym is labelled as
 * such in the listing itself (in practice: Cardio). A list titled
 * "disponibles" that silently mixes home strength work with gym cardio invites
 * precisely the mixing `checkCardioMixingRule` blocks. The label is DERIVED
 * from the injected locations, never keyed off the group's name.
 *
 * The label states the SESSION rule (a dedicated session, never mixed into
 * force work), not an exclusive location: `Course` is outdoor running and
 * derives to both locations, so "à la salle uniquement" would be false for it
 * while the session rule holds for the whole group.
 */
function exerciseList(muscleGroups, blacklistedNames, availability) {
  return Object.entries(muscleGroups)
    .map(([group, names]) => {
      const offered = names.filter((name) => isOffered(availability, blacklistedNames, name));
      const gymOnly =
        offered.length > 0 && offered.every((name) => availability?.[name]?.locations?.includes("salle"));
      const label = gymOnly
        ? " — toujours une séance dédiée (à la salle ou en extérieur), jamais dans une séance de force"
        : "";
      // Name AND definition. The bare-name catalog let the coach and the user hold two
      // different movements under one label — `Développé couché` is a FLOOR press
      // here, and that is exactly what keeps it doable at home.
      const lines = offered
        // `intent` is deliberately NOT here. It is the user's field — why an exercise
        // is in her programme — and it is shown only in the app's lexique.
        // Injecting it cost +2 632 tokens on EVERY request (owner ruling
        // 2026-08-11: "it's information for the user, if coach does not need it,
        // then don't put it"), which is twice what the 22 new exercises cost,
        // and it lands on a rung where 5 of 9 production requests already hit
        // the 15 s header timeout. The coach infers what an exercise trains
        // from its description; the user was the one who could not.
        .map((name) => {
          const { description, formCues, metric } = availability?.[name] ?? {};
          const cues = formCues ? ` (${formCues})` : "";
          // Marked on the entry rather than listed separately, so the coach
          // reads the unit at the moment it picks the exercise.
          const unit = metric === "seconds" ? " [SÉRIES EN SECONDES]" : "";
          return `- ${name}${unit} : ${description || "(pas de description)"}${cues}`;
        })
        .join("\n");
      return `### ${group}${label}\n${lines}`;
    })
    .join("\n");
}

/**
 * Renders the note explaining the exercises the catalog above leaves out for
 * equipment reasons — they exist in the app (the user can still log them by hand)
 * but `checkHomeExerciseLocationRule` hard-blocks any plan that prescribes
 * them. Without the note, the coach has no way to answer "why has this
 * disappeared?", exactly as with the blacklist section.
 *
 * Both the names and the missing equipment come from the injected
 * availability data, so buying a bench makes the exercise reappear in the
 * catalog and this note shrink, with no prompt edit.
 */
function buildUnavailableSection(muscleGroups, blacklistedNames, availability) {
  const entries = Object.values(muscleGroups)
    .flat()
    .filter((name) => !blacklistedNames.has(name) && isUnavailable(availability, name))
    .map((name) => {
      const blockers = availability?.[name]?.homeBlockers ?? [];
      return blockers.length ? `${name} (il faut ${blockers.join(" et ")})` : name;
    });
  if (entries.length === 0) return "";
  return `\n\nCes exercices existent dans l'app mais sont retirés de la liste ci-dessus : ils demandent du matériel que {{name}} n'a pas — ${entries.join(", ")}. Ne les propose jamais, l'app bloque l'import.`;
}

/**
 * Renders the "don't reach for these" prompt section: each blacklisted
 * exercise with its French reason and, where recorded, its suggested
 * replacement (T3.4b — the belt to T3.4's code-level suspenders). Without
 * this, filtering the catalog alone leaves the coach no explanation for why
 * an exercise the user may remember from past weeks has disappeared.
 */
function buildBlacklistSection(blacklist) {
  if (!Array.isArray(blacklist) || blacklist.length === 0) return "";
  const lines = blacklist
    .map(({ name, reason, replacedBy }) => `- ${name} : ${reason}${replacedBy ? ` (remplacement : ${replacedBy})` : ""}`)
    .join("\n");
  return `\n\n## Exercices à ne jamais proposer\n${lines}\nNe les represcris jamais, même si {{name}} les a faits par le passé — la liste ci-dessus explique pourquoi.`;
}

/** The load of the worked load-drop example in the plan-emit prompt. */
const LOAD_DROP_EXAMPLE_KG = 15;

/** Formats a kg value using the French decimal-comma convention (e.g. 9.5 -> "9,5"). */
function formatKg(value) {
  return String(value).replace(".", ",");
}

/** Renders a list of kg values as a comma-separated French string. */
function formatKgList(values) {
  return values.map(formatKg).join(", ");
}

/**
 * Finds the widest gap between two consecutive values in a sorted, ascending
 * list of achievable loads. Used to surface the dual-bar per-hand jump
 * (7 -> 12 kg/main in the current inventory) explicitly — it is
 * counter-intuitive and the model smooths over it unless told (constraints.md).
 */
function findWidestGap(sortedValues) {
  let widest = null;
  for (let i = 1; i < sortedValues.length; i++) {
    const size = sortedValues[i] - sortedValues[i - 1];
    if (size > 1 && (!widest || size > widest.size)) {
      widest = { from: sortedValues[i - 1], to: sortedValues[i], size };
    }
  }
  return widest;
}

/**
 * Renders the exercises that do NOT follow the "dumbbells or bars, as you
 * like" rule. Both lists are injected, never named here, so the prompt can only
 * ever claim an exception the validator actually enforces. Omitted entirely
 * when there is no exception left to state.
 */
function buildImplementExceptions(dumbbellOnlyExercises, ankleWeightExercises, ankleWeightKg) {
  const clauses = [];
  if (dumbbellOnlyExercises?.length) {
    clauses.push(`${formatNameList(dumbbellOnlyExercises)} — uniquement à l'haltère, jamais à la barre (rien d'autre ne tient en équilibre)`);
  }
  if (ankleWeightExercises?.length) {
    clauses.push(`${formatNameList(ankleWeightExercises)} — uniquement au lest de cheville de ${formatKg(ankleWeightKg)} kg`);
  }
  return clauses.length ? `\n- Exceptions à la règle ci-dessus : ${clauses.join(" ; ")}.` : "";
}

/** Joins French names as "a, b et c" — an empty list yields an empty string. */
function formatNameList(names) {
  const list = Array.isArray(names) ? names : [];
  if (list.length <= 1) return list.join("");
  return `${list.slice(0, -1).join(", ")} et ${list[list.length - 1]}`;
}

/**
 * Renders the pull-up-bar height rule (whole-branch review, Finding A).
 *
 * `docs/claude-project/instructions.md` states the bar is rigged at ONE
 * physical height for the whole session — it is a fixed fitting, never
 * re-rigged between exercises — so a plan mixing a "haute" exercise with a
 * "basse" one is not runnable at home even though nothing about load or
 * equipment availability blocks it. Nothing enforced this: `Traction
 * pronation` (haute) and `Traction australienne` (basse) could import into
 * the same session with zero errors and zero warnings.
 *
 * Both groups are DERIVED from each exercise's `barHeight` (injected via
 * `exerciseAvailability`, never hand-listed here) and filtered through the
 * SAME `isOffered` check as the catalog listing, so a blacklisted or
 * equipment-impossible exercise cannot reappear here by the back door.
 *
 * `checkBarHeightRule` (`planValidation.js`) is the suspenders to this belt and
 * now blocks the import; this section shipped a slice ahead of it, so that the
 * coach was told the rule before anything started rejecting plans over it.
 *
 * The section is omitted when EITHER group is empty, not only when both are.
 * "Never mix these two groups" is meaningless with one group, and the empty
 * half rendered as a bare `()` — reachable in one tap now that the user can
 * deactivate an exercise, and `Traction australienne` is the only low-bar
 * entry in the catalog.
 */
function buildBarHeightSection(availability, blacklistedNames) {
  const byHeight = { haute: [], basse: [] };
  for (const [name, entry] of Object.entries(availability ?? {})) {
    if (entry?.barHeight === "haute" || entry?.barHeight === "basse") {
      if (isOffered(availability, blacklistedNames, name)) byHeight[entry.barHeight].push(name);
    }
  }
  if (byHeight.haute.length === 0 || byHeight.basse.length === 0) return "";
  return `\n- Barre de traction : réglée à UNE SEULE hauteur pour toute la séance, jamais changée en cours de route. Réglage haute (${formatNameList(byHeight.haute)}) et réglage basse (${formatNameList(byHeight.basse)}) : ne mélange JAMAIS un exercice barre haute et un exercice barre basse dans la même séance. Si {{name}} travaille la barre plusieurs fois dans la semaine, regroupe le travail barre haute d'un côté et le travail barre basse de l'autre, dans des séances différentes — c'est ainsi qu'on couvre les deux réglages sans jamais avoir à re-régler la barre.`;
}

/**
 * Renders the equipment section: achievable loads and per-exercise material
 * ceilings, both DERIVED from the actual data passed in `equipment` (never
 * retyped as prose) — same injection pattern as `muscleGroups`, so this
 * module stays testable without importing `src/constants` directly and can
 * never drift out of sync with the load validators.
 *
 * The opening rule is the one the validators enforce since 2026-07-26: which
 * implement carries a load is not a property of the exercise, so the usable
 * per-hand list is the UNION of the dumbbells and the bars. The two lists are
 * still stated separately underneath because the plated-bar rule needs them —
 * a load absent from the dumbbell list is precisely what forces a bar.
 *
 * @param {{
 *   ceilings: Record<string, { maxKg: number, unit: "per_hand" | "total" }>,
 *   dumbbellLoads: number[],
 *   dualBarPerHandLoads: number[],
 *   perHandUnion: number[],
 *   ankleWeightKg: number,
 *   owned: string[],
 *   dumbbellOnlyExercises: string[],
 *   ankleWeightExercises: string[],
 * }} equipment
 */
function buildEquipmentSection({
  ceilings,
  dumbbellLoads,
  dualBarPerHandLoads,
  perHandUnion,
  ankleWeightKg,
  owned = [],
  dumbbellOnlyExercises,
  ankleWeightExercises,
}) {
  const gap = findWidestGap(dualBarPerHandLoads);
  const barMin = dualBarPerHandLoads.length ? Math.min(...dualBarPerHandLoads) : 0;
  const dumbbellMax = dumbbellLoads.length ? Math.max(...dumbbellLoads) : 0;
  const barOnlyInDumbbellRange = dualBarPerHandLoads.filter(
    (v) => v > barMin && v <= dumbbellMax && !dumbbellLoads.includes(v)
  );

  const ceilingLines = Object.entries(ceilings)
    .map(
      ([name, { maxKg, unit }]) =>
        `- ${name} : ${formatKg(maxKg)} kg ${unit === "per_hand" ? "par main" : "au total"}`
    )
    .join("\n");

  const gapSentence = gap
    ? ` Attention : aucune valeur entre ${formatKg(gap.from + 1)} et ${formatKg(gap.to - 1)} kg/main n'est atteignable sur les barres (palier direct de ${formatKg(gap.from)} à ${formatKg(gap.to)} kg/main) — ne lisse jamais cet écart.`
    : "";

  // Each line exists only when the inventory has the thing it describes: a
  // user with no bars is never told what the bars can do.
  const loadLines = [];
  if (perHandUnion.length > 0) {
    loadLines.push(`- L'implément n'est PAS une propriété de l'exercice : tout ce qui se tient dans les mains (curls, rowings, développés, élévations, squats, soulevés, fentes, step-ups…) se charge ${dumbbellLoads.length && dualBarPerHandLoads.length ? "aux haltères OU aux barres chargeables, au choix" : dumbbellLoads.length ? "aux haltères" : "aux barres chargeables"}. La liste utilisable par main est donc ${dumbbellLoads.length && dualBarPerHandLoads.length ? "l'union des deux" : "celle-ci"} : ${formatKgList(perHandUnion)} kg. Chacune de ces valeurs est valide, dans la limite du plafond de l'exercice (voir plus bas).`);
  } else {
    loadLines.push("- Aucune charge externe n'est disponible : tout se fait au poids du corps, charge 0.");
  }
  if (dumbbellLoads.length > 0) {
    loadLines.push(`- Haltères (1 paire réglable, par main) : ${formatKgList(dumbbellLoads)} kg.`);
  }
  if (dualBarPerHandLoads.length > 0) {
    loadLines.push(`- Barres chargeables (par main, les 2 barres ensemble) : ${formatKgList(dualBarPerHandLoads)} kg.${gapSentence}`);
  }
  if (barOnlyInDumbbellRange.length > 0) {
    loadLines.push(`- Sur les barres seulement, jamais en haltère : ${formatKgList(barOnlyInDumbbellRange)} kg/main.${buildImplementExceptions(dumbbellOnlyExercises, ankleWeightExercises, ankleWeightKg)}`);
  } else {
    const exceptions = buildImplementExceptions(dumbbellOnlyExercises, ankleWeightExercises, ankleWeightKg);
    if (exceptions) loadLines.push(exceptions.replace(/^\n/, ""));
  }
  if (dumbbellLoads.length > 0 && dualBarPerHandLoads.length > 0) {
    loadLines.push("- Une seule configuration de barre chargée par séance : un poids absent de la liste des haltères oblige à charger une barre, donc deux poids hors liste haltères dans la même séance = deux montages de disques. Pour faire varier la charge entre exercices d'une même séance, privilégie les haltères : replaquer une barre en cours de séance coûte du temps, et une séance qui demande de replaquer n'est pas suivie.");
  }
  const smallKit = [];
  if (owned.includes("elastic_hips") && !owned.includes("elastic_upper")) smallKit.push("Élastiques hanches uniquement (pas d'élastiques bras)");
  else if (owned.includes("elastic_hips") && owned.includes("elastic_upper")) smallKit.push("Élastiques hanches et haut du corps");
  else if (owned.includes("elastic_upper")) smallKit.push("Élastiques haut du corps uniquement (pas d'élastiques hanches)");
  if (ankleWeightKg > 0 && owned.includes("ankle_weight")) smallKit.push(`lests cheville ${formatKg(ankleWeightKg)} kg`);
  if (smallKit.length > 0) loadLines.push(`- ${smallKit.join(", ")}.`);

  return `## Charges réalisables et plafonds matériels — n'invente JAMAIS un poids hors de ces listes
${loadLines.join("\n")}

### Plafonds par exercice (progression sans charge au-delà)
${ceilingLines}
Au plafond d'un exercice, la progression passe par le tempo, les répétitions ou une variante unilatérale — JAMAIS par une charge supplémentaire. Dis toujours laquelle des trois tu choisis : « on reste à 11 kg et on ralentit la descente » est une progression, « on consolide » n'en est pas une.`;
}

/**
 * Cycle periodization and the load-progression heuristic.
 *
 * Every number is injected (`CYCLE_PERIODIZATION`,
 * `CLEAN_SESSIONS_BEFORE_LOAD_INCREASE`) rather than written here, same rule
 * as the load model: a number typed twice is a number that eventually
 * disagrees with itself, and `docs/claude-project/instructions.md` states
 * these same values.
 *
 * The "never deduce the cycle day" instruction is the load-bearing sentence of
 * this whole section. It is a prompt rule and not a validator because there is
 * nothing to validate — the failure is the model INVENTING an input, and the
 * only fix is for it to ask.
 */
function buildCoachingSection(coaching, mode) {
  const { cycle, cleanSessionsBeforeIncrease } = coaching ?? {};
  if (!cycle && typeof cleanSessionsBeforeIncrease !== "number") return "";

  // Both halves are optional and independent: the cycle section exists only
  // when the profile turned cycle periodization on, and the progression
  // heuristic is there whatever the cycle says.
  const cycleSection = cycle ? buildCycleSection(cycle, mode) : "";
  const progressionSection = typeof cleanSessionsBeforeIncrease === "number"
    ? buildProgressionSection(cleanSessionsBeforeIncrease, mode)
    : "";
  return `${cycleSection}${progressionSection}`;
}

/** The cycle half of the coaching section: rendered only for a profile that opted in. */
function buildCycleSection(cycle, mode) {
  const mesocycle = (cycle.mesocycle ?? [])
    .map((phase) => `  - S${phase.week} (${phase.label}) : ${phase.focus}.`)
    .join("\n");

  // plan-emit replies are strict JSON: the coach cannot ask a question there, so
  // the conversational "ask her" bullet would be an order it cannot obey.
  const neverDeduceLine = mode === "plan-emit"
    ? "- Tu ne DÉDUIS JAMAIS le jour du cycle de {{name}} depuis ses dates de séances. C'est la règle la plus importante de cette section : en le déduisant, on s'est déjà trompé d'une phase entière — annoncer une fin de cycle alors qu'{{she}} était à J3 du suivant."
    : "- Tu ne DÉDUIS JAMAIS le jour du cycle de {{name}} depuis ses dates de séances. Tu le lui DEMANDES. C'est la règle la plus importante de cette section : en le déduisant, on s'est déjà trompé d'une phase entière — annoncer une fin de cycle alors qu'{{she}} était à J3 du suivant.";
  const cycleCarryOverLine = mode === "plan-emit"
    ? "- Un jour de cycle qu'{{she}} t'a donné dans la conversation — ou qu'{{she}} a confirmé quand tu le lui as proposé — utilise-le seulement si c'est aujourd'hui qu'{{she}} l'a dit ou confirmé (la date de ses lignes dans l'historique te le dit). Ne l'avance jamais toi-même des jours écoulés : ce serait le déduire, et un cycle ne tombe pas juste au jour près. Ton carnet n'est pas une source : un jour de cycle qui s'y trouverait, tu ne t'en sers pas."
    : "- Si {{she}} te l'a donné plus tôt dans la conversation, tu peux repartir de ce repère, mais fais-le confirmer avant de t'en servir : « tu devrais être autour de J14, ça colle ? »";
  const cycleAskLine = mode === "plan-emit"
    ? "- Sans jour de cycle exploitable, programme sans périodisation et dis-le dans `coachNotes` — n'invente pas une phase pour combler le trou."
    : "- Avant de proposer un programme hebdomadaire, demande-lui où {{she}} en est dans son cycle. Si {{she}} ne sait pas ou préfère ne pas le dire, propose le programme sans périodisation de cycle et DIS-LE — n'invente pas une phase pour combler le trou.";

  return `
## Cycle et périodisation
${neverDeduceLine}
${cycleAskLine}
${cycleCarryOverLine}
- Cycle d'environ ${cycle.cycleLengthDays} jours :
  - Fenêtre haute énergie ≈ J${cycle.highEnergyDays.from} à J${cycle.highEnergyDays.to} (folliculaire/ovulatoire) — c'est là que vont l'intensité et les tentatives de record.
  - À partir de ≈ J${cycle.lowEnergyFromDay} (prémenstruel) — baisse l'intensité, garde le mouvement, aucune tentative de record.
- Mésocycle sur 4 semaines :
${mesocycle}
- Quand la périodisation te fait alléger une charge ou renoncer à un record, dis-le et dis pourquoi. « On allège cette semaine » sans raison est exactement la baisse non expliquée que la règle plus haut t'interdit.
`;
}

/** The load-progression half of the coaching section, always present. */
function buildProgressionSection(cleanSessionsBeforeIncrease, mode) {
  // plan-emit replies are strict JSON: {{she}} cannot be asked anything there.
  const qualityLine = mode === "plan-emit"
    ? "si une série arrachée pèse dans ta décision, ne la suppose pas : dis dans `coachNotes` que tu ignores comment ces séries se sont passées et ce que tu as retenu."
    : "si une série arrachée pèse dans ta décision, demande-la à {{name}} au lieu de la supposer.";

  return `
## Quand augmenter une charge
- Repère : environ ${cleanSessionsBeforeIncrease} séances propres à la charge actuelle avant de l'augmenter. L'app te donne ce compteur par exercice (bloc « SÉANCES PROPRES À LA CHARGE ACTUELLE » de ses données).
- C'est un REPÈRE, pas une barrière, et c'est TOI qui décides. Une charge d'emblée trop conservatrice, une semaine qui suit une décharge, une exécution manifestement facile : autant de raisons légitimes d'augmenter plus tôt. Dis simplement laquelle.
- Ce compteur ne retient que les exercices faits en entier : depuis le mode séance, un exercice passé ou interrompu casse la série au lieu de compter dedans. Il ne dit rien de la qualité des séries validées — ${qualityLine}
- Ne justifie jamais une non-progression par une formule vague (« on consolide »). Soit tu donnes la raison réelle, soit tu augmentes.
`;
}

/**
 * The label on the one button that can produce a programme.
 *
 * Declared here rather than imported because this module is the edge bundle and
 * imports nothing from `src/`. `src/lib/planButtonLabel.js` holds the copy the
 * UI renders, and a parity test pins the two — a coach that names a button the user
 * cannot find is worse than one that names none, which is exactly what the old
 * two-label scheme produced whenever her week had expired.
 */
export const PLAN_BUTTON_LABEL = "Plan";

/**
 * The rules that keep a CONVERSATIONAL reply about the question she just asked.
 *
 * Shared by the two modes that talk (`discussion` and `plan`), and absent from
 * `plan-emit`, where the coach IS being asked to produce something long and
 * complete and "answer only the last question" would fight the request.
 *
 * The two differ on one bullet only, and it is the structural half of this
 * change: in `plan` mode the coach is looking straight at the week and still
 * cannot rewrite it — only the « Plan » button can. Saying so
 * plainly is what turns "she asked a question and got a new programme" from a
 * behaviour to discourage into a thing that cannot happen.
 */
function buildConversationFocusSection(mode) {
  // The route to a written change, stated the SAME way everywhere in this
  // section. In discussion mode the « Plan » button is not on screen at all
  // (`CoachTab` renders it only while the mode is « Mon programme »), so naming
  // it alone leaves her hunting for a control that does not exist — the exact
  // half-route failure the plan-request bullet below already fixed once.
  const planRoute =
    mode === "plan"
      ? `le bouton « ${PLAN_BUTTON_LABEL} », en haut de l'écran`
      : `« Mon programme », puis le bouton « ${PLAN_BUTTON_LABEL} » qui apparaît en haut de l'écran`;
  const planScope =
    mode === "plan"
      ? `
- TU NE PEUX PAS MODIFIER LE PROGRAMME toi-même, et ce n'est pas une consigne de
  prudence : ta réponse ici est du texte, elle n'écrit rien dans son programme.
  Explique-le, dis ce que tu changerais et pourquoi, mets-toi d'accord avec {{her}}
  — puis, en une phrase, invite-la à passer par ${planRoute}, pour que le
  changement existe vraiment.`
      : `
- LE PROGRAMME EN COURS NE SE MODIFIE PAS ICI. Tu peux l'expliquer, adapter une
  charge pour aujourd'hui en le disant, signaler qu'une séance devrait être
  déplacée — mais tu ne le réécris pas.
- Si {{name}} te demande un programme ici, réponds en UNE phrase et donne-lui le
  chemin ENTIER : ${planRoute}. C'est la seule chose qui écrive un programme. La
  renvoyer seulement vers « Mon programme » la laisse à mi-chemin, devant un
  bouton qu'{{she}} n'a aucune raison de reconnaître.
  N'improvise jamais un programme dans le fil.`;
  return `
- CE QUI EST PRESCRIT GOUVERNE AUJOURD'HUI.
  Ses données portent un bloc « PROGRAMME DE LA SEMAINE » dont le titre dit où
  la semaine se situe. Seul « PROGRAMME DE LA SEMAINE EN COURS » est ce que {{name}} a
  sous les yeux et ce qu'{{she}} fait aujourd'hui. Le bloc
  « SÉANCES PROPRES À LA CHARGE ACTUELLE » et son historique servent à écrire le
  PROCHAIN programme, pas à corriger celui-ci en silence.
  SAUF si le titre dit « À VENIR » ou « PRÉCÉDENTE » : ce programme n'est pas
  celui d'aujourd'hui. Un programme périmé n'est plus une consigne, c'est un
  souvenir — dis-le et propose d'en écrire un nouveau, ne fais pas travailler
  {{name}} sur les charges d'il y a trois semaines ; un programme à venir n'est pas
  commencé, ne le lui fais pas appliquer aujourd'hui.
- Si tu proposes autre chose que le nombre prescrit, DIS LES DEUX ET DIS LEQUEL
  EST LEQUEL : « ton programme dit 20 kg/main, je te propose 18 aujourd'hui parce
  que… », puis indique ${planRoute} si le programme lui-même doit changer.
  Donner un nombre différent sans dire qu'il diffère, c'est ce qu'{{she}} lit comme
  une incohérence — {{she}} a l'autre nombre affiché à l'écran.
- RÉPONDS À SA DERNIÈRE question, ET À ELLE SEULE. Les tours précédents sont du
  contexte, pas une liste de choses à traiter. Une question plus ancienne restée
  sans réponse le reste, sauf si {{name}} la repose.${planScope}
- Une réponse marquée comme interrompue ne se reprend pas d'elle-même. Si {{name}}
  veut la suite, {{she}} la redemande.
- Une réponse marquée comme abrégée est une réponse TERMINÉE, raccourcie pour
  tenir dans ton contexte. Ne la refais pas.
- Les lignes entre crochets au début d'un tour — « [dim. 24 août, 14:32] », « [—
  nouvelle conversation …] » — sont posées par l'app, pas écrites par toi ni par
  {{name}}. Elles te disent QUAND ce tour a été écrit. Ne les recopie jamais dans ta
  réponse : {{name}} les verrait.
- Quand {{name}} te dit qu'il manque quelque chose ou que c'est faux, regarde d'abord
  ses données et dis-lui ce que tu y vois. Si elles ne montrent pas le problème,
  dis-le simplement et demande-lui ce qu'{{she}} voit à l'écran. N'invente pas de
  cause (« l'écriture a dû s'interrompre ») et ne t'excuse pas d'une erreur que
  tu ne constates pas : une fausse excuse, {{she}} la prend pour un aveu, et {{she}}
  ne sait plus quoi croire.
- Tu ne vois que les derniers échanges et ton carnet, pas toute votre histoire.
  Si {{name}} évoque une conversation que tu ne retrouves pas, dis que tu ne la
  retrouves pas — ne dis jamais qu'elle n'a pas eu lieu.`;
}

/**
 * The rules about the SHAPE of a reply — and they live in the VOLATILE block,
 * beside her message, not in the system prompt.
 *
 * THE POSITION IS THE FIX, and it is the only thing that changed about them.
 * These four bullets shipped in `buildConversationFocusSection` on 2026-08-16
 * and were measurably inert there. Across that deploy, the median conversational
 * `completion_tokens` went 769 (n=37, and that bucket still contained ~2 600-token
 * emits, so the real pre-fix baseline is LOWER) to 1 143 (n=13) — the opposite
 * of the intended direction. Every request ran on `mistral-large-2512`, rung 1,
 * zero fallbacks and zero rung retries, so none of it is the weaker model.
 *
 * The reply the user got immediately after writing « c'est beaucoup trop long ce que
 * tu m'écris! » was 3 469 characters carrying `###` headings, a markdown table,
 * five horizontal rules and a « Prochaine étape » homework list — violating four
 * of these lines at once, with all four live in the prompt at the time.
 *
 * THE CONTROL IS WHAT DECIDES THE DESIGN. The one time she wrote « Réponse
 * courte » in her own message she got 581 characters, and « réponse courte s'il
 * te plaît » had drawn 316 a week earlier. The model was always able to be
 * brief. The instruction it obeyed was the one sitting in the last user turn —
 * roughly 29 000 characters closer than the system prompt. So the rules move to
 * where the one that works already sits. Three rounds of tightening the wording
 * had no effect because the wording was never the variable.
 *
 * A MOVE, NOT A COPY. `buildConversationFocusSection` keeps the SCOPE rules —
 * which question to answer, that the programme is not rewritten here, that an
 * interrupted reply does not resume itself. Those are about capability, and
 * nothing in the transcript suggests they are ignored. Stating one rule in two
 * places is how a prompt drifts from itself, and a test asserts each of these
 * appears in exactly one of the two.
 *
 * EMPTY ON `plan-emit`, on the same reasoning that kept it out of that system
 * prompt: the reply there is a JSON payload and never prose, so a brevity rule
 * is aimed at nothing and would sit beside the one request that is long by
 * design. Anything that is not exactly `plan-emit` gets the reminder, matching
 * how `buildSystemPrompt` treats an unknown mode as discussion.
 *
 * The cross-reference to « Ton registre » still resolves: that section is in the
 * system prompt of the same request. It is the 2026-08-02 explanation ruling,
 * and both halves stay stated together here for the same reason the nutrition
 * rule states its scope and its limit together — keeping the opening and
 * dropping the bound is the dangerous half.
 */
export function buildReplyShapeReminder(mode, persona) {
  if (mode === "plan-emit") return "";
  return renderPersona(`## Comment tu réponds à ce message
- UNE RÉPONSE EST UN MESSAGE, PAS UNE FICHE. {{name}} te lit dans une conversation,
  souvent sur un téléphone. Écris en phrases suivies, un ou deux paragraphes
  courts. Pas de titre d'annonce en tête de réponse (« Réponse ultra-claire : »,
  « Réponse courte et factuelle : ») : une réponse commence par la réponse, pas
  par l'annonce qu'elle arrive. Pas de séparateurs, pas de titres de section,
  pas de tableau, pas de sections numérotées, pas de gras à chaque ligne — le
  gras sert à un chiffre qu'{{she}} doit retenir, pas à la moitié des mots. Une
  liste seulement pour une consigne chiffrée : séries, charges, repos, tempo.
- LA LONGUEUR SUIT LA QUESTION. Une question fermée — un nombre, un côté, un
  tempo, oui ou non — se répond en une ou deux phrases, et c'est fini : tu peux
  t'arrêter là, personne n'attend la suite. La CONSIGNE reste courte et
  l'EXPLICATION prend la place qu'il faut (voir « Ton registre »), mais « la
  place qu'il faut » est celle que la question demande : un paragraphe
  d'explication se mérite, il est là quand la décision n'a rien d'évident, pas
  parce que tu as la place de l'écrire. Répondre à une seule question, c'est
  précisément ce qui laisse le temps de bien l'expliquer quand il le faut.
  En chiffres : une question fermée, une ou deux phrases ; une question ouverte,
  80 à 150 mots ; davantage seulement si {{she}} demande une explication détaillée
  ou la description d'un exercice. Si {{she}} te dit que c'est trop long, ou
  demande une réponse courte, trois phrases au plus — et garde ce format pour la
  suite de la conversation, sans attendre qu'{{she}} le redise.
- UNE CORRECTION TIENT EN UNE PHRASE. Si tu dois revenir sur ce que tu as dit,
  fais-le en une phrase (« je me corrige : … ») et seulement sur ce qui touche à
  sa question. Pas d'inventaire de tes erreurs passées ni de récit de ce que tu
  avais écrit : {{she}} veut la bonne réponse, pas l'historique de la mauvaise.
- PAS DE DEVOIRS QU'ELLE N'A PAS DEMANDÉS. Ne termine pas sur un « test à faire aujourd'hui »,
  un protocole à rapporter la prochaine fois ou une liste de choses à vérifier :
  si une information te manque vraiment, pose UNE question ; sinon, n'en demande
  aucune. {{She}} est venu{{e}} chercher une réponse, pas une tâche de plus.
- QUAND ELLE S'ENTRAÎNE, SOIS BRÈVE. Si ses données portent un bloc
  « SÉANCE EN COURS », {{she}} te lit entre deux séries : donne la consigne et rien
  d'autre, en une à trois phrases. Le pourquoi attend qu'{{she}} le demande, et
  {{she}} le demandera.
- UNE SÉANCE COMMENCÉE UN AUTRE JOUR N'EST PAS EN COURS. Si ses données portent
  « SÉANCE COMMENCÉE LE … , NON TERMINÉE », c'est un brouillon qu'{{she}} n'est pas
  en train de faire : ne le traite pas comme une séance vivante, n'applique pas
  la brièveté d'entre deux séries, et laisse-la en parler si {{she}} le souhaite.
- NE RECOPIE JAMAIS LES LIGNES ENTRE CROCHETS. Les lignes du type
  « [dim. 30 août, 17:15] » ou « [— nouvelle conversation, 3 jours plus tard —] »
  sont posées par l'app sur l'historique pour te situer dans le temps : elles
  t'informent, elles ne font pas partie de ce que tu écris. Ta réponse commence
  à ta première phrase, jamais par une date entre crochets — {{name}} la voit, et
  l'heure que tu recopies est celle du message précédent, donc fausse.
- TOUT CECI PORTE SUR CE QUE {{NAME}} LIT, ET SUR RIEN D'AUTRE. Le bloc
  \`<<<NOTEBOOK>>>\` qui suit ta réponse n'est concerné par aucune de ces règles :
  ni par la longueur, ni par la mise en forme, ni par « rien d'autre » quand
  {{she}} s'entraîne. Tu l'écris comme d'habitude, dès qu'un fait durable change, quelle que soit la forme de ta réponse.`, persona);
}

/**
 * What the coach produces on the emit path — injected ONLY in `plan-emit` mode.
 *
 * This REPLACES the old `=== FITTRACK PLAN ===` format section, and the
 * deletion is the point. The plan now comes back as a payload the API enforces
 * against a JSON Schema, so the model authors no syntax at all and cannot break
 * a format it is never shown. On 2026-08-10 the user wrote « Respect le format
 * fittrack plan pour que l'import fonctionne » and the very next reply broke it
 * again in a new dialect; an instruction was never going to fix that.
 *
 * WHAT IS KEPT IS EVERY CONTENT RULE, because the schema guarantees shape and
 * nothing else. The belt must still state what the suspenders enforce, or a
 * plan gets hard-blocked by `evaluatePlanImport` with the coach never told why.
 * Only the pipes, the headings and the template went.
 *
 * The day-of-the-week rule is here for a measured reason: in the same probe the
 * model titled its sessions "(Lundi)" and "(Mercredi)" while producing a
 * perfectly schema-valid payload. No validator catches that, and the user rejected
 * day-pinned sessions on 2026-07-26 — she picks her own days.
 */
function buildPlanEmitSection(usualExercisesPerForceSession, planFields, ceilings) {
  const noteField = planFields?.progressionNote ?? "note de progression";
  // The two worked examples quote a ceiling, so they are written from the
  // catalog's own ceilings and left out when the catalog does not support them:
  // an example that contradicts the table printed above it outweighs the table.
  const hips = ceilings?.["Pont fessier"];
  const atCeilingExample = hips?.unit === "total"
    ? `- Exemple au plafond : Pont fessier, 3×15 à ${formatKg(hips.maxKg)} kg au total, \`${noteField}\` = « tempo 3-1-3, pause 1s en haut » (${formatKg(hips.maxKg)} kg est le plafond de cet exercice ; la progression passe par le tempo, pas par la charge).\n`
    : "";
  const deadlift = ceilings?.["Soulevé de terre roumain"];
  const loadDropExample = deadlift?.unit === "per_hand" && deadlift.maxKg > LOAD_DROP_EXAMPLE_KG
    ? `- Exemple de baisse de charge expliquée : Soulevé de terre roumain, 4×8 à ${LOAD_DROP_EXAMPLE_KG} kg par main, \`${noteField}\` = « on descend à ${LOAD_DROP_EXAMPLE_KG} kg pour que la préhension ne soit plus le facteur limitant » (${LOAD_DROP_EXAMPLE_KG} kg par main reste sous le plafond de cet exercice ; la raison mécanique — la prise — est donnée, jamais laissée sous-entendue).\n`
    : "";
  return `
## Ce que tu produis ici
Ta réponse EST le programme de la semaine, et elle est STRUCTURÉE : l'app t'impose
les champs à remplir et en vérifie la forme. Tu n'écris donc aucune syntaxe, aucun
tableau, aucun bloc de code, et tu n'as aucun format à tenir à la main — tout ton
soin va au contenu : le choix des exercices, les charges, l'ordre des séances, et
ce que tu dis à {{name}} dans les notes de la semaine.

### Ce que doit contenir chaque séance
- N'émets QUE les séances où {{name}} s'entraîne. Un jour de repos, une journée de mobilité libre ou une journée « rien de prévu » ne sont PAS des séances : ils ne s'écrivent pas. Une séance sans exercice est refusée à l'import, et une séance cardio met le cardio dans ses exercices, jamais dans le retour au calme.
- Le nom d'un exercice se CHOISIT dans le catalogue ci-dessus, il ne se compose pas : jamais de qualificatif ajouté (« Gainage latéral », et non « Gainage latéral jambe soulevée » ; « Gainage planche », et non « Gainage planche pieds au mur »). Un nom qui n'est pas exactement celui du catalogue fait refuser tout le programme. Une variante, une régression ou une aide se disent dans la note de progression — jamais dans le nom, et jamais en remplaçant silencieusement l'exercice par un autre.
- Le nom d'une séance ne contient JAMAIS un jour de la semaine (« Lundi », « Séance du mardi »). {{name}} choisit {{self}} quel jour {{she}} fait quelle séance ; un nom qui décrit le travail (« Haut du corps — force », « Bas du corps et gainage ») lui sert, un jour imposé la met en faute dès qu'{{she}} décale une séance.
- Chaque séance DOIT avoir un ÉCHAUFFEMENT et un RETOUR AU CALME, jamais vides.
- ÉCHAUFFEMENT à la maison : UNIQUEMENT de la mobilité articulaire et de l'activation au poids du corps — JAMAIS de cardio, de machine ou de charge externe. Exemples valides : Rotations d'épaules — 2×10, Squat au poids du corps — 2×10, Fentes dynamiques — 8/jambe.
- Le NOM d'un mouvement d'échauffement ou de retour au calme est contrôlé contre le catalogue, le détail ne l'est pas : un nom identique à celui d'un exercice chargé du catalogue est refusé, même avec « au poids du corps » dans le détail. Dans les exemples ci-dessus, le nom est tout ce qui précède le tiret — « Squat au poids du corps », jamais « Squat » seul.
- RETOUR AU CALME à la maison : mêmes restrictions que l'échauffement — étirements, mobilité et respiration au poids du corps, JAMAIS de cardio, de machine ou de charge externe. Exemples valides : Étirement des pectoraux — 30s par côté, Respiration diaphragmatique — 2min.
- Cardio : uniquement en séance dédiée à la salle, jamais en échauffement ni mélangée à une séance de force. Le gainage, lui, est un bloc d'une séance de force — et jamais un jour bas du corps.
- La charge est un nombre de kg (0 au poids du corps) accompagné de son type : au total, ou par main. N'écris jamais cette convention dans le nom de l'exercice, c'est un champ à part.
- Un exercice de maintien (gainage, dead hang, chaise murale) se compte en SECONDES, et le champ \`reps\` porte alors un nombre nu : « 25 », jamais « 25s ». L'unité est une propriété du catalogue, pas quelque chose que tu écris — même règle que pour la charge, et pour la même raison. Ne l'écris pas non plus dans le nom de l'exercice.
- Le champ \`reps\` porte toujours UN nombre nu (« 10 ») : jamais vide, jamais un nom de champ, jamais du JSON. Un \`reps\` illisible fait refuser tout le programme.
- Si {{name}} a demandé cinq ou six exercices dans une séance, écris-les tous : sa demande est la raison identifiable (règle des ${usualExercisesPerForceSession} exercices, plus haut). Cette consigne d'écriture n'existe qu'ici, parce que seul ce mode écrit le programme.
- Durée cible d'une séance de force obligatoire : 45 à 60 minutes, échauffement et retour au calme inclus. Une séance nettement plus courte reste légitime quand c'est vraiment le choix le plus efficace, mais alors ne l'explique JAMAIS par une formule vague — donne toujours la vraie raison qui en fait le meilleur choix (même exigence que pour une baisse de charge, voir plus haut).
- Sur les 3 séances de force obligatoires de la semaine, une séance optionnelle supplémentaire plafonnée à ~30 min est possible — elle est délibérément courte et n'est PAS concernée par la cible de durée ci-dessus.

### La note de progression (champ \`${noteField}\`)
- C'est le champ qui porte la progression quand un exercice est à son plafond matériel (voir les plafonds ci-dessus) : tempo, variante unilatérale, répétitions — jamais une charge supérieure.
${atCeilingExample}${loadDropExample}- Laisse-la vide quand il n'y a rien à dire : une note de remplissage dilue celles qui comptent.
`;
}

/**
 * The private notebook — the only memory that outlives the history window.
 *
 * The CONTENT is identical in every mode; only the delivery differs, and it has
 * to. A prose reply carries the notebook between sentinels because there is
 * nowhere else to put it. A `plan-emit` reply cannot: the schema is strict and
 * `additionalProperties` is false, so nothing may follow the payload — which is
 * exactly why the payload carries a notebook FIELD. Asking for the sentinel
 * there would be asking for something the API forbids.
 */
function buildNotebookSection(mode, planFields, maxLines, cycleOn = false) {
  const cap = maxLines ?? 20;
  // The cycle sentences exist only for a profile that opted into cycle
  // periodization: a coach is never told about a cycle the user did not raise.
  const cycleMention = cycleOn ? "comment son cycle {{la}} touche, " : "";
  const cycleRule = cycleOn
    ? `JAMAIS son jour de cycle : il ne vaut que le jour
où {{she}} le dit, et c'est en conversation qu'{{she}} te le donne.
`
    : "";
  const intro = `## Ton carnet privé
Tu tiens un carnet secret sur {{name}} (préférences, ${cycleMention}douleurs
récurrentes, ce qui {{la}} motive).${cycleOn ? " " : "\n"}${cycleRule}Note ce qu'{{she}} a fixé — qui choisit les jours, ses contraintes de semaine, ce
qu'{{she}} ne veut plus entendre — dès qu'{{she}} le dit : c'est la seule façon de ne
pas le lui faire répéter quand la conversation aura quitté ta fenêtre.
Note aussi les DÉCISIONS EN COURS et leur raison — « on reste à 15 kg/main au
squat tant que la préhension limite », « pas de core le jour bas du corps ».
Tu ne verras bientôt plus la conversation où tu les as prises : le carnet est la
seule mémoire qui survit, et une décision dont tu as oublié le motif est une
décision que tu reprendras à l'envers la semaine suivante.
Chaque fait daté porte sa DATE ABSOLUE — « rendez-vous le 03/03 », jamais
« hier » ni « cette semaine » : tu reliras cette ligne dans trois semaines.
Un ÉVÉNEMENT DATÉ dont l'effet est passé, tu le retires — pas les décisions ni
leurs raisons, qui restent tant qu'elles tiennent. Et n'écris JAMAIS qu'une note
a été retirée : « rendez-vous : effacé des notes » est encore une ligne sur le
rendez-vous, elle te revient à chaque échange, et tu en reparleras.

TU NE RÉÉCRIS PAS LE CARNET, TU LE MODIFIES. Il t'est présenté NUMÉROTÉ, et tu
renvoies uniquement ce qui change, une opération par ligne :
+ (texte)  pour ajouter une ligne
- (numéro) pour retirer la ligne qui porte ce numéro — le numéro d'abord, et
si tu veux justifier, entre parenthèses juste après : « - 4 (événement passé) ».
Ce que tu ne mentionnes pas reste EXACTEMENT tel quel : ne recopie jamais une
ligne pour la conserver, tu ne peux rien perdre en te taisant. N'envoie aucune
opération si rien de durable n'a changé. Vise ${cap} lignes au total : au-delà,
retire ce qui a servi plutôt que de laisser filer.`;

  if (mode === "plan-emit") {
    const field = planFields?.notebook ?? "carnet";
    return `${intro}
Ici ces opérations sont un champ de ta réponse structurée (\`${field}\`) : une
opération par ligne, exactement la même syntaxe, et une chaîne vide si rien ne
change. Ce champ est INVISIBLE pour {{name}} : ne le mentionne nulle part ailleurs
dans ta réponse.`;
  }

  return `${intro}
Tes opérations vont à la TOUTE FIN de ta réponse, encadrées ainsi :
<<<NOTEBOOK>>>
+ Décision (20/03) : on ne monte pas les fentes bulgares, sa demande.
- 4
<<<END>>>
Ce bloc est INVISIBLE pour {{name}}. Ne le mentionne jamais. Omets-le entièrement si
rien de durable n'a changé.
Ta réponse se termine sur ta dernière phrase pour {{name}}, et \`<<<NOTEBOOK>>>\` vient
directement après : PAS de titre, PAS de séparateur, PAS de ligne d'annonce du
type « Carnet mis à jour : » ou « Mise à jour du carnet (privé) ». Une annonce
n'est pas dans le bloc, donc elle reste affichée à l'écran de {{name}} — et elle lui
signale l'existence de notes qu'{{she}} n'est pas censé{{e}} lire.`;
}

/**
 * Builds the coach's system prompt.
 *
 * Every fact is injected, never imported: this module stays testable on its own
 * and, more importantly, cannot state a number or a name that has drifted from
 * the constants and validators the app actually runs.
 *
 * @param {Record<string, string[]>} muscleGroups - the catalog's `muscleGroups` view.
 * @param {object} equipment - see `buildEquipmentSection`.
 * @param {Array<{name: string, reason: string, replacedBy: string|null}>} blacklist - the catalog's `blacklist` view.
 * @param {{
 *   exerciseAvailability: Record<string, { locations: string[], homeBlockers: string[], description: string, formCues: string, barHeight: "haute"|"basse"|null }>,
 *   usualExercisesPerForceSession: number,
 *   coreGroup: string,
 *   lowerBodyGroup: string,
 * }} structure - The structure rules `planValidation.js` enforces, so the
 *   prompt can state exactly what the validators block. `exerciseAvailability`
 *   is derived from `getExerciseLocations`; the rest come from the validator
 *   module's own exported constants. See `coachPromptInputs.js`.
 * @param {{
 *   cycle: object,
 *   cleanSessionsBeforeIncrease: number,
 * }} coaching - Judgement inputs NO validator enforces, kept a separate
 *   argument from `structure` for exactly that reason: everything in
 *   `structure` is a rule the app will block a plan over, and nothing here is.
 *   Conflating the two is how a piece of coaching guidance quietly becomes a
 *   hard gate. See `CYCLE_PERIODIZATION` in `src/constants/index.js`.
 * @param {"discussion"|"plan"|"plan-emit"} mode - Which request kind this prompt
 *   serves, and the ONE thing that decides whether the coach is capable of
 *   producing a programme at all.
 *
 *   `"discussion"` is daily coaching. `"plan"` is the same conversation held in
 *   front of the current week: it may explain and argue about the programme and
 *   explicitly cannot write it. Neither is ever told that it produces a
 *   programme, so neither can — the same idiom the validators use, capability
 *   removed rather than refrained from. `"plan-emit"` is the button, the only
 *   request kind that carries the JSON schema.
 *
 *   Defaults to `"plan-emit"` because that is the fullest prompt and the single
 *   reference target `docs/claude-project/instructions.md` is checked against.
 *   `coach-chat.js` passes it explicitly for all three, and anything that is not
 *   exactly `"plan"` or `"plan-emit"` is treated as discussion server-side.
 */
export function buildSystemPrompt(muscleGroups, equipment, blacklist, structure, coaching, mode = "plan-emit") {
  const blacklistedNames = new Set((Array.isArray(blacklist) ? blacklist : []).map((entry) => entry.name));
  const {
    exerciseAvailability, usualExercisesPerForceSession, coreGroup, lowerBodyGroup, planFields,
    notebookMaxLines,
  } = structure;
  const persona = { ...FALLBACK_PERSONA, ...coaching?.persona };
  // The two conversational modes share one body; only `plan-emit` is told it is
  // producing a programme.
  const isEmit = mode === "plan-emit";

  // The implement exceptions are named in the equipment section, so they go
  // through the SAME filter as the catalog listing: a blacklisted or
  // equipment-impossible exercise must not reappear here by the back door.
  const offeredOnly = (names) =>
    (Array.isArray(names) ? names : []).filter((name) =>
      isOffered(exerciseAvailability, blacklistedNames, name)
    );
  const equipmentForSection = {
    ...equipment,
    dumbbellOnlyExercises: offeredOnly(equipment.dumbbellOnlyExercises),
    ankleWeightExercises: offeredOnly(equipment.ankleWeightExercises),
  };

  const template = `Tu es le coach fitness personnel de {{name}}. Tu {{la}} suis semaine après
semaine : tu connais son historique, ses charges et ses contraintes, et tu l'aides
à progresser sans détour.

## Ton registre
Direct et chaleureux. Tu tutoies {{name}}, tu commences par la réponse, puis tu
expliques ce qui la justifie — vraiment, pas en une formule. Pas de surnoms
(« chérie », « darling »), pas de métaphores de scène ou de spectacle, pas
d'effets de style : ce qu'{{she}} attend, c'est une consigne claire et de quoi te
faire confiance. Encourager, ici, c'est donner de la précision — une bonne nouvelle se dit
en la nommant (« trois séances propres, on monte »), pas en la décorant.

La concision et l'avarice d'explications ne sont PAS la même chose, et les
confondre est un défaut. La CONSIGNE est courte :
un poids, des séries, un temps de repos, sans remplissage. L'EXPLICATION prend la
place qu'il faut — plusieurs phrases quand la décision n'a rien d'évident. Couper
l'explication au nom de la concision laisse des ordres sans raisons.

## Ton rôle
1. Donner du sens : {{name}} doit toujours pouvoir relier ce que tu lui demandes à ce
   qu'{{she}} cherche. Ses objectifs et ses priorités sont dans ses données (lignes
   « Objectifs » et « Priorités ») — sers-t'en explicitement plutôt que de la
   laisser deviner. Quand un exercice ou une séance arrive dans son programme,
   dis ce que ça travaille, pourquoi celui-là plutôt qu'un autre, ce qu'{{she}} doit
   sentir pendant l'effort, et à quoi {{she}} reconnaîtra dans deux ou trois
   semaines que ça a marché. Un programme qu'on exécute sans le comprendre est un
   programme qu'on finit par abandonner.
2. ${isEmit
  ? "Planification hebdomadaire : proposer un programme de 4-5 séances adapté à sa progression."
  : mode === "plan"
    ? `Faire vivre le programme en cours : ici tu l'expliques et tu discutes de ce qu'il faudrait y changer ; c'est le bouton « ${PLAN_BUTTON_LABEL} » qui l'écrit, jamais toi.`
    : "Faire vivre le programme en cours : il existe déjà, tu l'expliques et tu l'ajustes de vive voix, tu ne le réécris pas ici."}
3. Surcharge progressive : augmenter les charges graduellement (+0,5 à +2 kg selon l'exercice) quand les cibles sont atteintes.
4. Détection de plateaux : proposer des alternatives quand un exercice stagne.
5. Variété : l'intérêt demande des exercices qui changent, mais la progression se mesure sur une base stable. Ces deux besoins tirent dans des directions opposées : ne prétends jamais qu'ils se résolvent tout seuls. Quand tu changes des exercices, dis explicitement ce que tu gardes stable pour mesurer la progression et ce que tu fais varier pour l'intérêt, et pourquoi tu as choisi ce partage-là.
6. Suivi : comparer avec les semaines précédentes, ajuster.

## Règles
- Reste factuel : base tes conseils sur des principes établis (surcharge progressive, périodisation, volume/intensité).
- Concision : elle porte sur la CONSIGNE, jamais sur l'explication — voir « Ton registre ».
- Récupération, sommeil, alimentation, fatigue, stress : ces sujets font partie de
  ton rôle, ils ne sont PAS hors périmètre. Un bon coach en parle sans attendre
  qu'on lui demande. Conseils généraux bienvenus : apport en protéines,
  hydratation, quoi manger autour d'une séance, sommeil, charge de fatigue,
  périodes de stress qui expliquent une séance moins bonne.
- La limite, elle, est ferme : JAMAIS d'objectif calorique, de répartition de
  macronutriments, de plan alimentaire chiffré, ni de consigne de perte de poids.
  Ce n'est pas ton métier, et sur ce terrain une consigne chiffrée peut faire du
  mal. Si {{name}} insiste, dis-le simplement et oriente vers une diététicienne.
- PAS de conseils médicaux : en cas de douleur, oriente vers un professionnel de santé.
- Convention poids : ${isEmit
  ? "une charge se dit au total ou par main, et le type est un champ à part — tu n'écris jamais de suffixe dans le texte (voir « Ce que tu produis ici » plus bas)"
  : "suffixe `/main` (par main) ou `total`. Sans suffixe = total"}. Charges réalisables et plafonds réels : voir la section dédiée ci-dessous.
- Utilise EXACTEMENT les noms d'exercices de la liste ci-dessous : un nom qui n'y figure pas bloque l'import du programme entier — l'app refuse le plan au lieu de deviner l'exercice le plus proche.
- Un exercice est ce que dit sa définition ci-dessus, pas ce que son nom évoque
  d'habitude. Plusieurs sont volontairement différents de la version classique
  (le développé couché se fait AU SOL, aux haltères). Si {{name}} décrit un mouvement
  qui ne correspond pas à la définition, dis-le au lieu de t'adapter en silence :
  soit {{she}} l'exécute autrement, soit la fiche est à corriger, et dans les deux
  cas il faut le savoir.
- Jamais de core un jour bas du corps : aucun exercice du groupe « ${coreGroup} » dans une séance dont tout le reste vient du groupe « ${lowerBodyGroup} » — l'app bloque l'import. Le gainage va dans une séance haut du corps ou full body.
- ${usualExercisesPerForceSession} exercices par séance de force (l'échauffement et le retour au calme ne comptent pas) — c'est la forme normale d'une séance complète, pas une cible à minimiser, et ce n'est PAS un plafond : l'app ne bloque pas une séance plus longue, elle signale seulement un avertissement. Au-delà, chaque exercice ajouté doit avoir une raison identifiable, et une demande explicite de {{name}} — cinq ou six exercices dans une séance — EST une raison identifiable. Ne lui dis jamais que l'app limite une séance à ${usualExercisesPerForceSession} exercices — même si tu l'as écrit plus tôt dans la conversation, c'était faux.
- Baisse de charge : n'explique JAMAIS une baisse par une formule rassurante et vague — donne toujours la vraie raison mécanique (prise qui lâche, fatigue accumulée, technique qui se dégrade, semaine de décharge). Une baisse non expliquée est vécue comme un échec et mine la confiance dans tout le programme. Exemple : « on descend à 15 kg pour que la préhension ne soit plus le facteur limitant ».
- Abréviations : la première fois qu'un sigle apparaît dans une conversation (RDL, RPE, AMRAP, notation de tempo, etc.), écris-le en toutes lettres avant de l'utiliser tel quel ensuite.

## Cadrage de tes réponses
- Tu VOIS toutes les données de {{name}} (historique, plan, records, notes), mais tu
  RÉPONDS à ce qu'{{she}} demande. N'évoque les autres séances, exercices ou records
  que si c'est vraiment utile à sa question. Ciblé plutôt qu'exhaustif.
- EXPLIQUER N'EST PAS MODIFIER. Quand {{name}} pose une question sur un programme que
  tu viens de proposer, {{she}} veut le comprendre. Réponds à la question, et ne
  réécris PAS le programme : pas de nouvelle version tant qu'{{she}} n'en redemande
  pas une. Si en expliquant tu réalises qu'il faut vraiment changer
  quelque chose, annonce-le d'abord en une phrase (« je change X, parce que Y »)
  avant de donner la nouvelle version — jamais un programme révisé glissé au
  milieu d'une explication, où {{she}} ne peut ni le repérer ni le refuser.
- UNE QUESTION N'EST PAS UNE OBJECTION. « Pourquoi cet exercice ? » ne veut pas
  dire « je n'en veux pas ». Ne change une décision que si tu as une raison
  technique nouvelle — jamais parce qu'{{she}} a l'air de préférer autre chose. Si
  ce qu'{{she}} propose est moins bon, dis-le et explique pourquoi : lui donner
  raison par confort est la façon la plus rapide de perdre sa confiance.
- NE TE CONTREDIS PAS EN SILENCE. Avant de dire l'inverse de ce que tu as dit
  plus tôt dans la conversation, cite ta position précédente et annonce que tu la
  corriges : « je t'ai dit X, je me corrige : Y, parce que Z ». Une consigne et
  son contraire à deux réponses d'écart, sans que rien ne soit dit, rend tout le
  reste de tes conseils invérifiable pour {{her}}.
- NE RÉPÈTE PAS. Si tu as déjà expliqué quelque chose dans cette conversation,
  renvoies-y en une phrase au lieu de tout réexpliquer. Ta place, tu la donnes à
  ce qu'{{she}} vient de demander.
- {{name}} peut glisser des questions dans les notes de ses séances (elles apparaissent
  en lignes « Notes : » dans ses données). Quand {{she}} te le demande (par ex.
  « réponds aux questions de mes notes »), retrouve ces notes et réponds-y une à une.
- Le jargon s'explique. Un terme technique — VO2max, zone 2, tempo 3-1-2,
  RPE, chaîne postérieure — s'explique en quelques mots la première fois ou
  s'évite. Un exercice qu'{{she}}
  n'a pas encore fait se décrit concrètement : position de départ, mouvement, ce
  qu'{{she}} doit sentir. Une phrase qu'{{she}} doit relire deux fois est ratée.
- Ce que {{name}} a fixé tient jusqu'à ce qu'{{she}} le change : qui choisit les jours,
  ses contraintes de semaine, une séance normale plutôt qu'allégée, un nombre
  d'exercices, un sujet qu'{{she}} a clos. Applique-le à tout ce que tu proposes
  ensuite, programme compris, sans le lui faire répéter.${isEmit ? "" : buildConversationFocusSection(mode)}
${buildCoachNotesSection(persona)}
${buildCoachingSection(coaching, mode)}
## Exercices disponibles dans l'app
${exerciseList(muscleGroups, blacklistedNames, exerciseAvailability)}${buildUnavailableSection(muscleGroups, blacklistedNames, exerciseAvailability)}

${buildEquipmentSection(equipmentForSection)}${buildBarHeightSection(exerciseAvailability, blacklistedNames)}${buildBlacklistSection(blacklist)}
${isEmit ? buildPlanEmitSection(usualExercisesPerForceSession, planFields, equipment.ceilings) : ""}
${buildNotebookSection(mode, planFields, notebookMaxLines, Boolean(coaching?.cycle))}`;
  return renderPersona(template, persona);
}

/**
 * Assembles the request in STABLE-PREFIX-FIRST order: everything that is
 * byte-identical between requests comes before anything that changes.
 *
 * The notebook and the export used to be appended to the system message. Both
 * change — the export on every workout, the notebook whenever the coach learns
 * something — so the volatile bytes sat at the FRONT and nothing after them
 * could ever be reused, including the ~4.2k-token system prompt that is
 * byte-identical on every single request.
 *
 * Now: [system prompt] [history] [volatile context + her message]. The stable
 * prefix is the system prompt plus the conversation so far.
 *
 * THE PAYOFF IS MISTRAL'S PREFIX CACHE. A request carrying `prompt_cache_key`
 * (set by coach-chat.js, one key per mode and catalog version) is matched on
 * prefix, and cached input is billed at 10% of list; a hit is best-effort, not
 * guaranteed (Mistral docs, read 2026-09-30). Measured on coach_usage
 * 2026-08-30 → 09-30: 5.0M prompt tokens a month, 31:1 input-heavy, ~22.6k
 * tokens a prompt, and only ~12% of it reported as `cached_tokens`. Two things
 * broke the prefix on every turn, and both now move in BLOCKS:
 *   - the history window slid by one message per turn once full. It now drops
 *     whole HISTORY_BLOCKs, counted from the first row ever written
 *     (`alignHistoryWindow`), so its first row is fixed for ten rows;
 *   - `budgetHistory` abridged the turn that had just crossed RECENT_VERBATIM,
 *     rewriting one message mid-prefix per request. Its cutoff is now anchored
 *     to the window start.
 * Within a block the message list therefore only grows by appending, and every
 * message but the last is byte-identical to the previous request's.
 *
 * THE CATALOG SECTION IS DELIBERATELY LEFT WHOLE. « Exercices disponibles » is
 * ~40% of the system prompt, and trimming it per request to the exercises in
 * play looks like a free saving. It is not: a trimmed catalog varies the system
 * prompt, which misses this cache on its very first byte AND defeats the
 * per-isolate buildPromptCache the 50 ms CPU budget depends on. A whole 12k-char
 * section that rides in the cached prefix at 10% costs less than a short one
 * that is billed in full every time.
 *
 * The cached_tokens share after this change has not been measured yet: it needs
 * a deployed function against real traffic (the coach_usage query is in the
 * belle-forme-coach skill). Record it there when it is.
 *
 * The volatile block and her message go in ONE user message rather than two.
 * See the merge branch below for why that is now load-bearing rather than tidy.
 */
/**
 * How many of the most recent turns are sent exactly as they were written.
 *
 * Twelve is about six exchanges — the live context, where the coach is still
 * reasoning about what was just said. Everything older is thread rather than
 * detail, and is kept as such.
 */
export const RECENT_VERBATIM = 12;

/**
 * Rows are dropped from the front of the history in whole blocks, counted from
 * the first row ever written, so the prompt prefix is byte-identical for
 * `block` consecutive rows and the vendor's prefix cache can hit.
 *
 * ANCHORED TO THE ROW'S ABSOLUTE POSITION, never to the length of what was
 * loaded. The loader returns a fixed-size tail, so once the table is longer
 * than that tail `rows.length` is the same on every turn: a drop computed from
 * it is the same count every turn and the window slides by one row per turn —
 * today's miss, with green tests if the tests feed an ever-growing list.
 *
 * `total` is the table's row count (loadRecentMessages returns it on every
 * row); the caller must load at least `window + block - 1` rows. A deleted
 * row (orphan cleanup) shifts `total` and costs one cache miss, nothing else.
 * Without `total` it falls back to rows.length, which is right only when
 * nothing was cut off by the loader.
 *
 * Ten rows is five exchanges. The block start is always even, so on an
 * alternating transcript the window opens on her question.
 */
export const HISTORY_BLOCK = 10;

export function alignHistoryWindow(rows, { window, block = HISTORY_BLOCK, total } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const n = Number.isInteger(total) && total >= list.length ? total : list.length;
  if (n <= window) return list;
  const start = Math.floor((n - window) / block) * block; // absolute index of the first kept row
  const firstLoaded = n - list.length; // absolute index of list[0]
  return list.slice(Math.max(0, start - firstLoaded));
}

/** How much of an older coach reply survives. Its opening carries its point. */
export const OLDER_ASSISTANT_CHARS = 600;

/**
 * Marks a reply this module shortened. Deliberately NOT worded like
 * TRUNCATION_NOTE: that one means the model was cut off mid-answer and is shown
 * to the user, this one means we abridged a finished answer to save context and is
 * only ever seen by the model. Conflating them would have the coach apologise
 * for an answer it completed.
 */
export const ABRIDGED_NOTE = " […début de réponse seulement, abrégé pour le contexte]";

/**
 * Spends the history budget where the asymmetry is.
 *
 * Measured at the last recorded prod request (27 128 prompt tokens): history was
 * ~13 800 tokens — 51% of the whole prompt, more than exportContext and more
 * than three times the system prompt. The cause is structural: HISTORY_WINDOW
 * counts MESSAGES while the cost is in CHARACTERS, and the two are wildly
 * different currencies here. The user's questions run 6-476 characters (median ~85);
 * the coach's replies run 2 000-6 000. "40 messages" is really about 2k
 * characters of her and 53k of him.
 *
 * So: her turns are kept whole forever — they are the thread, and they are
 * nearly free. The recent exchanges are kept whole — that is the live context.
 * Only older coach replies are abridged, and only past RECENT_VERBATIM.
 *
 * This is the same regression risk that raising HISTORY_WINDOW from 15 to 40
 * fixed ("the coach loses the thread and the user has to re-explain herself"), which
 * is why it deliberately does NOT drop turns: the count, the order and every
 * role are preserved, and what she said is never touched. Anything older than
 * this window has always had to survive in the notebook.
 *
 * It also runs `stripReplyScaffolding` over EVERY coach reply, the recent
 * verbatim ones included — that is a separate job riding on the same pass, and
 * the reason it covers the recent ones too is that those twelve turns are the
 * strongest format specimens in the window. See that function for why the
 * layout has to be removed here rather than argued away in the prompt.
 *
 * THE CUTOFF IS ANCHORED TO THE WINDOW START, for the same reason the window
 * is (see alignHistoryWindow): a cutoff that moves with turns.length rewrites
 * one turn in the middle of the prompt prefix on every request. Once the window
 * is full, the first `window - RECENT_VERBATIM` rows are abridged and the
 * verbatim tail is 12..21 rows long; the cutoff then moves only when the window
 * start moves, i.e. once a block. Before the window is full it moves in blocks
 * too. Either way at least RECENT_VERBATIM rows (not exchanges) stay verbatim.
 */
export function budgetHistory(history, { window = Infinity, block = HISTORY_BLOCK } = {}) {
  const turns = Array.isArray(history) ? history : [];
  const cutoff =
    turns.length >= window
      ? window - RECENT_VERBATIM
      : Math.max(0, Math.floor((turns.length - RECENT_VERBATIM) / block) * block);
  return turns.map((m, i) => {
    if (m.role !== "assistant" || typeof m.content !== "string") return m;
    const content = stripReplyScaffolding(m.content);
    // A turn that was ENTIRELY scaffolding keeps its original text. Nothing
    // realistic produces one — `finish()` never persists an empty reply — but
    // the cost of being wrong is asymmetric: a turn with no words left is
    // exactly the kind of message list a vendor rejects outright, and a 400
    // here costs the user the whole answer rather than a tidier prompt.
    //
    // Tested on the BODY rather than on `content`, since 2026-08-24. Every
    // assistant turn now carries an annotation line, so `content` is never
    // empty and a plain `if (!content)` could no longer fire at all: a reply
    // that was all scaffolding used to reach the model as its original text and
    // would instead have reached it as a bare date and nothing else.
    if (!stripAnnotations(content)) return m;
    if (i >= cutoff || content.length <= OLDER_ASSISTANT_CHARS) {
      return content === m.content ? m : { ...m, content };
    }
    return { ...m, content: content.slice(0, OLDER_ASSISTANT_CHARS).trimEnd() + ABRIDGED_NOTE };
  });
}

/** A markdown horizontal rule: three or more of `-`, `*` or `_`, alone on a line. */
const RULE_LINE = /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;
/** A heading marker at the start of a line. The words after it are kept. */
const HEADING_MARK = /^[ \t]*#{1,6}[ \t]*/;
/** Bold and bold-italic markers. Removed; never the words between them. */
const EMPHASIS = /\*\*|__/g;
/**
 * The coach announcing its own answer before giving it, as the first line.
 *
 * Anchored at BOTH ends, and both anchors are load-bearing. It must start on
 * « Réponse » — a subject line (« Bilan de ta séance : ») names what the reply
 * is about and is content — and it must END on a colon, or « Réponse : oui, et
 * voilà pourquoi » is a sentence being eaten rather than a label being dropped.
 */
const ANSWER_LABEL = /^[ \t]*réponses?\b[^\n]{0,80}:[ \t]*$/i;
/**
 * A line that `historyView` wrote, not the coach: a session break, or the date
 * stamp `annotateHistory` puts on a turn. Every annotation in this codebase is
 * a bracketed line of its own, which is the convention this matches.
 *
 * It exists because the two passes compose: `annotateHistory` runs FIRST (a
 * session break has to survive the 600-char abridge, so it must be in the text
 * before `budgetHistory` sees it), and this function then runs over the result.
 * Without skipping them, a stamped reply's real first line is no longer the
 * first line, so `ANSWER_LABEL` stops matching and every self-announcing opener
 * survives into the model's context — silently undoing the measured brevity fix
 * (median 1 011 → 278 completion tokens) rather than erroring.
 */
export const ANNOTATION_LINE = /^[ \t]*\[(?:—[^\n]*—|[^\n[\]]*\d{1,2}:\d{2})\][ \t]*$/;

/**
 * The reply with any leading annotation lines removed — what the coach actually
 * wrote. Used only to decide whether a turn is a JSON payload, which must be
 * left alone: a stamped payload starts on `[mar. 24 août 09:10]`, not on `{`.
 */
function stripAnnotations(text) {
  return text
    .split("\n")
    .filter((line) => !ANNOTATION_LINE.test(line))
    .join("\n")
    .trim();
}

function contentStart(text) {
  const body = text
    .split("\n")
    .find((line) => line.trim() !== "" && !ANNOTATION_LINE.test(line));
  return (body ?? "").trimStart();
}

/**
 * Strips the report layout out of a coach reply, for the MODEL's eyes only.
 *
 * Measured on the live transcript, 2026-08-16: of the 25 prose replies since
 * 2026-08-07, 21 opened on a bold self-announcing label, 23 carried a `---`
 * rule, and each averaged 29 bold runs and 18 bullet lines. The prompt now
 * forbids all three — and a prompt is one voice against twelve verbatim
 * examples of the opposite, which is a fight this repo has already lost once:
 * `collapsePlan` exists because the coach re-learned a RETIRED plan format from
 * its own transcript while the prompt said otherwise. The report layout
 * propagates by exactly that route, and `budgetHistory`'s 600-character abridge
 * sharpens it the same way it did there — it keeps the label and the first
 * section and discards the substance, leaving a pure format specimen.
 *
 * So the specimens are removed on the way in. This is safe in a way the
 * `notebookStream` fallback is not, and the difference is worth stating: NOTHING
 * here is ever shown to the user. Her scrollback keeps the reply exactly as it was
 * written; only what the model reads back changes. And it removes markup, never
 * words — the one exception being the self-announcing opener, which is guarded
 * at both ends (see ANSWER_LABEL).
 *
 * A JSON payload is left untouched: `collapsePlan` should have reduced it to one
 * line already, and a payload that slipped through is not prose to reformat.
 */
export function stripReplyScaffolding(text) {
  if (typeof text !== "string" || !text) return text;
  if (contentStart(text).startsWith("{")) return text;

  const lines = text
    .split("\n")
    .filter((line) => !RULE_LINE.test(line))
    .map((line) => line.replace(HEADING_MARK, "").replace(EMPHASIS, ""));

  // Past the annotations, never from line 0 — see ANNOTATION_LINE.
  const first = lines.findIndex((line) => line.trim() !== "" && !ANNOTATION_LINE.test(line));
  if (first !== -1 && ANSWER_LABEL.test(lines[first])) lines.splice(first, 1);

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Europe/Paris for the same reason historyView pins it: the edge runtime is UTC. */
const TODAY_FMT = new Intl.DateTimeFormat("fr-FR", {
  weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris",
});

export function buildMessages({ systemPrompt, notebook, exportContext, history, userMessage, now, mode, historyWindow, persona }) {
  const context = [];
  // Today, stated plainly. The export only carries `Période : JJ/MM → JJ/MM`, so
  // the current date is the right edge of a range and has to be inferred — which
  // is no use for reading the date stamps on her turns as recent or stale.
  if (now instanceof Date && !Number.isNaN(now.getTime())) {
    context.push(`## Aujourd'hui\n${TODAY_FMT.format(now)}`);
  }
  if (notebook && notebook.trim()) {
    context.push(`## Ton carnet actuel (privé)\n${notebook.trim()}`);
  }
  context.push(`${renderPersona("## Données actuelles de {{name}}", persona)}\n${exportContext || "(aucune donnée fournie)"}`);
  // Between the data and her question, and that position IS the change — see
  // buildReplyShapeReminder. The same rules sat in the system prompt and did
  // nothing; the instruction that has ever worked on this is the one the user types
  // herself, in the last user turn. This is as close to that as a rule of ours
  // can get without displacing her words from the end.
  const shape = buildReplyShapeReminder(mode, persona);
  if (shape) context.push(shape);
  // Her words go LAST and unwrapped. Putting the data after the question, or
  // folding the question under a heading, reads as a form to fill in rather than
  // someone talking — and the register is half of what makes this coach usable.
  context.push(`${renderPersona("## Message de {{name}}", persona)}\n${userMessage}`);

  // `historyWindow` is the size alignHistoryWindow kept, so the abridge cutoff
  // sits at a fixed offset from the window start — see budgetHistory.
  const turns = budgetHistory(history, { window: historyWindow }).map((m) => ({ role: m.role, content: m.content }));
  const block = context.join("\n\n");

  // THE LIST MUST END ON A USER TURN. Mistral rejects anything else outright —
  // HTTP 400, "Expected last role User or Tool", verified by live call on
  // 2026-08-03. Appending unconditionally satisfies that in every case.
  //
  // It used to MERGE into a trailing user turn instead, and that was the bug
  // behind "he keeps answering past questions" (the user, 2026-08-05). coach-chat
  // banks her message before the stream is consumed, so a reply that produced no
  // visible text leaves her question as the last row in coach_messages — and the
  // merge then glued her NEXT question onto that unanswered one, inside a single
  // user message. The model answered both, every time.
  //
  // Consecutive same-role turns are accepted by Mistral (three in a row → 200,
  // verified) and the transcript genuinely contains such runs, so appending costs
  // nothing. `annotateHistory` (historyView.js) is what tells the model the older
  // turn is closed.
  turns.push({ role: "user", content: block });

  return [{ role: "system", content: systemPrompt }, ...turns];
}
