/**
 * Domain guardrail for a parsed coach plan — the layer between "JSON was
 * turned into a structure" (`planFromJson.js`) and "this structure is safe to
 * hand to the app". No React, no I/O.
 *
 * This is where the guardrails built in earlier tasks actually fire: no
 * coach-generated plan reaches the user without going through
 * `validatePlanDomain`. See `.superpowers/sdd/2026-07-26-belle-forme-coach-
 * guardrails/constraints.md` for the binding rules this module enforces.
 *
 * Severities, never conflated (owner rulings, constraints.md and the Task 4
 * fix-report addendum):
 * - A prescribed weight that isn't an achievable value, but sits at or below
 *   the exercise's ceiling -> WARNING. Rounded DOWN to the nearest achievable
 *   value; import proceeds with the corrected weight.
 * - A prescribed weight that exceeds the exercise's ceiling -> BLOCKING
 *   ERROR. Import does not proceed; the weight is never silently rounded.
 * - A session requiring more than one plated bar configuration -> WARNING
 *   (owner ruling). Import proceeds.
 * - A session mixing a high-bar and a low-bar pull-up exercise -> BLOCKING
 *   ERROR. Not the same severity as the plated-bar rule above and deliberately
 *   so: plates can be changed mid-session at a cost in time, the bar height is
 *   not changed at all, so there is no corrected plan to let through.
 * - An exercise name that does not resolve (forgivingly — trimmed,
 *   case-insensitive) to a catalog entry -> BLOCKING ERROR. Import does not
 *   proceed, and the name is never auto-corrected to the "nearest" entry.
 * - An exercise name that DOES resolve is rewritten to its canonical catalog
 *   key in the corrected plan, silently (no warning). Every downstream catalog
 *   lookup is an exact string match, so storing the coach's own spelling would
 *   pass validation and then break the Lexique and the stats.
 * - A `/main` (per-hand) suffix on a single-implement (non-bilateral)
 *   exercise -> WARNING, regardless of whether the numeric load itself is
 *   valid. The corrected plan's `weightType` is normalized to `"total"` so
 *   the app never renders a meaningless "X kg/main" label for an exercise
 *   that only has one implement to begin with.
 * - A home session's `warmup` OR `cooldown` containing a recognised cardio,
 *   not-allowed-at-home, or externally-loaded catalog exercise (e.g.
 *   `Rameur`) -> BLOCKING ERROR. This is THE canonical failure this whole
 *   plan exists to prevent (see `checkWarmupCooldownContentRule`).
 *   Unrecognised free-text items (the norm — most mobility and stretching
 *   movements aren't in the catalog) are always allowed.
 * - A home session prescribing a MAIN exercise that isn't doable at home
 *   (`Développé incliné` needs a bench, `Tirage vertical élastique` needs a
 *   high-anchored upper-body elastic) -> BLOCKING ERROR naming the missing
 *   equipment (`checkHomeExerciseLocationRule`). Cardio lines are excluded —
 *   they are T3.3's error, never reported twice.
 * - A core exercise (the catalog's `Core` group) on a session whose only non-core
 *   work is `Lower Body` -> BLOCKING ERROR (T3.1, `checkCoreOnLowerBodyDayRule`).
 * - More than 4 exercises in a force session (`isHomeSession` true) ->
 *   WARNING, never blocking (T3.2, `checkExerciseCountRule`).
 * - A session mixing at least one cardio exercise with at least one non-cardio
 *   exercise -> BLOCKING ERROR (T3.3, `checkCardioMixingRule`). A pure cardio
 *   session and a pure force session are both fine.
 * - A blacklisted exercise (`findBlacklistEntry`, `./catalog.js`) anywhere in
 *   a plan — main exercise line, warmup, or cooldown -> BLOCKING ERROR naming
 *   the reason and, where one exists, the suggested replacement (T3.4). The
 *   line/item is left untouched; blacklisting never corrects, only blocks.
 *
 * **Every exported function takes the CATALOG as its last argument, required.**
 * The catalog is a document in Neon now, so nothing here may import the
 * build-time constants: a validator reading its own copy of the exercise list
 * would enforce yesterday's rules against today's plan, silently. There is
 * deliberately no default and no fallback to the seed — a missing catalog
 * throws (`requireCatalog`), because it is a programming error and must fail at
 * the first test that exercises the path rather than in production.
 *
 * Extensibility: this module is organized around two small rule-family
 * lists, `LINE_RULES` (per exercise line, can correct the line) and
 * `SESSION_RULES` (read-only, once per session, over the corrected lines).
 * T3.1/T3.2/T3.3 are `SESSION_RULES` entries — they each reason about a
 * whole session's exercise list, not one line at a time. T3.4 (the
 * blacklist) is split across TWO surfaces for a reason worth remembering if
 * a future rule needs the same shape: the main-exercise-line half runs
 * inline in `validatePlanDomain`'s exercise-mapping step, BEFORE catalog
 * resolution — not as a `LINE_RULES` entry — because it must reject a name
 * that has no catalog entry at all (`Hip thrust`, carried by the document's
 * `forbiddenNames`), which every existing `LINE_RULES` function assumes has
 * already resolved. The warmup/cooldown half
 * (`checkBlacklistInWarmupCooldownRule`) fits the `SESSION_RULES` shape fine
 * and is registered there. Adding a rule to either list is otherwise
 * the only change `validatePlanDomain`'s aggregation needs; no restructuring.
 * The exported `isHomeSession(exercises, catalog)` helper (Task 7) is the single
 * source of truth for "is this a home session or a pure-cardio gym session";
 * T3.2 reuses it directly ("force session" = "not a pure cardio session" =
 * `isHomeSession`'s own definition) and T3.3 pairs it with a second, small
 * predicate (`sessionHasCardioExercise`, "does this session contain any
 * cardio at all") rather than inventing a competing definition of either
 * notion — `isHomeSession` alone can't distinguish a pure-force session from
 * a mixed cardio+force one, since both resolve to `true`.
 */

import { planFromJson, formatSets, normalizeReps } from "./planFromJson.js";
import {
  isLoadValid,
  roundToAchievable,
  computeTotalAndPerHand,
  checkSessionBarConfigurations,
} from "./loadValidation.js";
import { requireCatalog, findBlacklistEntry, canonicalExerciseName } from "./catalog.js";
import { deriveLocations, describeHomeBlockers } from "../constants/equipment.js";
import { normalizeBlacklistName } from "../constants/index.js";

/** Tolerance for floating-point weight comparisons, matching `loadValidation.js` (1e-6, not 1e-10 — too tight at scale). */
const EPS = 1e-6;

/**
 * Structure rules (constraints.md, handoff section 3), exported so the coach's
 * system prompt can STATE the rule this module ENFORCES instead of retyping it
 * as prose. A number or a group name written twice is a number or a group name
 * that eventually disagrees with itself.
 */

/** Above this many exercises, a force session gets a warning (`checkExerciseCountRule`). */
export const USUAL_EXERCISES_PER_FORCE_SESSION = 4;

/** The catalog group key holding core work — never allowed on a lower-body day. */
export const CORE_MUSCLE_GROUP = "Core";

/** The catalog group key that defines a "lower-body day" (`checkCoreOnLowerBodyDayRule`). */
export const LOWER_BODY_MUSCLE_GROUP = "Lower Body";

/** Formats one exercise line's prescribed weight for a French message, e.g. "12.5 kg/main". Mirrors `loadValidation.js`'s private helper of the same name. */
function formatWeightForWarning(weightKg, weightType) {
  return `${weightKg} kg${weightType === "per_hand" ? "/main" : ""}`;
}

/**
 * Resolves a raw exercise name (as written by the coach) to its exact
 * `catalog.descriptions` key, matching forgivingly so a trailing
 * space or a lowercase initial doesn't reject an otherwise valid plan:
 * surrounding whitespace is trimmed, then the comparison falls back to
 * case-insensitive if there's no exact match. Returns `null` when nothing in
 * the catalog matches even case-insensitively (an unresolvable name — see
 * the "unknown exercise" rule in `validatePlanDomain`).
 *
 * Pure — never mutates the caller's copy of the name. What the CALLER then
 * does with the result differs by outcome, and the distinction matters:
 * a name that resolved is stored as the returned catalog key (normalization —
 * see `validatePlanDomain`), while a name that did NOT resolve is rejected
 * outright and kept verbatim (per the owner's ruling: never guess at the
 * "nearest" catalog entry).
 */
