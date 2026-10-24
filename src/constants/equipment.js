/**
 * Equipment/load model — what the coach may prescribe, derived from the
 * user's own inventory.
 *
 * The inventory is DATA, not code: it lives in the profile document in Neon
 * (`profile.inventory`), is edited in the Profil tab, and is validated when it
 * is written (`validateInventory`). Every achievable-load set, every home/gym
 * verdict and every equipment line is DERIVED from it by the functions below —
 * never hand-write a derived list as a literal (only in tests, as
 * assertions).
 *
 * `STARTER_INVENTORY` is what a fresh install shows before the user has said
 * what they own. It is an example to edit, not a claim about anyone's gym.
 */

/**
 * The inventory a new install starts from: adjustable dumbbells, two loadable
 * bars with plates, a pull-up bar, hip bands, a chair and one ankle weight.
 */
export const STARTER_INVENTORY = Object.freeze({
  dumbbellOptionsKg: Object.freeze([2, 4, 6, 8, 10, 12]),
  barEmptyKg: 2.5,
  barCount: 2,
  plateStock: Object.freeze([
    Object.freeze({ weightKg: 5, count: 4 }),
    Object.freeze({ weightKg: 2, count: 4 }),
    Object.freeze({ weightKg: 1, count: 4 }),
  ]),
  ankleWeightKg: 1.5,
  owned: Object.freeze(["dumbbell", "bar", "ankle_weight", "pullup_bar", "elastic_hips", "chair"]),
});

/** Allowed values inside a catalog exercise's `implementTypes`. */
export const IMPLEMENT_TYPES = [
  "bodyweight",
  "dumbbell",
  "dual_bar_symmetric",
  "single_bar_heavy",
  "ankle_weight",
  "elastic",
  "cardio",
];

/**
 * Which implement carries the load is NOT a property of the exercise: almost
 * every hand-held movement can be loaded with the adjustable dumbbells OR with
 * the loadable bars. A catalog exercise's `implementTypes` is therefore a
 * SET, and a prescribed weight is validated against the UNION of those
 * implements' achievable sets (`loadValidation.js`).
 *
 * The two sets below are the owner's general rule (2026-07-26), named once and
 * shared so the rule stays greppable instead of being retyped 25 times. Frozen:
 * every entry that follows the rule points at the same array.
 *
 * Per-exercise ceilings (the catalog's `ceilings` view) apply on top and are NOT
 * widened by any of this — an implement set says what is loadable, a ceiling
 * says what is allowed.
 */

/** One implement in EACH hand (`bilateral: true`): a dumbbell per hand, or one loadable bar per hand. */
export const BILATERAL_HAND_IMPLEMENTS = Object.freeze(["dumbbell", "dual_bar_symmetric"]);

/**
 * A SINGLE implement held in the hands (`bilateral: false`) — two-handed in
 * front or overhead (Extension triceps, Squat sumo) or one-handed (Kickback
 * triceps, Turkish get-up). One dumbbell, or one loaded bar: with a single bar
 * there is no "both bars must match" constraint, so plates pair per end only
 * and the achievable set is `single_bar_heavy`, not `dual_bar_symmetric`.
 */
export const SINGLE_HAND_HELD_IMPLEMENTS = Object.freeze(["dumbbell", "single_bar_heavy"]);

/** Allowed values for a catalog exercise's `equipmentNeeds` entries. */
export const EQUIPMENT_VOCABULARY = [
  "bench",
  "machine",
  "pulley",
  "kettlebell",
  "rack",
  "elastic_hips",
  "elastic_upper",
  "chair",
  "ankle_weight",
  "dumbbell",
  "bar",
  "pullup_bar",
];

/**
 * French, user-facing names for `EQUIPMENT_VOCABULARY` tokens. A rejection
 * that only says "not doable at home" is not actionable — these let the
 * validators name the exact piece of equipment that is missing. Phrased as a
 * noun group ("un banc") so it drops straight into a sentence.
 */
