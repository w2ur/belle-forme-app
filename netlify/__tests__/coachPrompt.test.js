import { describe, it, expect, vi } from "vitest";
import {
  buildSystemPrompt,
  buildMessages,
  buildReplyShapeReminder,
  offeredExerciseNames,
  budgetHistory,
  stripReplyScaffolding,
  ABRIDGED_NOTE,
  RECENT_VERBATIM,
  PLAN_BUTTON_LABEL,
  alignHistoryWindow,
  HISTORY_BLOCK,
  FALLBACK_PERSONA,
  renderPersona,
} from "../functions/lib/coachPrompt.js";
import { resolvePersona } from "../../src/lib/persona.js";
import { TEST_INVENTORY } from "../../src/constants/testInventory.js";
import { annotateHistory } from "../functions/lib/historyView.js";
import { PLAN_BUTTON_LABEL as UI_PLAN_BUTTON_LABEL } from "../../src/lib/planButtonLabel.js";
import { buildPromptInputs } from "../functions/lib/coachPromptInputs.js";
import seed from "../../src/data/catalogSeed.json";
import { buildCatalogViews } from "../../src/lib/catalogTestkit.js";
import { USUAL_EXERCISES_PER_FORCE_SESSION } from "../../src/lib/planValidation.js";
import { generateExport } from "../../src/lib/planExport.js";
import { deriveLocations } from "../../src/constants/index.js";
import { TEST_PROFILE } from "./testProfile.js";

// The exact objects production sends — `coach-chat.js` calls the same function
// on the same document — so a test can never assert against a hand-maintained
// copy of the injected data. The seed is the committed copy of the catalog
// document Neon was seeded with.
//
// Named CATALOG_* rather than after the retired constants: a bare `GROUPS`
// already names the tiny hand-written fixture below, and the two are
// deliberately different things (see the comment on `pFull`).
const CATALOG = buildCatalogViews(seed);
// The inventory the catalog was built against: the load lists the prompt states
// are derived from it, so the tests read the same object.
const INVENTORY = CATALOG.inventory;
const DUMBBELL_OPTIONS_KG = INVENTORY.dumbbellOptionsKg;
const ACHIEVABLE_LOADS_PER_IMPLEMENT = INVENTORY.achievable;
const PER_HAND_LOAD_UNION_KG = INVENTORY.perHandUnion;
const ANKLE_WEIGHT_KG = INVENTORY.ankleWeightKg;
const {
  muscleGroups: CATALOG_GROUPS,
  allExercises: CATALOG_ALL,
  descriptions: CATALOG_DESCRIPTIONS,
  blacklist: CATALOG_BLACKLIST,
  ceilings: CATALOG_CEILINGS,
} = CATALOG;

/**
 * The locations an exercise is allowed in, derived from its own catalog
 * descriptor — the same derivation `coachPromptInputs.js` runs in production,
 * and all the deleted `getExerciseLocations` constant-reader ever did.
 */
function locationsOf(name) {
  const entry = CATALOG_DESCRIPTIONS[name];
  if (!entry) return [];
  return deriveLocations(entry.equipmentNeeds, entry.implementTypes, INVENTORY);
}

/** The exercises that do NOT follow the "dumbbells or bars, as you like" rule — derived, never named here. */
const DUMBBELL_ONLY_EXERCISES = CATALOG_ALL.filter((name) => {
  const types = CATALOG_DESCRIPTIONS[name].implementTypes;
  return types.length === 1 && types[0] === "dumbbell";
});
const ANKLE_WEIGHT_EXERCISES = CATALOG_ALL.filter((name) =>
  CATALOG_DESCRIPTIONS[name].implementTypes.includes("ankle_weight")
);
/**
 * The catalog exercises a fragment of prompt text actually names.
 *
 * Resolved LONGEST NAME FIRST, blanking each match out of the working copy, so
 * a name that is a prefix of another is never credited by the longer one's
 * occurrence. A bare `toContain("Pont fessier")` was satisfied by
 * "Pont fessier unilatéral" three words later, which made the whole
 * dumbbell-only clause deletable with every assertion still green. The rule is
 * general, not a special case for that pair: any catalog name that is a prefix
 * of another has the same hole (and today "Squat"/"Squat sumo",
 * "Pont fessier"/"Pont fessier unilatéral" and "Fentes"/"Fentes bulgares" all
 * are).
 */
function namesMentioned(text, candidates = CATALOG_ALL) {
  let rest = text;
  const found = new Set();
  for (const name of [...candidates].sort((a, b) => b.length - a.length)) {
    if (rest.includes(name)) {
      found.add(name);
      rest = rest.split(name).join(" ");
    }
  }
  return [...found].sort();
}

const GROUPS = { "Upper Body": ["Développé couché au sol"], "Core": ["Gainage planche"] };

// The suite's user: a made-up person who turned cycle periodization on (most of
// what is asserted below is about that section). The tests that need the other
// states build their own profile.
const PROFILE = { ...TEST_PROFILE, cycle: { enabled: true, lengthDays: 25 } };
const { equipment: EQUIPMENT, structure: STRUCTURE, coaching: COACHING } = buildPromptInputs(CATALOG, PROFILE);

// Derived from the real catalog (constraints.md: cardio machine names must never be
// hardcoded here, or a cardio exercise added later would silently escape this guard).
const CARDIO_EXERCISE_NAMES = CATALOG_GROUPS.Cardio;

/** Exercises the real equipment makes impossible everywhere — derived, never named here. */
const HOME_INFEASIBLE_EXERCISE_NAMES = CATALOG_ALL.filter(
  (name) => locationsOf(name).length === 0
);

/**
 * Extracts every prompt block that concerns one free-text section of a session: the literal
 * FITTRACK PLAN template heading + its placeholder line, and any format-rule bullet whose
 * first line is about that section (continuation lines are indented; a sibling bullet at
 * column 0 ends the block, so an adjacent bullet like "Cardio : ..." is never swept in).
 * This is the real regression guard: a machine reintroduced into any of these blocks makes
 * the cardio-name assertions below fail.
 *
 * Only a line ABOUT the section (the bare template heading, or a bullet whose subject IS the
 * section) starts a block — a line that merely mentions the word in passing (e.g. the cardio
 * bullet's "jamais en échauffement" scoping clause) must not, or it would sweep unrelated
 * bullets (and their own examples) into the check.
 */
function extractSections(prompt, headingRe, bulletRe) {
  const lines = prompt.split("\n");
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const isHeading = headingRe.test(trimmed);
    const isBullet = bulletRe.test(trimmed);
    if (!isHeading && !isBullet) continue;
    const block = [lines[i]];
    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j];
      if (line.trim() === "") break;
      if (isBullet && /^-/.test(line)) break;
      block.push(line);
      j++;
    }
    sections.push(block.join("\n"));
  }
  return sections;
}

/**
 * The whole of one bullet — its first line plus the indented continuation lines
 * — identified by a marker it contains, with whitespace collapsed.
 *
 * Both halves matter. Asserting on a single LINE would only ever see the first
 * of the five a rule wraps onto, so half of it could be deleted with every
 * assertion still green. And the prompt is hard-wrapped at ~80 columns, so any
 * assertion longer than two words straddles a newline — matching against the raw
 * block fails for a reason that has nothing to do with what the rule says.
 */
function ruleBlock(prompt, marker) {
  const lines = prompt.split("\n");
  const start = lines.findIndex((line) => /^-\s/.test(line) && line.includes(marker));
  if (start === -1) return null;
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "" || /^-\s/.test(lines[i]) || /^#/.test(lines[i])) break;
    block.push(lines[i]);
  }
  return block.join(" ").replace(/\s+/g, " ").trim();
}

const extractWarmupSections = (prompt) =>
  extractSections(prompt, /^[ÉE]CHAUFFEMENT$/i, /^-\s*[ÉE]CHAUFFEMENT\b/i);

const extractCooldownSections = (prompt) =>
  extractSections(prompt, /^RETOUR AU CALME$/i, /^-\s*RETOUR AU CALME\b/i);