function resolveCatalogName(rawName, catalog) {
  const { descriptions } = catalog;
  const trimmed = rawName.trim();
  if (Object.prototype.hasOwnProperty.call(descriptions, trimmed)) return trimmed;

  // An old name is resolved to the current one rather than rejected. The coach's
  // notebook is free text and cannot be migrated, so a retired name can resurface
  // from it at any time; blocking the import over that costs a full round-trip
  // for something the alias map answers exactly. This is NOT guessing at the
  // nearest entry — the map is explicit — so the owner's ruling still holds.
  const aliased = canonicalExerciseName(trimmed, catalog);
  if (aliased !== trimmed && Object.prototype.hasOwnProperty.call(descriptions, aliased)) {
    return aliased;
  }

  const lower = trimmed.toLowerCase();
  for (const key of Object.keys(descriptions)) {
    if (key.toLowerCase() === lower) return key;
  }
  return null;
}

/**
 * Formats a blocking blacklist error (T3.4/T3.4b). Shared by the main
 * exercise-line check and the warmup/cooldown check so the two surfaces
 * never drift into two different message shapes.
 */
function formatBlacklistError(sessionLabel, rawName, entry) {
  const replacement = entry.replacedBy ? ` Remplacement suggéré : ${entry.replacedBy}.` : "";
  return `${sessionLabel} : « ${rawName} » est sur liste noire (${entry.reason}).${replacement} Import bloqué.`;
}

/**
 * Loosened blacklist match for `warmup`/`cooldown` items ONLY (fix round,
 * coordinator review 2026-07-26, Finding 1). `findBlacklistEntry` (used for
 * the main exercise line) is a WHOLE-NAME match — right there, because a
 * main exercise line names one specific catalog exercise and a false
 * positive would wrongly block an unrelated one. But a warmup/cooldown item
 * is free text with no catalog backstop to catch a near miss: unlike the
 * main-exercise-line path, there is no `resolveCatalogName` step to reject
 * "Hollow Body hold" as an unrecognised name — free text is always allowed
 * there by design (see `checkWarmupCooldownContentRule`). Exact-match
 * checking therefore let real bypasses straight through: `- Hollow Body
 * hold | 3×30s`, `- Russian twists | 1×20`, `- Hip thrusts | 3×12`,
 * `- Gainage hollow body | 3×30s` all previously imported with zero errors,
 * and an exercise is often blacklisted for a safety reason rather than a
 * preference — such a bypass has a real cost.
 *
 * Fix: match when the normalized item name CONTAINS a normalized blacklist
 * name as a substring (both sides trimmed, lowercased, diacritics stripped
 * via `normalizeBlacklistName`). This is safe specifically because the
 * blacklist is only a handful of specific names — substring matching against
 * the full ~70-exercise catalog (what `checkWarmupCooldownContentRule` does)
 * would wrongly reject legitimate free-text mobility items, which is why THAT
 * check must stay whole-string and is NOT changed by this fix.
 *
 * Reads `catalog.blacklist`: the document's deactivated exercises PLUS its
 * `forbiddenNames`. That second half exists for this rule specifically — a
 * blacklisted movement that was never an exercise (`Hip thrust`) cannot ride in
 * the exercise list, and free text has no catalog backstop, so a name missing
 * from the blacklist is caught by nothing at all here. `- Hip thrusts | 3×12`
 * in a cooldown is one of the four production bypasses this function closed.
 */
function findBlacklistEntryLoose(rawName, catalog) {
  if (typeof rawName !== "string") return null;
  const normalized = normalizeBlacklistName(rawName);
  const entries = Array.isArray(catalog.blacklist) ? catalog.blacklist : [];
  return entries.find((entry) => normalized.includes(normalizeBlacklistName(entry.name))) ?? null;
}

/**
 * Resolves a catalog exercise name to the `catalog.muscleGroups` key it belongs to
 * (e.g. `"Squat"` -> `"Lower Body"`), or `null` when the name isn't in any
 * group (should not happen for a name that already resolved via
 * `resolveCatalogName`, but kept defensive).
 */
function classifyMuscleGroup(catalogName, catalog) {
  for (const [group, names] of Object.entries(catalog.muscleGroups)) {
    if (names.includes(catalogName)) return group;
  }
  return null;
}

/**
 * True iff one exercise line resolves (forgivingly — trimmed,
 * case-insensitive) to a catalog entry whose `implementTypes` contain
 * `"cardio"`.
 *
 * The single definition of "this line is cardio" for this module: three call
 * sites used to carry a verbatim copy of this body (`isHomeSession`,
 * `sessionHasCardioExercise`, and `checkCardioMixingRule`'s name-listing
 * filter). A line whose name is malformed or doesn't resolve is NOT cardio —
 * the safer default everywhere it's used, since it keeps a session classified
 * as "home" and therefore keeps the home-only rules running.
 *
 * @param {{ name?: string }} exercise
 * @param {object} catalog - a `buildCatalogViews` result.
 * @returns {boolean}
 */
function isCardioExercise(exercise, catalog) {
  if (!exercise || typeof exercise.name !== "string") return false;
  const catalogName = resolveCatalogName(exercise.name, catalog);
  const descriptor = catalogName ? catalog.descriptions[catalogName] : null;
  return descriptor?.implementTypes?.includes("cardio") ?? false;
}

/**
 * Determines whether a session is a HOME session or a (pure-cardio) GYM
 * session, from its main `exercises` list alone. Exported — Task 9's "cardio
 * never mixed into a force session" rule needs the exact same notion, and
 * two divergent definitions of "home/force session" would be a real bug.
 *
 * Rule (constraints.md: "she trains strength at home and does cardio at the
 * gym"): a session is a home session UNLESS every one of its exercises is a
 * cardio exercise. A pure-cardio session is therefore a gym session; any
 * session with at least one non-cardio exercise is a home session, even if
 * it also contains `Course` (outdoor running is cardio but legitimately
 * allowed at both locations — see Task 6's report — so its presence alone
 * doesn't disqualify a session from being "home").
 *
 * Matches each exercise name forgivingly (trimmed, case-insensitive, same
 * as `resolveCatalogName`). An exercise whose name doesn't resolve to any
 * catalog entry is treated as NOT cardio — the safer default, since it keeps
 * the session flagged as "home" so the warmup rule still runs rather than
 * silently skipping validation because of an unrecognised main-exercise name.
 *
 * A session with no exercises at all defaults to a home session: there is no
 * evidence it's a pure-cardio session, and skipping the warmup check on an
 * empty/malformed session would be the wrong direction to err in.
 *
 * @param {Array<{ name?: string }>} exercises
 * @param {object} catalog - a `buildCatalogViews` result. Required, never defaulted.
 * @returns {boolean}
 */
export function isHomeSession(exercises, catalog) {
  requireCatalog(catalog, "isHomeSession");

  const list = Array.isArray(exercises) ? exercises : [];
  if (list.length === 0) return true;

  return !list.every((exercise) => isCardioExercise(exercise, catalog));
}

/**
 * Detects a ceiling breach BEFORE any rounding decision is made. This has to
 * be a separate step from `roundToAchievable` because that function clamps
 * to the ceiling internally — by the time it returns, a breach has already
 * been silently corrected. The total/per-hand resolution itself comes from
 * `loadValidation.js`'s exported `computeTotalAndPerHand`, the canonical
 * implementation — this module deliberately does NOT keep a private copy of
 * that arithmetic (see that function's docstring for the drift risk).
 *
 * Returns `null` when there is no ceiling for this exercise, the exercise is
 * unknown, the weight isn't finite, or the weight is within the ceiling.
 * Otherwise returns `{ ceiling, relevantKg }`, where `relevantKg` is the
 * weight expressed in whichever unit the ceiling is declared in.
 */
