/**
 * Build-time constants — everything the app knows before it reads anything.
 *
 * **The exercise catalog is NOT here.** It is a document in Neon: consumers
 * call `buildCatalogViews(doc, inventory)` (`src/lib/catalog.js`) and read
 * `muscleGroups` / `allExercises` / `descriptions` / `blacklist` / `ceilings` /
 * `aliases` off the result. Do not reintroduce a build-time copy of any of
 * them — a second source for a document the user can edit is free to disagree
 * with it, silently.
 *
 * **Nor is the equipment inventory:** it is part of the profile document
 * (`profile.inventory`), and `./equipment.js` only knows how to validate it and
 * derive loads from it.
 *
 * What is left is what a document could never carry: the timer presets, the
 * coaching-judgement numbers nothing enforces, and the empty profile a new
 * install starts from.
 */
export * from "./equipment.js";

/**
 * Normalizes a name for blacklist comparisons: trims, lowercases, and strips
 * diacritics (NFD decomposition + drop combining marks) so "Elevations
 * frontales" (the unaccented spelling constraints.md's own table uses) still
 * matches "Élévations frontales".
 *
 * The last catalog-shaped thing in this file, and it stays because it is a
 * STRING rule rather than catalog data. Two consumers share it so the matching
 * convention has one definition: `catalog.js`'s `findBlacklistEntry`
 * (whole-name) and `planValidation.js`'s `findBlacklistEntryLoose` (substring,
 * for warmup/cooldown free text).
 *
 * @param {string} str
 * @returns {string}
 */
export function normalizeBlacklistName(str) {
  return str.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export const TIMER_PRESETS = [
  { label: "30s", seconds: 30 },
  { label: "60s", seconds: 60 },
  { label: "90s", seconds: 90 },
  { label: "2min", seconds: 120 },
  { label: "3min", seconds: 180 },
];

/**
 * Coaching policy the coach reasons with but no validator enforces.
 *
 * These are judgment inputs, not guardrails, and the distinction is deliberate.
 * Everything in `planValidation.js` blocks or corrects a plan; nothing here
 * does. A cycle phase and a clean-session count are context the coach weighs
 * against how a session actually felt — turning either into a hard rule would
 * override a coaching decision that is legitimately contextual (a load that was
 * conservative to begin with, a week coming off a deload).
 *
 * They live here so the system prompt states ONE set of numbers, derived,
 * instead of two hand-typed copies that drift. The parity test pins both.
 */

/** Cycle length offered when the user turns cycle periodization on. */
export const DEFAULT_CYCLE_LENGTH_DAYS = 28;

/** Bounds a stored cycle length must sit in (days); outside them the cycle is treated as off. */
export const CYCLE_LENGTH_RANGE_DAYS = Object.freeze({ min: 21, max: 40 });

/** Mesocycle shape across a 4-week block, S4 aligned on the low-energy window. */
export const MESOCYCLE = Object.freeze([
  { week: 1, label: "reprise", focus: "réinstaller la technique et le volume, charges modérées" },
  { week: 2, label: "pic d'intensité", focus: "charges les plus lourdes du bloc, tentatives de record" },
  { week: 3, label: "maintien", focus: "garder le volume, ne pas chercher de record" },
  { week: 4, label: "décharge", focus: "volume et intensité réduits, alignée sur la fenêtre prémenstruelle" },
]);

/**
 * The energy windows for a cycle of `lengthDays`, derived from the length
 * alone: the high-energy window runs from day 6 to ~72% of the cycle, and the
 * premenstrual one starts the day after. One number to ask the user for, and
 * the rest follows.
 */
export function cycleWindowsFor(lengthDays) {
  const to = Math.round(lengthDays * 0.72);
  return { highEnergyDays: { from: 6, to }, lowEnergyFromDay: to + 1 };
}

/**
 * Menstrual-cycle periodization, OPT-IN: off unless the profile says
 * `cycle.enabled` with a plausible length. Returns the object the prompt
 * renders, or null when the feature is off — null is what keeps the whole
 * cycle section out of the prompt.
 *
 * `dayInCycle` is ALWAYS supplied by the user in conversation and never
 * deduced: the model previously inferred it from session dates and got a whole
 * phase wrong, announcing the end of a cycle while the user was on day 3 of the
 * next one. That failure is the reason this is prompt guidance asking a
 * question, rather than a computation over `sessions`.
 *
 * @param {object|null|undefined} profile
 * @returns {{ cycleLengthDays: number, highEnergyDays: {from: number, to: number}, lowEnergyFromDay: number, mesocycle: readonly object[] } | null}
 */
export function resolveCycle(profile) {
  const cycle = profile?.cycle;
  if (!cycle || cycle.enabled !== true) return null;
  const length = Number(cycle.lengthDays);
  if (!Number.isInteger(length) || length < CYCLE_LENGTH_RANGE_DAYS.min || length > CYCLE_LENGTH_RANGE_DAYS.max) {
    return null;
  }
  return { cycleLengthDays: length, ...cycleWindowsFor(length), mesocycle: MESOCYCLE };
}

/**
 * Consecutive clean sessions at the SAME load before a load increase is
 * warranted. Guidance, not a gate: `generateExport` reports the count per
 * exercise so the coach can weigh it, and no validator checks it.
 *
 * Supplying the number matters more than enforcing it. Without a counter the
 * model could not tell a consolidation from a plateau, so it fell back to
 * "on consolide par précaution" — which reads as stagnation.
 */
export const CLEAN_SESSIONS_BEFORE_LOAD_INCREASE = 3;

/**
 * The profile a new install starts from: nothing filled in. The first-run
 * setup (`needsProfileSetup`, `src/lib/persona.js`) asks for the name and the
 * grammatical gender before anything else. `inventory: null` means "not said
 * yet" and reads as the starter inventory.
 */
export const DEFAULT_PROFILE = {
  name: "",
  gender: "",
  age: null,
  height: null,
  weight: null,
  experience: "",
  frequency: "",
  goals: "",
  priorities: "",
  coachNotes: "",
  cycle: { enabled: false, lengthDays: DEFAULT_CYCLE_LENGTH_DAYS },
  inventory: null,
};