export const EQUIPMENT_LABELS_FR = {
  bench: "un banc",
  machine: "une machine de salle",
  pulley: "une poulie",
  kettlebell: "un kettlebell",
  rack: "un rack",
  elastic_hips: "un élastique de hanches",
  elastic_upper: "un élastique haut du corps accroché en hauteur",
  chair: "une chaise",
  ankle_weight: "des lests de cheville",
  dumbbell: "des haltères",
  bar: "des barres chargeables",
  pullup_bar: "une barre de traction",
};

/**
 * Lists, in French, the equipment an exercise needs that the user does NOT
 * have at home — i.e. exactly the tokens that make `deriveLocations` withhold
 * 'maison'. Returns an empty array for a home-legal exercise, so callers can
 * treat "nothing blocks it" and "these things block it" with one call.
 *
 * Derived from the inventory's `unavailableAtHome`, never hand-listed, so a
 * change to the inventory can't leave the message contradicting the verdict.
 *
 * @param {string[]} equipmentNeeds
 * @param {{ unavailableAtHome: string[] }} inventory - a `buildInventoryViews` result.
 */
export function describeHomeBlockers(equipmentNeeds, inventory) {
  const missing = inventory?.unavailableAtHome ?? [];
  return (Array.isArray(equipmentNeeds) ? equipmentNeeds : [])
    .filter((need) => missing.includes(need))
    .map((need) => EQUIPMENT_LABELS_FR[need] ?? need);
}

/** Locations the app recognizes for a session. */
export const LOCATIONS = ["maison", "salle"];

/**
 * Derives the locations an exercise is allowed in from its raw equipment
 * needs and implement type. Never hand-write a location on an exercise —
 * always go through this function so the verdict cannot drift from the
 * equipment facts.
 *
 * - 'maison' is allowed when `equipmentNeeds` contains nothing the inventory
 *   lacks (`inventory.unavailableAtHome`).
 * - 'salle' applies to cardio only (`implementTypes` contains `"cardio"`) —
 *   strength training is a home activity here.
 *
 * An exercise can legitimately resolve to an empty array (allowed nowhere,
 * e.g. a bench exercise that isn't cardio) — that is a real state, not an
 * error, and callers must handle it rather than assume a non-empty result.
 *
 * @param {string[]} equipmentNeeds
 * @param {string[]} implementTypes - The exercise's implement SET (see
 *   `BILATERAL_HAND_IMPLEMENTS`), not a single type.
 * @param {{ unavailableAtHome: string[] }} inventory - a `buildInventoryViews` result.
 */
export function deriveLocations(equipmentNeeds, implementTypes, inventory) {
  const missing = inventory?.unavailableAtHome ?? [];
  const locations = [];
  const needsMissingEquipment = equipmentNeeds.some((need) => missing.includes(need));
  if (!needsMissingEquipment) {
    locations.push("maison");
  }
  if ((Array.isArray(implementTypes) ? implementTypes : []).includes("cardio")) {
    locations.push("salle");
  }
  return locations;
}

/** Rounds a computed load to 1 decimal place to avoid float artifacts (e.g. 2 + 0.5 + 0.5 -> 2.9999...). */
function roundToDecimal(value) {
  return Math.round(value * 10) / 10;
}

/** Sorts ascending, deduplicates, and rounds every value to 1 decimal. */
function sortedUniqueRounded(values) {
  const rounded = values.map(roundToDecimal);
  return Array.from(new Set(rounded)).sort((a, b) => a - b);
}

/**
 * Enumerates every achievable load from the plate stock for one bar setup.
 *
 * A loadable bar takes ONE plate per end, so any given plate size must
 * always be added in a matched pair (one per end) — strict pairing, no
 * odd/unbalanced single-plate loading. `PLATES_PER_STEP` is how many
 * physical plates one "step" of usage consumes from the shared stock:
 * - `single_bar_heavy`: 2 at a time (one pair, on the one bar).
 * - `dual_bar_symmetric`: 4 at a time (one pair per bar, on BOTH bars,
 *   since the two bars must carry an identical per-hand load).
 *
 * Either way, one step always adds `2 * weightKg` to the load being
 * computed (the pair mounted on the relevant bar) — the physical rule is
 * identical, only the stock-consumption multiplier differs per implement
 * type. A 0.5 kg plate therefore only ever contributes in 1 kg steps; no
 * half-kilo value is achievable on a bar.
 */