function detectCeilingBreach(exerciseName, weightKg, weightType, catalog) {
  const ceiling = catalog.ceilings[exerciseName];
  if (!ceiling) return null;

  const descriptor = catalog.descriptions[exerciseName];
  if (!descriptor) return null;

  if (!Number.isFinite(weightKg)) return null;

  const { totalKg, perHandKg } = computeTotalAndPerHand(descriptor, weightKg, weightType);
  const relevantKg = ceiling.unit === "per_hand" ? perHandKg : totalKg;

  return relevantKg > ceiling.maxKg + EPS ? { ceiling, relevantKg } : null;
}

/**
 * Line rule: validates and, when possible, corrects one exercise line's
 * prescribed weight.
 *
 * @returns {{ weight: number, errors: string[], warnings: string[] }}
 */
function validateExerciseLoadRule(session, exercise, sessionIndex, catalog) {
  const { name, weight, weightType } = exercise;
  const errors = [];
  const warnings = [];
  const sessionLabel = `Séance ${sessionIndex + 1} (${session.name})`;

  if (isLoadValid(name, weight, weightType, catalog)) {
    return { weight, errors, warnings };
  }

  const breach = detectCeilingBreach(name, weight, weightType, catalog);
  if (breach) {
    const unitLabel = breach.ceiling.unit === "per_hand" ? "par main" : "au total";
    errors.push(
      `${sessionLabel} : ${name} — poids demandé ${formatWeightForWarning(weight, weightType)} ` +
        `dépasse le plafond de cet exercice (${breach.ceiling.maxKg} kg ${unitLabel}). Import bloqué : ` +
        "à ce plafond, la progression passe par le tempo, les répétitions ou une variante unilatérale, jamais par la charge."
    );
    // Do NOT round on a ceiling breach — the line is rejected as-is.
    return { weight, errors, warnings };
  }

  const rounded = roundToAchievable(name, weight, weightType, catalog);
  if (rounded.warning) {
    warnings.push(
      `${sessionLabel} : ${name} — poids demandé ${formatWeightForWarning(weight, weightType)}. ${rounded.warning}`
    );
  }
  return { weight: rounded.weightKg, errors, warnings };
}

/**
 * Session rule: flags a session that needs more than one plated bar
 * configuration. Read-only (never corrects a weight) — always a warning,
 * per the owner's ruling in constraints.md.
 *
 * @returns {{ errors: string[], warnings: string[] }}
 */
function checkBarConfigurationsRule(session, sessionIndex, correctedExercises, catalog) {
  const errors = [];
  const warnings = [];
  const { warnings: barWarnings } = checkSessionBarConfigurations(correctedExercises, catalog);
  for (const warning of barWarnings) {
    warnings.push(`Séance ${sessionIndex + 1} (${session.name}) : ${warning}`);
  }
  return { errors, warnings };
}

/**
 * The two free-text sections of a session, with the French wording each one
 * needs. Same content rule applies to both (see
 * `checkWarmupCooldownContentRule`); only the label and the reminder sentence
 * differ.
 */
const FREE_TEXT_SECTIONS = [
  {
    key: "warmup",
    label: "échauffement",
    suffix:
      "Interdit en échauffement à la maison : l'échauffement à domicile se limite à la mobilité " +
      "articulaire et à l'activation au poids du corps.",
  },
  {
    key: "cooldown",
    label: "retour au calme",
    suffix:
      "Interdit en retour au calme à la maison : le retour au calme à domicile se limite aux " +
      "étirements et à la mobilité au poids du corps.",
  },
];

/**
 * Session rule: THE canonical guardrail of this whole project. For months
 * the coach put `- Rameur | 5min` (a rowing machine) into home warmups
 * because one prompt EXAMPLE showed exactly that line and the model copied
 * the example rather than the rule — see constraints.md. "Home warmup =
 * joint mobility + bodyweight activation. That is the entire permitted set."
 * is therefore enforced here, in code, as a hard blocking error — not left
 * to the prompt.
 *
 * Covers `warmup` AND `cooldown` (final review, 2026-07-26). Task 7's brief
 * permitted warmup-only, which meant the very same `- Rameur | 5min` line
 * imported cleanly if the coach filed it under RETOUR AU CALME instead —
 * three lines further down the page, same bad outcome.
 *
 * Only runs on HOME sessions (`isHomeSession`) — a pure-cardio gym session
 * has no such restriction.
 *
 * Item names in both sections are free text: most mobility and stretching
 * movements ("Rotations d'épaules", "Étirement des ischio-jambiers"...)
 * appear in NO catalog, and that is the norm, not a defect. A name is only
 * ever flagged when it resolves (forgivingly — trimmed, case-insensitive,
 * same as `resolveCatalogName`) to an actual catalog entry; anything else is
 * allowed without inspection. Over-rejection here would block nearly every
 * legitimate plan, which is strictly worse than the under-detection it would
 * replace. For a resolved name, in order:
 *   1. `implementTypes` contains `"cardio"` -> reject (the Rameur case).
 *   2. not allowed at home per `deriveLocations` (Task 6) -> reject.
 *   3. `implementTypes` does not contain `"bodyweight"` (takes external load) -> reject —
 *      warmups and cooldowns are unloaded by definition.
 *   4. otherwise (a `bodyweight` catalog exercise) -> allowed.
 * Order matters: cardio is checked first so a cardio exercise that also
 * happens to resolve `'maison'` in its locations (e.g. `Course`, allowed at
 * both locations per Task 6) is still caught by the cardio check rather than
 * slipping past the location check.
 *
 * @returns {{ errors: string[], warnings: string[] }}
 */
function checkWarmupCooldownContentRule(session, sessionIndex, correctedExercises, catalog) {
  const errors = [];
  const warnings = [];

  if (!isHomeSession(correctedExercises, catalog)) {
    return { errors, warnings };
  }

  const sessionLabel = `Séance ${sessionIndex + 1} (${session.name})`;

  for (const { key, label, suffix } of FREE_TEXT_SECTIONS) {
    const items = Array.isArray(session?.[key]) ? session[key] : [];

    for (const item of items) {
      if (!item || typeof item.name !== "string") continue;

      // A blacklisted item is already rejected by
      // `checkBlacklistInWarmupCooldownRule`, with a far more useful message
      // (the reason and the suggested replacement). Reporting the same item
      // twice — e.g. `Russian twist`, blacklisted AND a loaded catalog
      // exercise — is worse than one clear message.
      if (findBlacklistEntryLoose(item.name, catalog)) continue;

      const catalogName = resolveCatalogName(item.name, catalog);
      if (!catalogName) continue; // unrecognised free-text mobility/stretching movement -- allowed by definition

      const descriptor = catalog.descriptions[catalogName];
      if (!descriptor) continue;

      const prefix = `${sessionLabel} : ${label} « ${item.name} »`;

      if (descriptor.implementTypes.includes("cardio")) {
        // Only machine-based cardio gets the "(machine de salle)"
        // parenthetical — `Course` is outdoor running and needs no machine.
        const machineNote = descriptor.equipmentNeeds?.includes("machine") ? " (machine de salle)" : "";
        errors.push(`${prefix} — c'est un exercice cardio${machineNote}. ${suffix}`);
        continue;
      }

      if (!deriveLocations(descriptor.equipmentNeeds, descriptor.implementTypes, catalog.inventory).includes("maison")) {
        errors.push(`${prefix} — cet exercice n'est pas disponible à la maison. ${suffix}`);
        continue;
      }

      // THE REMEDY IS THE POINT of this wording. The bare « nécessite une charge
      // externe » drew seven rejections in a row on 2026-09-28: the coach wrote
      // `{ name: "Squat", detail: "2×10 au poids du corps" }`, read the message
      // as "warmups must be bodyweight", believed it already complied, and
      // re-sent the same NAME with a reworded detail each time. Only the name is
      // matched against the catalog, so the message has to say so.
      if (!descriptor.implementTypes.includes("bodyweight")) {
        errors.push(
          `${prefix} — « ${item.name} » est le nom d'un exercice chargé du catalogue. ${suffix} ` +
            "C'est le NOM qui est contrôlé, pas le détail : écrire « au poids du corps » dans le détail ne suffit pas. " +
            `Renomme le mouvement pour dire ce qu'il est (ex. « ${item.name} au poids du corps »), ` +
            "ou remplace-le par un mouvement de mobilité."
        );
      }
    }
  }

  return { errors, warnings };
}

