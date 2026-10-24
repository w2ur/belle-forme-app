/**
 * Load guardrails — pure functions over the physical load model.
 *
 * Two levels live here:
 * - **Per exercise line**: is this prescribed weight physically loadable and
 *   within the exercise's ceiling (`isLoadValid`), and if not, what is the
 *   nearest legal weight at or below it (`roundToAchievable`)?
 * - **Per session**: how many distinct plated bar configurations does a whole
 *   session require (`checkSessionBarConfigurations`)?
 *
 * It also owns `computeTotalAndPerHand` (the canonical total/per-hand
 * resolution every consumer must reuse rather than re-derive).
 *
 * No React, no I/O — everything here is a pure function of the equipment
 * model in `src/constants/equipment.js` (reached through `catalog.inventory`, built
 * from the profile) and of the CATALOG the caller passes
 * in. Per-exercise metadata and ceilings are read off that catalog
 * (`catalog.descriptions`, `catalog.ceilings`), never off a module-level
 * constant: the catalog is a document in Neon now, so a build-time import
 * would be a second, silently disagreeing source.
 */

import { requireCatalog } from "./catalog.js";

/** Tolerance for floating-point weight comparisons, per project convention (1e-6, not 1e-10 — too tight at scale). */
const EPS = 1e-6;

function isCloseTo(a, b) {
  return Math.abs(a - b) <= EPS;
}

