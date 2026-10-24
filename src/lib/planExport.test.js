import { describe, it, expect, vi, afterEach } from "vitest";
import { generateExport } from "./planExport.js";
import { formatDateShort, today } from "./helpers.js";
import { generateEquipmentLines } from "../constants/equipment.js";
import { TEST_INVENTORY } from "../constants/testInventory.js";
import { sessionForCoach } from "./activeSession.js";

// --- Test data factories ---

function makeProfile(overrides = {}) {
  return {
    name: "Test",
    age: 25,
    height: 170,
    weight: 65,
    experience: "3 ans",
    frequency: "3x/semaine",
    equipment: ["Haltères"],
    inventory: TEST_INVENTORY,
    goals: "Stay fit",
    priorities: "Upper body",
    ...overrides,
  };
}

function makeSession(overrides = {}) {
  return {
    id: "s_1",
    name: "Upper Body",
    date: "2026-02-10",
    duration_minutes: 40,
    exercises: [
      {
        name: "Développé couché au sol",
        sets: [
          { reps: 10, weight: 20 },
          { reps: 10, weight: 20 },
        ],
      },
    ],
    general_notes: "",
    ...overrides,
  };
}

function makePlan(overrides = {}) {
  return {
    weekStart: "2026-02-10",
    weekEnd: "2026-02-16",
    coachNotes: "",
    sessions: [
      {
        name: "Upper Body",
        exercises: [
          {
            name: "Développé couché au sol",
            sets: "4×10",
            setsCount: 4,
            reps: "10",
            weight: 20,
            restSeconds: 60,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("generateExport", () => {
  const profile = makeProfile();

  // Regression: 17c3f06 — a profile field she cleared is stored as null and the export printed
  // « nullkg » to the coach (« null kg » shape on the profile card too).
  // Regression: cf38ff5 — the name was joined unconditionally: « - , 34 ans » or « - null, 34 ans ».
  // Regression: 4857643 — experience, frequency, goals and priorities were interpolated raw: a
  // cleared field printed « fréquence : » or « null ».
  it("leaves cleared practice and goal fields out, and drops a line left empty", () => {
    const text = generateExport([], makeProfile({ experience: null, frequency: " ", goals: "", priorities: "Haut du corps" }), null);
    expect(text).not.toMatch(/null|fréquence|Expérience|Objectifs/);
    expect(text).toContain("- Priorités : Haut du corps");
    const one = generateExport([], makeProfile({ experience: "", frequency: "3x/semaine" }), null);
    expect(one).toContain("- fréquence : 3x/semaine");
    // Control: a full profile keeps both phrases on one line.
    expect(generateExport([], makeProfile(), null)).toContain("- Expérience : 3 ans, fréquence : 3x/semaine");
  });

  it("leaves a blank or missing name out of the profile line", () => {
    const afterHeader = (p) => {
      const lines = generateExport([], p, null).split("\n");
      return lines[lines.indexOf("PROFIL :") + 1];
    };
    expect(afterHeader(makeProfile({ name: "" }))).toBe("- 25 ans, 170cm, 65kg");
    expect(afterHeader(makeProfile({ name: null }))).toBe("- 25 ans, 170cm, 65kg");
    // Nothing at all to say: no empty « - » line.
    expect(afterHeader(makeProfile({ name: " ", age: null, height: null, weight: null }))).toMatch(/^- Expérience/);
  });

  it("leaves a cleared profile field out of the profile line", () => {
    const line = (p) => generateExport([], p, null).split("\n").find((l) => l.startsWith("- Test"));
    expect(line(makeProfile({ weight: null }))).toBe("- Test, 25 ans, 170cm");
    expect(line(makeProfile({ age: null, height: null, weight: null }))).toBe("- Test");
    // Control: a filled profile keeps every field, in order.
    expect(line(profile)).toBe("- Test, 25 ans, 170cm, 65kg");
  });

  it("generates export with header and period dates", () => {
    const result = generateExport([], profile, null);

    expect(result).toContain("=== FITTRACK EXPORT ===");
    expect(result).toContain("Période :");
    expect(result).toContain("→");

    // Period should contain two formatted dates
    const periodLine = result.split("\n").find((l) => l.startsWith("Période"));
    expect(periodLine).toBeDefined();
    // Should have DD/MM format on both sides of arrow
    expect(periodLine).toMatch(/\d{2}\/\d{2}\s*→\s*\d{2}\/\d{2}/);
  });

  it("formats recent sessions with exercises", () => {
    const session = makeSession();
    const result = generateExport([session], profile, null);

    expect(result).toContain("SÉANCES RÉCENTES :");
    expect(result).toContain(formatDateShort("2026-02-10"));
    expect(result).toContain("Upper Body");
    expect(result).toContain("40 min");
    expect(result).toContain("Développé couché au sol");
    expect(result).toContain("10reps @ 20kg");
  });

  it("shows session notes when present", () => {
    const session = makeSession({ general_notes: "Felt strong today" });
    const result = generateExport([session], profile, null);

    expect(result).toContain("Notes : Felt strong today");
  });

  it("computes personal records (top 10 by weight)", () => {
    const sessions = [
      makeSession({
        id: "s_1",
        exercises: [
          {
            name: "Squat",
            sets: [
              { reps: 8, weight: 60 },
              { reps: 8, weight: 65 },
            ],
          },
        ],
      }),
      makeSession({
        id: "s_2",
        date: "2026-02-11",
        exercises: [
          {
            name: "Squat",
            sets: [
              { reps: 8, weight: 50 },
              { reps: 8, weight: 55 },
            ],
          },
        ],
      }),
    ];
    const result = generateExport(sessions, profile, null);

    expect(result).toContain("RECORDS PERSONNELS (top 10) :");
    // PR should be 65kg (max of all Squat sets across sessions), and the
    // per-hand/total unit must be EXPLICIT — a bare "65kg" is ambiguous by a
    // factor of two and feeds straight into the coach's next prescribed load.
    expect(result).toContain("Squat : 65kg total");
  });

  it("marks a per-hand record as /main, not as a total (regression)", () => {
    // Regression: records were exported as bare `${pr.weight}kg`, so a 12kg/main
    // squat and a 12kg total squat were indistinguishable to the coach.
    const sessions = [
      makeSession({
        date: "2026-02-10",
        exercises: [
          { name: "Squat", weightType: "per_hand", sets: [{ reps: 8, weight: 12 }] },
          { name: "Pont fessier", weightType: "total", sets: [{ reps: 12, weight: 11 }] },
        ],
      }),
    ];
    const result = generateExport(sessions, profile, null);

    expect(result).toContain("Squat : 12kg/main");
    expect(result).toContain("Pont fessier : 11kg total");
  });

  it("limits personal records to top 10", () => {
    // Create 12 different exercises with increasing weights
    const exercises = Array.from({ length: 12 }, (_, i) => ({
      name: `Exercise ${i + 1}`,
      sets: [{ reps: 10, weight: (i + 1) * 10 }],
    }));
    const session = makeSession({ exercises });
    const result = generateExport([session], profile, null);

    // Extract only the PR section
    const prSection = result
      .split("RECORDS PERSONNELS (top 10) :")[1]
      .split("\n\n")[0];
    const prLines = prSection
      .split("\n")
      .filter((l) => l.startsWith("- Exercise"));
    expect(prLines).toHaveLength(10);

    // Lowest weight exercises (10kg, 20kg) should NOT appear in PR section
    expect(prSection).not.toContain("Exercise 1 :");
    expect(prSection).not.toContain("Exercise 2 :");
    // Highest should be included
    expect(prSection).toContain("Exercise 12 : 120kg");
    expect(prSection).toContain("Exercise 3 : 30kg");
  });

  it("computes weekly volume", () => {
    // Create a session dated within the current week
    const todayISO = today();
    const session = makeSession({
      date: todayISO,
      exercises: [
        {
          name: "Développé couché au sol",
          sets: [
            { reps: 10, weight: 20 },
            { reps: 10, weight: 20 },
          ],
        },
      ],
    });
    // Volume = 10*20 + 10*20 = 400
    const result = generateExport([session], profile, null);

    expect(result).toContain("TENDANCES :");
    expect(result).toContain("Volume hebdo");
    expect(result).toMatch(/400/);
  });

  it("detects plateaus (3+ sessions same max weight)", () => {
    const now = new Date();
    const sessions = [0, 1, 2].map((offset) => {
      const d = new Date(now);
      d.setDate(d.getDate() - offset * 3);
      return makeSession({
        id: `s_${offset}`,
        date: d.toISOString().split("T")[0],
        exercises: [
          {
            name: "Développé couché au sol",
            sets: [{ reps: 10, weight: 30 }],
          },
        ],
      });
    });

    const result = generateExport(sessions, profile, null);

    expect(result).toContain("Plateaux détectés");
    expect(result).toContain("Développé couché au sol");
    expect(result).toContain("30kg");
  });

  it("does not show plateau section when no plateaus", () => {
    const now = new Date();
    // Only 2 sessions, not enough for plateau detection
    const sessions = [0, 1].map((offset) => {
      const d = new Date(now);
      d.setDate(d.getDate() - offset);
      return makeSession({
        id: `s_${offset}`,
        date: d.toISOString().split("T")[0],
        exercises: [
          {
            name: "Développé couché au sol",
            sets: [{ reps: 10, weight: 30 }],
          },
        ],
      });
    });

    const result = generateExport(sessions, profile, null);
    expect(result).not.toContain("Plateaux détectés");
  });

  it("includes plan adherence section when currentPlan provided", () => {
    const todayISO = today();

    const session = makeSession({
      date: todayISO,
      exercises: [
        {
          name: "Développé couché au sol",
          sets: [
            { reps: 10, weight: 20 },
            { reps: 10, weight: 25 },
          ],
        },
      ],
    });

    const plan = makePlan({ weekStart: "2000-01-01", weekEnd: "2999-12-31" });
    const result = generateExport([session], profile, plan);

    expect(result).toContain("ADHÉRENCE AU PROGRAMME DE LA SEMAINE EN COURS");
    expect(result).toContain("séances réalisées");
    expect(result).toContain("Cibles atteintes");
  });

  it("shows missed targets in plan adherence", () => {
    const todayISO = today();

    // Session with weight below plan target
    const session = makeSession({
      date: todayISO,
      exercises: [
        {
          name: "Développé couché au sol",
          sets: [{ reps: 10, weight: 15 }],
        },
      ],
    });

    // Plan expects 20kg
    const plan = makePlan({ weekStart: "2000-01-01", weekEnd: "2999-12-31" });
    const result = generateExport([session], profile, plan);

    expect(result).toContain("Cibles manquées");
    expect(result).toContain("cible 20kg");
    expect(result).toContain("fait 15kg");
  });

  it("does not include plan adherence when no currentPlan", () => {
    const result = generateExport([], profile, null);
    expect(result).not.toContain("ADHÉRENCE AU PLAN");
  });

  it("does not include plan adherence when plan has empty sessions", () => {
    const plan = makePlan({ sessions: [] });
    const result = generateExport([], profile, plan);
    expect(result).not.toContain("ADHÉRENCE AU PLAN");
  });

  it("handles empty sessions array", () => {
    const result = generateExport([], profile, null);

    expect(result).toContain("=== FITTRACK EXPORT ===");
    expect(result).toContain("Aucune séance enregistrée.");
    expect(result).toContain("PROFIL :");
    // Should not have PR section with no sessions
    expect(result).not.toContain("RECORDS PERSONNELS");
  });

  it("includes profile summary", () => {
    const result = generateExport([], profile, null);

    expect(result).toContain("PROFIL :");
    expect(result).toContain("Test, 25 ans, 170cm, 65kg");
    expect(result).toContain("Expérience : 3 ans");
    expect(result).toContain("fréquence : 3x/semaine");
    expect(result).toContain(`Équipement : ${generateEquipmentLines(TEST_INVENTORY).join(", ")}`);
    expect(result).toContain("Objectifs : Stay fit");
    expect(result).toContain("Priorités : Upper body");
  });

  it("always derives the equipment line from the profile's inventory, ignoring stale profile.equipment", () => {
    const staleProfile = makeProfile({ equipment: ["Haltères fixes 1-20kg/main"] });
    const result = generateExport([], staleProfile, null);

    // The inventory's dumbbell ceiling (18), never the stale profile figure (20).
    expect(result).toContain("18kg");
    expect(result).not.toContain("20kg/main");
  });

  it("follows an edited inventory, and shows the starter one when none was saved yet", () => {
    const heavy = generateExport([], makeProfile({ inventory: { ...TEST_INVENTORY, dumbbellOptionsKg: [4, 24] } }), null);
    expect(heavy).toContain("4-24kg/main");
    const none = generateExport([], makeProfile({ inventory: null }), null);
    expect(none).toContain(generateEquipmentLines(null).join(", "));
    expect(none).not.toContain("3-18kg");
  });

  it("still shows an equipment line when profile.equipment is missing", () => {
    const noEquipProfile = makeProfile({ equipment: null });
    const result = generateExport([], noEquipProfile, null);

    expect(result).toContain(`Équipement : ${generateEquipmentLines(TEST_INVENTORY).join(", ")}`);
  });

  it("shows session without duration when duration_minutes is missing", () => {
    const session = makeSession({ duration_minutes: null });
    const result = generateExport([session], profile, null);

    // Should show the session name without "(X min)"
    const sessionLine = result
      .split("\n")
      .find((l) => l.includes("Upper Body"));
    expect(sessionLine).toBeDefined();
    expect(sessionLine).not.toContain("min");
  });

  it("sorts sessions by date descending and takes most recent 10", () => {
    // Create 12 sessions spread over 12 days
    const sessions = Array.from({ length: 12 }, (_, i) => {
      const d = new Date("2026-02-01");
      d.setDate(d.getDate() + i);
      return makeSession({
        id: `s_${i}`,
        name: `Session ${i + 1}`,
        date: d.toISOString().split("T")[0],
        exercises: [
          {
            name: "Squat",
            sets: [{ reps: 10, weight: 40 }],
          },
        ],
      });
    });

    const result = generateExport(sessions, profile, null);

    // Oldest two sessions (Session 1, Session 2) should not appear
    // since only the 10 most recent are shown
    expect(result).not.toContain("Session 1 ");
    expect(result).not.toContain("Session 2 ");
    // Most recent should appear
    expect(result).toContain("Session 12");
  });
});

describe("generateExport — sessions at the current load (coach progression evidence)", () => {
  const profile = {
    name: "Camille",
    age: 30,
    height: 170,
    weight: 65,
    experience: "5 ans",
    frequency: "3x/semaine",
    goals: "Tonique",
    priorities: "Épaules",
  };

  const at = (date, weight) => ({
    id: `s_${date}`,
    date,
    name: "Bas du corps",
    exercises: [{ name: "Squat", weightType: "per_hand", sets: [{ reps: 8, weight }] }],
  });

  it("reports how many consecutive sessions an exercise has spent at its current load", () => {
    const result = generateExport([at("2026-02-01", 12), at("2026-02-08", 12), at("2026-02-15", 12)], profile, null);

    expect(result).toContain("SÉANCES PROPRES À LA CHARGE ACTUELLE");
    expect(result).toContain("Squat : 12kg/main depuis 3 séances");
  });

  it("uses the singular for a load done only once", () => {
    const result = generateExport([at("2026-02-01", 12), at("2026-02-08", 14)], profile, null);
    expect(result).toContain("Squat : 14kg/main depuis 1 séance (");
    expect(result).not.toContain("depuis 1 séances");
  });

  it("names the block for what it now counts, and drops the old caveat", () => {
    // It used to ship "⚠️ ce compteur compte les séances FAITES … pas les
    // séances « propres »", because the data model could not tell a skipped
    // exercise from a completed one. Mode séance records a three-way status, so
    // the count IS a clean-session count and the caveat would now be a lie.
    const result = generateExport([at("2026-02-01", 12)], profile, null);

    expect(result).toContain("SÉANCES PROPRES À LA CHARGE ACTUELLE");
    expect(result).not.toContain("pas les séances « propres »");
    expect(result).not.toMatch(/ne sait pas encore distinguer/);
  });

  it("breaks the run on an exercise she skipped or cut short", () => {
    const skipped = {
      id: "s_skip", date: "2026-02-15", name: "Bas du corps",
      exercises: [{ name: "Squat", weightType: "per_hand", status: "skipped", sets: [] }],
    };
    const result = generateExport([at("2026-02-01", 12), at("2026-02-08", 12), skipped], profile, null);
    expect(result).toContain("Squat : 12kg/main depuis 2 séances");
  });

  it("omits bodyweight exercises, which have no load to progress", () => {
    const bodyweight = {
      id: "s_bw",
      date: "2026-02-01",
      name: "Core",
      exercises: [{ name: "Gainage planche", sets: [{ reps: 45, weight: 0 }] }],
    };
    const result = generateExport([bodyweight], profile, null);
    expect(result).not.toContain("Gainage planche : 0kg");
  });

  it("omits the whole section when there are no loaded exercises at all", () => {
    expect(generateExport([], profile, null)).not.toContain("SÉANCES PROPRES À LA CHARGE ACTUELLE");
  });
});

describe("generateExport with a séance in progress", () => {
  const PROFILE = makeProfile();

  // Regression: f09e021 — a draft quit on Monday was presented on Thursday as today's workout.
  it("dates a draft from another day instead of calling it « en cours »", () => {
    const draft = (date) => ({
      name: "Haut du corps", date, cursor: { exercise: 0, set: 0 },
      exercises: [{ name: "Rowing", status: "pending", sets: [{ reps: "", weight: "", done: false }] }],
    });
    const stale = generateExport([], PROFILE, null, draft("2020-01-06"));
    expect(stale).toContain("SÉANCE COMMENCÉE LE 06/01/2020, NON TERMINÉE : Haut du corps");
    expect(stale).not.toContain("SÉANCE EN COURS");
    const fresh = generateExport([], PROFILE, null, draft(today()));
    expect(fresh).toContain("SÉANCE EN COURS : Haut du corps");
    expect(fresh).not.toContain("COMMENCÉE LE");
  });

  // Regression: e0575c4 — a draft resumed on a later day, or a séance past midnight, lost its « EN COURS » heading while being trained.
  describe("liveness is decided by sessionForCoach: screen open OR dated today", () => {
    const draft = (date) => ({
      name: "Haut du corps", date, cursor: { exercise: 0, set: 0 },
      exercises: [{ name: "Rowing", status: "pending", sets: [{ reps: "", weight: "", done: false }] }],
    });

    it("an old draft with the séance screen open is EN COURS", () => {
      const text = generateExport([], PROFILE, null, sessionForCoach(draft("2020-01-06"), true));
      expect(text).toContain("SÉANCE EN COURS : Haut du corps");
      expect(text).not.toContain("COMMENCÉE LE");
    });

    it("an old draft with the screen closed is dated, with the year when it is not this year's", () => {
      const text = generateExport([], PROFILE, null, sessionForCoach(draft("2020-01-06"), false));
      expect(text).toContain("SÉANCE COMMENCÉE LE 06/01/2020, NON TERMINÉE : Haut du corps");
      expect(text).not.toContain("SÉANCE EN COURS");
    });

    it("a stale draft from the current year omits the year", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
      const text = generateExport([], PROFILE, null, sessionForCoach(draft("2026-09-28"), false));
      vi.useRealTimers();
      expect(text).toContain("SÉANCE COMMENCÉE LE 28/09, NON TERMINÉE");
      expect(text).not.toContain("28/09/2026");
    });

    it("a draft dated today is EN COURS with the screen closed (Coach tab below xl)", () => {
      const text = generateExport([], PROFILE, null, sessionForCoach(draft(today()), false));
      expect(text).toContain("SÉANCE EN COURS : Haut du corps");
    });
  });

  it("says nothing about a séance when there isn't one", () => {
    const text = generateExport([], PROFILE, null);
    expect(text).not.toMatch(/SÉANCE EN COURS/);
  });

  it("reports the séance in progress, its position, and what is already done", () => {
    const active = {
      name: "Haut du corps",
      cursor: { exercise: 1, set: 0 },
      exercises: [
        { name: "Rowing", weightType: "per_hand", status: "complete",
          sets: [{ reps: "12", weight: "11", done: true }, { reps: "12", weight: "11", done: true }] },
        { name: "Développé", weightType: "per_hand", status: "pending",
          sets: [{ reps: "", weight: "", done: false }] },
      ],
    };
    const text = generateExport([], PROFILE, null, active);
    expect(text).toMatch(/SÉANCE EN COURS/);
    expect(text).toMatch(/Haut du corps/);
    expect(text).toMatch(/exercice 2\/2/);
    expect(text).toMatch(/Rowing/);
    expect(text).toMatch(/12 × 11kg\/main/);
  });

  it("marks a skipped exercise as skipped so the coach doesn't re-prescribe it blind", () => {
    const active = {
      name: "Bas du corps",
      cursor: { exercise: 1, set: 0 },
      exercises: [
        { name: "Squat", weightType: "total", status: "skipped", sets: [{ reps: "", weight: "", done: false }] },
        { name: "Fentes", weightType: "total", status: "pending", sets: [] },
      ],
    };
    expect(generateExport([], PROFILE, null, active)).toMatch(/Squat.*(passé|non réalisé)/i);
  });
});

/**
 * What the coach reads about a held exercise. The unit is a field now, so the
 * export renders it — and the old concatenation is gone.
 */
describe("held exercises in the export", () => {
  const holdSession = makeSession({
    exercises: [{ name: "Dead hang", metric: "seconds", weightType: "total", sets: [{ reps: "25", weight: "" }] }],
  });

  it("never emits the old unit-glued form", () => {
    const out = generateExport([holdSession], makeProfile(), null);
    // `45sreps` was reaching the model as its own evidence about her training.
    expect(out).not.toMatch(/\d+\s*s\s*reps/i);
    expect(out).toMatch(/Dead hang : 1×\(25 s\)/);
  });

  it("gives holds their own records block, apart from the kilogram list", () => {
    const out = generateExport([holdSession], makeProfile(), null);
    expect(out).toContain("RECORDS DE MAINTIEN");
    expect(out).toMatch(/Dead hang : 25 s/);
    // A duration must not be sorted among loads: 25 seconds is not 25 kg.
    const weightBlock = out.split("RECORDS PERSONNELS")[1]?.split("\n\n")[0] ?? "";
    expect(weightBlock).not.toMatch(/Dead hang/);
  });

  it("still renders a rep-counted exercise the way it always did", () => {
    const out = generateExport([makeSession()], makeProfile(), null);
    expect(out).toMatch(/10reps @ 20kg/);
  });
});

/**
 * What the coach learns about an exercise that did not happen.
 *
 * In one session the user spent five messages telling the coach by hand that she
 * could not rig the pull-up bar, substituted rowing, and then managed to rig it
 * after all. The coach was reading a session listing that rendered a skipped
 * exercise as `- Dead hang : 0×()` — an empty parenthesis with no reason
 * attached, and no way to tell a skip from a data glitch.
 */
describe("a skipped or partial exercise in a recorded session", () => {
  const withStatus = (ex) => makeSession({ exercises: [ex] });

  it("says it was skipped, and why", () => {
    const out = generateExport([withStatus({ name: "Dead hang", status: "skipped", skipReason: "materiel", sets: [] })], makeProfile(), null);
    expect(out).toContain("Dead hang : passé (non réalisé) — matériel");
    expect(out).not.toMatch(/Dead hang : 0×\(\)/);
  });

  it("says it was skipped even with no reason given", () => {
    const out = generateExport([withStatus({ name: "Dead hang", status: "skipped", sets: [] })], makeProfile(), null);
    expect(out).toContain("Dead hang : passé (non réalisé)");
    expect(out).not.toMatch(/—\s*$/m);
  });

  it("marks a partial exercise as partial", () => {
    const out = generateExport([withStatus({ name: "Squat", status: "partial", sets: [{ reps: 10, weight: 15 }] })], makeProfile(), null);
    expect(out).toMatch(/Squat : 1×\(10reps @ 15kg\) — partiel/);
  });

  it("leaves a complete exercise unmarked", () => {
    const out = generateExport([withStatus({ name: "Squat", status: "complete", sets: [{ reps: 10, weight: 15 }] })], makeProfile(), null);
    expect(out).toMatch(/Squat : 1×\(10reps @ 15kg\)$/m);
  });
});

/**
 * Regression: f2be256..HEAD — the coach was never sent the plan it wrote.
 *
 * In one session the user asked what load to use while standing in a séance whose
 * plan said 12 kg. The export carried history, records, streaks and adherence
 * COUNTS — but no prescriptions — so the coach answered 14 kg from the streak
 * block. She read that as incoherence (« arrête de faire des erreur »); the
 * coach then apologised for having « mal lu le programme en cours », which it
 * had never received.
 */
describe("the coach can read the plan it wrote", () => {
  afterEach(() => vi.useRealTimers());
  const plan = {
    weekStart: "2026-08-17", weekEnd: "2026-08-23",
    sessions: [{
      name: "Traction", warmup: [], cooldown: [],
      exercises: [{ name: "Rowing haltères", sets: "3×8", setsCount: 3, reps: "8", weight: 12, weightType: "per_hand", progressionNote: "Charge réduite pour le rendez-vous." }],
    }],
  };
  const history = [1, 2, 3].map((i) => makeSession({
    id: `s${i}`, date: `2026-08-0${i}`,
    exercises: [{ name: "Rowing haltères", weightType: "per_hand", status: "complete", sets: [{ reps: "8", weight: "14" }] }],
  }));

  it("states the prescribed load, with its per-hand marker and its reason", () => {
    // The plan's week is pinned: the heading depends on where today sits in it.
    vi.useFakeTimers({ now: new Date("2026-08-19T12:00:00+02:00") });
    const out = generateExport(history, makeProfile(), plan);
    expect(out).toContain("PROGRAMME DE LA SEMAINE EN COURS");
    expect(out).toMatch(/Rowing haltères : 3×8 à 12kg\/main — Charge réduite pour le rendez-vous\./);
  });

  it("gives an upcoming exercise its prescription instead of a bare « à venir »", () => {
    const active = {
      name: "Traction", cursor: { exercise: 0, set: 0 }, warmup: [], cooldown: [],
      exercises: [{ name: "Rowing haltères", weightType: "per_hand", plannedReps: "8", plannedWeight: 12, status: "pending", sets: [{ reps: "", weight: "", done: false }] }],
    };
    const out = generateExport(history, makeProfile(), plan, active);
    expect(out).toMatch(/Rowing haltères : à venir — prévu 8 à 12kg\/main/);
    // The control: without this the string "12" appeared NOWHERE in the whole
    // export while five separate lines said 14.
    expect(out.split("SÉANCES RÉCENTES")[0]).toContain("12kg/main");
  });

  it("renders a held exercise's prescription in seconds", () => {
    const holdPlan = { ...plan, sessions: [{ ...plan.sessions[0], exercises: [
      { name: "Dead hang", setsCount: 3, reps: "25", weight: 0, weightType: "total", metric: "seconds", progressionNote: "" },
    ] }] };
    expect(generateExport([], makeProfile(), holdPlan)).toMatch(/Dead hang : 3×25 s au poids du corps/);
  });

  it("emits no plan block when there is no plan", () => {
    expect(generateExport([], makeProfile(), null)).not.toContain("PROGRAMME DE LA SEMAINE");
    expect(generateExport([], makeProfile(), { sessions: [] })).not.toContain("PROGRAMME DE LA SEMAINE");
  });
});

/**
 * Regression: the adherence block scored held exercises on kilograms.
 */
describe("adherence handles holds and empty set lists", () => {
  const planOf = (ex) => ({ weekStart: "2000-01-01", weekEnd: "2999-12-31", sessions: [{ name: "S", warmup: [], cooldown: [], exercises: [ex] }] });
  const thisWeek = (ex) => [makeSession({ date: today(), exercises: [ex] })];

  it("never reports -Infinity for a skipped exercise", () => {
    const out = generateExport(
      thisWeek({ name: "Squat", weightType: "per_hand", status: "skipped", sets: [] }),
      makeProfile(),
      planOf({ name: "Squat", setsCount: 3, reps: "10", weight: 15, weightType: "per_hand" })
    );
    expect(out).not.toContain("-Infinity");
    expect(out).toMatch(/Squat \(cible 15kg, fait 0kg\)/);
  });

  it("scores a hold on seconds, not on its 0 kg load", () => {
    const out = generateExport(
      thisWeek({ name: "Dead hang", metric: "seconds", weightType: "total", status: "complete", sets: [{ reps: "5", weight: "" }] }),
      makeProfile(),
      planOf({ name: "Dead hang", setsCount: 3, reps: "45", weight: 0, weightType: "total", metric: "seconds" })
    );
    // Was a "cible atteinte": planned 0 kg vs actual 0 kg.
    expect(out).toMatch(/Dead hang \(cible 45 s, fait 5 s\)/);
  });

  it("counts a hold that met its target as a hit", () => {
    const out = generateExport(
      thisWeek({ name: "Dead hang", metric: "seconds", weightType: "total", status: "complete", sets: [{ reps: "45", weight: "" }] }),
      makeProfile(),
      planOf({ name: "Dead hang", setsCount: 3, reps: "45", weight: 0, weightType: "total", metric: "seconds" })
    );
    expect(out).not.toMatch(/Cibles manquées/);
  });
});

describe("adherence measures the plan's own week", () => {
  const ex = { name: "Squat", sets: [{ reps: 10, weight: 20 }] };
  const planFor = (extra = {}) => ({
    weekStart: "2026-10-05",
    weekEnd: "2026-10-11",
    sessions: [{ name: "S", exercises: [{ name: "Squat", setsCount: 3, reps: "10", weight: 20 }] }],
    ...extra,
  });

  afterEach(() => vi.useRealTimers());
  const at = (iso) => vi.useFakeTimers({ now: new Date(`${iso}T12:00:00+02:00`) });

  // Regression: 749d6df — nothing pinned the whole prescription heading: « PROGRAMME DE LA SEMAINE EN COURS »
  // is also a substring of the adherence heading, so a toContain on it stayed green with the prescription heading renamed.
  it("pins the full prescription heading at the start of a line, apart from the adherence heading", () => {
    at("2026-10-07");
    const out = generateExport([], makeProfile(), planFor());
    expect(out).toMatch(
      /^PROGRAMME DE LA SEMAINE EN COURS \(05\/10 → 11\/10\) — c'est CE QUI EST PRESCRIT, et ce que Test a sous les yeux :$/m
    );
    // The adherence heading must not be what satisfies the line above.
    expect(out).toMatch(/^ADHÉRENCE AU PROGRAMME DE LA SEMAINE EN COURS \(05\/10 → 11\/10\) :$/m);
  });

  // The heading names whoever the profile says, not a person baked into the code.
  it("names the user from the profile, and falls back to a neutral word when there is no name", () => {
    at("2026-10-07");
    expect(generateExport([], makeProfile({ name: "Camille" }), planFor())).toContain("ce que Camille a sous les yeux");
    const unnamed = generateExport([], makeProfile({ name: "" }), planFor());
    expect(unnamed).toContain("ce que l'utilisatrice a sous les yeux");
    expect(unnamed).not.toContain("Camille");
  });

  // Regression: 1c011de — a plan for next week read as « 0/N » against the calendar week it never covered.
  // Regression: d5875c6 — the heading still said « EN COURS » for a week that had not started.
  it("labels a plan entirely in the future as upcoming, with its own range and no score", () => {
    at("2026-10-01");
    const out = generateExport([makeSession({ date: "2026-09-30", exercises: [ex] })], makeProfile(), planFor());
    expect(out).toContain("ADHÉRENCE AU PROGRAMME À VENIR (pas commencée) (05/10 → 11/10)");
    expect(out).not.toContain("ADHÉRENCE AU PROGRAMME DE LA SEMAINE");
    expect(out).not.toContain("séances réalisées");
    expect(out).not.toContain("Cibles");
  });

  // Regression: b8685ef — the prescription block said « EN COURS » for upcoming and finished weeks too.
  it("titles the prescription block by the plan's phase, keeping the stable prefix", () => {
    at("2026-10-01");
    const upcoming = generateExport([], makeProfile(), planFor());
    expect(upcoming).toContain("PROGRAMME DE LA SEMAINE À VENIR (pas commencée) (05/10 → 11/10)");
    expect(upcoming).not.toContain("PROGRAMME DE LA SEMAINE EN COURS");
    at("2026-10-14");
    const previous = generateExport([], makeProfile(), planFor());
    expect(previous).toContain("PROGRAMME DE LA SEMAINE PRÉCÉDENTE (terminée) (05/10 → 11/10)");
    expect(previous).not.toContain("PROGRAMME DE LA SEMAINE EN COURS");
    at("2026-10-07");
    expect(generateExport([], makeProfile(), planFor())).toContain("PROGRAMME DE LA SEMAINE EN COURS (05/10 → 11/10)");
  });

  it("labels a plan whose week is over as the previous one and still scores it", () => {
    at("2026-10-14");
    const out = generateExport([makeSession({ date: "2026-10-06", exercises: [ex] })], makeProfile(), planFor());
    expect(out).toContain("ADHÉRENCE AU PROGRAMME DE LA SEMAINE PRÉCÉDENTE (05/10 → 11/10)");
    expect(out).toContain("1/1 séances réalisées");
  });

  it("labels the plan as current on its first and last day", () => {
    for (const day of ["2026-10-05", "2026-10-11"]) {
      at(day);
      const out = generateExport([makeSession({ date: "2026-10-06", exercises: [ex] })], makeProfile(), planFor());
      expect(out).toContain("ADHÉRENCE AU PROGRAMME DE LA SEMAINE EN COURS (05/10 → 11/10)");
      expect(out).toContain("1/1 séances réalisées");
      vi.useRealTimers();
    }
  });

  // Regression: 1c011de — a stored plan session without `exercises` threw and made every send fail.
  it("does not throw on a plan session without exercises", () => {
    const plan = planFor({ sessions: [{ name: "S" }] });
    expect(() => generateExport([makeSession({ date: "2026-10-06", exercises: [ex] })], makeProfile(), plan)).not.toThrow();
  });
});