/**
 * Session rule: in a HOME session, every MAIN exercise line must be doable at
 * home. Blocking error.
 *
 * Task 6 built the `equipmentNeeds` -> derived `locations` model and Task 7
 * consumed it for warmup items only, so nothing checked the main lines: a
 * plan prescribing `Développé incliné` (needs an inclined bench) or `Tirage
 * vertical` (needs a high-anchored upper-body elastic — she owns hip bands
 * only) imported with zero errors, and the user was then told to do an exercise
 * she has no equipment for.
 *
 * Scope, deliberately narrow:
 * - HOME sessions only, via the shared `isHomeSession` — a pure-cardio gym
 *   session legitimately uses machines and is never touched by this rule.
 * - Cardio lines are skipped entirely. A cardio exercise inside a home
 *   session is already T3.3's error (`checkCardioMixingRule`); reporting the
 *   same line twice with two different explanations is worse than one clear
 *   message. `Course` (outdoor running, home-allowed) is therefore never
 *   flagged here either.
 * - An unresolvable name is skipped: it already produces its own blocking
 *   "introuvable dans le catalogue" error, and there is no equipment data to
 *   reason about.
 *
 * The message names the missing equipment (`describeHomeBlockers`), not just
 * the verdict — "remplace-le" is only actionable if she knows what's missing.
 *
 * @returns {{ errors: string[], warnings: string[] }}
 */
function checkHomeExerciseLocationRule(session, sessionIndex, correctedExercises, catalog) {
  const errors = [];
  const warnings = [];

  if (!isHomeSession(correctedExercises, catalog)) {
    return { errors, warnings };
  }

  const sessionLabel = `Séance ${sessionIndex + 1} (${session.name})`;

  for (const exercise of Array.isArray(correctedExercises) ? correctedExercises : []) {
    if (!exercise || typeof exercise.name !== "string") continue;
    if (isCardioExercise(exercise, catalog)) continue; // T3.3's error, not this rule's

    const catalogName = resolveCatalogName(exercise.name, catalog);
    if (!catalogName) continue; // already blocked as an unknown exercise

    // An absent descriptor cannot happen for a name that just resolved, but the
    // verdict is kept identical to `getExerciseLocations`' own: no entry means
    // no location at all, so the line is reported rather than waved through.
    const descriptor = catalog.descriptions[catalogName];
    const locations = descriptor
      ? deriveLocations(descriptor.equipmentNeeds, descriptor.implementTypes, catalog.inventory)
      : [];
    if (locations.includes("maison")) continue;

    const blockers = describeHomeBlockers(descriptor?.equipmentNeeds, catalog.inventory);
    const needs = blockers.length ? blockers.join(" et ") : "du matériel indisponible à la maison";
    errors.push(
      `${sessionLabel} : ${exercise.name} — cet exercice n'est pas réalisable à la maison, il nécessite ` +
        `${needs}. Import bloqué : remplace-le par un exercice faisable avec le matériel de la maison.`
    );
  }

  return { errors, warnings };
}

/**
 * Resolves each of a session's main exercises to `{ raw, catalogName, group }`,
 * dropping lines that don't resolve to any catalog entry (unnamed/typo'd
 * lines already produce their own blocking error elsewhere and can't be
 * classified into a muscle group here). Used by T3.1
 * (`checkCoreOnLowerBodyDayRule`) only — T3.2 counts raw lines and T3.3 works
 * off `isCardioExercise`, so neither needs muscle-group classification.
 */
function classifyExercises(correctedExercises, catalog) {
  return (Array.isArray(correctedExercises) ? correctedExercises : [])
    .filter((exercise) => exercise && typeof exercise.name === "string")
    .map((exercise) => ({ raw: exercise.name, catalogName: resolveCatalogName(exercise.name, catalog) }))
    .filter((entry) => entry.catalogName)
    .map((entry) => ({ ...entry, group: classifyMuscleGroup(entry.catalogName, catalog) }));
}

/**
 * Session rule (T3.1): no core exercise on a lower-body day. Error.
 *
 * "Predominantly lower body" is deliberately defined narrowly, per the
 * brief ("a session whose only non-core work is lower body is unambiguous,
 * and that is the case that matters. Do not overreach into sessions that mix
 * upper and lower body"): a session is a lower-body day when it has at least
 * one non-core exercise AND every non-core exercise belongs to the
 * `Lower Body` group. A session mixing e.g. an Upper Body exercise with a
 * Lower Body one is NOT a lower-body day under this rule and is never
 * flagged, even if it also contains core work.
 *
 * KNOWN LIMITATION (accepted, reviewed 2026-07-26): a single `Full Body`
 * exercise (Burpees, Thruster...) alongside otherwise purely lower-body work
 * disables this rule for that session, since not every non-core exercise is
 * then `Lower Body`. Deliberately left as-is — widening the definition risks
 * flagging legitimate mixed sessions, and over-rejection is the failure mode
 * this project has already been burned by.
 *
 * @returns {{ errors: string[], warnings: string[] }}
 */
function checkCoreOnLowerBodyDayRule(session, sessionIndex, correctedExercises, catalog) {
  const errors = [];
  const warnings = [];
  const classified = classifyExercises(correctedExercises, catalog);

  const coreItems = classified.filter((entry) => entry.group === CORE_MUSCLE_GROUP);
  const nonCoreItems = classified.filter((entry) => entry.group !== CORE_MUSCLE_GROUP);
  const isLowerBodyDay =
    nonCoreItems.length > 0 && nonCoreItems.every((entry) => entry.group === LOWER_BODY_MUSCLE_GROUP);

  if (isLowerBodyDay && coreItems.length > 0) {
    const sessionLabel = `Séance ${sessionIndex + 1} (${session.name})`;
    const coreNames = coreItems.map((entry) => entry.raw).join(", ");
    errors.push(
      `${sessionLabel} : exercice(s) de core (${coreNames}) sur un jour bas du corps — le gainage n'a pas ` +
        "sa place un jour jambes. Retire le core ou change le focus de la séance."
    );
  }

  return { errors, warnings };
}

/**
 * Session rule (T3.2): `USUAL_EXERCISES_PER_FORCE_SESSION` exercises is the
 * normal shape of a force session; more is a WARNING, never blocking, and not a
 * ceiling (owner ruling 2026-10-06 — the user asking for six is a sufficient reason,
 * and the message must not read as an instruction to cut what she asked for).
 * Counts only the main `exercises` array — warmup and cooldown
 * items don't count. "Force session" reuses `isHomeSession` verbatim (per
 * the controller ruling: it already encodes "not a pure cardio session" —
 * writing a second definition would be a bug), so a pure-cardio gym session
 * with many lines is never warned by this rule.
 *
 * @returns {{ errors: string[], warnings: string[] }}
 */
function checkExerciseCountRule(session, sessionIndex, correctedExercises, catalog) {
  const errors = [];
  const warnings = [];
  const count = Array.isArray(correctedExercises) ? correctedExercises.length : 0;

  if (isHomeSession(correctedExercises, catalog) && count > USUAL_EXERCISES_PER_FORCE_SESSION) {
    const sessionLabel = `Séance ${sessionIndex + 1} (${session.name})`;
    warnings.push(
      `${sessionLabel} : ${count} exercices, plus que les ${USUAL_EXERCISES_PER_FORCE_SESSION} habituels d'une séance de force. ` +
        "Si c'est ce que tu as demandé, rien à changer ; sinon, vérifie qu'aucun exercice ne fait doublon."
    );
  }

  return { errors, warnings };
}

/**
 * True iff at least one of a session's main exercises resolves to a cardio
 * catalog entry (`implementType === "cardio"`). This is the "additional
 * small predicate" the controller called for beside `isHomeSession`:
 * `isHomeSession` alone can't distinguish a pure-force session from a mixed
 * cardio+force one (both resolve to `true`), so T3.3 needs this second,
 * narrower check rather than a competing definition of "force session".
 */