function computeBarLoads(plateStock, barEmptyKg, platesPerStep) {
  const stepsPerType = plateStock.map((plate) => {
    const maxSteps = Math.floor(plate.count / platesPerStep);
    const steps = [];
    for (let step = 0; step <= maxSteps; step++) {
      steps.push(step * plate.weightKg * 2);
    }
    return steps;
  });

  const loads = [];
  function recurse(typeIndex, currentLoad) {
    if (typeIndex === stepsPerType.length) {
      loads.push(currentLoad);
      return;
    }
    for (const contribution of stepsPerType[typeIndex]) {
      recurse(typeIndex + 1, currentLoad + contribution);
    }
  }
  recurse(0, barEmptyKg);

  return sortedUniqueRounded(loads);
}

/**
 * Computes the achievable-load set per implement type from the raw
 * inventory. Only implement types with a variable numeric load are
 * included — bodyweight, ankle_weight, elastic, and cardio have no
 * combinatorial set to derive.
 *
 * Two bars are needed for `dual_bar_symmetric` (the same load on both) and one
 * for `single_bar_heavy`; with fewer bars the set is empty rather than
 * invented.
 */
export function computeAchievableLoadsPerImplement({
  dumbbellOptionsKg = STARTER_INVENTORY.dumbbellOptionsKg,
  plateStock = STARTER_INVENTORY.plateStock,
  barEmptyKg = STARTER_INVENTORY.barEmptyKg,
  barCount = STARTER_INVENTORY.barCount,
} = {}) {
  return {
    dumbbell: sortedUniqueRounded(dumbbellOptionsKg),
    dual_bar_symmetric: barCount >= 2 ? computeBarLoads(plateStock, barEmptyKg, 4) : [],
    single_bar_heavy: barCount >= 1 ? computeBarLoads(plateStock, barEmptyKg, 2) : [],
  };
}

const MAX_DUMBBELL_OPTIONS = 40;
const MAX_PLATE_SIZES = 12;
const MAX_LOAD_KG = 500;

const isPositiveKg = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_LOAD_KG;
const isNonNegativeKg = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_LOAD_KG;

/**
 * Write-time check of an inventory document. Never throws; returns the list of
 * problems in French (a message is read by the user in the profile form, and
 * by the sync endpoint as its 400 body).
 *
 * @param {unknown} raw
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateInventory(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["Le matériel doit être un objet."] };
  }
  const inv = raw;

  if (!Array.isArray(inv.dumbbellOptionsKg) || inv.dumbbellOptionsKg.length > MAX_DUMBBELL_OPTIONS
    || !inv.dumbbellOptionsKg.every(isPositiveKg)) {
    errors.push("Les haltères doivent être une liste de poids positifs (kg).");
  }
  if (!isNonNegativeKg(inv.barEmptyKg)) errors.push("Le poids d'une barre à vide doit être un nombre positif ou nul (kg).");
  if (!Number.isInteger(inv.barCount) || inv.barCount < 0 || inv.barCount > 10) {
    errors.push("Le nombre de barres doit être un entier entre 0 et 10.");
  }
  if (!Array.isArray(inv.plateStock) || inv.plateStock.length > MAX_PLATE_SIZES
    || !inv.plateStock.every((p) => p && isPositiveKg(p.weightKg) && Number.isInteger(p.count) && p.count >= 0 && p.count <= 1000)) {
    errors.push("Les disques doivent être une liste de { poids, quantité } valides.");
  }
  if (!isNonNegativeKg(inv.ankleWeightKg)) errors.push("Le lest de cheville doit être un nombre positif ou nul (kg).");
  if (!Array.isArray(inv.owned) || !inv.owned.every((t) => EQUIPMENT_VOCABULARY.includes(t))) {
    errors.push("Le matériel possédé contient une valeur inconnue.");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Reads an inventory document tolerantly: `null`/`undefined` is "not said yet"
 * and gives the starter, anything object-shaped is cleaned field by field (a
 * bad entry is dropped, a missing field is empty — never silently filled from
 * the starter, which would credit the user with equipment they did not list).
 * `validateInventory` is the strict gate at write time; this is what keeps a
 * damaged row from taking the coach down.
 */
