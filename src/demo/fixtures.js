/**
 * The demo's data: an invented persona, her programme and ~6 weeks of history.
 *
 * NOTHING here comes from the owner's instance (CLAUDE.md, « Personal data
 * policy »): the persona, her numbers and her notes are made up, the equipment is
 * the app's own STARTER_INVENTORY and every exercise name is from the frozen
 * catalog seed, which carries nothing personal either. Dates are generated
 * relative to the visitor's today, so the demo always reads as current.
 *
 * The programme is authored as a coach PAYLOAD (the plan JSON schema) and stored
 * through `evaluatePlanImport` — the same path a real import takes — so it is
 * valid by construction, and `fixtures.test.js` pins that it imports with no
 * error and no warning.
 */
import seed from "../data/catalogSeed.json";
import { STARTER_INVENTORY } from "../constants/equipment.js";
import { DEFAULT_PROFILE } from "../constants/index.js";
import { usableCatalogViews } from "../lib/catalog.js";
import { evaluatePlanImport } from "../lib/planValidation.js";

export const DEMO_PERSONA_NAME = "Nora";

export const DEMO_PROFILE = {
  ...DEFAULT_PROFILE,
  name: DEMO_PERSONA_NAME,
  gender: "f",
  age: 34,
  height: 168,
  weight: 62,
  experience: "Six mois de musculation à la maison",
  frequency: "3 séances par semaine",
  goals: "Gagner en force et tenir une routine régulière",
  priorities: "Squat et tirage",
  coachNotes: "",
  cycle: { enabled: false, lengthDays: 28 },
  inventory: STARTER_INVENTORY,
};

/** Index 0 is six weeks ago, index 6 is the current week (the programme's loads). */
const WEEKS = 7;

/** One line of the programme, with its load for each of the seven weeks. */
const ex = (name, setsCount, reps, weightType, loads, restSeconds, extra = {}) =>
  ({ name, setsCount, reps, weightType, loads, restSeconds, ...extra });

export const DEMO_SESSIONS = [
  {
    name: "Haut du corps",
    day: 0, // Monday
    warmup: [{ name: "Cercles de bras", detail: "2×15" }, { name: "Rotations des épaules", detail: "1 min" }],
    exercises: [
      ex("Développé couché au sol", 3, 10, "per_hand", [6, 6, 6, 8, 8, 8, 8], 90),
      ex("Rowing haltères", 3, 10, "per_hand", [8, 8, 8, 8, 10, 10, 10], 90),
      ex("Développé épaules", 3, 10, "per_hand", [4, 4, 4, 4, 6, 6, 6], 90),
      ex("Gainage planche", 3, null, "total", [0, 0, 0, 0, 0, 0, 0], 60, { seconds: [30, 30, 35, 40, 40, 45, 45] }),
    ],
    cooldown: [{ name: "Étirement des pectoraux", detail: "30s par côté" }],
  },
  {
    name: "Bas du corps",
    day: 2, // Wednesday
    warmup: [{ name: "Mobilité des hanches", detail: "2 min" }],
    exercises: [
      ex("Squat", 4, 8, "per_hand", [8, 8, 10, 12, 12, 12, 12], 120),
      ex("Soulevé de terre roumain", 3, 10, "per_hand", [10, 10, 10, 12, 12, 12, 12], 120),
      ex("Fentes", 3, 10, "per_hand", [4, 4, 4, 4, 6, 6, 6], 90),
      ex("Pont fessier", 3, 12, "total", [10, 10, 10, 12, 12, 12, 12], 60),
    ],
    cooldown: [{ name: "Étirement des ischios", detail: "30s par côté" }],
  },
  {
    name: "Full body & gainage",
    day: 4, // Friday
    warmup: [{ name: "Cercles de bras", detail: "2×15" }, { name: "Mobilité des hanches", detail: "1 min" }],
    exercises: [
      ex("Thruster", 3, 10, "per_hand", [4, 4, 4, 6, 6, 6, 6], 90),
      ex("Traction australienne", 3, null, "total", [0, 0, 0, 0, 0, 0, 0], 90, { repsByWeek: [6, 6, 7, 8, 8, 9, 10] }),
      ex("Dead bug", 3, null, "total", [0, 0, 0, 0, 0, 0, 0], 45, { repsByWeek: [10, 10, 10, 12, 12, 12, 12] }),
      ex("Gainage latéral", 3, null, "total", [0, 0, 0, 0, 0, 0, 0], 45, { seconds: [20, 20, 25, 25, 30, 30, 30] }),
    ],
    cooldown: [{ name: "Respiration lente", detail: "2 min" }],
  },
];