function sessionHasCardioExercise(exercises, catalog) {
  return (Array.isArray(exercises) ? exercises : []).some((exercise) =>
    isCardioExercise(exercise, catalog)
  );
}

/**
 * Session rule (T3.3): cardio is never mixed into a force session. Error.
 *
 * Fires when a session contains at least one cardio exercise
 * (`sessionHasCardioExercise`) AND is a home/force session per
 * `isHomeSession` (true unless every exercise is cardio) — i.e. it has both
 * a cardio exercise and at least one non-cardio exercise. A pure cardio
 * session (`isHomeSession` false) and a pure force session
 * (`sessionHasCardioExercise` false) are both fine and never flagged.
 *
 * @returns {{ errors: string[], warnings: string[] }}
 */
function checkCardioMixingRule(session, sessionIndex, correctedExercises, catalog) {
  const errors = [];
  const warnings = [];

  if (
    sessionHasCardioExercise(correctedExercises, catalog) &&
    isHomeSession(correctedExercises, catalog)
  ) {
    const sessionLabel = `Séance ${sessionIndex + 1} (${session.name})`;
    const cardioNames = (Array.isArray(correctedExercises) ? correctedExercises : [])
      .filter((exercise) => isCardioExercise(exercise, catalog))
      .map((exercise) => exercise.name)
      .join(", ");
    errors.push(
      `${sessionLabel} : cardio (${cardioNames}) mélangé à une séance de force — le cardio doit être ` +
        "une séance dédiée à la salle, sur un jour de repos, jamais mélangé au travail de force."
    );
  }

  return { errors, warnings };
}

/**
 * Session rule (T3.4b half of T3.4): blacklist enforcement for `warmup` and
 * `cooldown` items. The main-exercise-line half of T3.4 runs earlier, inline
 * in `validatePlanDomain`'s exercise-mapping step (see its comment for why
 * it can't live in `LINE_RULES`: it must fire even for a name absent from
 * the catalog, e.g. `Hip thrust`, which would otherwise be short-circuited
 * by the "unresolvable name" catalog-lookup error first). This rule covers
 * the other two surfaces a blacklisted movement can appear on — "a
 * blacklisted movement is unwanted wherever it appears" (brief).
 *
 * Uses `findBlacklistEntryLoose` (substring match), not `findBlacklistEntry`
 * (whole-name match) — see that function's docstring for why the looser
 * match is safe here specifically and must NOT be applied to the main
 * exercise line or to `checkWarmupCooldownContentRule`.
 *
 * @returns {{ errors: string[], warnings: string[] }}
 */
// `_correctedExercises` is unused: this rule reads only `warmup`/`cooldown`. It
// is declared anyway so every `SESSION_RULES` entry has one signature and
// `catalog` stays in the same position in all of them — a rule list whose
// members take different shapes is how the wrong argument gets passed.
function checkBlacklistInWarmupCooldownRule(session, sessionIndex, _correctedExercises, catalog) {
  const errors = [];
  const warnings = [];
  const sessionLabel = `Séance ${sessionIndex + 1} (${session.name})`;

  for (const listKey of ["warmup", "cooldown"]) {
    const items = Array.isArray(session?.[listKey]) ? session[listKey] : [];
    for (const item of items) {
      if (!item || typeof item.name !== "string") continue;
      const entry = findBlacklistEntryLoose(item.name, catalog);
      if (entry) {
        errors.push(formatBlacklistError(sessionLabel, item.name, entry));
      }
    }
  }

  return { errors, warnings };
}

/** Per exercise line, in the order they should run. */
const LINE_RULES = [validateExerciseLoadRule];

/**
 * Session rule: ONE pull-up bar height per session. Blocking error.
 *
 * The bar is rigged at a single height and the user does not re-rig mid-workout, so
 * a session mixing a high-bar exercise (traction, dead hang) with a low-bar one
 * (traction australienne) cannot be performed as written.
 *
 * **It is deliberately NOT the same severity as `checkBarConfigurationsRule`,
 * and the difference is the whole argument.** Re-plating a bar mid-session is
 * possible and merely costs time, so that rule warns and lets the import
 * through; the bar height is not changed mid-session at all, so there is no
 * corrected plan to let through. An earlier draft of this comment called them
 * "the same class", which is exactly backwards — a reader following that
 * reasoning would demote this rule or promote that one.
 *
 * The message names the offending EXERCISES, not just the two heights. « la
 * séance mélange haute et basse » is true and useless: the coach has to know
 * which lines to move, and an error she cannot act on costs a full round-trip.
 *
 * Two exclusions, both to avoid a second error for one mistake:
 * - An unresolvable name — already reported by the resolution step.
 * - A DEACTIVATED exercise — already reported as blacklisted, and advice about
 *   separating an exercise she has removed is worse than no advice. This also
 *   keeps the suspenders scoped like the belt: `buildBarHeightSection` filters
 *   the same names out of the prompt through `isOffered`.
 *
 * Warmup and cooldown are deliberately not checked. They are free text, the
 * standing rule is that an unrecognised name there must be allowed, and a
 * mobility drill that hangs from the bar is not a rigging change.
 */
function checkBarHeightRule(session, sessionIndex, correctedExercises, catalog) {
  const byHeight = new Map();

  for (const ex of Array.isArray(correctedExercises) ? correctedExercises : []) {
    if (typeof ex?.name !== "string") continue;
    const resolved = resolveCatalogName(ex.name, catalog);
    const entry = resolved ? catalog.descriptions[resolved] : null;
    if (!entry || entry.active === false) continue;
    const height = entry.barHeight;
    if (height !== "haute" && height !== "basse") continue;
    if (!byHeight.has(height)) byHeight.set(height, []);
    byHeight.get(height).push(resolved);
  }

  if (byHeight.size < 2) return { errors: [], warnings: [] };

  const describe = (height) => `barre ${height} (${byHeight.get(height).join(", ")})`;
  return {
    errors: [
      `Séance ${sessionIndex + 1} (${session.name}) : hauteur de barre incompatible — ` +
        `la séance mélange ${describe("haute")} et ${describe("basse")}. La barre de traction ` +
        "est réglée une seule fois par séance, jamais en cours de route — sépare-les en deux séances.",
    ],
    warnings: [],
  };
}

/**
 * Once per session, over the corrected exercise lines. T3.4's warmup/cooldown
 * half is deliberately last — order doesn't matter for correctness (every
 * rule only pushes to the shared `errors`/`warnings` arrays), but it groups
 * the two blacklist-adjacent checks (main-exercise blacklist runs earlier,
 * inline) with the other structure rules Task 9 added.
 */
const SESSION_RULES = [
  checkBarConfigurationsRule,
  checkBarHeightRule,
  checkWarmupCooldownContentRule,
  checkHomeExerciseLocationRule,
  checkCoreOnLowerBodyDayRule,
  checkExerciseCountRule,
  checkCardioMixingRule,
  checkBlacklistInWarmupCooldownRule,
];

/**
 * Runs every domain guardrail over a parsed plan (the object `planFromJson`
 * returns) and returns the blocking errors, the non-blocking warnings, and a
 * corrected copy of the plan with out-of-range-but-under-ceiling weights
 * rounded down and any meaningless `/main` label normalized away.
 *
 * Pure: never mutates `plan`. Always returns a NEW plan object (and new
 * session/exercise objects within it) — the caller should import
 * `correctedPlan`, not the original, so the rounded weights are what
 * actually get stored.
 *
 * Only `session.exercises` lines are load/name-validated. `warmup` and
 * `cooldown` items are free-text movements, not weighted exercise lines, and
 * are always copied into the corrected plan unchanged (never corrected) —
 * but in a home session BOTH lists ARE content-checked (see
 * `checkWarmupCooldownContentRule`): a recognised cardio/not-home/
 * externally-loaded catalog exercise is a blocking error, while an
 * unrecognised free-text name is always allowed.
 *
 * An exercise `name` that doesn't resolve (forgivingly — trimmed,
 * case-insensitive) to a catalog entry is a blocking error; the rest of that
 * line's checks (load, ceiling) are skipped since there's no catalog entry
 * to validate against, and its `name` is preserved verbatim — an unresolvable
 * name is rejected, never auto-corrected to the "nearest" catalog entry. A
 * name that DOES resolve is stored as its canonical catalog key instead of the
 * coach's spelling, silently and with no warning.
 *
 * Never throws: a plan with no `sessions`, a session with no `exercises`, or
 * a line with a missing/malformed `weight` are all tolerated — they simply
 * produce no domain errors/warnings for the missing pieces (this module's
 * own structural `validatePlan` is the layer responsible for flagging
 * structurally incomplete plans).
 *
 * @param {object} plan - The object returned by `planFromJson`.
 * @param {object} catalog - a `buildCatalogViews` result. Required, never defaulted.
 * @returns {{
 *   errors: string[],
 *   warnings: string[],
 *   correctedPlan: object,
 * }}
 *   - `errors`: French, user-facing. Non-empty means import must be blocked.
 *   - `warnings`: French, user-facing. Import may proceed; the corrected
 *     plan already reflects any rounding/normalization these describe.
 *   - `correctedPlan`: a deep-enough copy of `plan` — same shape, with each
 *     exercise line's `weight` replaced by its rounded-down value and
 *     `weightType` normalized to `"total"` where applicable. Identical in
 *     content to `plan` when there is nothing to correct.
 */