/** Rounds a computed load to 1 decimal place to avoid float artifacts (e.g. 12.5 / 2 * 2 -> 12.499999...). */
function roundToDecimal(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Converts a prescribed weight line into its total (both implements
 * combined) and per-hand (one implement) equivalents.
 *
 * - `bilateral: true` (one implement in each hand): the two are related by
 *   a factor of 2, in whichever direction `weightType` states.
 * - `bilateral: false` (a single implement, or none): the `/main`
 *   (`per_hand`) convention does not apply — the number IS the implement
 *   load, in both readings. If the caller still supplied `per_hand`, that
 *   is a caller-side misuse `roundToAchievable` reports via a warning; it
 *   does not change the arithmetic.
 *
 * EXPORTED as the single implementation of this arithmetic. `planValidation.js`
 * used to carry a private copy inside `detectCeilingBreach`; the two were
 * identical, but the drift mode was silent and dangerous — a divergence would
 * downgrade a ceiling BREACH (blocking error) into a rounding WARNING, which
 * is exactly the failure this whole guardrail layer exists to prevent. One
 * implementation, one place to change.
 *
 * @param {{ bilateral: boolean }} descriptor - A `catalog.descriptions` entry.
 * @param {number} weightKg
 * @param {"per_hand" | "total"} weightType
 * @returns {{ totalKg: number, perHandKg: number }}
 */
export function computeTotalAndPerHand(descriptor, weightKg, weightType) {
  if (descriptor.bilateral) {
    return weightType === "per_hand"
      ? { totalKg: weightKg * 2, perHandKg: weightKg }
      : { totalKg: weightKg, perHandKg: weightKg / 2 };
  }
  return { totalKg: weightKg, perHandKg: weightKg };
}

/**
 * The achievable per-implement load set for ONE implement type, always
 * including `0` (the bodyweight variant, valid for every exercise) even
 * though the inventory's `achievable` sets do not enumerate it.
 * Sorted ascending.
 */
function getAchievableSetForType(implementType, inventory) {
  switch (implementType) {
    case "bodyweight":
    case "elastic":
    case "cardio":
      return [0];
    case "ankle_weight":
      return [0, inventory.ankleWeightKg];
    case "dumbbell":
    case "dual_bar_symmetric":
    case "single_bar_heavy":
      return [0, ...inventory.achievable[implementType]];
    default:
      return [0];
  }
}

/**
 * The achievable per-implement load set for an exercise: the UNION of every
 * implement it can be loaded with, sorted ascending and deduplicated.
 *
 * This is the fix for the production false rejections of 2026-07-26. Which
 * implement carries the load is not a property of the exercise — most hand-held
 * movements take either the dumbbells or a loadable bar — so validating against
 * a single implement rejected weights the user can genuinely lift (`Squat` at
 * 11 kg/main, `Rowing haltères` at 13 kg/main) and silently rounded them down.
 * A per-exercise ceiling still applies on top of this union, unchanged: the set
 * says what is LOADABLE, the catalog's ceiling says what is ALLOWED.
 */
function getAchievableSet(implementTypes, inventory) {
  const types = Array.isArray(implementTypes) ? implementTypes : [];
  const union = new Set([0]);
  for (const type of types) {
    for (const value of getAchievableSetForType(type, inventory)) union.add(value);
  }
  return [...union].sort((a, b) => a - b);
}

/** Largest value in the exercise's achievable union that is <= target. The set always contains 0, so this never fails to find a candidate. */
function snapDownToAchievable(implementTypes, targetKg, inventory) {
  const set = getAchievableSet(implementTypes, inventory);
  let best = 0;
  for (const value of set) {
    if (value <= targetKg + EPS) {
      best = value;
    } else {
      break;
    }
  }
  return best;
}

/** Converts an achievable per-implement load back to the caller's requested unit (mirrors `computeTotalAndPerHand`'s direction). */
function perImplementToRequestedUnit(descriptor, perImplementKg, weightType) {
  if (!descriptor.bilateral) {
    return roundToDecimal(perImplementKg);
  }
  return weightType === "per_hand"
    ? roundToDecimal(perImplementKg)
    : roundToDecimal(perImplementKg * 2);
}

/**
 * Is this prescribed weight physically loadable with the available
 * equipment, and within this exercise's ceiling?
 *
 * - `0` is always valid, for every KNOWN exercise (the bodyweight variant).
 * - An unknown exercise name, a negative weight, or `NaN` are never valid —
 *   this never throws.
 *
 * @param {string} exerciseName
 * @param {number} weightKg
 * @param {"per_hand" | "total"} weightType
 * @param {object} catalog - a `buildCatalogViews` result. Required, never defaulted.
 * @returns {boolean}
 */
export function isLoadValid(exerciseName, weightKg, weightType, catalog) {
  requireCatalog(catalog, "isLoadValid");

  if (!Number.isFinite(weightKg) || weightKg < 0) return false;

  const descriptor = catalog.descriptions[exerciseName];
  if (!descriptor) return false;

  if (weightKg === 0) return true;

  const { totalKg, perHandKg } = computeTotalAndPerHand(descriptor, weightKg, weightType);
  const perImplementKg = descriptor.bilateral ? perHandKg : totalKg;

  const achievableSet = getAchievableSet(descriptor.implementTypes, catalog.inventory);
  const isAchievable = achievableSet.some((value) => isCloseTo(value, perImplementKg));
  if (!isAchievable) return false;

  const ceiling = catalog.ceilings[exerciseName];
  if (ceiling) {
    const ceilingRelevantKg = ceiling.unit === "per_hand" ? perHandKg : totalKg;
    if (ceilingRelevantKg > ceiling.maxKg + EPS) return false;
  }

  return true;
}

/** Builds the error-shape result for an unknown exercise or an unusable (negative/NaN) weight — see the "Error/warning shape" note in the module doc. */
function invalidResult(warning) {
  return { weightKg: 0, changed: true, warning, atCeiling: false };
}

/**
 * Returns the nearest legal weight at or below the target, for one
 * prescribed exercise line.
 *
 * Order of operations: apply the exercise's ceiling first (if any), THEN
 * snap to the implement's achievable set — so a ceiling-clamped value is
 * itself always achievable. Never rounds up: if no achievable value is at
 * or below the target, the result is `0` (always valid).
 *
 * Return shape (documented here — Task 3/4 consume it):
 * - `weightKg` (number): the resulting weight, in the SAME unit as the
 *   input (i.e. respecting the input `weightType`, not always per-implement).
 * - `changed` (boolean): `true` if `weightKg` differs from the input weight
 *   (also `true` for the unknown-exercise / invalid-weight error cases).
 * - `warning` (string | null): French, user-facing. Non-null whenever
 *   `changed` is `true`. It CAN also be non-null when `changed` is `false`,
 *   for the one informational case that isn't a value change: a `per_hand`
 *   weightType supplied on a non-bilateral exercise (the `/main` suffix
 *   does not apply there) — the number is still used as-is, but the caller
 *   is told the suffix was ignored.
 * - `atCeiling` (boolean): structured counterpart to the French "plafond"
 *   warning, so downstream consumers (Task 4/5) never have to string-match
 *   the warning text to know progression must stop going through load. Per
 *   `constraints.md`: "At a ceiling, progression goes through tempo, reps,
 *   or a unilateral variant — never load." `true` when `exerciseName` has
 *   a ceiling in the catalog AND the RETURNED `weightKg` sits at
 *   that ceiling — this covers both a value that got clamped down TO the
 *   ceiling and a value that was already exactly at it (so it can be `true`
 *   even when `changed` is `false`). Always `false` for an exercise with no
 *   catalog ceiling, even if the returned weight happens to sit at that
 *   exercise's implement max (no explicit ceiling was declared).
 *
 * Safe to call with an unknown exercise name or a negative/NaN weight — no
 * throwing. In both cases: `{ weightKg: 0, changed: true, warning: "<French message>", atCeiling: false }`.
 * A missing `catalog` is the one thing it does throw on: that is a programming
 * error, not bad data.
 *
 * @param {string} exerciseName
 * @param {number} weightKg
 * @param {"per_hand" | "total"} weightType
 * @param {object} catalog - a `buildCatalogViews` result. Required, never defaulted.
 * @returns {{ weightKg: number, changed: boolean, warning: string | null, atCeiling: boolean }}
 */
export function roundToAchievable(exerciseName, weightKg, weightType, catalog) {
  requireCatalog(catalog, "roundToAchievable");

  if (!Number.isFinite(weightKg) || weightKg < 0) {
    return invalidResult(
      "Poids invalide (doit être un nombre positif) : ramené à 0 kg (poids du corps)."
    );
  }

  const descriptor = catalog.descriptions[exerciseName];
  if (!descriptor) {
    return invalidResult(
      `Exercice « ${exerciseName} » inconnu : impossible de valider le poids, ramené à 0 kg (poids du corps).`
    );
  }

  if (weightKg === 0) {
    return { weightKg: 0, changed: false, warning: null, atCeiling: false };
  }

  const unitMismatch = !descriptor.bilateral && weightType === "per_hand";
  const { totalKg, perHandKg } = computeTotalAndPerHand(descriptor, weightKg, weightType);
  let perImplementKg = descriptor.bilateral ? perHandKg : totalKg;

  const ceiling = catalog.ceilings[exerciseName];
  let ceilingClamped = false;
  if (ceiling) {
    const ceilingRelevantKg = ceiling.unit === "per_hand" ? perHandKg : totalKg;
    if (ceilingRelevantKg > ceiling.maxKg + EPS) {
      ceilingClamped = true;
      // Bring perImplementKg down to the ceiling, expressed in the
      // per-implement domain, before snapping to the achievable set.
      perImplementKg =
        ceiling.unit === "per_hand"
          ? ceiling.maxKg
          : descriptor.bilateral
            ? ceiling.maxKg / 2
            : ceiling.maxKg;
    }
  }

  const achievableImplementKg = snapDownToAchievable(descriptor.implementTypes, perImplementKg, catalog.inventory);
  const resultKg = perImplementToRequestedUnit(descriptor, achievableImplementKg, weightType);
  const changed = !isCloseTo(resultKg, weightKg);

  // Structured "is this exercise now at its material ceiling" flag — true
  // whether the input got clamped down TO the ceiling or was already
  // exactly at it. Recomputed from the RETURNED weight (not from the
  // clamp flag alone) so the already-at-ceiling case is covered too.
  let atCeiling = false;
  if (ceiling) {
    const finalUnits = computeTotalAndPerHand(descriptor, resultKg, weightType);
    const finalCeilingRelevantKg = ceiling.unit === "per_hand" ? finalUnits.perHandKg : finalUnits.totalKg;
    atCeiling = isCloseTo(finalCeilingRelevantKg, ceiling.maxKg);
  }

  const notes = [];
  if (unitMismatch) {
    notes.push(
      "La mention « /main » ne s'applique pas à cet exercice (un seul appareil) : le poids a été traité comme la charge totale."
    );
  }
  if (changed) {
    if (ceilingClamped) {
      const unitLabel = ceiling.unit === "per_hand" ? "par main" : "au total";
      notes.push(
        `Plafond matériel de cet exercice atteint (${ceiling.maxKg} kg ${unitLabel}) : poids ramené à ${resultKg} kg. Au plafond, la progression passe par le tempo, les répétitions ou une variante unilatérale, jamais par la charge.`
      );
    } else if (achievableImplementKg === 0) {
      notes.push(
        "Ce poids n'est pas réalisable avec le matériel disponible : ramené à 0 kg (poids du corps)."
      );
    } else {
      notes.push(
        `Ce poids n'est pas réalisable avec le matériel disponible : arrondi à la valeur disponible la plus proche en dessous, ${resultKg} kg.`
      );
    }
  }

  return { weightKg: resultKg, changed, warning: notes.length ? notes.join(" ") : null, atCeiling };
}

/** The two implement types that draw from the shared plate stock (see constants.md). */
const BAR_IMPLEMENT_TYPES = new Set(["dual_bar_symmetric", "single_bar_heavy"]);

/**
 * Does this per-implement load need PLATES on a bar, for an exercise that can
 * use one?
 *
 * Since an exercise is no longer bound to a single implement, "this line uses a
 * bar" can no longer be read off its implement set — almost every hand-held
 * line could use one. It is the LOAD that decides: a value the dumbbells can
 * produce is assumed to be done with the dumbbells, which are cheaper to change
 * and which the coach's prompt already tells it to prefer. Only a load the
 * dumbbells cannot produce forces a plated bar.
 *
 * Returns the bar implement type that has to carry the load, or `null` when no
 * plating is needed (no bar in the set, a dumbbell-achievable load, an empty
 * bar, or 0).
 */
function resolveRequiredBarType(implementTypes, perImplementKg, inventory) {
  const barTypes = (Array.isArray(implementTypes) ? implementTypes : []).filter((type) =>
    BAR_IMPLEMENT_TYPES.has(type)
  );
  if (barTypes.length === 0) return null;

  // An empty bar (no plates mounted) and a 0 load are not plate manipulations.
  if (isCloseTo(perImplementKg, 0) || isCloseTo(perImplementKg, inventory.barEmptyKg)) return null;

  const dumbbellSet = getAchievableSetForType("dumbbell", inventory);
  if (implementTypes.includes("dumbbell") && dumbbellSet.some((value) => isCloseTo(value, perImplementKg))) {
    return null;
  }

  return (
    barTypes.find((type) =>
      getAchievableSetForType(type, inventory).some((value) => isCloseTo(value, perImplementKg))
    ) ?? barTypes[0]
  );
}

/** Formats one exercise line's prescribed weight for a French warning message, e.g. "12 kg/main". */
function formatWeightForWarning(weightKg, weightType) {
  return `${weightKg} kg${weightType === "per_hand" ? "/main" : ""}`;
}

/**
 * Session-level guardrail: reports how many distinct plated bar
 * configurations a session's exercise lines require, and warns (never
 * blocks) when that is more than one. Re-plating a shared, loadable bar
 * mid-session is slow enough in practice that the plan just doesn't get
 * followed — see constraints.md.
 *
 * Only lines that actually need a PLATED BAR count (`resolveRequiredBarType`) —
 * i.e. a line whose exercise can use a bar AND whose per-implement load the
 * dumbbells cannot produce. Everything else is ignored, since varying a
 * dumbbell/ankle-weight/elastic/bodyweight/cardio load is cheap. This used to
 * be decided from the exercise's single `implementType`; that inference broke
 * the moment an exercise could be loaded with either implement, which is why
 * the LOAD decides now (a dumbbell-achievable load is assumed to be done with
 * the dumbbells, the cheaper option the prompt already asks the coach to
 * prefer). A "configuration" is the pair `(bar implement type, per-implement
 * load)`. Both bar types draw from the SAME shared plate stock, so a session
 * mixing a `dual_bar_symmetric` line and a `single_bar_heavy` line needs
 * re-plating even at numerically similar loads — they are always counted as
 * distinct configurations, never merged. A bar at its empty weight
 * (`inventory.barEmptyKg` — no plates needed) and a `0` weight are both excluded
 * from the count, since neither is a plate manipulation. Two lines at the same
 * configuration (same bar type + per-implement load, regardless of exercise or
 * order) count once.
 *
 * Reuses `computeTotalAndPerHand` (this module's per-implement resolution,
 * shared with `isLoadValid`/`roundToAchievable`) rather than re-deriving the
 * bilateral/weightType arithmetic.
 *
 * Pure, never throws: a non-array input, a `null`/malformed line, an unknown
 * exercise name, or a non-finite/negative weight are all silently skipped
 * rather than raising.
 *
 * @param {Array<{name: string, weight: number, weightType: "per_hand"|"total"}>} exercises
 *   One session's exercise lines, in the shape `planFromJson` produces.
 * @param {object} catalog - a `buildCatalogViews` result. Required, never defaulted.
 * @returns {{
 *   count: number,
 *   configurations: Array<{
 *     implementType: "dual_bar_symmetric" | "single_bar_heavy",
 *     perImplementKg: number,
 *     exercises: Array<{ name: string, weightKg: number, weightType: string }>,
 *   }>,
 *   warnings: string[],
 * }}
 *   `count` is the number of distinct non-empty bar configurations found
 *   (this IS the threshold value: flagged when `count > 1`). `configurations`
 *   lists each one with the exercise lines that use it (original weight/
 *   weightType, as prescribed — not the resolved per-implement load).
 *   `warnings` holds at most one French, user-facing string, present only
 *   when `count > 1`, naming every exercise and its prescribed load.
 */
export function checkSessionBarConfigurations(exercises, catalog) {
  requireCatalog(catalog, "checkSessionBarConfigurations");

  const lines = Array.isArray(exercises) ? exercises : [];
  const configsByKey = new Map();

  for (const line of lines) {
    if (!line || typeof line.name !== "string") continue;

    const descriptor = catalog.descriptions[line.name];
    if (!descriptor) continue;

    const weightKg = line.weight;
    if (!Number.isFinite(weightKg) || weightKg < 0) continue;

    const weightType = line.weightType === "per_hand" ? "per_hand" : "total";
    const { totalKg, perHandKg } = computeTotalAndPerHand(descriptor, weightKg, weightType);
    const perImplementKg = roundToDecimal(descriptor.bilateral ? perHandKg : totalKg);

    const barType = resolveRequiredBarType(descriptor.implementTypes, perImplementKg, catalog.inventory);
    if (!barType) continue;

    const key = `${barType}::${perImplementKg}`;
    if (!configsByKey.has(key)) {
      configsByKey.set(key, {
        implementType: barType,
        perImplementKg,
        exercises: [],
      });
    }
    configsByKey.get(key).exercises.push({ name: line.name, weightKg, weightType });
  }

  const configurations = [...configsByKey.values()];
  const warnings = [];

  if (configurations.length > 1) {
    const details = configurations
      .map((config) =>
        config.exercises
          .map((ex) => `${ex.name} (${formatWeightForWarning(ex.weightKg, ex.weightType)})`)
          .join(", ")
      )
      .join(" ; ");
    warnings.push(
      `Cette séance nécessite ${configurations.length} réglages de barre différents, ce qui demande de repositionner les disques en cours de séance : ${details}. Essayez de regrouper les exercices sur la même charge de barre, ou de faire varier la charge sur les haltères plutôt que sur la barre.`
    );
  }

  return { count: configurations.length, configurations, warnings };
}