export function normalizeInventory(raw) {
  if (raw === null || raw === undefined) return { ...STARTER_INVENTORY, isStarter: true };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ...STARTER_INVENTORY, isStarter: true };
  return {
    dumbbellOptionsKg: Array.isArray(raw.dumbbellOptionsKg) ? raw.dumbbellOptionsKg.filter(isPositiveKg) : [],
    barEmptyKg: isNonNegativeKg(raw.barEmptyKg) ? raw.barEmptyKg : 0,
    barCount: Number.isInteger(raw.barCount) && raw.barCount >= 0 ? raw.barCount : 0,
    plateStock: Array.isArray(raw.plateStock)
      ? raw.plateStock.filter((p) => p && isPositiveKg(p.weightKg) && Number.isInteger(p.count) && p.count >= 0)
          .map((p) => ({ weightKg: p.weightKg, count: p.count }))
      : [],
    ankleWeightKg: isNonNegativeKg(raw.ankleWeightKg) ? raw.ankleWeightKg : 0,
    owned: Array.isArray(raw.owned) ? raw.owned.filter((t) => EQUIPMENT_VOCABULARY.includes(t)) : [],
    isStarter: false,
  };
}

/**
 * Renders the inventory as French, user-facing equipment lines — the plan
 * export's equipment line and the profile summary — so the coach never
 * reasons against stale hand-written prose.
 */
export function generateEquipmentLines(inventory) {
  const inv = inventory?.achievable ? inventory : buildInventoryViews(inventory);
  const lines = [];
  if (inv.dumbbellOptionsKg.length > 0) {
    lines.push(`Haltères réglables (1 paire), ${Math.min(...inv.dumbbellOptionsKg)}-${Math.max(...inv.dumbbellOptionsKg)}kg/main`);
  }
  if (inv.barCount > 0) {
    const plateDescription = inv.plateStock.map((p) => `${p.count}x${p.weightKg}kg`).join(", ");
    const perHand = inv.achievable.dual_bar_symmetric;
    const maxNote = perHand.length > 0 ? ` (max ~${Math.max(...perHand)}kg/main)` : "";
    lines.push(`${inv.barCount} barres chargeables (${inv.barEmptyKg}kg à vide chacune) + disques : ${plateDescription}${maxNote}`);
  }
  if (inv.ankleWeightKg > 0 && inv.owned.includes("ankle_weight")) lines.push(`Lests cheville ${inv.ankleWeightKg}kg`);
  if (inv.owned.includes("elastic_hips")) lines.push("Élastiques (hanches uniquement, pas de bras)");
  if (inv.owned.includes("pullup_bar")) lines.push("Barre de traction (hauteur réglée une fois par séance)");
  if (inv.owned.includes("chair")) lines.push("Chaise pour les step-ups");
  return lines;
}

/**
 * Everything the validators and the prompt need from an inventory, as DATA
 * (no functions: the views are passed around with the catalog and must survive
 * a JSON round trip). `unavailableAtHome` is the vocabulary minus what the user
 * owns; the load sets are enumerated from the raw numbers.
 *
 * @param {unknown} [raw] - `profile.inventory`; absent means the starter.
 */
export function buildInventoryViews(raw) {
  const inv = normalizeInventory(raw);
  const achievable = computeAchievableLoadsPerImplement(inv);
  const views = {
    isStarter: inv.isStarter,
    dumbbellOptionsKg: sortedUniqueRounded(inv.dumbbellOptionsKg),
    barEmptyKg: inv.barEmptyKg,
    barCount: inv.barCount,
    plateStock: inv.plateStock.map((p) => ({ ...p })),
    ankleWeightKg: inv.ankleWeightKg,
    owned: [...inv.owned],
    unavailableAtHome: EQUIPMENT_VOCABULARY.filter((token) => !inv.owned.includes(token)),
    achievable,
    // `single_bar_heavy` is a total-on-the-bar load, not a per-hand one, so it
    // is excluded: folding it in would misrepresent per-hand capacity.
    perHandUnion: sortedUniqueRounded([...achievable.dumbbell, ...achievable.dual_bar_symmetric]),
  };
  return views;
}