export function validatePlanDomain(plan, catalog) {
  requireCatalog(catalog, "validatePlanDomain");

  const errors = [];
  const warnings = [];

  const sourceSessions = Array.isArray(plan?.sessions) ? plan.sessions : [];

  const correctedSessions = sourceSessions.map((session, sessionIndex) => {
    const sourceExercises = Array.isArray(session?.exercises) ? session.exercises : [];

    const sessionLabel = `Séance ${sessionIndex + 1} (${session.name})`;

    const correctedExercises = sourceExercises.map((exercise) => {
      if (!exercise || typeof exercise.name !== "string") {
        return { ...exercise };
      }

      // Blacklist (T3.4) is checked FIRST, before catalog resolution — a
      // blacklisted name must be rejected with its reason and replacement
      // even when it has no catalog entry at all (`Hip thrust`, carried by the
      // document's `forbiddenNames`), which the catalog-resolution check below
      // would otherwise reject first with the wrong ("introuvable") message.
      // This is why the blacklist check isn't a `LINE_RULES` entry: every
      // `LINE_RULES` function only ever sees an already-resolved catalog name.
      const blacklistEntry = findBlacklistEntry(exercise.name, catalog);
      if (blacklistEntry) {
        errors.push(formatBlacklistError(sessionLabel, exercise.name, blacklistEntry));
        return { ...exercise };
      }

      // An exercise name that doesn't resolve to a catalog entry is a
      // BLOCKING error (owner ruling) — the coach's system prompt requires
      // exact catalog names, so an unresolvable name means it disregarded
      // that; importing the line at 0 kg under an unrecognised name is a
      // worse outcome than refusing the plan. Matched forgivingly (trimmed,
      // case-insensitive) so whitespace/case alone never rejects a valid
      // name. The line itself (including its `name` as written) is left
      // untouched in the corrected plan — reject, never auto-correct.
      const catalogName = resolveCatalogName(exercise.name, catalog);
      if (!catalogName) {
        errors.push(
          `${sessionLabel} : exercice « ${exercise.name} » introuvable dans le catalogue. ` +
            "Vérifie l'orthographe ou redemande un programme au coach avec le nom exact."
        );
        return { ...exercise };
      }

      let weight = exercise.weight;
      let weightType = exercise.weightType;

      // The `/main` (per-hand) convention only applies to a bilateral
      // exercise (one implement per hand). On a single-implement exercise
      // it's a meaningless label — even when the numeric load itself is
      // otherwise valid — so this is normalized unconditionally, outside
      // (and before) the load-validity check below.
      const descriptor = catalog.descriptions[catalogName];
      if (descriptor && !descriptor.bilateral && weightType === "per_hand") {
        weightType = "total";
        warnings.push(
          `${sessionLabel} : ${exercise.name} — la mention « /main » ne s'applique pas à cet exercice ` +
            "(un seul appareil) : le poids a été traité comme la charge totale."
        );
      }

      for (const rule of LINE_RULES) {
        const result = rule(
          session,
          { ...exercise, name: catalogName, weight, weightType },
          sessionIndex,
          catalog
        );
        errors.push(...result.errors);
        warnings.push(...result.warnings);
        weight = result.weight;
      }
      // Store the CANONICAL catalog key, not the string the coach wrote.
      // `catalog.descriptions[name]` (the Lexique, the load model) and
      // `getExerciseGroup(name)` (the stats) are exact-string lookups, so
      // importing "  développé COUCHÉ  " verbatim puts an entry in the user's
      // stored data that nothing can resolve: the plan validates and the data
      // is quietly corrupted. This is NOT the auto-correction the owner
      // forbade — that ruling is about GUESSING at a name which did not
      // resolve, and it stands unchanged (see the unresolvable-name branch
      // above, which still blocks and still preserves the raw name). Here the
      // name already resolved by exact trim/case-insensitive match; writing
      // the key it resolved to is normalization, not a guess. Silent by
      // design: no warning, since there is nothing for the user to act on.

      // The unit is the catalog's answer, never the model's. It is stamped
      // onto the plan (and from there onto the séance and the stored session)
      // so that `computePRs` and `generateExport` never need the catalog to
      // know what a recorded set meant — and so a later catalog edit cannot
      // retroactively reinterpret her history.
      //
      // ONLY when it is `"seconds"`. Absent means repetitions everywhere in
      // this model, so writing `metric: "reps"` onto every line would be
      // redundant data that also breaks the invariant a test pins: a plan with
      // nothing wrong with it comes back untouched.
      const metric = descriptor?.metric ?? "reps";
      if (metric !== "seconds") {
        return { ...exercise, name: catalogName, weight, weightType };
      }

      const normalized = normalizeReps(exercise.reps, metric);
      if (normalized.unparsed) {
        warnings.push(
          `${sessionLabel} : ${exercise.name} — « ${exercise.reps} » n'est pas une durée lisible ` +
            "pour un exercice de maintien : la consigne est gardée telle quelle, écris un nombre de secondes."
        );
      }

      return {
        ...exercise,
        name: catalogName,
        weight,
        weightType,
        metric,
        reps: normalized.reps,
        // Re-derived, because `sets` was built from the PRE-normalisation
        // `reps` by `planFromJson`. Leaving it would put `3×45s` beside
        // `reps: "45"` — two sources for one fact, which is the whole reason
        // `sets` is derived rather than model-authored.
        sets: formatSets(exercise.setsCount ?? 1, normalized.reps),
      };
    });

    const correctedSession = {
      ...session,
      exercises: correctedExercises,
      warmup: Array.isArray(session?.warmup) ? session.warmup.map((item) => ({ ...item })) : session?.warmup,
      cooldown: Array.isArray(session?.cooldown) ? session.cooldown.map((item) => ({ ...item })) : session?.cooldown,
    };

    for (const rule of SESSION_RULES) {
      const result = rule(correctedSession, sessionIndex, correctedExercises, catalog);
      errors.push(...result.errors);
      warnings.push(...result.warnings);
    }

    return correctedSession;
  });

  const correctedPlan = { ...plan, sessions: correctedSessions };

  return { errors, warnings, correctedPlan };
}

/**
 * `weekStart`/`weekEnd` must be ISO `AAAA-MM-JJ`, and only a regex check
 * proves it. The deleted `planParser.js` ran `parseFrenchDate()` on the
 * `Semaine :` line, so `plan.weekStart` used to be ISO-or-`null` BY
 * CONSTRUCTION. `planFromJson.js` replaced that with a bare `typeof ===
 * "string"` check — any string passes, including the exact French
 * `JJ/MM/AAAA` form that still saturates the user's transcript. `PLAN_JSON_SCHEMA`
 * only declares `type: "string"` (no `pattern`), so strict mode cannot catch
 * this either: the model is free to emit `"11/08/2026"` and every upstream
 * gate passes.
 *
 * Left unchecked, `sync-plan.js` inserts the string into a Postgres `DATE`
 * column: Postgres' default DateStyle (ISO, MDY) reads `11/08/2026` as
 * 2026-11-08 and stores the wrong week SILENTLY, and `WeeklyPlan.jsx`'s
 * `new Date(plan.weekStart)` agrees with it — every card keeps showing
 * « Commencer »/« Noter » after she has done the workout, because nothing
 * ever matches a completed session to November.
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Structural validation of a parsed plan: does it have the minimum shape
 * `validatePlanDomain` and the app need to do anything useful with it at all.
 *
 * Moved here (unchanged) from `planParser.js`, which is now deleted — this is
 * structural validation of a plan, which is this module's stated job. It only
 * ever lived beside the parser because the parser produced what it checked;
 * now `planFromJson.js` produces what it checks, and this module already owns
 * the domain layer immediately below it.
 */