const repsFor = (e, week) => e.seconds?.[week] ?? e.repsByWeek?.[week] ?? e.reps;

/** YYYY-MM-DD of a local Date. */
export const isoDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** The Monday of the week containing `now`, at local midnight. */
export function mondayOf(now) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return addDays(d, -((d.getDay() + 6) % 7));
}

/** The programme as the coach would emit it, for the week starting `monday`. */
export function buildPlanPayload(monday, week = WEEKS - 1) {
  return {
    weekStart: isoDate(monday),
    weekEnd: isoDate(addDays(monday, 6)),
    coachNotes: "Semaine de consolidation : mêmes charges que la semaine dernière, la technique d'abord. Tu choisis tes jours.",
    sessions: DEMO_SESSIONS.map((s) => ({
      name: s.name,
      warmup: s.warmup,
      exercises: s.exercises.map((e) => ({
        name: e.name,
        setsCount: e.setsCount,
        reps: String(repsFor(e, week)),
        weight: e.loads[week],
        weightType: e.weightType,
        restSeconds: e.restSeconds,
        progressionNote: "",
      })),
      cooldown: s.cooldown,
    })),
    notebook: "",
  };
}

/** Every recorded session up to (excluding) `now`'s date, oldest first. */
export function buildHistory(now) {
  const thisMonday = mondayOf(now);
  const todayIso = isoDate(now);
  const sessions = [];
  for (let week = 0; week < WEEKS; week++) {
    const monday = addDays(thisMonday, -7 * (WEEKS - 1 - week));
    for (const s of DEMO_SESSIONS) {
      const date = isoDate(addDays(monday, s.day));
      if (date >= todayIso) continue;
      // Last week's Friday is the one bad day: a short night, the side plank
      // left part-way. It gives the coach something real to read on fatigue.
      const tired = week === WEEKS - 2 && s.day === 4;
      sessions.push({
        id: `demo_${date}_${s.day}`,
        date,
        name: s.name,
        exercises: s.exercises.map((e) => {
          const reps = repsFor(e, week);
          const cut = tired && e.name === "Gainage latéral";
          const count = cut ? 1 : e.setsCount;
          return {
            name: e.name,
            weightType: e.weightType,
            ...(e.seconds ? { metric: "seconds" } : {}),
            status: cut ? "partial" : "complete",
            ...(cut ? { skipReason: "fatigue" } : {}),
            sets: Array.from({ length: count }, () => ({ reps, weight: e.loads[week], notes: "" })),
          };
        }),
        duration_minutes: s.day === 2 ? 50 : 40,
        general_notes: tired ? "Mauvaise nuit, j'ai arrêté le gainage latéral avant la fin." : "",
      });
    }
  }
  return sessions;
}

/** The catalog as the demo's mirror holds it (the frozen seed, never the live one). */
export const demoCatalogViews = () => usableCatalogViews(seed, DEMO_PROFILE.inventory);

/**
 * Everything the app reads at first load, keyed as `storage.js` stores it.
 * `now` is injectable so the tests pin dates.
 */
export function buildDemoData(now = new Date()) {
  const monday = mondayOf(now);
  const verdict = evaluatePlanImport(buildPlanPayload(monday), demoCatalogViews());
  return {
    profile: DEMO_PROFILE,
    settings: { defaultTimer: 90 },
    sessions: buildHistory(now),
    currentPlan: verdict.plan,
    catalog: { doc: seed, updatedAt: `${isoDate(monday)}T00:00:00.000Z` },
  };
}

export const SEEDED_KEY = "demo_seeded";

/** Writes the demo data into `store` (the namespaced localStorage). */
export function seedDemo(store, now = new Date()) {
  const data = buildDemoData(now);
  for (const [key, value] of Object.entries(data)) store.setItem(key, JSON.stringify(value));
  store.setItem(SEEDED_KEY, "1");
}