describe("buildSystemPrompt", () => {
  const p = buildSystemPrompt(GROUPS, EQUIPMENT, [], STRUCTURE, COACHING);
  it("includes the persona, the exercises, what it produces and the notebook protocol", () => {
    expect(p).toMatch(/coach fitness personnel de Camille/i); // who it is
    expect(p).toContain("Développé couché au sol");          // exercise from groups
    expect(p).toContain("Gainage planche");
    expect(p).toContain("## Ce que tu produis ici");   // output contract
    expect(p).toContain("RETOUR AU CALME");
    // The notebook is a FIELD on the emit path — the sentinel belongs to the
    // prose modes, and is asserted there. See "three modes" below.
    expect(p).toContain(STRUCTURE.planFields.notebook);
    expect(p).toMatch(/médicaux/i);                    // safety rail
  });

  it("instructs the coach to focus on the question while seeing all data, and to answer questions left in notes", () => {
    expect(p).toMatch(/RÉPONDS à ce qu'elle demande/);   // scope: answer what's asked
    expect(p).toMatch(/notes de ses séances/);           // notes-as-questions feature
  });

  // The model authors no syntax any more, so there is no line format left to
  // document. What survives is the FIELD the note goes into, named off the
  // schema rather than retyped — see coachPromptInputs.schemaField.
  it("names the progression-note field the schema declares, and no line format", () => {
    expect(p).toContain(`champ \`${STRUCTURE.planFields.progressionNote}\``);
    expect(p).not.toContain("Nom | SxR | Pkg | repos Xs | note");
  });

  it("states the at-ceiling rule: progression via tempo/reps/unilateral, never additional load", () => {
    expect(p).toMatch(/plafond/i);
    expect(p).toMatch(/tempo, les répétitions ou une variante unilatérale/i);
    expect(p).toMatch(/JAMAIS par une charge supplémentaire/);
  });

  it("gives an at-ceiling example that does NOT model a load-increase violation", () => {
    // Examples outweigh rules (constraints.md): the example must show the
    // note field used for tempo, not for sneaking in extra weight, and the
    // load in the example must not exceed that exercise's real ceiling.
    const ceiling = CATALOG_CEILINGS["Pont fessier"];
    expect(ceiling.unit).toBe("total");
    // Written from the catalog's own ceiling, so it can never contradict the table.
    expect(p).toContain(`Pont fessier, 3×15 à ${ceiling.maxKg} kg au total`);
    expect(p).toContain(`(${ceiling.maxKg} kg est le plafond de cet exercice`);
    expect(p).toContain("tempo 3-1-3, pause 1s en haut");
  });

  // The two worked examples quote a ceiling. They used to be literals, true only
  // for one catalog; a catalog with other ceilings got an example that contradicted
  // its own table. Built against explicit ceilings so the cases are not the seed's.
  describe("the worked ceiling examples follow the catalog's ceilings", () => {
    const emitWith = (ceilings) =>
      buildSystemPrompt(GROUPS, { ...EQUIPMENT, ceilings }, [], STRUCTURE, COACHING);
    const HIPS = "Pont fessier";
    const DEADLIFT = "Soulevé de terre roumain";

    // Regression: the plan-emit prompt of a catalog whose ceilings are 11 kg total
    // and 17 kg per hand must stay word for word what it was before the examples
    // were derived.
    it("keeps the historical sentences for a catalog with an 11 kg and a 17 kg ceiling", () => {
      const out = emitWith({ [HIPS]: { maxKg: 11, unit: "total" }, [DEADLIFT]: { maxKg: 17, unit: "per_hand" } });
      expect(out).toContain("- Exemple au plafond : Pont fessier, 3×15 à 11 kg au total, `" + STRUCTURE.planFields.progressionNote + "` = « tempo 3-1-3, pause 1s en haut » (11 kg est le plafond de cet exercice ; la progression passe par le tempo, pas par la charge).\n");
      expect(out).toContain("- Exemple de baisse de charge expliquée : Soulevé de terre roumain, 4×8 à 15 kg par main, `" + STRUCTURE.planFields.progressionNote + "` = « on descend à 15 kg pour que la préhension ne soit plus le facteur limitant » (15 kg par main reste sous le plafond de cet exercice ; la raison mécanique — la prise — est donnée, jamais laissée sous-entendue).\n- Laisse-la vide");
    });

    it("quotes another ceiling when the catalog has one", () => {
      const out = emitWith({ [HIPS]: { maxKg: 7.5, unit: "total" } });
      expect(out).toContain("Pont fessier, 3×15 à 7,5 kg au total");
      expect(out).toContain("(7,5 kg est le plafond de cet exercice");
      expect(out).not.toContain("à 11 kg au total");
    });

    it("leaves an example out rather than state a ceiling the catalog does not have", () => {
      const out = emitWith({});
      expect(out).not.toContain("Exemple au plafond");
      expect(out).not.toContain("Exemple de baisse de charge expliquée");
      expect(out).toContain("- Laisse-la vide quand il n'y a rien à dire");
    });

    it("drops the load-drop example when 15 kg is not below the exercise's ceiling", () => {
      const out = emitWith({ [HIPS]: { maxKg: 12, unit: "total" }, [DEADLIFT]: { maxKg: 15, unit: "per_hand" } });
      expect(out).toContain("Exemple au plafond");
      expect(out).not.toContain("Exemple de baisse de charge expliquée");
    });
  });

  it("injects the real per-exercise ceilings, sourced from the constant rather than retyped", () => {
    // Every ceiling EXCEPT a blacklisted exercise's: stating a maximum load for
    // an exercise the same prompt forbids is contradictory, and the "no
    // blacklisted name anywhere" guard below refuses it. The exclusion is
    // derived from the blacklist here too, never a hand-written skip list.
    const blacklisted = new Set(CATALOG_BLACKLIST.map((entry) => entry.name));
    const offered = Object.entries(CATALOG_CEILINGS).filter(([name]) => !blacklisted.has(name));
    expect(offered.length, "there should still be ceilings to inject").toBeGreaterThan(0);

    for (const [name, { maxKg, unit }] of offered) {
      expect(p).toContain(name);
      expect(p).toContain(`${maxKg} kg ${unit === "per_hand" ? "par main" : "au total"}`);
    }
    for (const [name] of Object.entries(CATALOG_CEILINGS).filter(([name]) => blacklisted.has(name))) {
      expect(p, `${name} is blacklisted and must not be given a ceiling in the prompt`).not.toContain(name);
    }
  });

  it("injects the achievable dumbbell and dual-bar per-hand load sets, sourced from the constants", () => {
    for (const kg of DUMBBELL_OPTIONS_KG) {
      expect(p).toContain(String(kg).replace(".", ","));
    }
    for (const kg of ACHIEVABLE_LOADS_PER_IMPLEMENT.dual_bar_symmetric) {
      expect(p).toContain(String(kg));
    }
    for (const kg of PER_HAND_LOAD_UNION_KG) {
      expect(p).toContain(String(kg).replace(".", ","));
    }
  });

  it("makes the widest dual-bar per-hand gap explicit", () => {
    const loads = ACHIEVABLE_LOADS_PER_IMPLEMENT.dual_bar_symmetric;
    let widest = null;
    for (let i = 1; i < loads.length; i++) {
      const size = loads[i] - loads[i - 1];
      if (size > 1 && (!widest || size > widest.size)) widest = { from: loads[i - 1], to: loads[i], size };
    }
    expect(widest, "the test inventory should leave a gap between its bar loads").not.toBeNull();
    expect(p).toContain(`aucune valeur entre ${widest.from + 1} et ${widest.to - 1} kg/main`);
  });

  it("states which loads only exist on the bar, never as a dumbbell", () => {
    // Derived from the constants (not retyped): the bar-only per-hand values
    // inside the dumbbell's own range, i.e. present on the bar but absent
    // from the dumbbell set: the counter-intuitive "phantom-adjacent" values from
    // constraints.md.
    const dumbbellMax = Math.max(...DUMBBELL_OPTIONS_KG);
    const barOnlyInDumbbellRange = ACHIEVABLE_LOADS_PER_IMPLEMENT.dual_bar_symmetric.filter(
      (v) => v > Math.min(...ACHIEVABLE_LOADS_PER_IMPLEMENT.dual_bar_symmetric) && v <= dumbbellMax && !DUMBBELL_OPTIONS_KG.includes(v)
    );
    expect(barOnlyInDumbbellRange.length, "the test inventory should have bar-only loads").toBeGreaterThan(0);
    expect(barOnlyInDumbbellRange).toContain(5);
    expect(barOnlyInDumbbellRange).toContain(11);
    const expectedList = barOnlyInDumbbellRange.map((v) => String(v).replace(".", ",")).join(", ");
    expect(p).toContain(`Sur les barres seulement, jamais en haltère : ${expectedList} kg/main.`);
  });

  it("states that a hand-held exercise takes either implement, and gives the union as the usable per-hand list", () => {
    // The belt for the fix of 2026-07-26: the prompt used to present the
    // dumbbell list and the bar list as separate, implement-bound options, so
    // the coach had no way to know that 11 kg/main is a legal Squat load.
    expect(p).toMatch(/n'est PAS une propriété de l'exercice/);
    expect(p).toContain(`l'union des deux : ${PER_HAND_LOAD_UNION_KG.map((v) => String(v).replace(".", ",")).join(", ")} kg`);
  });

  it("names exactly the exercises that are exceptions to the union rule, derived from the catalog", () => {
    const exceptions = p.split("\n").find((line) => line.trim().startsWith("- Exceptions à la règle"));
    expect(exceptions).toBeDefined();
    // Non-vacuous: there really are exceptions to state.
    expect(DUMBBELL_ONLY_EXERCISES.length).toBeGreaterThan(0);
    expect(ANKLE_WEIGHT_EXERCISES.length).toBeGreaterThan(0);

    // One exact set comparison, prefix-safe: it fails both when an exception
    // goes missing (the dumbbell-only clause used to be deletable in silence)
    // and when an exercise that follows the general rule is wrongly listed.
    expect(namesMentioned(exceptions)).toEqual(
      [...DUMBBELL_ONLY_EXERCISES, ...ANKLE_WEIGHT_EXERCISES].sort()
    );
    expect(exceptions).toContain(`${String(ANKLE_WEIGHT_KG).replace(".", ",")} kg`);
  });

  it("states the preference for dumbbells when varying load within a session", () => {
    expect(p).toMatch(/privilégie les haltères/i);
  });

  it("no longer contains the superseded hand-written equipment sentence", () => {
    expect(p).not.toContain("Poids réalistes : haltères fixes");
  });

  it("states the warmup rule positively: home warmup is mobility + bodyweight activation only", () => {
    expect(p).toMatch(/mobilité articulaire/i);
    expect(p).toMatch(/activation au poids du corps/i);
  });

  it("gives concrete warmup examples that are mobility/bodyweight, never a cardio or loaded exercise", () => {
    expect(p).toContain("Rotations d'épaules — 2×10");
    expect(p).toContain("Squat au poids du corps — 2×10");
    expect(p).toContain("Fentes dynamiques — 8/jambe");
  });

  // Belt for the name check in `checkWarmupCooldownContentRule`: on 2026-09-28
  // the coach split the example « Squat au poids du corps — 2×10 » into name
  // « Squat » + detail « 2×10 au poids du corps », seven rejections in a row.
  it("states that a warmup item's NAME is what is checked, not its detail", () => {
    expect(p).toMatch(/Le NOM d'un mouvement d'échauffement ou de retour au calme est contrôlé contre le catalogue, le détail ne l'est pas/);
    expect(p).toContain("« Squat au poids du corps », jamais « Squat » seul");
  });

  // Belt for the `reps` readability check in `validatePlan`.
  it("states that reps is always one bare number, never empty, a field name or JSON", () => {
    expect(p).toMatch(/porte toujours UN nombre nu[^\n]*jamais vide, jamais un nom de champ, jamais du JSON/);
  });

  it("REGRESSION GUARD: no ÉCHAUFFEMENT section contains a cardio machine name — the root cause of months of failures (constraints.md)", () => {
    const warmupSections = extractWarmupSections(p);
    expect(warmupSections.length).toBeGreaterThan(0);
    for (const section of warmupSections) {
      for (const cardioName of CARDIO_EXERCISE_NAMES) {
        expect(section).not.toContain(cardioName);
      }
    }
  });

  it("the cardio format example is unmistakably scoped to a dedicated gym session, never a warmup", () => {
    const cardioBullet = p.split("\n").find((line) => line.trim().startsWith("- Cardio :"));
    expect(cardioBullet).toBeDefined();
    expect(cardioBullet).toMatch(/séance dédiée à la salle/i);
    expect(cardioBullet).toMatch(/jamais en échauffement/i);
  });

  it("no blacklisted exercise name is used as a prescribed example anywhere in the prompt", () => {
    for (const { name } of CATALOG_BLACKLIST) {
      expect(p).not.toContain(name);
    }
  });

  it("TONE GUARD: the coach is direct — no pet names, no stage metaphors", () => {
    // History matters here. An earlier version of the coach had a stage
    // persona and this guard used to assert the OPPOSITE: that chérie/darling
    // and the revue framing survived. The user then used the coach for real and
    // asked for a more direct register (2026-08-01), which reverses that call. The guard is kept rather than
    // deleted because the tone has now been deliberately decided twice — a
    // later edit should have to argue with a failing test, in either direction.
    expect(p).not.toMatch(/meneuse de revue/i);
    expect(p).not.toMatch(/paillettes/i);
    // Named only inside the instruction NOT to use them.
    expect(p).toMatch(/Pas de surnoms/i);
    expect(p).toMatch(/Direct et chaleureux/i);
    // \s+ because the prompt is a wrapped template literal — the phrase is
    // split across a newline, which a literal space would not match.
    expect(p).toMatch(/pas de\s+métaphores de scène/i);
  });

  it("requires a stated mechanical reason whenever a load drops, not a vague reassurance", () => {
    expect(p).toMatch(/raison mécanique/i);
    expect(p).toMatch(/prise qui lâche|fatigue accumulée|technique qui se dégrade|semaine de décharge/i);
    expect(p).toContain("on descend à 15 kg pour que la préhension ne soit plus le facteur limitant");
  });

  it("gives a load-drop example that states a real reason and does not violate any load/blacklist rule", () => {
    // Examples outweigh rules (constraints.md) — audit this one exactly like Task 8 did.
    expect(p).toContain("Soulevé de terre roumain, 4×8 à 15 kg par main");
    expect(p).toContain("on descend à 15 kg pour que la préhension ne soit plus le facteur limitant");
    // Not blacklisted.
    for (const { name } of CATALOG_BLACKLIST) {
      expect(name).not.toBe("Soulevé de terre roumain");
    }
    // Achievable per-hand load, and strictly below (not at or above) the exercise's own ceiling.
    expect(PER_HAND_LOAD_UNION_KG).toContain(15);
    const ceiling = CATALOG_CEILINGS["Soulevé de terre roumain"];
    expect(ceiling.unit).toBe("per_hand");
    expect(15).toBeLessThan(ceiling.maxKg);
  });

  it("requires abbreviations to be spelled out on first use", () => {
    expect(p).toMatch(/première fois qu'un sigle apparaît/i);
    expect(p).toMatch(/en toutes lettres/i);
    expect(p).toMatch(/RDL/);
    expect(p).toMatch(/RPE/);
    expect(p).toMatch(/AMRAP/);
  });

  // --- The belt catching up with the suspenders: every rule below is one the
  // validators in `src/lib/planValidation.js` ALREADY enforce. Before this, the
  // coach was hard-blocked by rules its own prompt never stated.

  it("states the exercise count per force session, with the number the validator actually uses", () => {
    expect(p).toContain(`${USUAL_EXERCISES_PER_FORCE_SESSION} exercices par séance de force`);
    expect(p).toMatch(/raison identifiable/i);
  });

  // Regression: 43c4898 — 2026-10-06, six « Plan » presses in 70 minutes. The
  // validator only WARNS above USUAL_EXERCISES_PER_FORCE_SESSION
  // (checkExerciseCountRule), but this line said « Maximum … le plafond », so the
  // model refused the user's explicit six-exercise push three emits running, moved the
  // core into the optional Sunday session each time and told her « la limite de
  // l'app est de 4 ». Owner ruling: the count is not a hard rule and the prompt
  // must not present it as a block. The belt must never be STRICTER than the
  // suspenders either.
  // Round 5 of the same review: the ruling reached only the plan-emit prompt,
  // while her history held three assistant turns saying « la limite de l'app
  // est de 4 » — so in discussion mode the model had the precedent and no
  // counter-instruction, and would repeat the false limit in chat.
  it("tells every mode, not just plan-emit, that the count is not a ceiling", () => {
    for (const mode of ["discussion", "plan", "plan-emit"]) {
      const prompt = buildSystemPrompt(GROUPS, EQUIPMENT, [], STRUCTURE, COACHING, mode);
      expect(prompt, mode).toMatch(/PAS un plafond/);
      expect(prompt, mode).toMatch(/ne bloque pas une séance plus longue/);
      expect(prompt, mode).toMatch(/Ne lui dis jamais que l'app limite une séance/);
      expect(prompt, mode).toMatch(/c'était faux/);
      // Round 8: the REASSURANCE is for every mode; the ORDER to write the
      // exercises out is for plan-emit only — discussion and « Mon programme »
      // are told never to write the plan, and an order to write exercises there
      // is an invitation to the prose programme providers.js records as a known
      // failure.
      if (mode === "plan-emit") expect(prompt).toMatch(/écris-les tous/);
      else expect(prompt, mode).not.toMatch(/écris-les/);
    }
  });

  it("presents the exercise count as a warning, never as a block, and names her request as a sufficient reason", () => {
    const line = p.split("\n").find((l) => l.includes(`${USUAL_EXERCISES_PER_FORCE_SESSION} exercices par séance de force`));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/\bmaximum\b/i);
    expect(line).toMatch(/PAS un plafond/);
    expect(line).toMatch(/ne bloque pas/i);
    expect(line).toMatch(/avertissement/i);
    expect(line).toMatch(/demande explicite de Camille/i);
    expect(line).toMatch(/Ne lui dis jamais que l'app limite/i);
  });

  it("states the exercise cap as the normal shape of a full session, not just an undershoot-able ceiling", () => {
    // Follow-up (2026-07-26): a bare maximum with no target pulled the model
    // toward the low end. The cap line must now say it is also the norm.
    expect(p).toMatch(/forme normale d'une séance complète/i);
    expect(p).toMatch(/pas une cible à minimiser/i);
  });

  it("states the 45-60 minute duration target for a mandatory force session, warmup and cooldown included", () => {
    expect(p).toMatch(/Durée cible d'une séance de force obligatoire\s*:\s*45 à 60 minutes/i);
    expect(p).toMatch(/échauffement et retour au calme inclus/i);
  });

  it("requires a stated efficiency reason for a materially shorter session, phrased like the load-drop rule (not a hard floor)", () => {
    // Same voice as the existing "explique toujours la vraie raison mécanique"
    // load-drop rule (constraints.md: examples/rules must stay consistent), and
    // explicitly NOT a validator-enforced minimum — a short session stays legal.
    expect(p).toMatch(/ne l'explique JAMAIS par une formule vague/i);
    expect(p).toMatch(/donne toujours la vraie raison qui en fait le meilleur choix/i);
  });

  it("mentions the optional ~30 min session and scopes it out of the new duration target", () => {
    expect(p).toMatch(/3 séances de force obligatoires/i);
    expect(p).toMatch(/séance optionnelle supplémentaire plafonnée à ~30 min/i);
    expect(p).toMatch(/n'est PAS concernée par la cible de durée/i);
  });

  it("states as a general rule that core work never goes on a lower-body day", () => {
    // The group names come from the catalog itself, so renaming a muscle group
    // key can never leave the prompt pointing at a group that no longer exists.
    expect(Object.keys(CATALOG_GROUPS)).toContain(STRUCTURE.coreGroup);
    expect(Object.keys(CATALOG_GROUPS)).toContain(STRUCTURE.lowerBodyGroup);
    const coreRules = p
      .split("\n")
      .filter(
        (line) =>
          /jour bas du corps/i.test(line) &&
          line.includes(STRUCTURE.coreGroup) &&
          line.includes(STRUCTURE.lowerBodyGroup)
      );
    expect(coreRules).toHaveLength(1);
    expect(coreRules[0]).toMatch(/bloque l'import/i);
  });

  it("states the RETOUR AU CALME restrictions, mirroring the ÉCHAUFFEMENT rule", () => {
    const cooldownRule = p.split("\n").find((line) => /^-\s*RETOUR AU CALME/.test(line.trim()));
    expect(cooldownRule).toBeDefined();
    expect(cooldownRule).toMatch(/étirements/i);
    expect(cooldownRule).toMatch(/respiration/i);
    expect(cooldownRule).toMatch(/JAMAIS de cardio, de machine ou de charge externe/);
  });

  it("gives cooldown examples that are stretching/breathing, never a cardio or loaded exercise", () => {
    expect(p).toContain("Étirement des pectoraux — 30s par côté");
    expect(p).toContain("Respiration diaphragmatique — 2min");
  });

  it("REGRESSION GUARD: no RETOUR AU CALME section contains a cardio machine name — the cooldown is content-checked exactly like the warmup", () => {
    const cooldownSections = extractCooldownSections(p);
    expect(cooldownSections.length).toBeGreaterThan(0);
    for (const section of cooldownSections) {
      for (const cardioName of CARDIO_EXERCISE_NAMES) {
        expect(section).not.toContain(cardioName);
      }
    }
  });

  it("states the one-plated-bar-configuration-per-session rule, keeping the rationale", () => {
    expect(p).toMatch(/une seule configuration de barre chargée par séance/i);
    expect(p).toMatch(/replaquer une barre en cours de séance coûte du temps/i);
    expect(p).toMatch(/privilégie les haltères/i); // the existing rationale, kept
  });

  it("states that a name outside the catalog blocks the whole import", () => {
    const nameRule = p.split("\n").find((line) => /EXACTEMENT les noms d'exercices/.test(line));
    expect(nameRule).toBeDefined();
    expect(nameRule).toMatch(/bloque l'import/i);
    expect(nameRule).toMatch(/programme entier/i);
  });

  it("names the variety-vs-stability tradeoff explicitly and requires it to be arbitrated, not assumed resolved", () => {
    expect(p).toMatch(/l'intérêt demande des exercices qui changent/i);
    // A taste of one user belongs in that user's coach notes, not in the shared prompt.
    expect(p).not.toMatch(/déteste/i);
    expect(p).toMatch(/base stable/i);
    expect(p).toMatch(/tirent dans des directions opposées/i);
    expect(p).toMatch(/ne prétends jamais qu'ils se résolvent tout seuls/i);
    expect(p).toMatch(/ce que tu gardes stable.*ce que tu fais varier/i);
  });
});

// Whole-branch review Finding A: `docs/claude-project/instructions.md:72`
// states the pull-up bar is rigged at ONE height per session and a plan must
// never mix a high-bar exercise with a low-bar one, but nothing in the built
// prompt said so — a session mixing "Traction pronation" (haute) and
// "Traction australienne" (basse) imported with zero errors and zero
// warnings. This is the belt only; enforcement is deferred to a later slice.
describe("buildSystemPrompt — bar height mixing rule (Finding A)", () => {
  const p = buildSystemPrompt(CATALOG_GROUPS, EQUIPMENT, CATALOG_BLACKLIST, STRUCTURE, COACHING);

  // Derived from the real catalog, never hand-listed — same discipline as
  // DUMBBELL_ONLY_EXERCISES/ANKLE_WEIGHT_EXERCISES above.
  const HAUTE = CATALOG_ALL.filter((name) => CATALOG_DESCRIPTIONS[name]?.barHeight === "haute");
  const BASSE = CATALOG_ALL.filter((name) => CATALOG_DESCRIPTIONS[name]?.barHeight === "basse");

  it("sanity check on the fixture: both bar heights are actually used in the real catalog", () => {
    expect(HAUTE.length).toBeGreaterThan(0);
    expect(BASSE.length).toBeGreaterThan(0);
  });

  it("names every high-bar and every low-bar exercise in the bar-height rule", () => {
    for (const name of [...HAUTE, ...BASSE]) {
      expect(p, `${name} should be named in the bar-height rule`).toContain(name);
    }
  });

  it("states the prohibition on mixing a high-bar and a low-bar exercise in one session", () => {
    expect(p).toMatch(/barre haute/i);
    expect(p).toMatch(/barre basse/i);
    // Not just present anywhere in the prompt — actually the mixing rule.
    expect(p).toMatch(/jamais.{0,60}(barre haute|barre basse).{0,60}(barre haute|barre basse)/is);
  });

  // A prohibition with no exit, in front of a goal that walks straight into it.
  // Measured 2026-08-16: three of the thirteen errors that rejected five
  // consecutive plans were this rule, every time pairing `Dead hang` with
  // `Traction australienne` — because the user's new stated objective is pull-ups
  // and the catalog holds five `haute` exercises against a single `basse`, so
  // any session that trains both a hang and a row is a hard block. The rule was
  // stated and the model still had to guess what a legal week looks like.
  it("says how to satisfy the rule, not only that it exists", () => {
    expect(p).toMatch(/regroupe/i);
    expect(p).toMatch(/séances différentes/);
    // And says it in the same breath as the prohibition, not somewhere else in
    // a 29k-character prompt where it reads as unrelated advice.
    const rule = p.match(/- Barre de traction : réglée[^\n]*/)?.[0] ?? "";
    expect(rule).toMatch(/regroupe/i);
  });

  it("has both bar heights in the fixture, so the grouping advice is not vacuous", () => {
    expect(HAUTE.length).toBeGreaterThan(1);
    expect(BASSE.length).toBeGreaterThan(0);
  });
});

describe("buildSystemPrompt — T3.4b: blacklisted exercises must not appear in the model-facing catalog", () => {
  // Rendered from the REAL catalog (not the tiny GROUPS fixture above, which never
  // contained a blacklisted name to begin with and could never have caught this).
  const pFull = buildSystemPrompt(CATALOG_GROUPS, EQUIPMENT, CATALOG_BLACKLIST, STRUCTURE, COACHING);

  it("three of the four blacklisted names ARE in the real catalog (sanity check on the fixture)", () => {
    // If this ever goes false, the test below would pass vacuously again.
    for (const { name } of CATALOG_BLACKLIST) {
      if (name === "Hip thrust") continue; // a forbiddenNames entry, never an exercise
      expect(CATALOG_ALL, `${name} should still be in the exercise list`).toContain(name);
    }
  });

  it("no blacklisted name appears in the '## Exercices disponibles dans l'app' catalog section", () => {
    const catalogSection = pFull.split("## Exercices disponibles dans l'app")[1].split("## Charges réalisables")[0];
    for (const { name } of CATALOG_BLACKLIST) {
      expect(catalogSection, `${name} must be filtered out of the model-facing catalog`).not.toContain(name);
    }
  });

  it("sanity check on the fixture: the real catalog does contain home-infeasible exercises", () => {
    // If this ever goes false (she buys a bench and an upper-body elastic), the
    // filter test below becomes vacuous rather than wrong — and that is fine,
    // because there would be nothing left to filter. This assertion is what
    // makes the difference visible instead of silent.
    expect(HOME_INFEASIBLE_EXERCISE_NAMES.length).toBeGreaterThan(0);
  });

  it("no home-infeasible exercise appears in the model-facing catalog, derived from the catalog's own equipment descriptors", () => {
    const catalogSection = pFull.split("## Exercices disponibles dans l'app")[1].split("## Charges réalisables")[0];
    const listing = catalogSection.split("Ces exercices existent dans l'app")[0];
    for (const name of HOME_INFEASIBLE_EXERCISE_NAMES) {
      expect(listing, `${name} needs equipment she does not own and must be filtered out`).not.toContain(name);
    }
  });

  it("explains, in French, that the filtered exercises exist in the app but need missing equipment", () => {
    for (const name of HOME_INFEASIBLE_EXERCISE_NAMES) {
      expect(pFull, `${name} should be named in the unavailable-equipment note`).toContain(name);
    }
    expect(pFull).toMatch(/matériel que Camille n'a pas/i);
  });

  it("marks the Cardio group as gym-only in the catalog listing itself, not only in the format rules", () => {
    const catalogSection = pFull.split("## Exercices disponibles dans l'app")[1].split("## Charges réalisables")[0];
    // Derived: the group whose every exercise is allowed at the gym is the one
    // that must carry the marker — never hardcoded as "Cardio" here.
    const gymOnlyGroups = Object.entries(CATALOG_GROUPS)
      .filter(([, names]) => names.every((name) => locationsOf(name).includes("salle")))
      .map(([group]) => group);
    expect(gymOnlyGroups.length).toBeGreaterThan(0);
    for (const group of gymOnlyGroups) {
      const heading = catalogSection.split("\n").find((line) => line.startsWith(`### ${group}`));
      expect(heading, `${group} heading should be marked as dedicated-session only`).toBeDefined();
      expect(heading).toMatch(/toujours une séance dédiée/i);
      expect(heading).toMatch(/jamais dans une séance de force/i);
      // Accurate, not overclaiming: `Course` is outdoor running and derives to
      // both locations, so the label must not say "à la salle" exclusively.
      expect(heading).not.toMatch(/uniquement en séance dédiée à la salle/i);
    }
    // ...and no other group carries the marker.
    for (const [group] of Object.entries(CATALOG_GROUPS).filter(([g]) => !gymOnlyGroups.includes(g))) {
      const heading = catalogSection.split("\n").find((line) => line.startsWith(`### ${group}`));
      expect(heading, `${group} heading`).toBe(`### ${group}`);
    }
  });

  it("names each blacklisted exercise with its French reason and replacement, so the coach knows why not to reach for it", () => {
    for (const { name, reason, replacedBy } of CATALOG_BLACKLIST) {
      expect(pFull, `${name} should be named in the blacklist prompt section`).toContain(name);
      expect(pFull, `${name}'s reason should appear in the prompt`).toContain(reason);
      if (replacedBy) {
        expect(pFull, `${name}'s replacement should appear in the prompt`).toContain(replacedBy);
      }
    }
  });
});

describe("buildMessages", () => {
  const build = (over = {}) => buildMessages({
    systemPrompt: "SYS",
    notebook: "NB",
    exportContext: "EXP",
    // The normal transcript shape: her turn, then the coach's reply.
    history: [{ role: "user", content: "U0" }, { role: "assistant", content: "A" }],
    userMessage: "U1",
    ...over,
  });

  it("assembles system + history + one final user turn carrying the volatile context", () => {
    const msgs = build();
    expect(msgs[0]).toEqual({ role: "system", content: "SYS" });
    expect(msgs[1]).toEqual({ role: "user", content: "U0" });
    expect(msgs[2]).toEqual({ role: "assistant", content: "A" });
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toContain("NB");
    expect(last.content).toContain("EXP");
    expect(last.content).toContain("U1");
  });

  // THE POSITION IS THE FIX. These rules sat in the system prompt and did
  // nothing measurable — median conversational completion_tokens 769 -> 1143
  // across the deploy that added them, on rung 1 throughout. The one
  // instruction that has ever produced a short reply is the one the user types
  // herself, in the last user turn. So the reminder rides in the volatile
  // block, and the ORDER is the assertion: after the data, before her words.
  it("puts the shape reminder after the data and before her message", () => {
    const last = build({ mode: "discussion" }).at(-1).content;
    expect(last).toContain("PAS UNE FICHE");
    expect(last.indexOf("EXP")).toBeLessThan(last.indexOf("PAS UNE FICHE"));
    expect(last.indexOf("PAS UNE FICHE")).toBeLessThan(last.indexOf("U1"));
  });

  // Her words stay LAST and unwrapped, which is deliberate and predates this:
  // putting anything after the question reads as a form to fill in.
  it("still ends on her message, with the reminder in front of it", () => {
    const last = build({ mode: "discussion" }).at(-1).content;
    expect(last.trimEnd().endsWith("U1")).toBe(true);
  });

  it("sends no shape reminder on the emit path", () => {
    const last = build({ mode: "plan-emit" }).at(-1).content;
    expect(last).not.toContain("PAS UNE FICHE");
    expect(last).toContain("U1");
  });

  // An unknown or absent mode is answered in discussion mode by
  // buildSystemPrompt, so it must be SHAPED that way too — the two decisions
  // have to agree or a request gets discussion capability with no shape rule.
  it.each([undefined, "brief", null])("treats mode %s as discussion", (mode) => {
    expect(build({ mode }).at(-1).content).toContain("PAS UNE FICHE");
  });

  // The whole point of the layout. A prefix cache of any kind stops at the first
  // byte that differs from the last request, so anything that changes between
  // requests must come AFTER everything that doesn't. The notebook and the
  // export both change; the system prompt never does. When they were folded into
  // the system message the ~4.2k-token prompt could never be reused at all.
  // (The specific 90%-discount mechanism this was written for was Gemini's
  // implicit cache; the layout outlives it — see buildMessages.)
  it("keeps the per-request context out of the cacheable prefix", () => {
    const msgs = build();
    for (const m of msgs.slice(0, -1)) {
      expect(m.content).not.toContain("NB");
      expect(m.content).not.toContain("EXP");
    }
  });

  // A byte-identical system prompt must produce a byte-identical first message,
  // or there is no prefix to match and the cache silently never hits.
  it("emits an identical system message across requests that differ elsewhere", () => {
    const a = build({ notebook: "one", exportContext: "x", userMessage: "q1" });
    const b = build({ notebook: "two", exportContext: "y", userMessage: "q2" });
    expect(a[0]).toEqual(b[0]);
  });

  // THIS IS A HARD VENDOR REQUIREMENT NOW, not a courtesy. Verified by live call
  // on 2026-08-03: Mistral rejects a message list ending on an `assistant` turn
  // with HTTP 400, "Expected last role User or Tool". Under Gemini the same
  // invariant was worth keeping only because its compatibility layer silently
  // merged whatever we sent — so the old wording here ("a vendor enforcing strict
  // alternation WOULD 400") described a hypothetical. It is now the difference
  // between the coach answering and the coach failing every single request.
  //
  // Both branches of buildMessages are reachable in production, which is why both
  // are exercised: coach-chat banks her message before consuming the stream, so a
  // reply that produced no visible text leaves the transcript ending on HER turn.
  it("always ends on a user turn, whatever the transcript ended on", () => {
    const histories = {
      // The 400 case, and the ordinary one — this is the default fixture.
      "ends on an assistant turn (the push branch)": [
        { role: "user", content: "U0" }, { role: "assistant", content: "A" },
      ],
      "ends on a user turn (an unanswered question)": [
        { role: "assistant", content: "A" }, { role: "user", content: "U0" },
      ],
      "empty history": [],
      // Real, not contrived: 2026-08-02 recorded 8 questions against 2 replies,
      // because six invocations were killed before their reply was banked. That
      // leaves runs of consecutive user turns in coach_messages. Mistral accepts
      // them (three in a row → 200, verified), so this must not crash and must
      // not start dropping her questions to tidy the list.
      "consecutive user turns": [
        { role: "user", content: "U0" },
        { role: "user", content: "U0b" },
        { role: "user", content: "U0c" },
      ],
    };
    for (const [label, history] of Object.entries(histories)) {
      const msgs = build({ history });
      expect(msgs[msgs.length - 1].role, label).toBe("user");
      // Whichever branch ran, nothing is lost and her message still lands last.
      const joined = msgs.map((m) => m.content).join("\n");
      expect(joined, label).toContain("EXP");
      expect(msgs[msgs.length - 1].content, label).toContain("U1");
      for (const turn of history) expect(joined, label).toContain(turn.content);
    }
  });

  // This test used to assert that buildMessages never introduces a consecutive
  // same-role pair. It does now, on purpose: when the transcript ends on an
  // unanswered question, appending her new question produces two user turns in a
  // row. That is strictly better than the merge it replaced (see the regression
  // below), and Mistral accepts it. The property worth pinning is the stronger
  // one, which the merge branch never satisfied.
  it("passes every history turn through untouched and appends exactly one turn", () => {
    for (const history of [
      [{ role: "user", content: "U0" }, { role: "assistant", content: "A" }],
      [{ role: "assistant", content: "A" }, { role: "user", content: "U0" }],
      [{ role: "user", content: "U0" }, { role: "user", content: "U0b" }],
      [],
    ]) {
      const msgs = build({ history });
      expect(msgs).toHaveLength(history.length + 2); // system + history + her turn
      history.forEach((turn, i) => expect(msgs[i + 1]).toEqual(turn));
      expect(msgs[msgs.length - 1].role).toBe("user");
    }
  });

  it("omits the notebook header when the notebook is empty", () => {
    const msgs = build({ notebook: "", history: [] });
    expect(msgs.map((m) => m.content).join("\n")).not.toMatch(/carnet/i);
  });

  it("puts her message last, after the data, so the reply answers her and not the export", () => {
    const msgs = build();
    const last = msgs[msgs.length - 1].content;
    expect(last.indexOf("U1")).toBeGreaterThan(last.indexOf("EXP"));
  });

  // The export only carries `Période : 29/07 → 05/08`, so today is the right edge
  // of a range and has to be inferred. The coach needs it plainly: to read the
  // date stamps on her turns as recent or stale, and to write the `Semaine :`
  // line of a programme.
  it("states today's date plainly in the volatile block", () => {
    const msgs = build({ now: new Date("2026-08-05T09:00:00Z") });
    const last = msgs[msgs.length - 1].content;
    expect(last).toContain("Aujourd'hui");
    expect(last).toMatch(/mercredi 5 ao[ûu]t 2026/);
  });

  // Regression: (pending) — the user 2026-08-05, "he keeps answering past questions".
  // When the transcript ended on an unanswered question, buildMessages merged the
  // volatile block (which ends with her NEW message) into that OLD user turn. The
  // model then received a single message containing two questions and answered
  // both. Orphan user turns are not hypothetical: 2026-08-02 recorded 8 questions
  // against 2 replies.
  it("never folds the volatile block into a historical user turn", () => {
    const history = [{ role: "assistant", content: "A" }, { role: "user", content: "U0" }];
    const msgs = build({ history });

    expect(msgs).toHaveLength(4);
    // Her earlier question is passed through untouched — not extended, not merged.
    expect(msgs[2]).toEqual({ role: "user", content: "U0" });
    // Her new question is its own turn, and carries the volatile block.
    expect(msgs[3].role).toBe("user");
    expect(msgs[3].content).toContain("U1");
    expect(msgs[3].content).toContain("EXP");
    expect(msgs[3].content).not.toContain("U0");
  });

  // Pure in the sense that matters: the caller's rows come straight from Neon and
  // are read again by the annotation layer. Mutating them in place is how a
  // "harmless" formatting change becomes a persisted one.
  it("does not mutate the history array it was given", () => {
    const history = [{ role: "assistant", content: "A" }, { role: "user", content: "U0" }];
    const snapshot = JSON.parse(JSON.stringify(history));
    build({ history });
    expect(history).toEqual(snapshot);
  });
});

// The user's standing complaint was that the coach never explained anything — it
// prescribed. The cause was in this prompt, not in the model: it said "reste
// concise, pas de tartines", put nutrition explicitly out of scope, and listed a
// role made only of programming mechanics. A stronger model obeyed all three
// more faithfully, which is why upgrading never helped. These pin the fix,
// because a future "let's tighten the prompt" pass would silently undo it and
// nothing else in the suite would notice.
describe("buildSystemPrompt — the coach explains, it does not just prescribe", () => {
  const p = buildSystemPrompt(CATALOG_GROUPS, EQUIPMENT, CATALOG_BLACKLIST, STRUCTURE, COACHING);

  it("makes giving meaning part of the role, anchored on the goals it actually receives", () => {
    expect(p).toMatch(/Donner du sens/);
    // generateExport emits "Objectifs" / "Priorités" lines; the prompt has to
    // point at those exact labels or it is telling the coach to use data it
    // cannot find.
    expect(p).toMatch(/Objectifs/);
    expect(p).toMatch(/Priorités/);
  });

  it("asks for what it trains, what she should feel, and how she will know it worked", () => {
    expect(p).toMatch(/ce que ça travaille/);
    expect(p).toMatch(/sentir/);
    expect(p).toMatch(/deux ou trois\s+semaines/);
  });

  it("scopes concision to the instruction and never to the explanation", () => {
    // The exact wording that caused the problem. Its return in any form is the
    // regression this test exists to catch.
    expect(p).not.toMatch(/pas de tartines/);
    expect(p).toMatch(/CONSIGNE/);
    expect(p).toMatch(/EXPLICATION/);
  });

  it("puts recovery, sleep and food in scope rather than out of it", () => {
    expect(p).not.toMatch(/PAS de conseils nutritionnels/);
    expect(p).toMatch(/sommeil/i);
    expect(p).toMatch(/alimentation/i);
  });

  // Widening the scope is only safe because the hard edge is stated with it.
  // If a later edit keeps the opening and drops this, the coach starts writing
  // calorie targets for a user whose health data is the reason this whole app
  // is private.
  it("keeps the hard edge on prescriptive nutrition and on medical advice", () => {
    expect(p).toMatch(/objectif calorique/);
    expect(p).toMatch(/macronutriments/);
    expect(p).toMatch(/perte de poids/);
    expect(p).toMatch(/diététicienne/);
    expect(p).toMatch(/PAS de conseils médicaux/);
  });
});

// Regression: user feedback 2026-08-02, first programme conversation. Asking the
// coach to explain the plan made it rewrite the plan; two answers apart it said
// core-before-cardio was a bad idea and then an excellent one; and it kept
// re-explaining what it had already said. Three of the four causes are prompt
// causes — the fourth (a reply lost before it was persisted, so the coach never
// saw its own answer) is fixed in coach-chat.js.
describe("buildSystemPrompt — the coach holds a position and explains without rewriting", () => {
  const p = buildSystemPrompt(CATALOG_GROUPS, EQUIPMENT, CATALOG_BLACKLIST, STRUCTURE, COACHING);

  it("separates explaining from modifying, and forbids a revised plan inside an explanation", () => {
    const rule = ruleBlock(p, "EXPLIQUER N'EST PAS MODIFIER");
    expect(rule).toBeTruthy();
    // It named the FITTRACK block until 2026-08-10. The block is gone, so the
    // rule now names the thing rather than the syntax — and it has to, since the
    // rule is pinned in the two modes that must never mention that syntax.
    expect(rule).toMatch(/pas de nouvelle version tant qu'elle n'en redemande pas une/);
    expect(rule).toMatch(/réponds? à la question/i);
  });

  it("requires a change to be announced before it is delivered, never slipped in", () => {
    const rule = ruleBlock(p, "EXPLIQUER N'EST PAS MODIFIER");
    expect(rule).toMatch(/annonce/i);
    expect(rule).toMatch(/je change/i);
  });

  // The sycophancy case, and the one that needs no memory at all to happen: the
  // same question asked in two directions gets two opposite answers.
  it("tells the coach that a question is not an objection, and that agreeing to please is a failure", () => {
    const rule = ruleBlock(p, "UNE QUESTION N'EST PAS UNE OBJECTION");
    expect(rule).toBeTruthy();
    expect(rule).toMatch(/raison technique nouvelle/i);
    expect(rule).toMatch(/moins bon/i);
  });

  it("forbids a silent reversal and dictates the shape of an announced one", () => {
    const rule = ruleBlock(p, "NE TE CONTREDIS PAS EN SILENCE");
    expect(rule).toBeTruthy();
    expect(rule).toMatch(/cite/i);
    expect(rule).toMatch(/je me corrige/i);
  });

  it("asks the coach to refer back rather than re-explain", () => {
    const rule = ruleBlock(p, "NE RÉPÈTE PAS");
    expect(rule).toBeTruthy();
    expect(rule).toMatch(/déjà expliqué/i);
  });

  // The notebook is the only memory that outlives HISTORY_WINDOW. Preferences
  // alone are not enough: a decision whose reason was forgotten is a decision
  // that gets taken backwards next week.
  it("puts standing decisions AND their reason in the notebook, not just preferences", () => {
    const notebook = p.split("## Ton carnet privé")[1];
    expect(notebook).toMatch(/DÉCISIONS EN COURS/);
    expect(notebook).toMatch(/raison/i);
    expect(notebook).toMatch(/seule mémoire qui survit/i);
  });

  /**
   * The belt for the wholesale-overwrite defect. `applyNotebookOps` is the
   * suspenders and is what actually holds — a model ignoring this section can no
   * longer destroy anything — but a model that keeps re-emitting the whole
   * notebook spends output tokens on it every turn and drowns the real change.
   *
   * Measured 2026-08-30: the stored notebook was three lines, all dated that day,
   * every request answered by rung 2. Under the wholesale write, "forgot to
   * repeat a line" and "chose to remove a line" were the same bytes.
   */
  it("asks for OPERATIONS on the notebook, never a rewrite of it", () => {
    const notebook = p.split("## Ton carnet privé")[1];
    expect(notebook).toMatch(/TU NE RÉÉCRIS PAS LE CARNET, TU LE MODIFIES/);
    // The two operators, literally — the Objectifs/Priorités precedent: a rule
    // describing a syntax the model cannot see spelled out points at nothing.
    expect(notebook).toMatch(/\+ \(texte\)/);
    expect(notebook).toMatch(/- \(numéro\)/);
    // The half that saves the tokens AND is the whole safety argument: silence
    // preserves, so recopying a line to keep it is wasted work.
    expect(notebook).toMatch(/reste EXACTEMENT tel quel/);
    expect(notebook).toMatch(/ne recopie jamais une\s+ligne pour la conserver/i);
  });

  // The cap is INJECTED, never retyped as prose: the number the prompt announces
  // and the number `applyNotebookOps` warns on are one value.
  it("states the line cap it was given rather than a hardcoded one", () => {
    const notebook = buildSystemPrompt(
      CATALOG_GROUPS, EQUIPMENT, CATALOG_BLACKLIST,
      { ...STRUCTURE, notebookMaxLines: 33 }, COACHING, "discussion"
    ).split("## Ton carnet privé")[1];
    expect(notebook).toMatch(/33 lignes/);
  });

  // Both halves together, on the nutrition-rule precedent: the notebook is
  // rewritten wholesale every turn and re-injected verbatim on the next one, so
  // a line with no date and a line recording its own deletion are the two ways
  // a fact outlives its relevance. A line such as « Rendez-vous : effacé des
  // notes » is a tombstone re-read on every single request, and the user keeps
  // having to ask to drop the subject. Keeping the date rule and dropping the deletion rule is
  // the dangerous half: a correctly dated tombstone still comes back forever.
  it("dates every notebook fact and forbids recording a deletion", () => {
    const notebook = p.split("## Ton carnet privé")[1];
    expect(notebook).toMatch(/DATE ABSOLUE/);
    expect(notebook).toMatch(/jamais\s+«\s*hier\s*»/i);
    // Scoped to a dated EVENT, deliberately. The same section calls the
    // notebook « la seule mémoire qui survit » and says a decision whose reason
    // was forgotten is one the coach reverses next week — so an unbounded
    // "delete what no longer applies", against a ≤20-line file rewritten
    // wholesale each turn and an anti-tombstone rule that leaves no trace, is a
    // licence to destroy exactly the lines the notebook exists to hold.
    expect(notebook).toMatch(/ÉVÉNEMENT DATÉ/);
    expect(notebook).toMatch(/pas les décisions ni\s+leurs raisons/i);
    expect(notebook).toMatch(/n'écris JAMAIS qu'une note\s+a été retirée/i);
  });

  // Guard: these four rules pull against a prompt that also says "be concise"
  // and "propose a weekly programme". A future tightening pass must not quietly
  // drop them — that is exactly how the last explanation regression happened.
  it("states all four consistency rules, not a subset", () => {
    for (const marker of [
      "EXPLIQUER N'EST PAS MODIFIER",
      "UNE QUESTION N'EST PAS UNE OBJECTION",
      "NE TE CONTREDIS PAS EN SILENCE",
      "NE RÉPÈTE PAS",
    ]) {
      expect(p).toContain(marker);
    }
  });
});

// The coach can see the stored plan and the load streaks at once and nothing
// said which governed today: the plan said one number, the coach said another,
// and the user read the gap as incoherence because the app was showing her the
// other number. The plan wins; a deviation has to be named as one.
describe("buildSystemPrompt — the prescribed number governs today", () => {
  const focus = (mode) =>
    buildSystemPrompt(CATALOG_GROUPS, EQUIPMENT, CATALOG_BLACKLIST, STRUCTURE, COACHING, mode);

  for (const mode of ["discussion", "plan"]) {
    it(`states the precedence and names both data blocks (${mode})`, () => {
      const p = focus(mode);
      // Scoped to the bullet, not to the whole prompt: « SÉANCES PROPRES À LA
      // CHARGE ACTUELLE » already appears in the progression section, so a
      // whole-prompt `toContain` passes even with the phrase deleted from here
      // — measured. The rule has to name both blocks itself.
      const bullet = p.split("CE QUI EST PRESCRIT GOUVERNE AUJOURD'HUI")[1];
      expect(bullet).toBeTruthy();
      const rule = bullet.split("\n- ")[0];
      // The stable prefix every phase of the block carries, and the one title
      // that governs today; the other two are named as exceptions.
      expect(rule).toContain("« PROGRAMME DE LA SEMAINE »");
      expect(rule).toContain("PROGRAMME DE LA SEMAINE EN COURS");
      expect(rule).toContain("À VENIR");
      expect(rule).toContain("PRÉCÉDENTE");
      expect(rule).toContain("SÉANCES PROPRES À LA CHARGE ACTUELLE");
    });

    it(`requires a deviation to state BOTH numbers (${mode})`, () => {
      // The half that is easy to drop. "The plan governs" alone turns into a
      // coach that cannot lower a load on a bad day; "say both numbers" alone
      // leaves the app and the coach disagreeing with no stated winner. The
      // pair is the ruling.
      const p = focus(mode);
      expect(p).toMatch(/DIS LES DEUX ET DIS LEQUEL\s+EST LEQUEL/);
      expect(p).toMatch(/incohérence/i);
    });
  }

  it("says nothing of the sort in plan-emit, which is the mode that WRITES the plan", () => {
    // Streaks and history are exactly what should drive the next week, so a
    // rule subordinating them to the current plan would be backwards here.
    expect(focus("plan-emit")).not.toContain("CE QUI EST PRESCRIT GOUVERNE AUJOURD'HUI");
  });

  it("names blocks generateExport actually emits", () => {
    // The Objectifs/Priorités precedent: a rule pointing at a heading the model
    // cannot find in its data is a rule about nothing. Cross-module on purpose
    // — coachPrompt.js may not import from src/, but a test may.
    // Sessions carrying a load, or `SÉANCES PROPRES À LA CHARGE ACTUELLE` is
    // simply absent — the block is conditional on there being a streak to show.
    const sessions = [1, 2].map((n) => ({
      id: `s${n}`,
      date: `2026-08-1${n}`,
      name: "Bas du corps",
      exercises: [
        { name: "Squat", status: "complete", weightType: "per_hand", sets: [{ reps: "12", weight: 15 }] },
      ],
    }));
    const plan = { weekStart: "2026-08-24", weekEnd: "2026-08-30", sessions: [{ name: "Bas du corps", exercises: [{ name: "Squat", setsCount: 4, reps: "12", weight: 16, weightType: "per_hand" }] }] };
    const exportOn = (now) => {
      vi.useFakeTimers({ now: new Date(`${now}T12:00:00+02:00`) });
      try {
        return generateExport(sessions, { name: "Camille", goals: "x", priorities: "y" }, plan);
      } finally {
        vi.useRealTimers();
      }
    };
    const exported = exportOn("2026-08-26");
    // All three phases keep the prefix the prompt names; only EN COURS governs today.
    expect(exportOn("2026-08-10")).toContain("PROGRAMME DE LA SEMAINE À VENIR");
    expect(exportOn("2026-09-10")).toContain("PROGRAMME DE LA SEMAINE PRÉCÉDENTE");
    expect(exported).toContain("PROGRAMME DE LA SEMAINE EN COURS");
    expect(exported).toContain("SÉANCES PROPRES À LA CHARGE ACTUELLE");
    expect(focus("discussion")).toContain("PROGRAMME DE LA SEMAINE EN COURS");
    expect(focus("discussion")).toContain("SÉANCES PROPRES À LA CHARGE ACTUELLE");
  });
});

describe("buildSystemPrompt — cycle periodization and load progression (issue #4, T5.1/T5.2)", () => {
  const p = buildSystemPrompt(CATALOG_GROUPS, EQUIPMENT, CATALOG_BLACKLIST, STRUCTURE, COACHING);

  it("tells the coach to ASK for the cycle day and never to deduce it", () => {
    // The whole point of T5.1. The model previously inferred the cycle day from
    // session dates and got a full phase wrong; there is nothing for a validator
    // to catch here, because the failure is the model inventing an input.
    expect(p).toMatch(/JAMAIS le jour du cycle/);
    const discussion = buildSystemPrompt(CATALOG_GROUPS, EQUIPMENT, CATALOG_BLACKLIST, STRUCTURE, COACHING, "discussion");
    expect(discussion).toMatch(/DEMANDES/);
  });

  it("states every cycle window using the injected numbers, never a retyped literal", () => {
    const { cycle } = COACHING;
    expect(p).toContain(`environ ${cycle.cycleLengthDays} jours`);
    expect(p).toContain(`J${cycle.highEnergyDays.from} à J${cycle.highEnergyDays.to}`);
    expect(p).toContain(`J${cycle.lowEnergyFromDay}`);
  });

  it("describes all four mesocycle weeks", () => {
    for (const phase of COACHING.cycle.mesocycle) {
      expect(p, `mesocycle week S${phase.week} should appear`).toContain(`S${phase.week} (${phase.label})`);
      expect(p).toContain(phase.focus);
    }
  });

  it("tells the coach not to invent a phase when Camille does not supply the day", () => {
    expect(p).toMatch(/n'invente pas une phase/i);
  });

  it("states the load-increase heuristic with the injected threshold", () => {
    expect(p).toContain(`environ ${COACHING.cleanSessionsBeforeIncrease} séances propres à la charge actuelle`);
  });

  it("frames the threshold as the coach's call, not as a gate", () => {
    // Owner ruling: over-determinising progression prevents coaching. No
    // validator enforces this, and the prompt must not imply one does.
    expect(p).toMatch(/REPÈRE, pas une barrière/);
    expect(p).toMatch(/c'est TOI qui décides/i);
  });

  it("states exactly what the clean-session counter does and does not know", () => {
    // Mode séance records a three-way per-exercise status, so a skipped or
    // partial exercise breaks the run (issue #4 T5.2) — the prompt must say so,
    // since that is what the code now enforces. What it still cannot see is the
    // quality of a set she did validate, so the coach asks rather than assumes.
    expect(p).toMatch(/SÉANCES PROPRES À LA CHARGE ACTUELLE/);
    expect(p).toMatch(/un exercice passé ou interrompu casse la série/);
    // `p` is plan-emit (the default mode), which cannot ask: it states the gap.
    expect(p).toMatch(/dis dans `coachNotes` que tu ignores/);
    // The old caveat claimed the counter could not tell the two apart. It can.
    expect(p).not.toMatch(/pas les séances « propres »/);
  });

  // Regression: bb0837d — plan-emit was told to ask the user about a hard set, which a strict-JSON reply cannot do.
  it("plan-emit states the uncertainty in coachNotes instead of asking her", () => {
    const build = (mode) => buildSystemPrompt(CATALOG_GROUPS, EQUIPMENT, CATALOG_BLACKLIST, STRUCTURE, COACHING, mode);
    const emit = build("plan-emit");
    expect(emit).not.toMatch(/demande-la à Camille/);
    expect(emit).toContain("dis dans `coachNotes` que tu ignores");
    for (const mode of ["discussion", "plan"]) expect(build(mode)).toMatch(/demande-la à Camille/);
  });

  it("forbids the vague non-progression formula the counter exists to replace", () => {
    expect(p).toMatch(/on consolide/);
  });

  it("omits the whole section rather than emitting broken text when no coaching input is given", () => {
    // `coaching` is a newer argument than the other four; a caller that forgets
    // it must degrade to silence, never to "environ undefined jours".
    const bare = buildSystemPrompt(CATALOG_GROUPS, EQUIPMENT, CATALOG_BLACKLIST, STRUCTURE);
    expect(bare).not.toContain("undefined");
    expect(bare).not.toContain("## Cycle et périodisation");
  });
});

// Measured at the last recorded prod request (27 128 prompt tokens): history is
// ~13 800 tokens, 51% of the whole prompt — bigger than exportContext, and far
// bigger than the system prompt. The cause is that HISTORY_WINDOW counts
// MESSAGES while the cost is in CHARACTERS, and the asymmetry is extreme: the user's
// questions run 6-476 characters (median ~85), the coach's replies 2 000-6 000.
// "40 messages" is really ~2k characters of her and ~53k of him.
//
// So the budget is spent where the asymmetry is: her turns are kept whole
// forever (they are the thread, and they are nearly free), recent exchanges are
// kept whole (that is the live context), and older coach replies are abridged.
describe("budgetHistory", () => {
  const user = (i) => ({ role: "user", content: `Question ${i} ?` });
  const assistant = (i) => ({ role: "assistant", content: `Réponse ${i}. ${"x".repeat(4000)}` });

  /** A transcript of `pairs` exchanges, oldest first. */
  const transcript = (pairs) =>
    Array.from({ length: pairs }, (_, i) => [user(i), assistant(i)]).flat();

  it("leaves a short transcript completely untouched", () => {
    const history = transcript(2);
    expect(budgetHistory(history)).toEqual(history);
  });

  it("keeps every question she asked, however old, in full", () => {
    const history = transcript(20);
    const out = budgetHistory(history);
    for (let i = 0; i < 20; i++) {
      expect(out.some((m) => m.role === "user" && m.content === `Question ${i} ?`)).toBe(true);
    }
  });

  it("keeps the most recent exchanges verbatim", () => {
    const history = transcript(20);
    const out = budgetHistory(history);
    for (const m of out.slice(-RECENT_VERBATIM)) {
      expect(m.content).not.toContain(ABRIDGED_NOTE);
    }
    // The newest reply is the live context and must survive whole.
    expect(out[out.length - 1].content).toBe(history[history.length - 1].content);
  });

  it("abridges older coach replies and says that it did", () => {
    const history = transcript(20);
    const out = budgetHistory(history);
    const oldest = out[1];
    expect(oldest.role).toBe("assistant");
    expect(oldest.content).toContain(ABRIDGED_NOTE);
    expect(oldest.content.length).toBeLessThan(history[1].content.length);
    // The opening of the reply is what carries its point, so it is the part kept.
    expect(oldest.content).toContain("Réponse 0.");
  });

  // Turn count and alternation are load-bearing downstream: buildMessages relies
  // on the last turn's role, and a vendor enforcing strict alternation would 400
  // on a dropped turn.
  it("changes no turn's role, count or order", () => {
    const history = transcript(20);
    const out = budgetHistory(history);
    expect(out).toHaveLength(history.length);
    expect(out.map((m) => m.role)).toEqual(history.map((m) => m.role));
  });

  it("cuts a realistic transcript substantially", () => {
    const history = transcript(20);
    const before = history.reduce((n, m) => n + m.content.length, 0);
    // With the window coach-chat.js passes: the cutoff sits at window - RECENT_VERBATIM.
    const after = budgetHistory(history, { window: 40 }).reduce((n, m) => n + m.content.length, 0);
    expect(after).toBeLessThan(before / 2);
  });

  // An abridged reply must never be mistaken for one the model cut short, or the
  // coach will apologise for an answer it actually finished.
  it("does not reuse the truncation wording shown to Camille", () => {
    const out = budgetHistory(transcript(20));
    for (const m of out) expect(m.content).not.toContain("Réponse coupée");
  });

  it("survives an empty or absent transcript", () => {
    expect(budgetHistory([])).toEqual([]);
    expect(budgetHistory(undefined)).toEqual([]);
  });

  // The prompt is one voice against twelve verbatim examples of the opposite.
  // This repo has already proved which one wins: `collapsePlan` exists because
  // the coach re-learned a retired plan format from its own transcript, not
  // from the prompt. The report layout propagates the same way, and the 600-char
  // abridge sharpens it exactly as it did there — it keeps the bold label and
  // the first section and throws the substance away, turning an older reply into
  // a pure format specimen.
  it("strips the report layout from every coach reply, recent ones included", () => {
    const report = [
      "**Réponse ultra-courte et ciblée :**",
      "",
      "**Bilan :**",
      "- **24 min en zone 2** → **parfait**.",
      "",
      "---",
      "### **Prochaine fois**",
      "- Garde **14%**.",
    ].join("\n");
    const out = budgetHistory([{ role: "user", content: "Q" }, { role: "assistant", content: report }]);
    const kept = out[1].content;
    expect(kept).not.toMatch(/\*\*/);
    expect(kept).not.toMatch(/^---$/m);
    expect(kept).not.toMatch(/^#/m);
    expect(kept).not.toMatch(/Réponse ultra-courte/);
    // Every content word survives — this removes formatting, never substance.
    expect(kept).toContain("24 min en zone 2");
    expect(kept).toContain("Prochaine fois");
    expect(kept).toContain("Garde 14%");
    expect(kept).toContain("Bilan :");
  });

  // An empty assistant turn is the shape a vendor rejects outright, and a 400
  // costs the user the answer rather than a tidier prompt. Nothing realistic gets
  // here — `finish()` never persists an empty reply — so this is the asymmetry
  // being respected, not a case anyone has seen.
  it("keeps a turn that was entirely scaffolding rather than emptying it", () => {
    const allMarkup = { role: "assistant", content: "---\n**" };
    expect(budgetHistory([{ role: "user", content: "Q" }, allMarkup])[1]).toEqual(allMarkup);
  });

  it("never touches what she wrote, however report-shaped it looks", () => {
    const hers = { role: "user", content: "**Réponse ultra-claire :**\n---\n# Titre" };
    expect(budgetHistory([hers, { role: "assistant", content: "ok" }])[0]).toEqual(hers);
  });

  // The abridge budget should buy 600 characters of coaching, not 600
  // characters of bold markers and rules.
  it("spends the abridge budget on content rather than on markup", () => {
    const scaffolded = `**Réponse ultra-précise :**\n\n---\n\n${"**mot** ".repeat(400)}`;
    const history = [
      ...Array.from({ length: 14 }, (_, i) => ({ role: "user", content: `Q${i}` })),
      { role: "assistant", content: scaffolded },
      ...Array.from({ length: RECENT_VERBATIM }, (_, i) => ({ role: "user", content: `R${i}` })),
    ];
    // A full window, so the cutoff is window - RECENT_VERBATIM = 15 and row 14 is
    // abridged. Without it the block-aligned growth rule would cut at 10.
    const abridged = budgetHistory(history, { window: history.length })[14].content;
    expect(abridged).toContain(ABRIDGED_NOTE);
    expect(abridged).not.toMatch(/\*\*/);
    // 600 chars of "mot " is ~150 words; the scaffolded original would have
    // spent more than half of them on asterisks.
    expect(abridged.split(/\s+/).filter(Boolean).length).toBeGreaterThan(100);
  });
});

describe("stripReplyScaffolding", () => {
  it("removes horizontal rules, heading markers and emphasis, and nothing else", () => {
    expect(stripReplyScaffolding("## **Titre**\n---\ntexte **gras** ici")).toBe("Titre\ntexte gras ici");
  });

  it("drops a self-announcing opener but keeps a subject line", () => {
    expect(stripReplyScaffolding("**Réponse ultra-claire :**\nOui.")).toBe("Oui.");
    // « Bilan de ta séance … » names what the reply is ABOUT. Only the coach
    // announcing its own answer is scaffolding.
    expect(stripReplyScaffolding("**Bilan de ta séance :**\nOui.")).toBe("Bilan de ta séance :\nOui.");
  });

  // False-positive guards. Each fails against one specific loosening of the
  // rule, which is what makes them evidence rather than decoration.
  it("keeps the word « réponse » when it is not the opening label", () => {
    // Not the first line — dropping it would eat an answer.
    expect(stripReplyScaffolding("Oui.\nRéponse courte :")).toBe("Oui.\nRéponse courte :");
    // No colon, so it is a sentence rather than a label.
    expect(stripReplyScaffolding("Réponse : oui, et voilà pourquoi.")).toContain("oui, et voilà pourquoi");
  });

  it("leaves a STAMPED JSON turn alone — the other half of the annotation guard", () => {
    // `annotateHistory` stamps every assistant turn, so a JSON turn no longer
    // starts with `{`. Without looking past the annotation the stripper would
    // run over the payload itself, deleting `**`/`__`/`#` and dropping `---`
    // lines from INSIDE the JSON before the model ever reads it. `collapsePlan`
    // leaves valid non-plan JSON and an unrecognised payload shape alone, so
    // both really do reach this function.
    const stamped = '[dim. 24 août, 14:32]\n{"foo":"a **b**","note":"---"}';
    expect(stripReplyScaffolding(stamped)).toBe(stamped);
  });

  it("keeps a turn that is nothing but scaffolding and a stamp", () => {
    // The empty-content guard is tested on the BODY now: with a stamp always
    // present, `content` is never empty, so an all-scaffolding reply would have
    // gone to the model as a bare date instead of falling back to its original
    // text. Mistral rejects a turn with no words outright.
    const out = budgetHistory([
      { role: "assistant", content: "[dim. 24 août, 14:32]\n**Réponse :**\n---" },
    ]);
    expect(out[0].content).toBe("[dim. 24 août, 14:32]\n**Réponse :**\n---");
  });

  it("leaves a plan payload alone", () => {
    const payload = '{"weekStart":"2026-08-11","coachNotes":"a **b**"}';
    expect(stripReplyScaffolding(payload)).toBe(payload);
  });

  it("survives an empty or absent reply", () => {
    expect(stripReplyScaffolding("")).toBe("");
    expect(stripReplyScaffolding(undefined)).toBe(undefined);
  });
});

// budgetHistory is only worth anything if the prompt actually goes through it.
// A pure function with its own green tests can sit unwired for months while the
// suite stays entirely green — this is the assertion that would notice.
describe("buildMessages applies the history budget", () => {
  it("abridges an old coach reply on the way into the prompt", () => {
    const history = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0
        ? { role: "user", content: `Q${i}` }
        : { role: "assistant", content: `R${i}. ${"y".repeat(4000)}` }
    );
    const msgs = buildMessages({
      systemPrompt: "SYS", notebook: "NB", exportContext: "EXP", history, userMessage: "U",
    });
    const oldestReply = msgs.find((m) => m.role === "assistant");
    expect(oldestReply.content).toContain(ABRIDGED_NOTE);
    expect(oldestReply.content.length).toBeLessThan(1000);
  });

  it("passes her own words through untouched however old they are", () => {
    const history = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0
        ? { role: "user", content: `Q${i}` }
        : { role: "assistant", content: `R${i}. ${"y".repeat(4000)}` }
    );
    const msgs = buildMessages({
      systemPrompt: "SYS", notebook: "NB", exportContext: "EXP", history, userMessage: "U",
    });
    const joined = msgs.map((m) => m.content).join("\n");
    for (let i = 0; i < 40; i += 2) expect(joined).toContain(`Q${i}`);
  });
});

// The user, 2026-08-10: « Respect le format fittrack plan pour que l'import
// fonctionne » — and the very next reply broke it again, in a NEW dialect. The
// hand-written format is gone; the API enforces the shape now. What that buys
// here is that the mode split becomes structural rather than rhetorical: two
// conversational modes that have never been shown how to produce a programme,
// and one request kind that can.
describe("buildSystemPrompt — three modes", () => {
  const build = (mode) =>
    buildSystemPrompt(CATALOG_GROUPS, EQUIPMENT, CATALOG_BLACKLIST, STRUCTURE, COACHING, mode);

  it("defaults to plan-emit, so instructions.md parity keeps a single reference target", () => {
    const bare = buildSystemPrompt(CATALOG_GROUPS, EQUIPMENT, CATALOG_BLACKLIST, STRUCTURE, COACHING);
    expect(bare).toBe(build("plan-emit"));
  });

  it("shows the plan-writing role ONLY in plan-emit mode", () => {
    // NOT `/programme/i`: that word occurs 16× in discussion and 13× in plan, so
    // the assertion could not fail and said nothing. The rôle item that actually
    // differs is the one that names the job.
    expect(build("plan-emit")).toMatch(/Planification hebdomadaire/);
    expect(build("plan-emit")).toContain("## Ce que tu produis ici");
    // Neither conversational mode may be told how to produce a plan.
    for (const mode of ["discussion", "plan"]) {
      expect(build(mode), mode).not.toMatch(/FITTRACK/);
      expect(build(mode), mode).not.toMatch(/Ce que tu produis ici/);
      expect(build(mode), mode).not.toMatch(/Planification hebdomadaire/);
      // Session-structure vocabulary belongs to the emitting prompt alone. Zero
      // occurrences today, and nothing pinned it until now — a later edit could
      // put the week's skeleton back into a mode that must not write one.
      expect(build(mode), mode).not.toMatch(/ÉCHAUFFEMENT/);
      expect(build(mode), mode).not.toMatch(/RETOUR AU CALME/);
    }
  });

  // The model no longer authors syntax, so the syntax is gone from every mode —
  // including the one that emits. Leaving it anywhere is how a dialect gets
  // re-learned from the transcript.
  it("has retired the hand-written text format from all three modes", () => {
    for (const mode of ["discussion", "plan", "plan-emit"]) {
      expect(build(mode), mode).not.toContain("=== FITTRACK PLAN ===");
    }
  });

  it("tells the conversational plan mode it cannot rewrite the week itself", () => {
    expect(build("plan")).toMatch(/ne (peux|peut) pas (modifier|réécrire)/i);
    expect(build("plan")).toContain(`« ${PLAN_BUTTON_LABEL} »`);
  });

  // The prompt names a control on the user's screen, so the two copies of that
  // string have to agree. They cannot be one constant: this module is the edge
  // bundle and imports nothing from `src/`. The old scheme had two labels
  // chosen by whether her week had expired while the prompt hardcoded one of
  // them — so on the very occasion she was most likely to ask for a plan, the
  // coach named a button that was not rendered.
  it("names the same button the UI renders", () => {
    expect(PLAN_BUTTON_LABEL).toBe(UI_PLAN_BUTTON_LABEL);
  });

  // The route also names WHERE the button is, and nothing tied that to the UI.
  // The design audit of 2026-10-10 moved « Plan » from below the composer to
  // the mode row beside « Mon programme »; with the old sentence the coach
  // would have sent her to a spot where nothing is rendered. « en haut de
  // l'écran » rather than « à côté » because the row wraps below ~375px and
  // « Plan » then sits under the toggle — still at the top, not beside it.
  it("places the « Plan » button where CoachTab renders it, in both conversational modes", () => {
    for (const mode of ["discussion", "plan"]) {
      const prompt = build(mode);
      expect(prompt, mode).not.toContain("sous la zone de message");
      expect(prompt, mode).not.toMatch(/« Plan »[^.\n]*à côté/);
      expect(prompt, mode).toMatch(/« Plan »[^.\n]*en haut de l'écran/);
    }
  });

  // These are pinned as a SET in all three modes. A future "tighten the prompt"
  // pass dropping any one of them is exactly how the last regression happened.
  it.each(["discussion", "plan", "plan-emit"])("keeps the consistency rules in %s mode", (mode) => {
    const p = build(mode);
    expect(p).toMatch(/EXPLIQUER N'EST PAS MODIFIER/);
    expect(p).toMatch(/UNE QUESTION N'EST PAS UNE OBJECTION/);
    expect(p).toMatch(/NE TE CONTREDIS PAS EN SILENCE/);
    expect(p).toMatch(/NE RÉPÈTE PAS/);
  });

  // BOTH HALVES, ENUMERATED, in all three modes. The weak version of this guard
  // (`/protéines|hydratation|sommeil/i` + `/diététicien/i`) survives a rewrite
  // that keeps « oriente vers une diététicienne » and deletes the calorie-target
  // / macro-split / numeric-meal-plan / weight-loss enumeration — which is the
  // half CLAUDE.md names as the dangerous one, since keeping the opening and
  // losing the limit is what lets the coach hand the user a macro split.
  it.each(["discussion", "plan", "plan-emit"])("keeps the nutrition scope AND its limit in %s mode", (mode) => {
    const p = build(mode);
    // The scope: recovery, sleep and food are IN, and volunteered rather than waited for.
    expect(p).toMatch(/Récupération, sommeil, alimentation/);
    expect(p).toMatch(/protéines/i);
    expect(p).toMatch(/hydratation/i);
    expect(p).not.toMatch(/PAS de conseils nutritionnels/);
    // The limit, item by item — a rewrite may not quietly drop one of the four.
    expect(p).toMatch(/JAMAIS d'objectif calorique/);
    expect(p).toMatch(/macronutriments/);
    expect(p).toMatch(/plan alimentaire chiffré/);
    expect(p).toMatch(/perte de poids/);
    expect(p).toMatch(/diététicienne/);
    // And the medical rail it sits beside, which was never in scope to widen.
    expect(p).toMatch(/PAS de conseils médicaux/);
  });

  it.each(["discussion", "plan", "plan-emit"])("keeps the cycle rule in %s mode", (mode) => {
    expect(build(mode)).toMatch(/cycle/i);
    expect(build(mode)).toMatch(/JAMAIS le jour du cycle/);
  });

  // Regression: e1ef969 — plan-emit was told to ask the user where she is in her cycle, but its reply must be JSON and cannot ask.
  it("plan-emit reads the cycle day instead of asking for it", () => {
    const p = build("plan-emit");
    expect(p).not.toContain("demande-lui où elle en est");
    // Regression: db51b54 — two more lines still ordered a question a strict-JSON reply cannot ask.
    expect(p).not.toContain("DEMANDES");
    expect(p).not.toContain("ça colle");
    expect(p).toContain("Sans jour de cycle exploitable, programme sans périodisation et dis-le dans `coachNotes`");
  });

  // Regression: 6960898 — the carry-over line put a day she STATED in chat and a notebook day under one condition.
  // Regression: 177ae0e — owner ruling 2026-10-02: « daté et récent » let a notebook day from days ago through unadvanced.
  // Both SUPERSEDED by 5119484: the notebook is no longer a source at all. The cycle day is never
  // stored (CLAUDE.md), and a day noted today was said in conversation today, so the separate
  // notebook branch those two tests pinned is gone; their intent — no stale day from the notebook —
  // is what this test now guards.
  it("plan-emit takes the cycle day from today's conversation only, never from the notebook", () => {
    const p = build("plan-emit");
    const line = p.split("\n").find((l) => l.includes("Un jour de cycle qu"));
    expect(line).toBeTruthy();
    expect(line).toContain("dans la conversation");
    expect(line).toContain("Ton carnet n'est pas une source");
    expect(p).not.toContain("S'il ne vient que du carnet");
    expect(p).not.toContain("qu'il vient du carnet");
    expect(p).not.toContain("la note porte la date");
    expect(p).not.toContain("conversation ou le carnet");
  });

  // Same commit: the notebook was told to keep « cycle », which invites storing the day.
  it.each(["discussion", "plan", "plan-emit"])("%s mode never asks the notebook to keep the cycle day", (mode) => {
    const p = build(mode);
    expect(p).toContain("JAMAIS son jour de cycle");
    expect(p).not.toContain("préférences, cycle,");
    expect(p).not.toContain("dans ton carnet avec sa date");
  });

  // Regression: 5755165 — owner ruling 2026-10-02: advancing a stated day by the elapsed days is deduction; same day only.
  it("plan-emit uses a stated cycle day only on the day she said it, and never advances it", () => {
    const line = build("plan-emit").split("\n").find((l) => l.includes("Un jour de cycle qu"));
    const [stated] = line.split("Ton carnet");
    expect(stated).toContain("seulement si c'est aujourd'hui qu'elle l'a dit ou confirmé");
    // Regression: 8e88ae8 — a day the coach proposed and she confirmed with « oui » today read as no day she gave today.
    expect(stated).toContain("ou qu'elle a confirmé quand tu le lui as proposé");
    expect(stated).toContain("Ne l'avance jamais");
    expect(stated).not.toContain("avance-le");
    expect(stated).not.toContain("tel quel");
  });

  it.each(["discussion", "plan"])("%s mode still asks for the cycle day", (mode) => {
    expect(build(mode)).toContain("demande-lui où elle en est");
    expect(build(mode)).toContain("DEMANDES");
    expect(build(mode)).toContain("ça colle");
  });

  it.each(["discussion", "plan", "plan-emit"])("keeps the explanation ruling in %s mode", (mode) => {
    expect(build(mode)).toMatch(/Donner du sens/);
    expect(build(mode)).toMatch(/L'EXPLICATION prend la/);
  });

  it.each(["discussion", "plan"])("asks %s mode to answer the LAST question only", (mode) => {
    expect(build(mode)).toMatch(/dernière question/i);
  });

  // The user, 2026-08-05: the coach ends on homework she never asked for. Moved to
  // the volatile reminder on 2026-08-16 — it was still being violated from the
  // system prompt (« Prochaine étape », « Bois 500 ml d'eau »), and it is a
  // rule about how a reply ENDS, which is shape.
  it.each(["discussion", "plan"])("forbids unrequested homework in %s mode", (mode) => {
    expect(buildReplyShapeReminder(mode)).toMatch(/test à faire aujourd'hui/);
  });

  it.each(["discussion", "plan"])("tells %s mode not to resume a cut reply or redo an abridged one", (mode) => {
    expect(build(mode)).toMatch(/interrompue/);
    expect(build(mode)).toMatch(/abrégée/);
  });

  // Measured against the live transcript on 2026-08-16, over the 25 prose
  // replies since 2026-08-07: 21 opened on a bold self-announcing label
  // (« **Réponse ultra-courte et ciblée :** »), 23 carried a `---` rule, and
  // each averaged 29 bold runs and 18 bullet lines — a median of 1 607
  // characters against a median question of 85, on a phone. Nothing in the
  // prompt said anything about the SHAPE of a reply: every rule was about
  // scope, so the model satisfied all of them and still wrote a report.
  it.each(["discussion", "plan"])("bans the report layout in %s mode", (mode) => {
    const p = buildReplyShapeReminder(mode);
    expect(p).toMatch(/UNE RÉPONSE EST UN MESSAGE, PAS UNE FICHE/);
    // The tics, named individually: a rewrite may not quietly keep one. The
    // table is new — reply #158 on 2026-08-16 answered a yes/no question with
    // a three-column markdown table, and no line had forbidden one.
    expect(p).toMatch(/titre d'annonce/);
    expect(p).toMatch(/Réponse ultra-claire/); // the literal tic, quoted back
    expect(p).toMatch(/séparateur/i);
    expect(p).toMatch(/tableau/);
  });

  // The belt for the stamp echo. `stripEchoedAnnotation` is the suspenders and
  // is what actually holds; this is the half that stops the model producing it
  // in the first place. Measured 2026-08-30: 25 of the 46 replies banked since
  // the 2026-08-24 stamping change open on a copied `[dim. 30 août, 17:15]`,
  // carrying the PRECEDING turn's time — so the date she reads is wrong.
  it.each(["discussion", "plan"])("tells %s mode never to copy an annotation line", (mode) => {
    const p = buildReplyShapeReminder(mode);
    expect(p).toMatch(/NE RECOPIE JAMAIS LES LIGNES ENTRE CROCHETS/);
    // The literal shape, quoted back — the Objectifs/Priorités precedent: a rule
    // naming a string the model cannot find in front of it points at nothing.
    expect(p).toMatch(/\[dim\. 30 août, 17:15\]/);
    expect(p).toMatch(/nouvelle conversation/);
  });

  // The layout rule has no business in plan-emit: that mode answers with a JSON
  // payload and never writes prose at all. Keeping the split structural is what
  // stops "be brief" leaking onto the path where a complete week is the point.
  it("does not put the layout rule on the emit path", () => {
    expect(buildReplyShapeReminder("plan-emit")).toBe("");
    expect(build("plan-emit")).not.toMatch(/UNE RÉPONSE EST UN MESSAGE, PAS UNE FICHE/);
  });

  // A MOVE, NOT A COPY. Stating one rule in two places is how a prompt drifts
  // from itself, and it is also what would make a future "the rules are already
  // there" reading true in the wrong place. Measured on 2026-08-16: these lines
  // shipped in the system prompt that morning and the median conversational
  // completion_tokens went 769 -> 1143 across the deploy, on rung 1 throughout.
  it.each(["discussion", "plan", "plan-emit"])(
    "keeps every shape rule OUT of the %s system prompt — they live beside her message",
    (mode) => {
      const p = build(mode);
      expect(p).not.toMatch(/UNE RÉPONSE EST UN MESSAGE, PAS UNE FICHE/);
      expect(p).not.toMatch(/LA LONGUEUR SUIT LA QUESTION/);
      expect(p).not.toMatch(/PAS DE DEVOIRS/);
      expect(p).not.toMatch(/QUAND ELLE S'ENTRAÎNE, SOIS BRÈVE/);
    }
  );

  // ...and the scope rules stay exactly where they were. The move is bounded:
  // these are about capability, not shape, and nothing suggests they are ignored.
  it.each(["discussion", "plan"])("keeps the SCOPE rules in the %s system prompt", (mode) => {
    const p = build(mode);
    expect(p).toMatch(/RÉPONDS À SA DERNIÈRE question/);
    expect(p).toMatch(/interrompue/);
    expect(p).toMatch(/abrégée/);
    expect(buildReplyShapeReminder(mode)).not.toMatch(/RÉPONDS À SA DERNIÈRE question/);
  });

  // The counterweight to « L'EXPLICATION prend la place qu'il faut ». That
  // sentence is the 2026-08-02 explanation ruling and stays (pinned above), but
  // it bounded concision in ONE direction only — an expansion licence with no
  // ceiling, which is how « Dead bug, 12 par coté ou 6 ? » drew 874 characters.
  it.each(["discussion", "plan"])("makes the length follow the question in %s mode", (mode) => {
    const p = buildReplyShapeReminder(mode);
    expect(p).toMatch(/LA LONGUEUR SUIT LA QUESTION/);
    expect(p).toMatch(/question fermée/);
    // Both halves stated together, exactly as the nutrition rule is: the
    // explanation ruling survives, it is simply no longer unbounded.
    //
    // The two halves live in two places now, and they always did — this
    // assertion used to read `expect(build(mode)).toMatch(/L'EXPLICATION/)`
    // and was silently matching « Ton registre », never the focus bullet it
    // was written under. Both are pinned separately here so neither can go
    // missing behind the other.
    expect(p).toMatch(/l'EXPLICATION prend la place qu'il faut/); // the bound
    expect(build(mode)).toMatch(/L'EXPLICATION prend la/); // the 2026-08-02 ruling
    // The cross-reference resolves only because « Ton registre » is in the
    // system prompt of the same request — asserted so the move cannot orphan it.
    expect(p).toMatch(/Ton registre/);
    expect(build(mode)).toMatch(/## Ton registre/);
  });

  // She talks to the coach from `SeanceCoachPanel` between two sets, and
  // `generateExport` already tells the model so. Nothing acted on it: her
  // mid-workout questions on 2026-08-11/12 drew 874-1 463 characters.
  it.each(["discussion", "plan"])("shortens the reply while a séance is running, in %s mode", (mode) => {
    const p = buildReplyShapeReminder(mode);
    // The literal block header generateExport emits, or the rule points at
    // something the model cannot find — same failure mode as Objectifs/Priorités.
    expect(p).toMatch(/SÉANCE EN COURS/);
    expect(p).toMatch(/entre deux séries/);
  });

  // Regression: e0575c4 — the stale-draft heading existed in the export with no line telling the model what it meant.
  it.each(["discussion", "plan"])("explains the stale-draft heading generateExport emits, in %s mode", (mode) => {
    const p = buildReplyShapeReminder(mode);
    const draft = { name: "X", date: "2020-01-06", cursor: { exercise: 0, set: 0 }, current: false,
      exercises: [{ name: "Rowing", status: "pending", sets: [{ reps: "", weight: "", done: false }] }] };
    const heading = generateExport([], { name: "T" }, null, draft).split("\n").find((l) => l.startsWith("SÉANCE COMMENCÉE"));
    expect(heading).toBeTruthy();
    // The literal prefix and suffix the export writes, or the rule points at nothing.
    expect(p).toContain("SÉANCE COMMENCÉE LE");
    expect(p).toContain("NON TERMINÉE");
    expect(heading).toContain("NON TERMINÉE");
    expect(p).toMatch(/n'applique pas\s+la brièveté/);
  });

  // The old chat mode was told the programme is not rewritten here. Discussion
  // keeps that wording and points at the OTHER mode; plan mode gets the stronger
  // statement, asserted above.
  it("tells discussion mode the current programme is not rewritten there, and where it is", () => {
    expect(build("discussion")).toMatch(/NE SE MODIFIE PAS/);
    expect(build("discussion")).toMatch(/« Mon programme »/);
  });

  // Naming only the mode left her one hop short: she switches to « Mon
  // programme » and still has to guess which control writes a week. Both modes
  // must give the whole route, because the button exists in only one of them.
  it.each(["discussion", "plan"])("gives %s mode the full route to a programme, not just the mode", (mode) => {
    expect(build(mode)).toContain(`« ${PLAN_BUTTON_LABEL} »`);
  });

  describe("plan-emit — what replaces the format section", () => {
    const emit = build("plan-emit");

    it("says the plan comes back as structured data rather than as text she has to parse", () => {
      expect(emit).toMatch(/Ce que tu produis ici/);
      expect(emit).toMatch(/structuré/i);
      expect(emit).toMatch(/aucune syntaxe|pas de syntaxe/i);
    });

    // The schema guarantees shape, never domain validity: in the 2026-08-10
    // probe the model titled sessions "(Lundi)" and "(Mercredi)", the exact
    // day-pinning the user rejected on 2026-07-26. Nothing but the prompt stops it.
    it("forbids a day of the week in a session name, and says why", () => {
      expect(emit).toMatch(/JAMAIS un jour de la semaine/);
      expect(emit).toMatch(/Camille choisit/);
    });

    // The belt for the empty-session error. Measured 2026-08-16: three of the
    // thirteen validator errors that rejected five consecutive plans were a
    // session with no exercises, emitted under a rest-day or mobility name.
    // Nothing in the prompt had ever said a rest day is not a session.
    it("says a rest day is not a session, and where cardio goes", () => {
      expect(emit).toMatch(/jour de repos/i);
      expect(emit).toMatch(/ne sont PAS des séances|n'est pas une séance/i);
      expect(emit).toMatch(/cardio dans ses exercices/);
    });

    // The belt for the enum. Four of the same thirteen errors were an exercise
    // name the catalog does not hold, and THREE of those four were a real
    // catalog name with a qualifier appended — the same decoration that retired
    // the `=== FITTRACK PLAN ===` header. The suspenders are the schema enum;
    // this is the half that stops a silent substitution instead, which no
    // validator can catch.
    it("says an exercise name is chosen, never composed, and where a variant goes", () => {
      expect(emit).toMatch(/se CHOISIT dans le catalogue/);
      expect(emit).toMatch(/jamais de qualificatif ajouté/i);
      expect(emit).toContain(STRUCTURE.planFields.progressionNote);
      expect(emit).toMatch(/remplaçant silencieusement/);
    });

    it("names the field progression goes into at a material ceiling, as the schema declares it", () => {
      expect(emit).toContain(STRUCTURE.planFields.progressionNote);
      expect(emit).toMatch(/plafond/);
    });

    // The `/main` suffix is a TEXT convention. Left unconditional it reached the
    // one mode where the model authors no syntax, forty lines above the rule
    // telling it never to write that convention into a field — and a name like
    // "Soulevé de terre roumain 15kg/main" is schema-valid, then fails
    // resolveCatalogName on import, which is the exact bug this project fixes.
    it("keeps the written /main suffix out of the emitting prompt, and in the prose ones", () => {
      expect(emit).not.toContain("suffixe `/main`");
      expect(emit).not.toContain("Sans suffixe = total");
      expect(emit).toMatch(/le type est un champ à part/);
      for (const mode of ["discussion", "plan"]) {
        expect(build(mode), mode).toContain("suffixe `/main`");
        expect(build(mode), mode).toContain("Sans suffixe = total");
      }
    });

    // Belt and suspenders: `validatePlanDomain` STRIPS the unit from a held
    // exercise's `reps`, so the prompt has to say so. A rule enforced in code
    // and unstated in the prompt makes the model produce plans that get
    // silently rewritten, and neither side is wrong.
    it("states that a hold is written as a bare number of seconds", () => {
      expect(emit).toMatch(/SECONDES/);
      expect(emit).toMatch(/nombre nu/);
      // The remedy in the same sentence as the rule, on the bar-height
      // precedent: an instruction and its example twenty thousand characters
      // apart read as unrelated advice.
      expect(emit).toMatch(/« 25 ».{0,20}jamais.{0,10}« 25s »/);
    });
  });

  describe("the notebook survives the format change, in every mode", () => {
    it.each(["discussion", "plan", "plan-emit"])("records standing decisions and their reason in %s mode", (mode) => {
      const notebook = build(mode).split("## Ton carnet privé")[1];
      expect(notebook).toMatch(/DÉCISIONS EN COURS/);
      expect(notebook).toMatch(/seule mémoire qui survit/i);
      expect(notebook).toMatch(/INVISIBLE pour Camille/);
    });

    // The sentinel is how a STREAMING prose reply carries the notebook. It
    // cannot be how a strict-JSON reply carries it: `additionalProperties` is
    // false, so there is nowhere to put a block, and the payload has a
    // `notebook` field precisely because of that.
    it("keeps the sentinel protocol on the two prose modes", () => {
      for (const mode of ["discussion", "plan"]) {
        expect(build(mode), mode).toContain("<<<NOTEBOOK>>>");
        expect(build(mode), mode).toContain("<<<END>>>");
      }
    });

    it("asks plan-emit for the notebook FIELD instead, never a sentinel it cannot emit", () => {
      const emit = build("plan-emit");
      expect(emit).not.toContain("<<<NOTEBOOK>>>");
      expect(emit).toContain(STRUCTURE.planFields.notebook);
    });

    // « Ne le mentionne jamais » was already there and was not enough: the model
    // read it as covering the block's CONTENT and kept writing a heading in
    // front of the sentinel. That announcement is outside the block, so it is
    // ordinary visible text — every reply from 2026-08-14 ended on a dangling
    // « Carnet mis à jour : » with nothing after it. The rule now names the
    // three shapes and says what the announcement costs her.
    it.each(["discussion", "plan"])("forbids announcing the notebook before the sentinel in %s mode", (mode) => {
      const notebook = build(mode).split("## Ton carnet privé")[1];
      expect(notebook).toMatch(/PAS de titre/);
      expect(notebook).toMatch(/PAS de séparateur/);
      expect(notebook).toMatch(/Carnet mis à jour/);
    });
  });
});

// The user and the coach held two different definitions of the same exercise. Hers is
// the lexique (description + form cues); the coach's was the bare name, read
// through general training data. `Développé couché au sol` is defined in this app as a
// FLOOR press with dumbbells — that is what keeps it home-legal — and any model
// reading the bare name assumes a barbell bench press on a bench.
describe("buildSystemPrompt — one shared definition of each exercise", () => {
  const p = buildSystemPrompt(CATALOG_GROUPS, EQUIPMENT, CATALOG_BLACKLIST, STRUCTURE, COACHING, "discussion");

  it("gives every offered exercise its definition, not just its name", () => {
    expect(p).toContain("Allongée au sol, un haltère dans chaque main");
  });

  it("gives the form cues too, which is what it explains from", () => {
    expect(p).toContain("Coudes à 45° du corps");
  });

  it("tells the coach the app's definition wins over the usual meaning of the name", () => {
    expect(p).toMatch(/définition ci-dessus/);
    expect(p).toMatch(/dis-le/);
  });

  // The catalog filters must not be weakened by the richer rendering.
  it("still omits blacklisted and equipment-impossible exercises", () => {
    const section = p.slice(p.indexOf("## Exercices disponibles"), p.indexOf("## Charges réalisables"));
    for (const entry of CATALOG_BLACKLIST) {
      expect(section, entry.name).not.toContain(entry.name);
    }
    for (const name of HOME_INFEASIBLE_EXERCISE_NAMES) {
      expect(section.slice(0, section.indexOf("Ces exercices existent dans l'app")), name).not.toContain(name);
    }
  });

  // Owner ruling 2026-08-11: `intent` is the user's field, shown in the lexique
  // only. It is never assembled into the prompt inputs and never rendered into
  // the catalog listing — it cost +2 632 tokens on every request, twice what
  // the 22 new exercises cost, on a rung where 5 of 9 production requests
  // already hit the 15 s header timeout.
  it("keeps intent out of the prompt inputs entirely", () => {
    const availability = STRUCTURE.exerciseAvailability;
    expect(availability["Squat"]).not.toHaveProperty("intent");
    expect(availability["Traction pronation"]).not.toHaveProperty("intent");
  });

  it("never leaks an intent line into the catalog the model reads", () => {
    // Asserted against the REAL text, not the absence of a field: a future
    // change that re-renders intent from the catalog descriptor directly would
    // pass the check above and fail this one.
    expect(p).not.toContain(CATALOG_DESCRIPTIONS["Squat"].intent);
    expect(p).not.toContain(CATALOG_DESCRIPTIONS["Pompes"].intent);
    // Control: description and form cues ARE still there, so this test can fail.
    expect(p).toContain(CATALOG_DESCRIPTIONS["Squat"].description);
  });
});

// The prompt inputs are assembled from the catalog DOCUMENT now, not from the
// build-time constants. The document is what Neon serves and what the user's app
// reads, so the coach and she can no longer be looking at two different lists.
describe("buildPromptInputs", () => {
  it("builds the prompt inputs from a catalog rather than from constants", () => {
    const { equipment, structure, coaching } = buildPromptInputs(CATALOG);
    expect(structure.exerciseAvailability["Squat"].locations).toEqual(["maison"]);
    // Owner ruling 2026-08-11: `intent` is the user's field. `catalog.descriptions`
    // carries it — unlike the old constants read, which only ever
    // took two fields — so it is newly easy to leak, and it costs +2 632 tokens
    // on every request.
    expect(structure.exerciseAvailability["Squat"]).not.toHaveProperty("intent");
    expect(equipment.ceilings["Squat"]).toEqual({ maxKg: 18, unit: "per_hand" });
    // A blacklisted exercise keeps no ceiling in the model-facing table: stating a
    // maximum for an exercise the same prompt forbids is contradictory guidance.
    expect(equipment.ceilings["Russian twist"]).toBeUndefined();
    expect(coaching.cleanSessionsBeforeIncrease).toBe(3);
  });

  // The definitions the coach reads have to be the ones the user reads, or the app's
  // deliberately non-standard movements (a floor press, not a bench press) get
  // prescribed as their usual meaning. Only `intent` — editorial rationale — is
  // held back.
  it("carries the definition and the form cues Camille reads in the lexique", () => {
    const { structure } = buildPromptInputs(CATALOG);
    const squat = structure.exerciseAvailability["Squat"];
    expect(squat.description).toBe(CATALOG.descriptions["Squat"].description);
    expect(squat.formCues).toBe(CATALOG.descriptions["Squat"].formCues);
  });

  // No fallback, by design: a prompt built from nothing invents movements the user
  // cannot do, and a wrong plan reads to her as a coaching decision.
  it("refuses to build anything without a catalog", () => {
    expect(() => buildPromptInputs(null)).toThrow(/catalog is required/);
  });
});

/*
 * Deactivating an exercise has to reach the coach, and for one commit it did
 * not. `buildCatalogViews` only puts a deactivated exercise on the blacklist
 * when it carries a REASON — deactivating without one is a deliberate state
 * (design §2bis.1) meaning "absent, not explained" — while `isOffered` keyed
 * its filter off the blacklist alone. So a reasonless deactivation left the
 * exercise fully visible in the model-facing catalog, which is the opposite of
 * what the control means.
 *
 * Nothing leaked in production: all five deactivated entries in the day-one
 * catalog carry a reason. What made it reachable is the lexique's «Désactiver»
 * button, which collects no reason at all — so it is the state EVERY
 * deactivation the user performs from the list lands in.
 */
describe("buildSystemPrompt — a deactivated exercise is never offered, reason or not", () => {
  const deactivate = (name, reason) => {
    const doc = {
      ...seed,
      exercises: seed.exercises.map((ex) =>
        ex.name === name ? { ...ex, active: false, inactiveReason: reason } : ex
      ),
    };
    const views = buildCatalogViews(doc);
    const { equipment, structure, coaching } = buildPromptInputs(views);
    return buildSystemPrompt(views.muscleGroups, equipment, views.blacklist, structure, coaching);
  };

  // Exactly the catalog listing's own line shape. Anchored, because the
  // ceilings section and the blacklist section both also render `- <name> : …`
  // and matching those would make this test pass for the wrong reason —
  // a ceiling for a withdrawn exercise is noise, its presence in the catalog
  // is the bug.
  const offered = (prompt, name) => new RegExp(`^- ${name} : `, "m").test(prompt.split("## Exercices à ne jamais proposer")[0].split("## Plafonds")[0]);

  const SUBJECT = "Squat";

  it("sanity check: the fixture exercise IS offered while active", () => {
    const p = buildSystemPrompt(CATALOG_GROUPS, EQUIPMENT, CATALOG_BLACKLIST, STRUCTURE, COACHING);
    expect(offered(p, SUBJECT)).toBe(true);
  });

  it("withdraws it when deactivated WITH a reason", () => {
    expect(offered(deactivate(SUBJECT, "Douleur genou"), SUBJECT)).toBe(false);
  });

  it("withdraws it when deactivated with NO reason — the state the list button creates", () => {
    expect(offered(deactivate(SUBJECT, null), SUBJECT)).toBe(false);
  });

  it("withdraws only that exercise", () => {
    const p = deactivate(SUBJECT, null);
    expect(offered(p, "Squat sumo")).toBe(true);
    expect(offered(p, "Squat gobelet")).toBe(true);
  });

  // The reason is what the coach is TOLD, and it is still the only thing that
  // earns a line in the blacklist section — the two halves stay separate.
  it("explains it only when a reason was given", () => {
    expect(deactivate(SUBJECT, "Douleur genou")).toContain(`- ${SUBJECT} : Douleur genou`);
    expect(deactivate(SUBJECT, null)).not.toContain(`- ${SUBJECT} : Douleur genou`);
  });
});

/*
 * The bar-height section is omitted when EITHER group is empty, not only when
 * both are. "Never mix these two groups" says nothing with one group, and the
 * empty half rendered as a bare `()`. That became reachable in one tap the
 * moment the user could deactivate an exercise: `Traction australienne` is the only
 * low-bar entry in the catalog.
 */
describe("buildSystemPrompt — the bar-height section needs both groups", () => {
  const promptWithout = (name) => {
    const views = buildCatalogViews({
      ...seed,
      exercises: seed.exercises.map((ex) =>
        ex.name === name ? { ...ex, active: false, inactiveReason: "Douleur épaule" } : ex
      ),
    });
    const { equipment, structure, coaching } = buildPromptInputs(views);
    return buildSystemPrompt(views.muscleGroups, equipment, views.blacklist, structure, coaching);
  };

  const ONLY_LOW_BAR = CATALOG_ALL.filter((n) => CATALOG_DESCRIPTIONS[n]?.barHeight === "basse");

  it("sanity check: exactly one low-bar exercise, so deactivating it empties that group", () => {
    expect(ONLY_LOW_BAR).toHaveLength(1);
  });

  it("drops the section entirely rather than rendering an empty list", () => {
    const p = promptWithout(ONLY_LOW_BAR[0]);
    expect(p).not.toMatch(/réglage basse \(\)/i);
    expect(p).not.toMatch(/Barre de traction : réglée/i);
  });

  it("keeps the section while both groups have an exercise", () => {
    const p = buildSystemPrompt(CATALOG_GROUPS, EQUIPMENT, CATALOG_BLACKLIST, STRUCTURE, COACHING);
    expect(p).toMatch(/Barre de traction : réglée/i);
  });
});

// The enum the API enforces on the emit path and the catalog the model is shown
// have to be the same set. They are computed once, here, precisely so they
// cannot drift — a name in the prompt but not the enum is unpickable with
// nothing to explain why, and a name in the enum but filtered out of the prompt
// makes a blacklisted movement emittable.
describe("offeredExerciseNames — the enum and the model-facing catalog agree", () => {
  const NAMES = offeredExerciseNames(STRUCTURE.exerciseAvailability, CATALOG_BLACKLIST);
  const emit = buildSystemPrompt(
    CATALOG_GROUPS, EQUIPMENT, CATALOG_BLACKLIST, STRUCTURE, COACHING, "plan-emit"
  );
  const catalogSection = emit
    .split("## Exercices disponibles dans l'app")[1]
    .split("## Charges réalisables")[0];

  it("is not vacuous: the real catalog offers a substantial list", () => {
    expect(NAMES.length).toBeGreaterThan(20);
  });

  it("every offered name is rendered in the model-facing catalog", () => {
    for (const name of NAMES) {
      expect(catalogSection, `${name} is in the enum but not in the prompt`).toContain(name);
    }
  });

  it("no blacklisted name is offered", () => {
    for (const { name } of CATALOG_BLACKLIST) {
      expect(NAMES, `${name} must never be emittable`).not.toContain(name);
    }
  });

  // The other direction, and the one a one-way check would miss: an exercise
  // she has no equipment for is filtered out of the prompt, so it must be out
  // of the enum too.
  it("no unavailable exercise is offered", () => {
    const unavailable = Object.entries(STRUCTURE.exerciseAvailability)
      .filter(([, e]) => Array.isArray(e?.locations) && e.locations.length === 0)
      .map(([name]) => name);
    expect(unavailable.length, "fixture sanity: some exercise must be unavailable").toBeGreaterThan(0);
    for (const name of unavailable) {
      expect(NAMES, `${name} has no location and must not be emittable`).not.toContain(name);
    }
  });

  it("survives a missing availability map or blacklist rather than throwing", () => {
    expect(offeredExerciseNames(undefined, undefined)).toEqual([]);
    expect(offeredExerciseNames(null, [])).toEqual([]);
  });
});

// The reply-shape reminder sits in the last user turn on the explicit thesis
// that the NEARER rule wins. That cuts both ways: it now bans the shape the
// notebook block uses ("pas de séparateurs, pas de titres de section") and,
// mid-séance, asks for "la consigne et rien d'autre" — while the instruction to
// emit the sentinel stays in the system prompt, the far block this very branch
// argues is not reliably obeyed.
//
// This repo has already lost its notebook silently for weeks once, the markdown
// fallback has fired 0 times in 67 replies, and nothing in the suite can see the
// failure. Two live calls (including the mid-séance case) did NOT reproduce it —
// this exemption is bought on the asymmetry, not on observed breakage.
describe("the shape reminder must not suppress the notebook", () => {
  it.each(["discussion", "plan"])("exempts the notebook block in %s mode", (mode) => {
    const reminder = buildReplyShapeReminder(mode);
    expect(reminder).toContain("<<<NOTEBOOK>>>");
    expect(reminder).toMatch(/n'est concerné par aucune de ces règles/);
    // Regression: f6f18e4 — the reminder said « tu l'écris TOUJOURS » while
    // the notebook rule says to send nothing when nothing durable changed; the
    // nearer rule won and a block was pushed out every turn.
    expect(reminder).toContain("dès qu'un fait durable change");
    expect(reminder).not.toMatch(/TOUJOURS/);
  });

  // The exemption is worthless if it names a sentinel the notebook section does
  // not actually ask for — the two must be the same literal string.
  it("names the same sentinel the notebook section instructs", () => {
    const prompt = buildSystemPrompt(
      CATALOG_GROUPS, EQUIPMENT, CATALOG_BLACKLIST, STRUCTURE, COACHING, "discussion"
    );
    expect(prompt).toContain("<<<NOTEBOOK>>>");
    expect(buildReplyShapeReminder("discussion")).toContain("<<<NOTEBOOK>>>");
  });

  // ...and it must not leak onto the emit path, where the notebook is a schema
  // FIELD and the sentinel is literally unemittable under additionalProperties.
  it("says nothing about a sentinel on the emit path", () => {
    expect(buildReplyShapeReminder("plan-emit")).toBe("");
  });
});

/**
 * Belt and suspenders on the unit. The prompt tells the coach to write a bare
 * number of SECONDS for a held exercise; `validatePlanDomain` stamps
 * `metric: "seconds"` from the catalog and normalises the value. Between those
 * two the model needs to know WHICH entries are counted that way — otherwise it
 * writes `reps: "12"` for a plank meaning repetitions, `normalizeReps` parses it
 * cleanly with no warning and no error, and the app records a 12-second plank.
 * A validator rule the model has no data to comply with is the exact shape this
 * project's belt-and-suspenders rule exists to prevent.
 */
describe("the model-facing catalog marks which exercises are counted in seconds", () => {
  // The REAL production path: the seed catalog through `buildPromptInputs`,
  // exactly as `coach-chat` builds it.
  const cat = buildCatalogViews(seed);
  const { equipment, structure, coaching } = buildPromptInputs(cat);
  // Same call shape as `coach-chat.js:191`.
  const prompt = buildSystemPrompt(cat.muscleGroups, equipment, cat.blacklist, structure, coaching);

  it("marks every seconds-counted exercise on its own catalog line", () => {
    // Hollow Body is deactivated, so it is filtered out of the model-facing
    // catalog and is deliberately not expected here.
    for (const name of ["Dead hang", "Chaise murale", "Gainage planche", "Gainage latéral"]) {
      expect(prompt, name).toMatch(new RegExp(`${name}\\s*\\[SÉRIES EN SECONDES\\]`));
    }
  });

  it("leaves rep-counted exercises unmarked, including the tempo decoys", () => {
    // The four whose prose mentions holding but which count repetitions. If
    // the marker followed the description text instead of `metric`, these are
    // what it would wrongly catch.
    for (const name of ["Shrugs", "Pont fessier", "Bird dog", "Squat"]) {
      expect(prompt, name).not.toMatch(new RegExp(`${name}\\s*\\[SÉRIES EN SECONDES\\]`));
    }
  });

  it("marks exactly as many entries as the catalog says are holds", () => {
    const marked = (prompt.match(/\[SÉRIES EN SECONDES\]/g) ?? []).length;
    // OFFERED, not every catalog entry: Hollow Body is a hold but is
    // deactivated, so it is filtered out of the model-facing listing — and a
    // marker for an exercise the coach cannot pick would be noise.
    const offered = offeredExerciseNames(structure.exerciseAvailability, cat.blacklist);
    const holds = offered.filter((n) => structure.exerciseAvailability?.[n]?.metric === "seconds").length;
    expect(marked).toBe(holds);
    expect(marked).toBeGreaterThan(0);
  });
});

// Mistral matches `prompt_cache_key` on PREFIX and bills cached input at 10% of
// list (docs read 2026-09-30). Measured on coach_usage 2026-08-30 → 09-30: 5.0M
// prompt tokens a month, and only ~12% of them reported as cached — because the
// history window slid by one message per turn once full, and budgetHistory's
// abridge cutoff rewrote one turn mid-prefix on every request. Both now move in
// blocks, so the prefix is byte-identical for HISTORY_BLOCK consecutive rows.
describe("alignHistoryWindow — the prefix moves in blocks so the vendor cache can hit", () => {
  const W = 40, B = HISTORY_BLOCK, LIMIT = W + B - 1; // 49, what coach-chat.js loads
  const table = (t) =>
    Array.from({ length: t }, (_, i) => ({ id: i + 1, role: i % 2 ? "assistant" : "user", content: `m${i + 1}` }));
  // What the loader returns when the table holds `t` rows: the last LIMIT rows, plus the total.
  const load = (t) => ({ rows: table(t).slice(-LIMIT), total: t });
  const kept = (t) => {
    const { rows, total } = load(t);
    return alignHistoryWindow(rows, { window: W, block: B, total });
  };

  it("is ten rows, five exchanges", () => {
    expect(HISTORY_BLOCK).toBe(10);
  });

  it("returns everything when the table holds at most `window` rows", () => {
    expect(kept(40)).toHaveLength(40);
    expect(kept(7)).toHaveLength(7);
    expect(kept(0)).toEqual([]);
  });

  // Regression: 2026-09-30 plan review — a version that computed the drop from
  // rows.length passed tests fed an ever-growing list, but in production the
  // loader always returns 49 rows, so it dropped 9 every turn and the window
  // still slid by one message per turn.
  it("with a table far longer than the LIMIT, the first kept row is fixed for a whole block", () => {
    for (let t = 300; t < 310; t++) expect(kept(t)[0].id).toBe(kept(300)[0].id);
    expect(kept(310)[0].id).toBe(kept(300)[0].id + 10);
  });

  it("keeps a suffix of the table, between `window` and `window + block - 1` rows", () => {
    for (let t = 0; t <= 400; t++) {
      const out = kept(t);
      expect(out.length).toBeGreaterThanOrEqual(Math.min(t, W));
      expect(out.length).toBeLessThanOrEqual(W + B - 1);
      if (t) expect(out.at(-1).id).toBe(t);
      expect(out.map((r) => r.id)).toEqual(table(t).slice(-out.length).map((r) => r.id));
    }
  });

  // The block start is even, so the window always opens on her question rather
  // than on a reply to a question the model cannot see.
  it("always opens the window on a user turn when the transcript alternates", () => {
    for (let t = 41; t <= 200; t++) expect(kept(t)[0].role).toBe("user");
  });

  it("without `total` it falls back to rows.length (tests and legacy callers)", () => {
    expect(alignHistoryWindow(table(57), { window: W, block: B })[0].id).toBe(11);
  });

  it("ignores a `total` smaller than what was loaded, and survives no rows at all", () => {
    expect(alignHistoryWindow(table(57), { window: W, block: B, total: 3 })[0].id).toBe(11);
    expect(alignHistoryWindow(undefined, { window: W })).toEqual([]);
  });
});

// The composition is what the vendor sees, so this is the test that the cache
// can actually hit: loader shape → alignHistoryWindow → annotateHistory →
// buildMessages, exactly as coach-chat.js chains them.
describe("buildMessages — the prompt prefix is byte-identical within a block", () => {
  const W = 40, LIMIT = W + HISTORY_BLOCK - 1;
  const t0 = Date.UTC(2026, 8, 1, 7, 0);
  // Realistic sizes (her questions short, his replies long enough to abridge),
  // and timestamps with a session gap every 12 rows so annotateHistory's breaks
  // and stamps are part of the prefix being compared.
  const row = (i) => ({
    id: i + 1,
    role: i % 2 ? "assistant" : "user",
    content: i % 2 ? `Réponse ${i + 1}. ${"x".repeat(2000)}` : `Question ${i + 1} ?`,
    created_at: new Date(t0 + i * 60_000 + Math.floor(i / 12) * 8 * 3_600_000).toISOString(),
    total: "ignored",
  });
  const table = (t) => Array.from({ length: t }, (_, i) => row(i));
  const kept = (t) => {
    const rows = table(t).slice(-LIMIT);
    return alignHistoryWindow(rows, { window: W, total: t });
  };
  const build = (t, now = new Date(t0 + 30 * 86_400_000)) =>
    buildMessages({
      systemPrompt: "SYS",
      notebook: "NB",
      exportContext: "EXP",
      history: annotateHistory(kept(t)),
      userMessage: "U",
      now,
      mode: "discussion",
      historyWindow: W,
    });

  // Regression: 2026-09-30 plan review — budgetHistory abridged at
  // `turns.length - RECENT_VERBATIM`, which moves every turn, so even with the
  // window held still one turn mid-prefix was rewritten on every request.
  it("keeps every message up to the last history row of the block's first turn deep-equal", () => {
    const prefixLen = 1 + kept(300).length; // system + history at t = 300
    const ref = build(300).slice(0, prefixLen);
    for (let t = 301; t < 310; t++) expect(build(t).slice(0, prefixLen), `t=${t}`).toEqual(ref);
  });

  it("when the window moves, the first message that differs is the first history row", () => {
    const a = build(309), b = build(310);
    expect(a[0]).toEqual(b[0]); // the system prompt
    expect(a[1]).not.toEqual(b[1]);
  });

  it("keeps at least the last RECENT_VERBATIM rows verbatim at every length", () => {
    for (let t = 1; t <= 200; t++) {
      const msgs = build(t);
      const history = msgs.slice(1, -1);
      for (const m of history.slice(-RECENT_VERBATIM)) expect(m.content, `t=${t}`).not.toContain(ABRIDGED_NOTE);
    }
  });

  it("sends only role and content, never the loader's id or total", () => {
    for (const m of build(300)) expect(Object.keys(m).sort()).toEqual(["content", "role"]);
  });

  // The one per-request date is `## Aujourd'hui`, and it must sit in the LAST
  // message, after history — anywhere earlier and every request is a miss.
  it("a different `now` changes only the last message", () => {
    const a = build(305, new Date(t0 + 30 * 86_400_000));
    const b = build(305, new Date(t0 + 31 * 86_400_000));
    expect(a.slice(0, -1)).toEqual(b.slice(0, -1));
    expect(a.at(-1)).not.toEqual(b.at(-1));
  });
});

describe("budgetHistory — the abridge cutoff moves in blocks", () => {
  const turns = (n) =>
    Array.from({ length: n }, (_, i) =>
      i % 2 ? { role: "assistant", content: `R${i}. ${"y".repeat(2000)}` } : { role: "user", content: `Q${i}` }
    );
  const abridgedCount = (out) => out.filter((m) => m.content.includes(ABRIDGED_NOTE)).length;

  it("with a full window, abridges exactly the rows before `window - RECENT_VERBATIM`", () => {
    for (const n of [40, 45, 49]) {
      const out = budgetHistory(turns(n), { window: 40 });
      out.forEach((m, i) => {
        if (m.role === "assistant") expect(m.content.includes(ABRIDGED_NOTE), `n=${n} i=${i}`).toBe(i < 40 - RECENT_VERBATIM);
      });
    }
  });

  it("before the window is full, the cutoff only moves on a block boundary", () => {
    // Rows 0..9 are abridgeable from length 22 on, and nothing more until 32.
    expect(abridgedCount(budgetHistory(turns(21)))).toBe(0);
    for (let n = 22; n < 32; n++) expect(abridgedCount(budgetHistory(turns(n))), `n=${n}`).toBe(5);
    expect(abridgedCount(budgetHistory(turns(32)))).toBe(10);
  });
});

// Tuned for Claude Sonnet 5.5 on 2026-10-12 against her history: the
// complaints that recur whatever the model are jargon she cannot parse,
// constraints she has to repeat, invented explanations for something she says
// is missing, and length. Measured on 13 real cases (Sonnet, production
// shape): 7/13 → 10/13, « c'est beaucoup trop long » answered in 512 chars
// instead of 819, « la séance est incomplète » answered from her data instead
// of « l'écriture a dû s'interrompre ».
describe("rules tuned on real coaching history (2026-10-12)", () => {
  const prompt = (mode) => buildSystemPrompt(GROUPS, EQUIPMENT, [], STRUCTURE, COACHING, mode);

  it("asks for plain words and standing constraints in every mode, the plan emit included", () => {
    for (const mode of ["discussion", "plan", "plan-emit"]) {
      expect(prompt(mode)).toMatch(/Le jargon s'explique/);
      expect(prompt(mode)).not.toMatch(/pas du métier/);
      expect(prompt(mode)).toMatch(/Ce que Camille a fixé tient jusqu'à ce qu'elle le change/);
    }
  });

  it("tells the conversational modes to check her data, not invent a cause, and to own the memory limit", () => {
    for (const mode of ["discussion", "plan"]) {
      expect(prompt(mode)).toMatch(/N'invente pas de\s+cause/);
      expect(prompt(mode)).toMatch(/ne dis jamais qu'elle n'a pas eu lieu/);
    }
    expect(prompt("plan-emit")).not.toMatch(/N'invente pas de\s+cause/);
  });

  it("asks the notebook to keep what she has fixed", () => {
    expect(prompt("discussion")).toMatch(/Note ce qu'elle a fixé/);
  });

  it("gives the reply a word budget and one-sentence corrections, in the reminder only", () => {
    const r = buildReplyShapeReminder("discussion");
    expect(r).toMatch(/80 à 150 mots/);
    expect(r).toMatch(/trois phrases au plus/);
    expect(r).toMatch(/UNE CORRECTION TIENT EN UNE PHRASE/);
    expect(prompt("discussion")).not.toMatch(/80 à 150 mots|UNE CORRECTION TIENT EN UNE PHRASE/);
    expect(buildReplyShapeReminder("plan-emit")).toBe("");
  });
});

describe("the persona: name, grammatical gender, coach notes", () => {
  const build = (profile, mode = "discussion", catalog = CATALOG) => {
    const inputs = buildPromptInputs(catalog, profile);
    return buildSystemPrompt(catalog.muscleGroups, inputs.equipment, catalog.blacklist, inputs.structure, inputs.coaching, mode);
  };
  const MODES = ["discussion", "plan", "plan-emit"];

  it("states the profile's name, never a name from the code", () => {
    const p = build({ ...TEST_PROFILE, name: "Noa" });
    expect(p).toContain("coach fitness personnel de Noa");
    expect(p).toContain("Tu tutoies Noa");
    expect(p).not.toContain("Camille");
  });

  it("agrees with the profile's gender", () => {
    const f = build({ ...TEST_PROFILE, gender: "f" });
    const m = build({ ...TEST_PROFILE, gender: "m" });
    expect(f).toContain("Tu la suis semaine après");
    expect(f).toContain("ce qu'elle attend");
    expect(m).toContain("Tu le suis semaine après");
    expect(m).toContain("ce qu'il attend");
    expect(m).not.toContain("ce qu'elle attend");
    // A participle that agrees with the user: « venu » / « venue » (in the
    // reply-shape reminder, which carries the persona too).
    const reminder = (gender) => buildReplyShapeReminder("discussion", resolvePersona({ name: "Camille", gender }));
    expect(reminder("f")).toContain("Elle est venue chercher");
    expect(reminder("m")).toContain("Il est venu chercher");
  });

  it("leaves no template token behind, in any mode, gender or with notes", () => {
    for (const mode of MODES) {
      for (const gender of ["f", "m", undefined]) {
        const p = build({ ...TEST_PROFILE, gender, coachNotes: "Une note." }, mode);
        expect(p, `${mode}/${gender}`).not.toMatch(/\{\{|\}\}/);
        expect(p).not.toContain("\u0000");
      }
    }
    for (const mode of ["discussion", "plan"]) {
      const reminder = buildReplyShapeReminder(mode, { name: "Noa", she: "il", She: "Il", her: "lui", self: "lui-même", la: "le", e: "" });
      expect(reminder).not.toMatch(/\{\{|\}\}/);
      expect(reminder).toContain("Noa te lit dans une conversation");
    }
  });

  it("falls back to neutral words with no profile, and the fallback IS what an empty profile resolves to", () => {
    const p = build(undefined);
    expect(p).toContain("coach fitness personnel de l'utilisatrice");
    expect(FALLBACK_PERSONA).toEqual(resolvePersona(undefined));
    expect(Object.isFrozen(FALLBACK_PERSONA)).toBe(true);
  });

  it("capitalises a token that opens a sentence, a line or a quotation", () => {
    const persona = resolvePersona({ name: "noa", gender: "m" });
    const out = renderPersona("{{name}} arrive. Puis {{she}} part.\n- {{she}} reste\n  {{name}} dort « {{she}} rêve » {{NAME}}", persona);
    expect(out).toBe("Noa arrive. Puis il part.\n- Il reste\n  Noa dort « Il rêve » NOA");
  });

  describe("coach notes", () => {
    it("adds a section only when the profile has notes, framed as completing the rules and not replacing them", () => {
      const without = build({ ...TEST_PROFILE, coachNotes: "" });
      expect(without).not.toContain("## Ce que tu sais de");
      const withNotes = build({ ...TEST_PROFILE, coachNotes: "Préfère les séances courtes." });
      expect(withNotes).toContain("## Ce que tu sais de Camille");
      expect(withNotes).toContain("Préfère les séances courtes.");
      expect(withNotes).toMatch(/Elles complètent les règles de ce prompt et ne les remplacent pas/);
    });

    it("splices the notes in verbatim: tokens and replacement patterns in them are not interpreted", () => {
      const p = build({ ...TEST_PROFILE, coachNotes: "{{she}} $& $1 {{name}}" });
      expect(p).toContain("{{she}} $& $1 {{name}}");
    });

    it("keeps the notes out of the system prompt's other sections: one occurrence, in every mode", () => {
      for (const mode of MODES) {
        const p = build({ ...TEST_PROFILE, coachNotes: "NOTE-UNIQUE-42" }, mode);
        expect(p.split("NOTE-UNIQUE-42")).toHaveLength(2);
      }
    });
  });

  describe("cycle periodization is opt-in", () => {
    const off = { ...TEST_PROFILE, cycle: { enabled: false, lengthDays: 28 } };
    const on = { ...TEST_PROFILE, cycle: { enabled: true, lengthDays: 28 } };

    it("says nothing about a cycle when the profile did not ask for it", () => {
      for (const mode of MODES) {
        const p = build(off, mode);
        expect(p, mode).not.toMatch(/cycle/i);
        expect(p, mode).not.toContain("prémenstruel");
      }
    });

    it("keeps the load-progression guidance whatever the cycle says", () => {
      for (const mode of MODES) {
        expect(build(off, mode)).toContain("## Quand augmenter une charge");
        expect(build(on, mode)).toContain("## Quand augmenter une charge");
      }
    });

    it("states the cycle section, with the length derived from the profile, when it is on", () => {
      for (const mode of MODES) {
        const p = build(on, mode);
        expect(p).toContain("## Cycle et périodisation");
        expect(p).toContain("Cycle d'environ 28 jours");
        expect(p).toContain("JAMAIS son jour de cycle");
      }
    });

    it("does not tell the notebook about a cycle that is off", () => {
      expect(build(off, "discussion")).not.toContain("JAMAIS son jour de cycle");
    });
  });

  describe("the equipment section follows the inventory", () => {
    const withInventory = (inventory) => {
      const catalog = buildCatalogViews(seed, inventory);
      return build({ ...TEST_PROFILE, inventory }, "discussion", catalog);
    };

    it("states only the implements the user has", () => {
      const noBars = withInventory({ ...TEST_INVENTORY, barCount: 0 });
      expect(noBars).toContain("Haltères (1 paire réglable, par main)");
      expect(noBars).not.toContain("Barres chargeables (par main");
      expect(noBars).not.toContain("Une seule configuration de barre chargée par séance");
      expect(noBars).toMatch(/se charge aux haltères\./);

      const noDumbbells = withInventory({ ...TEST_INVENTORY, dumbbellOptionsKg: [] });
      expect(noDumbbells).not.toContain("Haltères (1 paire réglable");
      expect(noDumbbells).toContain("Barres chargeables (par main");
    });

    it("says outright that nothing external is available when nothing is", () => {
      const none = withInventory({ ...TEST_INVENTORY, dumbbellOptionsKg: [], barCount: 0, owned: [] });
      expect(none).toContain("Aucune charge externe n'est disponible");
    });

    it("mentions ankle weights and elastics only when owned", () => {
      const bare = withInventory({ ...TEST_INVENTORY, owned: ["dumbbell", "bar"] });
      expect(bare).not.toMatch(/lests cheville/);
      expect(bare).not.toMatch(/Élastiques/);
      const equipped = withInventory(TEST_INVENTORY);
      expect(equipped).toMatch(/Élastiques hanches uniquement \(pas d'élastiques bras\), lests cheville 1 kg\./);
    });

    it("withholds the exercises the inventory makes impossible, and offers them once the user owns the kit", () => {
      const benchExercise = CATALOG_ALL.find(
        (name) => CATALOG_DESCRIPTIONS[name].equipmentNeeds.includes("bench") && !CATALOG_DESCRIPTIONS[name].implementTypes.includes("cardio")
      );
      expect(benchExercise).toBeDefined();
      const listed = (p) => p.split("\n").some((line) => line.startsWith(`- ${benchExercise} `) || line.startsWith(`- ${benchExercise} :`));
      expect(listed(withInventory(TEST_INVENTORY))).toBe(false);
      expect(listed(withInventory({ ...TEST_INVENTORY, owned: [...TEST_INVENTORY.owned, "bench"] }))).toBe(true);
    });
  });

  describe("buildMessages", () => {
    it("addresses the user's data and message by the persona's name", () => {
      const out = buildMessages({
        systemPrompt: "s", notebook: "", exportContext: "data", history: [], userMessage: "salut",
        now: new Date("2026-10-01T10:00:00Z"), mode: "discussion", persona: resolvePersona({ name: "Noa", gender: "m" }),
      });
      const last = out.at(-1).content;
      expect(last).toContain("## Données actuelles de Noa\ndata");
      expect(last).toContain("## Message de Noa\nsalut");
      expect(last).not.toContain("Camille");
    });

    it("never interprets a token inside the user's own message or data", () => {
      const out = buildMessages({
        systemPrompt: "s", notebook: "", exportContext: "{{name}}", history: [], userMessage: "{{she}}",
        now: new Date("2026-10-01T10:00:00Z"), mode: "plan-emit", persona: resolvePersona({ name: "Noa" }),
      });
      expect(out.at(-1).content).toContain("{{name}}");
      expect(out.at(-1).content).toContain("{{she}}");
    });
  });
});