export function validatePlan(plan) {
  const errors = [];
  if (!plan.sessions.length) errors.push("Aucune séance trouvée dans le plan.");
  if (!plan.weekStart) {
    errors.push("Date de début de semaine manquante.");
  } else if (!ISO_DATE_RE.test(plan.weekStart)) {
    errors.push("Date de début de semaine invalide (format attendu AAAA-MM-JJ).");
  }
  // weekEnd's absence is not itself an error (unlike weekStart, nothing
  // downstream requires it to exist) — but a PRESENT weekEnd in the wrong
  // format is exactly as dangerous as a malformed weekStart, so it gets the
  // same regex gate.
  if (plan.weekEnd && !ISO_DATE_RE.test(plan.weekEnd)) {
    errors.push("Date de fin de semaine invalide (format attendu AAAA-MM-JJ).");
  }
  plan.sessions.forEach((s, i) => {
    // THE REMEDY, NOT JUST THE FAULT. These strings are written for the user, but
    // they are read back VERBATIM by the model through `buildCorrectionRequest`
    // — so a message that states only what is wrong leaves the coach to guess
    // what would be right. On 2026-08-16 the bare "n'a aucun exercice." was
    // answered three times in one session by re-emitting an empty session under
    // a new name ("Repos ou Mobilité", then twice "Cardio + Mobilité"), and one
    // of those put `Tapis de course` in the cooldown of the empty session,
    // drawing a SECOND error for the same single mistake.
    //
    // The model was trying to express a rest day and a cardio day. The payload
    // has no way to say a rest day — the user picks her own days, so a week is the
    // sessions she trains and nothing else — and a cardio session says it by
    // putting the cardio in `exercises`. Both of those are now stated here,
    // because this string is the only thing the coach reads on a rejection.
    if (!s.exercises.length) {
      errors.push(
        `Séance ${i + 1} (${s.name}) n'a aucun exercice. Un jour de repos n'est pas une séance : ` +
          "retire-la du programme. Une séance cardio met le cardio dans ses exercices, " +
          "pas dans le retour au calme."
      );
    }

    // ONE error per session, listing the lines, and the bad values are NOT
    // quoted. On 2026-09-28 `zai-glm-5-2` filled `reps` with a JSON string,
    // `""`, `"detail"`, `"weightType"` and `": "` across five emits in one
    // morning, and nothing here looked at the field: those plans were blocked
    // by an unrelated warmup error only, and a clean warmup would have imported
    // « Squat 4×weightType ». Quoting the garbage back would put it in the very
    // next request, which is how a format specimen gets learned.
    const unreadable = s.exercises.filter((ex) => !isReadableReps(ex?.reps)).map((ex) => ex?.name);
    if (unreadable.length) {
      errors.push(
        `Séance ${i + 1} (${s.name}) : le champ « reps » est illisible pour ${unreadable.join(", ")}. ` +
          "Import bloqué : « reps » porte UN nombre nu — le nombre de répétitions (« 10 »), ou le nombre " +
          "de secondes pour un exercice de maintien (« 30 ») — jamais vide, jamais un nom de champ, jamais du JSON."
      );
    }
  });
  return errors;
}

/**
 * Whether a `reps` value says how much to do. Deliberately wider than « a bare
 * number »: ranges (« 10-12 », « 8 à 10 ») and a trailing unit (« 45s »,
 * « 30-40min », the cardio prescription seen in production on 16/08) are real
 * prescriptions `setInput`/`stats` already handle, and the unit is stripped or
 * warned about further down by `normalizeReps`. What it refuses is a value with
 * no leading number at all, or anything after the number that is not a short
 * unit word — the shapes that were emitted on 2026-09-28.
 */
const READABLE_REPS_RE = /^\d+(?:[.,]\d+)?(?:\s*(?:-|–|à)\s*\d+(?:[.,]\d+)?)?\s*[a-zà-ÿ]{0,8}$/i;

function isReadableReps(reps) {
  return typeof reps === "string" && READABLE_REPS_RE.test(reps.trim());
}

/**
 * The whole validation layer, as one decision: the model's JSON plan payload
 * in, an accept/reject verdict out.
 *
 * This exists because the pipeline `planFromJson` -> `validatePlan`
 * (structural) -> `validatePlanDomain` (domain) -> accept/reject used to live
 * inside `CoachTab.importPlan`. That is the single point where every
 * guardrail in this module meets the app, and it was the one part of the
 * layer no test covered: changing `if (domain.errors.length)` to `if (false)`
 * left the whole suite green. Project convention (CLAUDE.md) is that UI
 * components are not unit-tested and that convention stays — so the decision
 * moved OUT of the component instead. `CoachTab.importPlan` is now a thin
 * caller that renders this verdict.
 *
 * Structural and domain errors are reported TOGETHER, structural ones first.
 * Domain rules are skipped only when the plan has no sessions at all — there
 * is nothing to inspect then. Previously any structural error suppressed the
 * domain pass entirely, so a plan missing its `Semaine :` line reported that
 * and nothing else, hiding a ceiling breach until the next round-trip.
 *
 * Never throws: non-string, non-object, empty, or unparseable input all come
 * back as a rejection with a French message rather than an exception.
 *
 * @param {string|object} payload - the model's schema-generated JSON plan,
 *   parsed or not. This used to be the raw `=== FITTRACK PLAN ===` text that
 *   `detectPlanBlock` handed back; the model no longer authors syntax, so
 *   there is no text to parse and no parser to fail. See `planSchema.js`.
 * @param {object} catalog - a `buildCatalogViews` result. Required, never
 *   defaulted — the guard runs FIRST, before the payload is even read, so a
 *   caller that forgot it fails on every input rather than only on the ones
 *   that reach a catalog lookup.
 * @returns {{
 *   shouldImport: boolean,
 *   plan: object | null,
 *   errors: string[],
 *   warnings: string[],
 * }}
 *   - `shouldImport`: the decision. `false` means the caller must NOT import.
 *   - `plan`: the corrected plan to import (weights rounded, `/main` labels
 *     normalized, `warnings` attached), or `null` when `shouldImport` is
 *     `false`. Never the raw parsed plan.
 *   - `errors`: French, user-facing, ALL of them — the caller decides how to
 *     display them, but nothing is dropped here.
 *   - `warnings`: French, user-facing. Parser warnings plus domain warnings.
 *     Present whether or not the import proceeds.
 */
export function evaluatePlanImport(payload, catalog) {
  requireCatalog(catalog, "evaluatePlanImport");

  const { plan: parsed, errors: readErrors } = planFromJson(payload);
  if (!parsed) {
    return { shouldImport: false, plan: null, errors: readErrors, warnings: [] };
  }

  const parserWarnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  const structuralErrors = validatePlan(parsed);

  // Domain rules run whenever there is anything to run them ON, even if the
  // plan is structurally invalid. They used to be skipped entirely on any
  // structural error, which meant a plan missing only its `Semaine :` line
  // reported that one line and hid every ceiling breach behind it: the user fixes
  // the date, re-imports, and only THEN learns the squat is over the ceiling.
  // One round-trip per error class, each one a full conversation with the
  // coach.
  //
  // The guard is `sessions.length > 0`, not "no structural errors" — with no
  // sessions there is genuinely nothing to validate, and `validatePlanDomain`
  // would just return empty arrays anyway.
  const hasSessionsToInspect = Array.isArray(parsed?.sessions) && parsed.sessions.length > 0;
  const domain = hasSessionsToInspect
    ? validatePlanDomain(parsed, catalog)
    : { errors: [], warnings: [], correctedPlan: parsed };

  const warnings = [...parserWarnings, ...domain.warnings];
  // Structural errors come first: they describe a more fundamental problem
  // ("this isn't a readable plan") than a domain error ("this exercise is too
  // heavy"), and reading them in that order is how the fix is sequenced.
  const errors = [...structuralErrors, ...domain.errors];

  if (errors.length) {
    return { shouldImport: false, plan: null, errors, warnings };
  }

  return {
    shouldImport: true,
    plan: { ...domain.correctedPlan, warnings },
    errors: [],
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * The verdict, as the user reads it and as the coach reads it back.
 *
 * These three lived in `src/lib/coachNotice.js` until 2026-08-23. They moved
 * here because the verdict they render and the errors they relay are authored
 * a few lines above by `evaluatePlanImport` — one module now owns the rule,
 * its message, and how that message reaches both readers.
 *
 * Still pure and still tested, which is the load-bearing half: `CoachTab` is a
 * UI component and UI components are not unit-tested by convention, so the
 * "show EVERY blocking error" rule inlined there could regress to
 * `verdict.errors[0]` without a single test failing. That is the regression
 * the error-reporting work existed to prevent.
 * ------------------------------------------------------------------ */

/**
 * Maps an `evaluatePlanImport` verdict to the notice the Coach tab renders,
 * and to the message that asks the coach to fix what was rejected.
 */
export function noticeForVerdict(verdict) {
  const errors = verdict.errors ?? [];
  const warnings = verdict.warnings ?? [];

  if (!verdict.shouldImport) {
    return {
      shouldImport: false,
      tone: "error",
      title: "Ce programme n'a pas été importé :",
      items: errors,
      // Offered only when there is something to relay. A rejection carrying no
      // error cannot be fixed by asking — the request would hand the coach an
      // empty list and it would guess at what to change, which is how a plan
      // comes back different in ways nobody asked for.
      //
      // Derived from the builder rather than from `errors.length`, so the
      // button's enable condition and the message's own guard are the SAME
      // condition by construction. They used to be two: `length > 0` here and
      // "at least one non-blank string" there, which differ on a blank entry —
      // the button would render, dismiss the notice, and then send nothing,
      // destroying the error list with no feedback at all.
      canRequestCorrection: buildCorrectionRequest(errors) !== null,
    };
  }

  return {
    shouldImport: true,
    tone: "success",
    title: warnings.length
      ? "Programme importé, avec ces ajustements :"
      : "Programme importé.",
    items: warnings,
    // A warning is already applied and the plan is already in. There is
    // nothing to send back.
    canRequestCorrection: false,
  };
}

/**
 * The message that hands the import's own rejection back to the coach.
 *
 * The errors are relayed VERBATIM. They are written for the user, but they name the
 * session, the exercise and the number the validator objected to, which is
 * exactly what the coach needs; paraphrasing them here would put a second
 * wording of every rule in the codebase, free to drift from the one the
 * validator actually enforces a few hundred lines above.
 *
 * It asks for the COMPLETE programme rather than a patch, because a patch has
 * nowhere to go: `evaluatePlanImport` takes a whole payload and there is no
 * merge path that could apply a fragment to the plan it just rejected.
 *
 * Returns null when there is nothing to relay, so the caller sends nothing at
 * all rather than a bare demand with no list under it.
 *
 * @param {string[]} errors - blocking errors from the verdict.
 * @returns {string|null}
 */
export function buildCorrectionRequest(errors, planSummary = null) {
  const listed = (Array.isArray(errors) ? errors : []).filter(
    (error) => typeof error === "string" && error.trim()
  );
  if (listed.length === 0) return null;

  // « ci-dessous », never « celui que tu viens de proposer ». Every completed
  // plan in her scrollback keeps its import button, so the plan she is fixing
  // is not necessarily the coach's latest — and a newer turn can land while
  // the notice sits open. The message points at the copy it carries.
  const quoted = planSummary ? `\n\nProgramme refusé :\n${planSummary}\n` : "";

  return (
    "Le programme ci-dessous a été refusé à l'import." +
    quoted +
    "\nCorrige exactement ces points et renvoie le programme complet :\n" +
    listed.map((error) => `- ${error}`).join("\n")
  );
}

/** French decimal comma, as everywhere else the app prints a load. */
function formatKg(value) {
  return String(value).replace(".", ",");
}

/** `JJ/MM` from an ISO date, or null. Kept local: the errors name sessions by number, not by date. */
function shortDate(iso) {
  const match = typeof iso === "string" ? iso.match(/^(\d{4})-(\d{2})-(\d{2})/) : null;
  return match ? `${match[3]}/${match[2]}` : null;
}

/**
 * A compact, readable digest of the plan that was just rejected.
 *
 * **This exists because the coach cannot otherwise see it.** `collapsePlan`
 * rewrites the payload to `[programme émis : N séances, semaine du JJ/MM]`
 * before history reaches the model, and `generateExport` ships the CURRENT
 * stored plan — which is the previous week, since a rejected plan is never
 * imported. Without the digest, "corrige exactement ces points" asks the model
 * to fix a séance it has no way to read, and the only thing it can do is
 * regenerate the week from scratch: precisely the "comes back different in ways
 * nobody asked for" outcome the rest of this section guards against.
 *
 * **It reads NAMED FIELDS and never spreads the payload, and that is a privacy
 * requirement rather than a style.** The payload carries `notebook` — the
 * coach's private notes, « JAMAIS montré à l'utilisateur » in the schema's own words —
 * and this digest becomes a USER turn. `CoachConversation` renders user turns
 * as her own words, straight through `ReactMarkdown`, with none of the four
 * branches that protect an assistant turn: relaying the raw payload would print
 * the notebook on her screen, which has already happened to her once by another
 * route. Copying only the fields named here makes that structurally impossible.
 *
 * Warmup and cooldown names are included, because the content and blacklist
 * rules raise errors about their items (« Tapis de course » in a home
 * cool-down). `progressionNote` and `restSeconds` are left out: the
 * validator's errors never concern them, and this string is banked in
 * `coach_messages` and replayed in every request for the next 40 messages.
 *
 * @param {object|string|null} payload - the coach's plan payload, parsed or not.
 * @returns {string|null} the digest, or null when there is nothing readable.
 */
export function summarizeRejectedPlan(payload) {
  let doc = payload;
  if (typeof doc === "string") {
    try {
      doc = JSON.parse(doc);
    } catch {
      return null;
    }
  }
  const sessions = Array.isArray(doc?.sessions) ? doc.sessions : [];
  if (sessions.length === 0) return null;

  const lines = sessions.map((session, index) => {
    const name = typeof session?.name === "string" ? session.name : "";
    const exercises = (Array.isArray(session?.exercises) ? session.exercises : [])
      .map((ex) => {
        const label = typeof ex?.name === "string" ? ex.name : "?";
        const volume = `${ex?.setsCount ?? "?"}×${ex?.reps ?? "?"}`;
        const load =
          Number(ex?.weight) > 0
            ? ` à ${formatKg(ex.weight)} kg${ex?.weightType === "per_hand" ? "/main" : ""}`
            : " au poids du corps";
        return `${label} ${volume}${load}`;
      })
      .join(" ; ");
    const movements = (label, items) => {
      const named = (Array.isArray(items) ? items : [])
        .filter((item) => typeof item?.name === "string" && item.name)
        .map((item) => (typeof item.detail === "string" && item.detail ? `${item.name} (${item.detail})` : item.name));
      return named.length ? ` | ${label} : ${named.join(" ; ")}` : "";
    };
    return (
      `Séance ${index + 1} — ${name} : ${exercises}` +
      movements("échauffement", session?.warmup) +
      movements("retour au calme", session?.cooldown)
    );
  });

  const from = shortDate(doc?.weekStart);
  const to = shortDate(doc?.weekEnd);
  const header = from && to ? `Semaine du ${from} au ${to}` : from ? `Semaine du ${from}` : null;

  return [header, ...lines].filter(Boolean).join("\n");
}
