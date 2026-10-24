import { describe, it, expect } from "vitest";
import {
  validatePlan,
  validatePlanDomain,
  evaluatePlanImport,
  noticeForVerdict,
  buildCorrectionRequest,
  summarizeRejectedPlan,
} from "./planValidation.js";
import { getExerciseGroup } from "./helpers.js";
import seed from "../data/catalogSeed.json";
import { buildCatalogViews } from "./catalogTestkit.js";

const CATALOG = buildCatalogViews(seed);

describe("the catalog is a required argument", () => {
  it("throws rather than silently falling back", () => {
    expect(() => evaluatePlanImport({ sessions: [] })).toThrow(/catalog/i);
    expect(() => validatePlanDomain({ sessions: [] })).toThrow(/catalog/i);
  });

  it("throws BEFORE the payload is read, so an unreadable plan cannot mask it", () => {
    // `evaluatePlanImport` answers junk input with a French rejection long
    // before any catalog lookup. A late guard would leave exactly those paths
    // working without a catalog, and the omission would surface only on a plan
    // that actually parsed — in production.
    expect(() => evaluatePlanImport("bonjour, pas de programme ici")).toThrow(/catalog/i);
  });

  // CONTROLS. "It takes a catalog argument" and "it reads that catalog" are
  // different claims, and only the second one is the point of the migration: a
  // validator that accepted the argument and went on reading a build-time
  // constant would pass every other test in this file. Each of these mutates the
  // DOCUMENT and asserts the verdict follows it.
  it("reads ceilings from the catalog it was given, not from a build-time table", () => {
    const noCeiling = buildCatalogViews({
      ...seed,
      exercises: seed.exercises.map((e) => (e.name === "Pont fessier" ? { ...e, ceiling: null } : e)),
    });
    const plan = makePlan([makeSession("Haut du corps", [makeExercise("Pont fessier", 15, "total")])]);

    expect(validatePlanDomain(plan, CATALOG).errors.length).toBe(1);
    expect(validatePlanDomain(plan, noCeiling).errors).toEqual([]);
  });

  it("reads the exercise list from the catalog it was given", () => {
    const withoutSquat = buildCatalogViews({
      ...seed,
      exercises: seed.exercises.filter((e) => e.name !== "Squat"),
    });
    const plan = makePlan([makeSession("Jambes", [makeExercise("Squat", 12, "per_hand")])]);

    expect(validatePlanDomain(plan, CATALOG).errors).toEqual([]);
    expect(validatePlanDomain(plan, withoutSquat).errors[0]).toMatch(/introuvable dans le catalogue/);
  });

  it("reads the blacklist from the catalog it was given", () => {
    const squatBanned = buildCatalogViews({
      ...seed,
      exercises: seed.exercises.map((e) =>
        e.name === "Squat" ? { ...e, active: false, inactiveReason: "Motif de test" } : e
      ),
    });
    const plan = makePlan([makeSession("Jambes", [makeExercise("Squat", 12, "per_hand")])]);

    expect(validatePlanDomain(plan, CATALOG).errors).toEqual([]);
    expect(validatePlanDomain(plan, squatBanned).errors[0]).toMatch(/liste noire/);
  });

  it("rejects a partial object that is not a catalog", () => {
    // The guard keys on `descriptions`: a raw document (`{ exercises: [...] }`)
    // has the data but not the shape, and passing one would fail much later,
    // as an empty catalog silently rejecting every exercise name.
    expect(() => validatePlanDomain({ sessions: [] }, { exercises: [] })).toThrow(/catalog/i);
  });
});

/** Minimal parsed-plan builder, matching the shape `planFromJson` produces. */
function makePlan(sessions) {
  return {
    weekStart: "2026-07-27",
    weekEnd: "2026-08-02",
    coachNotes: "",
    sessions,
    warnings: [],
    raw: "",
  };
}

function makeSession(name, exercises, extra = {}) {
  return { name, exercises, warmup: [], cooldown: [], ...extra };
}

function makeExercise(name, weight, weightType = "total", extra = {}) {
  return { name, sets: "3×10", setsCount: 3, reps: "10", weight, weightType, restSeconds: 60, ...extra };
}

// Moved unchanged from planParser.test.js (planParser.js is deleted; this is
// structural validation of a plan, which is this module's job — see
// validatePlan's docstring in planValidation.js for why it moved here).
describe("validatePlan (moved from planParser.js)", () => {
  it("returns empty errors array for a valid plan", () => {
    // Was `validatePlan(parsePlan(VALID_PLAN))` before the FITTRACK text
    // parser was deleted; replaced with an equivalent already-parsed plan
    // object of the same shape `parsePlan` used to produce for it.
    const plan = makePlan([
      makeSession("Upper Body Push", [
        makeExercise("Développé couché au sol", 20, "total"),
        makeExercise("Élévations latérales", 9, "total"),
      ]),
      makeSession("Jambes", [makeExercise("Squat", 42, "total"), makeExercise("Fentes", 16, "total")]),
    ]);
    const errors = validatePlan(plan);
    expect(errors).toEqual([]);
  });

  it("returns error when sessions array is empty", () => {
    const plan = { sessions: [], weekStart: "2026-02-10" };
    const errors = validatePlan(plan);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("séance");
  });

  it("returns error when weekStart is missing", () => {
    const plan = {
      sessions: [{ name: "Test", exercises: [{ name: "Squat" }] }],
      weekStart: null,
    };
    const errors = validatePlan(plan);
    expect(errors.some((e) => e.toLowerCase().includes("date"))).toBe(true);
  });

  it("returns error when a session has empty exercises", () => {
    const plan = {
      sessions: [{ name: "Empty Session", exercises: [] }],
      weekStart: "2026-02-10",
    };
    const errors = validatePlan(plan);
    expect(errors.some((e) => e.includes("Empty Session"))).toBe(true);
    expect(errors.some((e) => e.includes("aucun exercice"))).toBe(true);
  });

  // Regression: 2026-08-16 — the bare "n'a aucun exercice." was answered three
  // times in one session by re-emitting an empty session under a new name
  // ("Repos ou Mobilité", then "Cardio + Mobilité"). The model was trying to
  // express a rest day, the payload has no way to say one, and the message
  // stated the fault without stating the remedy. These strings are written for
  // The user but they are read back VERBATIM by the model through
  // buildCorrectionRequest, so each has to say what to do instead.
  it("tells the coach a rest day is not a session, not just that it is empty", () => {
    const plan = {
      sessions: [{ name: "Repos ou Mobilité", exercises: [] }],
      weekStart: "2026-02-10",
    };
    const message = validatePlan(plan).find((e) => e.includes("Repos ou Mobilité"));
    expect(message).toContain("jour de repos n'est pas une séance");
    expect(message).toContain("retire-la");
    // The other half of the same mistake: the treadmill went into the cooldown
    // of an otherwise-empty session, drawing a second error for one error.
    expect(message).toContain("retour au calme");
  });

  it("returns multiple errors for multiple issues", () => {
    const plan = {
      sessions: [
        { name: "Session A", exercises: [] },
        { name: "Session B", exercises: [] },
      ],
      weekStart: null,
    };
    const errors = validatePlan(plan);
    // Missing weekStart + 2 empty sessions = 3 errors
    expect(errors).toHaveLength(3);
  });
});

// `planFromJson.js` only checks `typeof obj.weekStart === "string"`, so a
// malformed-but-string date (notably the French `JJ/MM/AAAA` form the old
// text format used) reaches here unchecked. This is the ONLY place that can
// still catch it — see the ISO_DATE_RE docstring in planValidation.js for the
// silent-corruption chain a miss here causes (sync-plan.js's DATE column,
// WeeklyPlan.jsx's session matching).
describe("validatePlan — weekStart/weekEnd format", () => {
  const validSession = [{ name: "Test", exercises: [{ name: "Squat", reps: "10" }] }];

  it("accepts a valid ISO weekStart/weekEnd", () => {
    const plan = { sessions: validSession, weekStart: "2026-08-10", weekEnd: "2026-08-16" };
    expect(validatePlan(plan)).toEqual([]);
  });

  it("blocks a French JJ/MM/AAAA weekStart with a French error", () => {
    const plan = { sessions: validSession, weekStart: "11/08/2026", weekEnd: "2026-08-16" };
    const errors = validatePlan(plan);
    expect(errors.some((e) => /date de début/i.test(e) && /invalide/i.test(e))).toBe(true);
  });

  it("blocks free-text weekStart", () => {
    const plan = { sessions: validSession, weekStart: "Semaine du 11 août", weekEnd: "2026-08-16" };
    const errors = validatePlan(plan);
    expect(errors.some((e) => /date de début/i.test(e) && /invalide/i.test(e))).toBe(true);
  });

  it("still blocks a null weekStart, as before", () => {
    const plan = { sessions: validSession, weekStart: null, weekEnd: "2026-08-16" };
    const errors = validatePlan(plan);
    expect(errors.some((e) => e.toLowerCase().includes("date"))).toBe(true);
  });

  it("blocks a French JJ/MM/AAAA weekEnd with a French error", () => {
    const plan = { sessions: validSession, weekStart: "2026-08-10", weekEnd: "16/08/2026" };
    const errors = validatePlan(plan);
    expect(errors.some((e) => /date de fin/i.test(e) && /invalide/i.test(e))).toBe(true);
  });

  it("does not require weekEnd to be present", () => {
    const plan = { sessions: validSession, weekStart: "2026-08-10", weekEnd: null };
    expect(validatePlan(plan)).toEqual([]);
  });
});

describe("validatePlanDomain — acceptance criteria", () => {
  it("Squat at 12.5 kg/main is not achievable but under ceiling: warning, no error, corrected to 12", () => {
    const plan = makePlan([makeSession("Jambes", [makeExercise("Squat", 12.5, "per_hand")])]);

    const { errors, warnings, correctedPlan } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes("Squat"))).toBe(true);
    expect(warnings.some((w) => w.includes("12.5"))).toBe(true);
    expect(warnings.some((w) => w.includes("12"))).toBe(true);
    expect(correctedPlan.sessions[0].exercises[0].weight).toBe(12);
  });

  it("Pont fessier at 15 kg exceeds its 12 kg ceiling: blocking error, plan NOT silently corrected", () => {
    const plan = makePlan([makeSession("Haut du corps", [makeExercise("Pont fessier", 15, "total")])]);

    const { errors, warnings, correctedPlan } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/Pont fessier/);
    expect(errors[0]).toMatch(/15/);
    expect(errors[0]).toMatch(/12 kg/);
    expect(warnings).toEqual([]);
    // The weight must NOT have been silently clamped/rounded to 11.
    expect(correctedPlan.sessions[0].exercises[0].weight).toBe(15);
  });
});

describe("validatePlanDomain — valid plan and purity", () => {
  it("a fully valid plan produces zero errors and zero warnings, and the returned plan is unchanged", () => {
    const plan = makePlan([
      makeSession("Haut du corps", [
        makeExercise("Développé couché au sol", 9, "per_hand"),
        makeExercise("Curl biceps", 6, "per_hand"),
      ]),
    ]);

    const { errors, warnings, correctedPlan } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(correctedPlan).toEqual(plan);
  });

  it("does not mutate the input plan — the original still holds 12.5 after the call", () => {
    const plan = makePlan([makeSession("Jambes", [makeExercise("Squat", 12.5, "per_hand")])]);

    validatePlanDomain(plan, CATALOG);

    expect(plan.sessions[0].exercises[0].weight).toBe(12.5);
  });
});

describe("validatePlanDomain — session-level bar configuration check", () => {
  it("a session requiring two plated bar configurations produces a warning, not an error", () => {
    const plan = makePlan([
      makeSession("Jambes", [
        makeExercise("Squat", 5, "per_hand"),
        makeExercise("Soulevé de terre roumain", 11, "per_hand"),
      ]),
    ]);

    const { errors, warnings } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => /r[ée]glages de barre/.test(w))).toBe(true);
  });
});

describe("validatePlanDomain — warmup/cooldown are not load-validated", () => {
  it("a warmup line with an unusual name does not error", () => {
    const plan = makePlan([
      makeSession("Jambes", [makeExercise("Squat", 5, "per_hand")], {
        warmup: [{ name: "Mouvement inventé qui n'existe pas", detail: "2 min" }],
        cooldown: [{ name: "Étirement quelconque", detail: "" }],
      }),
    ]);

    const { errors, warnings } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("validatePlanDomain — reports every problem, not just the first", () => {
  it("a plan with several problems reports all of them", () => {
    const plan = makePlan([
      makeSession("Jambes", [
        makeExercise("Squat", 12.5, "per_hand"), // warning: rounds to 12
        makeExercise("Pont fessier", 15, "total"), // error: over ceiling
      ]),
      makeSession("Haut du corps", [
        makeExercise("Extension triceps", 20, "total"), // error: over ceiling
      ]),
    ]);

    const { errors, warnings } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(2);
    expect(errors.some((e) => e.includes("Pont fessier"))).toBe(true);
    expect(errors.some((e) => e.includes("Extension triceps"))).toBe(true);
    expect(warnings.some((w) => w.includes("Squat"))).toBe(true);
  });
});

describe("validatePlanDomain — /main suffix normalization on a non-bilateral exercise", () => {
  it("Extension triceps at 9 kg/main is achievable, but the /main label is meaningless: warning + weightType normalized to total", () => {
    const plan = makePlan([makeSession("Haut du corps", [makeExercise("Extension triceps", 9, "per_hand")])]);

    const { errors, warnings, correctedPlan } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/main/);
    const correctedExercise = correctedPlan.sessions[0].exercises[0];
    expect(correctedExercise.weightType).toBe("total");
    expect(correctedExercise.weight).toBe(9); // numeric value unchanged, only the label was wrong
  });

  it("still fires the /main normalization even when the underlying load is NOT achievable", () => {
    // 7.5 kg is achievable on neither implement Extension triceps can use (one
    // dumbbell: 3/6/9/12/15/18, or one loaded bar: odd whole kilos only) — this
    // line is both mislabeled AND not achievable, and both must be reported.
    // This case used 6 kg, which the single-implement model rejected. 6 kg is a
    // dumbbell value, so it is valid now.
    const plan = makePlan([makeSession("Haut du corps", [makeExercise("Extension triceps", 7.5, "per_hand")])]);

    const { errors, warnings, correctedPlan } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
    expect(warnings.length).toBe(2); // the /main normalization + the not-achievable rounding
    expect(correctedPlan.sessions[0].exercises[0].weightType).toBe("total");
  });
});

describe("validatePlanDomain — unresolvable exercise names block import", () => {
  it("an unknown exercise name (typo) blocks with a message naming it and its session", () => {
    const plan = makePlan([makeSession("Jambes", [makeExercise("Squatt", 12, "per_hand")])]);

    const { errors, warnings, correctedPlan } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/Squatt/);
    expect(errors[0]).toMatch(/Jambes/);
    expect(warnings).toEqual([]);
    // The line is left untouched, never silently zeroed or renamed.
    expect(correctedPlan.sessions[0].exercises[0]).toEqual(plan.sessions[0].exercises[0]);
  });

  it("a valid name differing only by surrounding whitespace or case does NOT block, and is stored canonically", () => {
    const plan = makePlan([
      makeSession("Jambes", [
        makeExercise("  Squat  ", 12, "per_hand"),
        makeExercise("squat", 12, "per_hand"),
      ]),
    ]);

    const { errors, warnings, correctedPlan } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
    // A name that RESOLVED is written back as its catalog key. Anything else
    // stores a string the Lexique and the stats cannot look up (both are exact
    // lookups), so the plan would validate and still corrupt the data.
    expect(correctedPlan.sessions[0].exercises[0].name).toBe("Squat");
    expect(correctedPlan.sessions[0].exercises[1].name).toBe("Squat");
    // Silent normalization, not a correction the user has to act on.
    expect(warnings).toEqual([]);
  });

  it("the canonicalized name round-trips through every exact-string catalog lookup", () => {
    const plan = makePlan([
      makeSession("Jambes", [makeExercise("  soulevé DE terre roumain ", 15, "per_hand")]),
    ]);

    const { errors, correctedPlan } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
    const storedName = correctedPlan.sessions[0].exercises[0].name;
    expect(CATALOG.descriptions[storedName]).toBeDefined();
    expect(getExerciseGroup(storedName, CATALOG)).toBe("Lower Body");
    expect(CATALOG.allExercises).toContain(storedName);
  });

  it("a case-variant bar exercise no longer escapes the session-level bar-configuration check", () => {
    // `checkSessionBarConfigurations` looks its descriptor up by exact string.
    // While the corrected lines carried the coach's own spelling, "  squat  "
    // resolved to nothing there and the line was skipped outright — so a
    // session needing two different platings reported none.
    const plan = makePlan([
      makeSession("Jambes", [
        makeExercise("  squat  ", 5, "per_hand"),
        makeExercise("Squat sumo", 5, "total"),
      ]),
    ]);

    const { errors, warnings } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
    expect(warnings.some((w) => /réglages de barre différents/.test(w))).toBe(true);
  });

  it("still refuses to guess: an unresolvable name is blocked, never rewritten to the nearest entry", () => {
    // The canonicalization above applies ONLY to a name that already resolved by
    // exact trim/case-insensitive match. Fuzzy guessing stays forbidden.
    const plan = makePlan([makeSession("Jambes", [makeExercise("Squatt", 12, "per_hand")])]);

    const { errors, correctedPlan } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(1);
    expect(correctedPlan.sessions[0].exercises[0].name).toBe("Squatt");
  });
});

describe("validatePlanDomain — home warmup content (T7, the Rameur rule)", () => {
  it("ACCEPTANCE: Rameur in a home session's warmup is a blocking error naming it and the session", () => {
    const plan = makePlan([
      makeSession("Jambes", [makeExercise("Squat", 5, "per_hand")], {
        warmup: [{ name: "Rameur", detail: "5min" }],
      }),
    ]);

    const { errors, warnings } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/Rameur/);
    expect(errors[0]).toMatch(/Jambes/);
    expect(warnings).toEqual([]);
  });

  it("FALSE-POSITIVE GUARD: free-text mobility movements in a home warmup produce no error", () => {
    const plan = makePlan([
      makeSession("Jambes", [makeExercise("Squat", 5, "per_hand")], {
        warmup: [
          { name: "Rotations d'épaules", detail: "10 rép" },
          { name: "Cercles de hanches", detail: "10 rép" },
          { name: "Mobilité thoracique", detail: "1 min" },
        ],
      }),
    ]);

    const { errors, warnings } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  // Regression 2026-09-28: seven rejections in a row, because the message said
  // "bodyweight only" and the coach's detail already said « au poids du corps ».
  // The message must say the NAME is what is matched, and how to rename it.
  it("a loaded catalog name in a home warmup: the error says the name is checked and gives the rename", () => {
    const plan = makePlan([
      makeSession("Bas du corps", [makeExercise("Squat", 15, "per_hand")], {
        warmup: [{ name: "Squat", detail: "2×10 au poids du corps" }],
      }),
    ]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/NOM qui est contrôlé, pas le détail/);
    expect(errors[0]).toContain("« Squat au poids du corps »");
  });

  it("FALSE-POSITIVE GUARD: the rename the error suggests is accepted", () => {
    const plan = makePlan([
      makeSession("Bas du corps", [makeExercise("Squat", 15, "per_hand")], {
        warmup: [{ name: "Squat au poids du corps", detail: "2×10" }],
        cooldown: [{ name: "Fentes au poids du corps", detail: "8/jambe" }],
      }),
    ]);

    expect(validatePlanDomain(plan, CATALOG).errors).toEqual([]);
  });

  it("a bodyweight catalog exercise (Gainage planche) in a home warmup is allowed", () => {
    const plan = makePlan([
      makeSession("Jambes", [makeExercise("Squat", 5, "per_hand")], {
        warmup: [{ name: "Gainage planche", detail: "20s" }],
      }),
    ]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
  });

  it("a loaded catalog exercise (Curl biceps) in a home warmup is rejected", () => {
    const plan = makePlan([
      makeSession("Jambes", [makeExercise("Squat", 5, "per_hand")], {
        warmup: [{ name: "Curl biceps", detail: "2/main" }],
      }),
    ]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/Curl biceps/);
  });

  it("a not-allowed-at-home exercise (Tirage vertical) in a home warmup is rejected", () => {
    const plan = makePlan([
      makeSession("Jambes", [makeExercise("Squat", 5, "per_hand")], {
        warmup: [{ name: "Tirage vertical élastique", detail: "10 rép" }],
      }),
    ]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/Tirage vertical/);
  });

  it("a pure cardio session at the gym is not subject to the home warmup rule", () => {
    const plan = makePlan([
      makeSession("Cardio", [makeExercise("Rameur", 0, "total")], {
        warmup: [{ name: "Rameur", detail: "5min" }],
      }),
    ]);

    const { errors, warnings } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("case and whitespace variations of Rameur are still caught", () => {
    const plan = makePlan([
      makeSession("Jambes", [makeExercise("Squat", 5, "per_hand")], {
        warmup: [{ name: "  rameur  ", detail: "5min" }],
      }),
    ]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/rameur/i);
  });

  it("Course in a home warmup is rejected AS CARDIO, not merely as an external load", () => {
    // Regression guard for the cardio branch specifically. Course is the only
    // exercise that branch uniquely governs: it resolves to 'maison' (outdoor
    // running needs nothing) and is not bodyweight, so deleting the cardio
    // branch would still produce an error — but the WRONG one. Asserting the
    // wording is what makes this test fail if the branch goes away.
    const plan = makePlan([
      makeSession("Jambes", [makeExercise("Squat", 5, "per_hand")], {
        warmup: [{ name: "Course", detail: "10min" }],
      }),
    ]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/Course/);
    expect(errors[0]).toMatch(/cardio/);
    expect(errors[0]).not.toMatch(/charge externe/);
  });

  it("Course is not described as a machine, unlike Rameur (it is outdoor running)", () => {
    const courseErrors = validatePlanDomain(
      makePlan([
        makeSession("Jambes", [makeExercise("Squat", 5, "per_hand")], {
          warmup: [{ name: "Course", detail: "10min" }],
        }),
      ]), CATALOG).errors;
    const rameurErrors = validatePlanDomain(
      makePlan([
        makeSession("Jambes", [makeExercise("Squat", 5, "per_hand")], {
          warmup: [{ name: "Rameur", detail: "5min" }],
        }),
      ]), CATALOG).errors;

    expect(courseErrors[0]).not.toMatch(/machine/);
    expect(rameurErrors[0]).toMatch(/machine de salle/);
  });

  it("a session with no warmup at all does not throw", () => {
    const plan = makePlan([makeSession("Jambes", [makeExercise("Squat", 5, "per_hand")], { warmup: undefined })]);

    expect(() => validatePlanDomain(plan, CATALOG)).not.toThrow();
    const { errors } = validatePlanDomain(plan, CATALOG);
    expect(errors).toEqual([]);
  });
});

describe("validatePlan — reps must say how much to do", () => {
  // Every shape `zai-glm-5-2` actually emitted on 2026-09-28, plus the two
  // fallbacks (`planFromJson` turns "" into "?", a hand-built plan may omit it).
  const GARBAGE = [
    '{"sets": [{"reps": 12, "weight": 15, "weightType": "per_side"}]}',
    "",
    "?",
    "detail",
    "weightType",
    ": ",
    undefined,
  ];

  it.each(GARBAGE.map((g) => [g]))("blocks %j, naming the exercise and the remedy", (reps) => {
    const plan = makePlan([makeSession("Bas du corps", [makeExercise("Squat", 15, "per_hand", { reps })])]);
    const errors = validatePlan(plan);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Bas du corps/);
    expect(errors[0]).toMatch(/Squat/);
    expect(errors[0]).toMatch(/nombre nu/);
  });

  it("reports one error per session listing every bad line, never quoting the bad values", () => {
    const plan = makePlan([
      makeSession("Bas du corps", [
        makeExercise("Squat", 15, "per_hand", { reps: "weightType" }),
        makeExercise("Fentes bulgares", 9, "per_hand", { reps: "detail" }),
        makeExercise("Soulevé de terre roumain", 15, "per_hand"),
      ]),
    ]);
    const errors = validatePlan(plan);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Squat, Fentes bulgares\./);
    expect(errors[0]).not.toMatch(/Soulevé/);
    // « nom de champ » is part of the remedy; the emitted values themselves
    // must not travel back to the model.
    expect(errors[0]).not.toMatch(/weightType|detail/);
  });

  // FALSE-POSITIVE GUARD: shapes legitimately handled downstream.
  it.each([["12"], ["10-12"], ["8 à 10"], ["45s"], ["30 sec"], ["30-40min"], [" 10 "]])("accepts %j", (reps) => {
    const plan = makePlan([makeSession("Jambes", [makeExercise("Squat", 15, "per_hand", { reps })])]);
    expect(validatePlan(plan)).toEqual([]);
  });

  it("evaluatePlanImport refuses a payload whose only fault is an unreadable reps", () => {
    const bad = payload();
    bad.sessions[0].exercises[0].reps = "weightType";
    const r = evaluatePlanImport(bad, CATALOG);
    expect(r.shouldImport).toBe(false);
    expect(r.errors.join(" ")).toMatch(/reps/);
  });
});

describe("validatePlanDomain — home cooldown content (same rule as the warmup)", () => {
  it("Rameur in a home session's cooldown is a blocking error naming it and the session", () => {
    // The canonical failure of this project, three lines further down the
    // page: putting the rowing machine under RETOUR AU CALME instead of
    // ÉCHAUFFEMENT used to import cleanly, with the same bad outcome.
    const plan = makePlan([
      makeSession("Jambes", [makeExercise("Squat", 5, "per_hand")], {
        cooldown: [{ name: "Rameur", detail: "5min" }],
      }),
    ]);

    const { errors, warnings } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/Rameur/);
    expect(errors[0]).toMatch(/Jambes/);
    expect(errors[0]).toMatch(/retour au calme/i);
    expect(warnings).toEqual([]);
  });

  it("FALSE-POSITIVE GUARD: a realistic free-text French stretching cooldown produces zero errors", () => {
    const plan = makePlan([
      makeSession("Jambes", [makeExercise("Squat", 5, "per_hand")], {
        cooldown: [
          { name: "Étirement des ischio-jambiers", detail: "30s par côté" },
          { name: "Étirement des quadriceps", detail: "30s par côté" },
          { name: "Étirement des fessiers en position 4", detail: "30s par côté" },
          { name: "Ouverture de hanches papillon", detail: "1 min" },
          { name: "Respiration diaphragmatique", detail: "2 min" },
          { name: "Posture de l'enfant", detail: "1 min" },
        ],
      }),
    ]);

    const { errors, warnings } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("a bodyweight catalog exercise (Gainage planche) in a cooldown is allowed", () => {
    const plan = makePlan([
      makeSession("Jambes", [makeExercise("Squat", 5, "per_hand")], {
        cooldown: [{ name: "Gainage planche", detail: "30s" }],
      }),
    ]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
  });

  it("a loaded catalog exercise (Curl biceps) in a cooldown is rejected", () => {
    const plan = makePlan([
      makeSession("Jambes", [makeExercise("Squat", 5, "per_hand")], {
        cooldown: [{ name: "Curl biceps", detail: "2/main" }],
      }),
    ]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/Curl biceps/);
  });

  it("a pure cardio session at the gym is not subject to the home cooldown rule", () => {
    const plan = makePlan([
      makeSession("Cardio", [makeExercise("Rameur", 0, "total")], {
        cooldown: [{ name: "Vélo", detail: "5min" }],
      }),
    ]);

    const { errors, warnings } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("a session with no cooldown at all does not throw", () => {
    const plan = makePlan([makeSession("Jambes", [makeExercise("Squat", 5, "per_hand")], { cooldown: undefined })]);

    expect(() => validatePlanDomain(plan, CATALOG)).not.toThrow();
    expect(validatePlanDomain(plan, CATALOG).errors).toEqual([]);
  });
});

describe("validatePlanDomain — main exercise lines must be doable at home", () => {
  it("Développé incliné (needs a bench) in a home session is a blocking error naming the missing equipment", () => {
    const plan = makePlan([
      makeSession("Haut du corps", [
        makeExercise("Curl biceps", 6, "per_hand"),
        makeExercise("Développé incliné", 9, "per_hand"),
      ]),
    ]);

    const { errors, correctedPlan } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/Développé incliné/);
    expect(errors[0]).toMatch(/Haut du corps/);
    expect(errors[0]).toMatch(/banc/);
    // Blocking only — the line is never rewritten.
    expect(correctedPlan.sessions[0].exercises[1].name).toBe("Développé incliné");
  });

  it("Tirage vertical (needs a high-anchored upper-body elastic) in a home session is a blocking error", () => {
    const plan = makePlan([
      makeSession("Dos", [makeExercise("Tirage vertical élastique", 0, "total")]),
    ]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/Tirage vertical/);
    expect(errors[0]).toMatch(/Dos/);
    expect(errors[0]).toMatch(/élastique/i);
  });

  it("FALSE-POSITIVE GUARD: a normal home strength session of legal exercises produces no error", () => {
    const plan = makePlan([
      makeSession("Jambes", [
        makeExercise("Squat", 12, "per_hand"),
        makeExercise("Fentes bulgares", 9, "per_hand"), // needs a chair — home-legal
        makeExercise("Pont fessier", 12, "total"),
        makeExercise("Abducteurs élastique", 0, "total"), // hip band — home-legal
      ]),
      makeSession("Haut du corps", [
        makeExercise("Développé couché au sol", 9, "per_hand"), // floor variant — no bench needed
        makeExercise("Curl biceps", 6, "per_hand"),
        makeExercise("Gainage planche", 0, "total"),
      ]),
    ]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
  });

  it("a pure cardio (gym) session is unaffected, even though its machines are not available at home", () => {
    const plan = makePlan([
      makeSession("Cardio", [makeExercise("Rameur", 0, "total"), makeExercise("Elliptique", 0, "total")]),
    ]);

    const { errors, warnings } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("Course (outdoor running) is home-allowed and is never flagged by this rule", () => {
    const plan = makePlan([
      makeSession("Jambes", [makeExercise("Squat", 12, "per_hand"), makeExercise("Course", 0, "total")]),
    ]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    // Only T3.3 (cardio mixed into a force session) fires — Course itself is
    // doable at home, so the location rule must stay silent about it.
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/mélangé/);
  });

  it("a cardio machine mixed into a force session is reported once (T3.3), not twice", () => {
    const plan = makePlan([
      makeSession("Haut du corps", [
        makeExercise("Curl biceps", 6, "per_hand"),
        makeExercise("Rameur", 0, "total"),
      ]),
    ]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/mélangé/);
  });

  it("an unresolvable name is reported as unknown, not as missing equipment", () => {
    const plan = makePlan([makeSession("Jambes", [makeExercise("Squatt", 12, "per_hand")])]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/introuvable dans le catalogue/);
  });
});

describe("validatePlanDomain — T3.1 no core on a lower-body day", () => {
  it("core (Dead bug) alongside only lower-body work is a blocking error", () => {
    const plan = makePlan([
      makeSession("Jambes", [
        makeExercise("Squat", 12, "per_hand"),
        makeExercise("Fentes", 9, "per_hand"),
        makeExercise("Dead bug", 0, "total"),
      ]),
    ]);

    const { errors, warnings } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/Dead bug/);
    expect(errors[0]).toMatch(/Jambes/);
    expect(warnings).toEqual([]);
  });

  it("core alongside a session mixing upper and lower body is NOT flagged (do not overreach)", () => {
    const plan = makePlan([
      makeSession("Full body", [
        makeExercise("Squat", 12, "per_hand"),
        makeExercise("Curl biceps", 6, "per_hand"),
        makeExercise("Dead bug", 0, "total"),
      ]),
    ]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
  });

  it("core in a purely upper-body session is not flagged", () => {
    const plan = makePlan([
      makeSession("Haut du corps", [
        makeExercise("Curl biceps", 6, "per_hand"),
        makeExercise("Gainage planche", 0, "total"),
      ]),
    ]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
  });
});

describe("validatePlanDomain — T3.2 four exercises is the usual shape of a force session; more is a warning, never a ceiling", () => {
  it("5 exercises in a force session is a warning, not an error", () => {
    const plan = makePlan([
      makeSession("Haut du corps", [
        makeExercise("Curl biceps", 6, "per_hand"),
        makeExercise("Curl marteau", 6, "per_hand"),
        makeExercise("Extension triceps", 9, "total"),
        makeExercise("Shrugs", 9, "per_hand"),
        makeExercise("Oiseau", 6, "per_hand"),
      ]),
    ]);

    const { errors, warnings } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
    const warning = warnings.find((w) => /5 exercices/.test(w) && /Haut du corps/.test(w));
    expect(warning).toBeDefined();
    // Regression: c610839 — owner ruling 2026-10-06, the count is not a
    // ceiling. The prompt now writes the six exercises she asks for, so a
    // warning telling her every extra one « doit avoir une raison identifiable »
    // read as an instruction to cut what she had just requested — the belt and
    // the suspenders contradicting each other in the other direction.
    expect(warning).toMatch(/Si c'est ce que tu as demandé, rien à changer/);
    expect(warning).not.toMatch(/raison identifiable|retir|supprim|au-delà/i);
  });

  it("exactly 4 exercises in a force session triggers no warning", () => {
    const plan = makePlan([
      makeSession("Haut du corps", [
        makeExercise("Curl biceps", 6, "per_hand"),
        makeExercise("Curl marteau", 6, "per_hand"),
        makeExercise("Extension triceps", 9, "total"),
        makeExercise("Shrugs", 9, "per_hand"),
      ]),
    ]);

    const { errors, warnings } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("a pure cardio session with many lines is not warned as a force session", () => {
    const plan = makePlan([
      makeSession("Cardio", [
        makeExercise("Elliptique", 0, "total"),
        makeExercise("Tapis de course", 0, "total"),
        makeExercise("Rameur", 0, "total"),
        makeExercise("Vélo", 0, "total"),
        makeExercise("Course", 0, "total"),
      ]),
    ]);

    const { errors, warnings } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("validatePlanDomain — T3.3 cardio never mixed into a force session", () => {
  it("a cardio exercise mixed with strength exercises is a blocking error", () => {
    const plan = makePlan([
      makeSession("Haut du corps", [
        makeExercise("Curl biceps", 6, "per_hand"),
        makeExercise("Rameur", 0, "total"),
      ]),
    ]);

    const { errors, warnings } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/Rameur/);
    expect(errors[0]).toMatch(/Haut du corps/);
    expect(warnings).toEqual([]);
  });

  it("a pure cardio session is fine", () => {
    const plan = makePlan([
      makeSession("Cardio", [makeExercise("Rameur", 0, "total"), makeExercise("Vélo", 0, "total")]),
    ]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
  });

  it("a pure force session (no cardio at all) is fine", () => {
    const plan = makePlan([makeSession("Haut du corps", [makeExercise("Curl biceps", 6, "per_hand")])]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
  });
});

describe("validatePlanDomain — T3.4 blacklist enforcement", () => {
  it.each([
    ["Élévations frontales", /Redondant avec les élévations latérales/],
    ["Hollow Body", /gainage plus simple/],
    ["Russian twist", /Rotation chargée/],
    // `Hip thrust` is here on the strength of the document's `forbiddenNames`
    // field — it is the one blacklist entry with no catalog entry at all, so
    // for one commit the catalog-backed blacklist could not see it. See the
    // dedicated test below for the invariant that keeps it out of the exercise
    // views while keeping it on the blacklist.
    ["Hip thrust", /banc/],
  ])("%s in a main exercise line is a blocking error naming the reason", (name, reasonPattern) => {
    const plan = makePlan([makeSession("Séance", [makeExercise(name, 0, "total")])]);

    const { errors, warnings, correctedPlan } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(errors[0]).toMatch(reasonPattern);
    expect(warnings).toEqual([]);
    // No throw, and the line is left untouched — not silently zeroed/renamed.
    expect(correctedPlan.sessions[0].exercises[0]).toEqual(plan.sessions[0].exercises[0]);
  });

  it("a blacklisted name in a warmup item is a blocking error", () => {
    const plan = makePlan([
      makeSession("Jambes", [makeExercise("Squat", 5, "per_hand")], {
        warmup: [{ name: "Hollow Body", detail: "3×30s" }],
      }),
    ]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/Hollow Body/);
    expect(errors[0]).toMatch(/gainage plus simple/);
  });

  it("a blacklisted name in a cooldown item is a blocking error", () => {
    // Russian twist is also a loaded catalog exercise, so the cooldown content
    // rule would flag it too — the blacklist message wins, since it carries the
    // reason and the replacement. One item, one message.
    const plan = makePlan([
      makeSession("Jambes", [makeExercise("Squat", 5, "per_hand")], {
        cooldown: [{ name: "Russian twist", detail: "1×20" }],
      }),
    ]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/Russian twist/);
    expect(errors[0]).toMatch(/liste noire/);
  });

  it("a suggested replacement is named when one exists", () => {
    const plan = makePlan([makeSession("Jambes", [makeExercise("Hip thrust", 0, "total")])]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors[0]).toMatch(/Remplacement suggéré/);
    expect(errors[0]).toMatch(/Pont fessier/);
  });

  it("a replacement is named for a blacklisted exercise that DOES have a catalog entry too", () => {
    // The one above rides on `forbiddenNames`; this one on a deactivated
    // exercise. Both routes into `catalog.blacklist` must carry `replacedBy`.
    const plan = makePlan([makeSession("Core", [makeExercise("Hollow Body", 0, "total")])]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors[0]).toMatch(/Remplacement suggéré/);
    expect(errors[0]).toMatch(/Dead bug/);
  });

  it("no replacement is named for Élévations frontales (none recorded)", () => {
    const plan = makePlan([makeSession("Haut du corps", [makeExercise("Élévations frontales", 0, "total")])]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors[0]).not.toMatch(/Remplacement suggéré/);
  });

  // A blacklisted name that is not an exercise reaches the validator through the
  // document's `forbiddenNames` field. `Hip thrust` is the only one today: banned
  // « Nécessite un banc », never given a definition, so it cannot ride in the
  // exercise list the way the other five do. It must be rejected as BLACKLISTED
  // — with its reason — and never as a merely unknown name, which is what the
  // user would be told to go and correct the spelling of.
  it("a main line naming Hip thrust is blocked as blacklisted, not as an unknown name", () => {
    const plan = makePlan([makeSession("Jambes", [makeExercise("Hip thrust", 0, "total")])]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/Hip thrust/);
    expect(errors[0]).toMatch(/liste noire/);
    expect(errors[0]).toMatch(/banc/);
    expect(errors[0]).toMatch(/Pont fessier/);
    expect(errors[0]).not.toMatch(/introuvable dans le catalogue/);
  });

  // Regression: `- Hip thrusts | 3×12` in a cooldown is one of the four real
  // production bypasses `findBlacklistEntryLoose` was written to close on
  // 2026-07-26. Free text has NO catalog backstop — an unrecognised name is
  // allowed by design — so a blacklist that cannot see the name catches nothing
  // at all here. This is the surface that made `forbiddenNames` necessary.
  it("a cooldown item naming Hip thrusts (plural, free text) is caught by the loose matcher", () => {
    const plan = makePlan([
      makeSession("Jambes", [makeExercise("Squat", 5, "per_hand")], {
        cooldown: [{ name: "Hip thrusts", detail: "3×12" }],
      }),
    ]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/Hip thrusts/);
    expect(errors[0]).toMatch(/banc/);
  });

  // FALSE-POSITIVE GUARD. The loose matcher is substring-based and now has one
  // more name to match on, so widening it widens the over-rejection risk too —
  // and over-rejection in warmup/cooldown is the failure mode this repo has been
  // burned by: most legitimate mobility items are in no catalog and MUST import
  // clean. `Ouverture de hanches` is real French mobility work adjacent to the
  // hip-thrust family without containing the name.
  it("legitimate free-text mobility items still import clean", () => {
    const plan = makePlan([
      makeSession("Jambes", [makeExercise("Squat", 5, "per_hand")], {
        warmup: [
          { name: "Ouverture de hanches", detail: "2×10" },
          { name: "Charnière de hanche à vide", detail: "2×10" },
        ],
        cooldown: [
          { name: "Étirement des fléchisseurs de hanche", detail: "30s" },
          { name: "Pont fessier au poids du corps", detail: "2×10" },
        ],
      }),
    ]);

    const { errors, warnings } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("validatePlanDomain — T3.4 fix round: loosened blacklist matching in warmup/cooldown (coordinator review Finding 1)", () => {
  // Regression: previously matched by exact trimmed-lowercased name only, with no
  // catalog backstop for warmup/cooldown free text (unlike the main exercise line).
  // These near-miss phrasings all imported with ZERO errors before the fix.
  // "Hollow Body hold" is the highest-stakes case: an exercise is often blacklisted
  // for a safety reason rather than a preference, and this bypass had a real cost.
  //
  it.each([
    ["Hollow Body hold", "warmup", /Hollow Body/, /gainage plus simple/],
    ["Russian twists", "warmup", /Russian twists/, /Rotation chargée/],
    ["Hip thrusts", "cooldown", /Hip thrusts/, /banc/],
    ["Gainage hollow body", "cooldown", /Gainage hollow body/, /gainage plus simple/],
  ])("%s in %s is now caught (was a silent bypass)", (name, listKey, namePattern, reasonPattern) => {
    const plan = makePlan([
      makeSession("Jambes", [makeExercise("Squat", 5, "per_hand")], {
        [listKey]: [{ name, detail: "3×30s" }],
      }),
    ]);

    const { errors, warnings } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(namePattern);
    expect(errors[0]).toMatch(reasonPattern);
    expect(warnings).toEqual([]);
  });

  it("the unaccented spelling from constraints.md's own table is also caught in a warmup item", () => {
    const plan = makePlan([
      makeSession("Jambes", [makeExercise("Squat", 5, "per_hand")], {
        warmup: [{ name: "Elevations frontales", detail: "2×10" }],
      }),
    ]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/Redondant avec les élévations latérales/);
  });

  it("FALSE-POSITIVE GUARD: the loosened substring matching does not flag realistic free-text French mobility warmup items", () => {
    const plan = makePlan([
      makeSession("Jambes", [makeExercise("Squat", 5, "per_hand")], {
        warmup: [
          { name: "Rotations d'épaules", detail: "10 rép" },
          { name: "Cercles de hanches", detail: "10 rép" },
          { name: "Mobilité thoracique", detail: "1 min" },
          { name: "Fentes dynamiques", detail: "8/jambe" },
          { name: "Squat au poids du corps", detail: "2×10" },
        ],
        cooldown: [{ name: "Étirement des ischio-jambiers", detail: "30s" }],
      }),
    ]);

    const { errors, warnings } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("the main exercise line still uses whole-name matching, unaffected by the warmup/cooldown fix", () => {
    // "Squat" alone is NOT blacklisted; a substring-style false positive here
    // would be a real regression (over-rejection is the failure mode this
    // project has already been burned by).
    const plan = makePlan([makeSession("Jambes", [makeExercise("Squat", 5, "per_hand")])]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors).toEqual([]);
  });

  it("a near-miss main exercise line name (not an exact/whole match) is rejected as unresolvable, not blacklisted", () => {
    // "Hollow Body hold" is not a catalog name either, so it still blocks
    // import — but via the "introuvable dans le catalogue" path, not the
    // blacklist path, confirming the main-exercise-line path was not changed
    // to use the looser matcher.
    const plan = makePlan([makeSession("Séance", [makeExercise("Hollow Body hold", 0, "total")])]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/introuvable dans le catalogue/);
    expect(errors[0]).not.toMatch(/liste noire/);
  });
});

describe("validatePlanDomain — several structure violations at once", () => {
  it("a plan violating T3.1, T3.3 and T3.4 in separate sessions reports all of them", () => {
    const plan = makePlan([
      makeSession("Jambes", [
        makeExercise("Squat", 12, "per_hand"),
        makeExercise("Dead bug", 0, "total"), // T3.1: core on a lower-body day
      ]),
      makeSession("Haut du corps", [
        makeExercise("Curl biceps", 6, "per_hand"),
        makeExercise("Rameur", 0, "total"), // T3.3: cardio mixed into a force session
      ]),
      makeSession("Séance", [
        makeExercise("Hip thrust", 0, "total"), // T3.4: blacklisted
      ]),
    ]);

    const { errors } = validatePlanDomain(plan, CATALOG);

    expect(errors.length).toBe(3);
    expect(errors.some((e) => /Dead bug/.test(e))).toBe(true);
    expect(errors.some((e) => /Rameur/.test(e))).toBe(true);
    expect(errors.some((e) => /Hip thrust/.test(e))).toBe(true);
  });
});

describe("validatePlanDomain — malformed input never throws", () => {
  it("a plan with no sessions field does not throw", () => {
    expect(() => validatePlanDomain({}, CATALOG)).not.toThrow();
    const { errors, warnings, correctedPlan } = validatePlanDomain({}, CATALOG);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(correctedPlan.sessions).toEqual([]);
  });

  it("a session with no exercises does not throw", () => {
    const plan = makePlan([{ name: "Séance vide" }]);
    expect(() => validatePlanDomain(plan, CATALOG)).not.toThrow();
    const { errors, warnings, correctedPlan } = validatePlanDomain(plan, CATALOG);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(correctedPlan.sessions[0].exercises).toEqual([]);
  });

  it("a line with no weight field does not throw", () => {
    const plan = makePlan([makeSession("Jambes", [{ name: "Squat", sets: "3×10" }])]);
    expect(() => validatePlanDomain(plan, CATALOG)).not.toThrow();
    const { errors, warnings } = validatePlanDomain(plan, CATALOG);
    expect(errors).toEqual([]);
    expect(warnings.length).toBe(1); // "Poids invalide" warning, weight defaults to 0
  });

  it("null/undefined plan and malformed exercise lines do not throw", () => {
    expect(() => validatePlanDomain(null, CATALOG)).not.toThrow();
    expect(() => validatePlanDomain(undefined, CATALOG)).not.toThrow();
    const plan = makePlan([makeSession("Jambes", [null, {}, { name: 42 }])]);
    expect(() => validatePlanDomain(plan, CATALOG)).not.toThrow();
  });
});

/**
 * JSON payload builder for `evaluatePlanImport` tests — the model's
 * schema-generated plan (`planSchema.js`), not FITTRACK text. `evaluatePlanImport`
 * is the single point where the whole validation layer meets the app, so these
 * tests exercise it from the same shape `planFromJson` accepts.
 */
function payload(overrides = {}) {
  return {
    weekStart: "2026-08-11",
    weekEnd: "2026-08-17",
    coachNotes: "",
    notebook: "",
    sessions: [
      {
        name: "Bas du corps",
        warmup: [{ name: "Rotations de hanches", detail: "2×10" }],
        exercises: [
          {
            name: "Squat",
            setsCount: 3,
            reps: "12",
            weight: 15,
            weightType: "per_hand",
            restSeconds: 90,
            progressionNote: "",
          },
        ],
        cooldown: [{ name: "Étirement quadriceps", detail: "30s par jambe" }],
      },
    ],
    ...overrides,
  };
}

describe("evaluatePlanImport with a JSON payload", () => {
  it("imports a valid payload", () => {
    const r = evaluatePlanImport(payload(), CATALOG);
    expect(r.shouldImport).toBe(true);
    expect(r.plan.sessions[0].exercises[0].sets).toBe("3×12");
  });

  it("accepts the payload as a JSON string", () => {
    const r = evaluatePlanImport(JSON.stringify(payload()), CATALOG);
    expect(r.shouldImport).toBe(true);
  });

  it("rejects unreadable input with a French error and never throws", () => {
    for (const bad of ["", "{ not json", null, undefined, 42]) {
      const r = evaluatePlanImport(bad, CATALOG);
      expect(r.shouldImport).toBe(false);
      expect(r.plan).toBeNull();
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  // Regression: the domain pass used to be skipped on ANY structural error, so
  // a plan missing its week line reported that and hid every ceiling breach
  // behind it — one round-trip with the coach per error class.
  it("reports structural AND domain errors together, structural first", () => {
    const r = evaluatePlanImport(
      payload({
        weekStart: null,
        sessions: [
          {
            name: "Bas du corps",
            warmup: [{ name: "Rotations de hanches", detail: "2×10" }],
            exercises: [
              {
                name: "Squat",
                setsCount: 3,
                reps: "12",
                weight: 99,
                weightType: "per_hand",
                restSeconds: 90,
                progressionNote: "",
              },
            ],
            cooldown: [{ name: "Étirement quadriceps", detail: "30s" }],
          },
        ],
      }), CATALOG);
    expect(r.shouldImport).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
    expect(r.errors.some((e) => /semaine/i.test(e))).toBe(true);
    expect(r.errors.some((e) => /plafond|17/i.test(e))).toBe(true);
    // Structural error reported first — the more fundamental problem.
    expect(r.errors[0]).toMatch(/semaine/i);
  });

  it("skips the domain pass only when there are no sessions at all", () => {
    const r = evaluatePlanImport(payload({ sessions: [] }), CATALOG);
    expect(r.shouldImport).toBe(false);
    expect(r.errors.some((e) => /séance/i.test(e))).toBe(true);
  });
});

describe("evaluatePlanImport — the wire between the validation layer and the app", () => {
  it("a clean plan imports, with the parsed plan and no errors or warnings", () => {
    const r = evaluatePlanImport(
      payload({
        sessions: [
          {
            name: "Haut du corps",
            warmup: [{ name: "Rotations d'épaules", detail: "2×10" }],
            exercises: [
              {
                name: "Curl biceps",
                setsCount: 3,
                reps: "10",
                weight: 6,
                weightType: "per_hand",
                restSeconds: 60,
                progressionNote: "",
              },
              {
                name: "Développé couché au sol",
                setsCount: 3,
                reps: "8",
                weight: 9,
                weightType: "per_hand",
                restSeconds: 90,
                progressionNote: "",
              },
            ],
            cooldown: [{ name: "Étirement des pectoraux", detail: "30s par côté" }],
          },
        ],
      }), CATALOG);

    expect(r.shouldImport).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.plan.sessions.length).toBe(1);
    expect(r.plan.sessions[0].exercises.length).toBe(2);
  });

  it("a plan with a ceiling breach does NOT import and reports the error", () => {
    const r = evaluatePlanImport(
      payload({
        sessions: [
          {
            name: "Bas du corps",
            warmup: [],
            exercises: [
              {
                name: "Pont fessier",
                setsCount: 3,
                reps: "12",
                weight: 15,
                weightType: "total",
                restSeconds: 60,
                progressionNote: "",
              },
            ],
            cooldown: [],
          },
        ],
      }), CATALOG);

    expect(r.shouldImport).toBe(false);
    expect(r.plan).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.some((e) => /Pont fessier/.test(e))).toBe(true);
    expect(r.errors.some((e) => /plafond/.test(e))).toBe(true);
  });

  it("a plan with roundable weights imports WITH the corrected weights and the warnings", () => {
    const r = evaluatePlanImport(
      payload({
        sessions: [
          {
            name: "Bas du corps",
            warmup: [],
            exercises: [
              {
                name: "Squat",
                setsCount: 4,
                reps: "8",
                weight: 12.5,
                weightType: "per_hand",
                restSeconds: 90,
                progressionNote: "",
              },
            ],
            cooldown: [],
          },
        ],
      }), CATALOG);

    expect(r.shouldImport).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.some((w) => /Squat/.test(w))).toBe(true);
    // The plan handed to the app carries the CORRECTED weight, never the
    // prescribed-but-unloadable one.
    expect(r.plan.sessions[0].exercises[0].weight).toBe(12);
    // ...and the warnings travel with it, so they can be surfaced after import.
    expect(r.plan.warnings).toEqual(r.warnings);
  });

  it("a structurally invalid payload does NOT import and reports the structural error", () => {
    const r = evaluatePlanImport("bonjour chérie, pas de programme ici", CATALOG);

    expect(r.shouldImport).toBe(false);
    expect(r.plan).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("reports EVERY blocking error, not just the first", () => {
    const r = evaluatePlanImport(
      payload({
        sessions: [
          {
            name: "Bas du corps",
            warmup: [],
            exercises: [
              {
                name: "Pont fessier",
                setsCount: 3,
                reps: "12",
                weight: 15,
                weightType: "total",
                restSeconds: 60,
                progressionNote: "",
              },
            ],
            cooldown: [],
          },
          {
            name: "Haut du corps",
            warmup: [],
            exercises: [
              {
                name: "Extension triceps",
                setsCount: 3,
                reps: "12",
                weight: 20,
                weightType: "total",
                restSeconds: 60,
                progressionNote: "",
              },
            ],
            cooldown: [],
          },
        ],
      }), CATALOG);

    expect(r.shouldImport).toBe(false);
    expect(r.errors.length).toBe(2);
  });

  it("never throws on non-string or empty input", () => {
    for (const input of [null, undefined, 42, ""]) {
      expect(() => evaluatePlanImport(input, CATALOG)).not.toThrow();
      expect(evaluatePlanImport(input, CATALOG).shouldImport).toBe(false);
      expect(evaluatePlanImport(input, CATALOG).errors.length).toBeGreaterThan(0);
    }
  });
});

describe("evaluatePlanImport — structural and domain errors are reported together", () => {
  it("reports the ceiling breach alongside the missing week date (regression)", () => {
    // Regression: any structural error suppressed the domain pass entirely, so
    // this plan reported ONLY the missing date. The user fixed the date, re-imported,
    // and only then learned the squat was over the ceiling — one full round-trip
    // with the coach per error class.
    const r = evaluatePlanImport(
      payload({
        weekStart: null,
        sessions: [
          {
            name: "Jambes",
            warmup: [{ name: "Rotations de hanches", detail: "2×10" }],
            exercises: [
              {
                name: "Squat",
                setsCount: 4,
                reps: "8",
                weight: 25,
                weightType: "per_hand",
                restSeconds: 90,
                progressionNote: "",
              },
            ],
            cooldown: [{ name: "Étirement des ischio-jambiers", detail: "30s par côté" }],
          },
        ],
      }), CATALOG);

    expect(r.shouldImport).toBe(false);
    expect(r.errors.some((e) => /[Dd]ate de début de semaine manquante/.test(e))).toBe(true);
    expect(r.errors.some((e) => /Squat/.test(e) && /plafond/.test(e))).toBe(true);
  });

  it("puts the structural error first, since it is the more fundamental problem", () => {
    const r = evaluatePlanImport(
      payload({
        weekStart: null,
        sessions: [
          {
            name: "Jambes",
            warmup: [],
            exercises: [
              {
                name: "Squat",
                setsCount: 4,
                reps: "8",
                weight: 25,
                weightType: "per_hand",
                restSeconds: 90,
                progressionNote: "",
              },
            ],
            cooldown: [],
          },
        ],
      }), CATALOG);
    expect(r.errors[0]).toMatch(/[Dd]ate de début de semaine manquante/);
  });

  it("still reports a blacklisted exercise when the plan is also structurally broken", () => {
    // The blacklist half matters most here: those are the injury-risk cases,
    // and they were equally hidden behind a missing date line.
    const r = evaluatePlanImport(
      payload({
        weekStart: null,
        sessions: [
          {
            name: "Core",
            warmup: [],
            exercises: [
              {
                name: "Hollow Body",
                setsCount: 3,
                reps: "30s",
                weight: 0,
                weightType: "total",
                restSeconds: 30,
                progressionNote: "",
              },
            ],
            cooldown: [],
          },
        ],
      }), CATALOG);
    expect(r.shouldImport).toBe(false);
    expect(r.errors.some((e) => /liste noire/.test(e))).toBe(true);
  });

  it("reports only the structural error when there are no sessions to inspect", () => {
    // Nothing to run the domain rules against — no invented noise on top.
    const r = evaluatePlanImport(payload({ sessions: [] }), CATALOG);

    expect(r.shouldImport).toBe(false);
    expect(r.errors.some((e) => /Aucune séance/.test(e))).toBe(true);
    expect(r.errors.every((e) => !/plafond/.test(e))).toBe(true);
  });

  it("does not throw when the plan is structurally broken and the lines are malformed", () => {
    expect(() =>
      evaluatePlanImport(
        payload({
          weekStart: null,
          sessions: [{ name: "Vide", warmup: [], exercises: [null, {}], cooldown: [] }],
        }), CATALOG)
    ).not.toThrow();
  });
});

// The coach's notebook is free text and cannot be migrated, so a retired name can
// resurface from it long after the rename. Blocking the whole import over that
// would cost a full round-trip for something the alias map answers exactly.
describe("retired exercise names on import", () => {
  it("accepts a plan that still uses an old name and corrects it silently", () => {
    const [oldName, canonical] = Object.entries(CATALOG.aliases)[0];
    const r = evaluatePlanImport(
      payload({
        sessions: [
          {
            name: "Haut du corps",
            warmup: [{ name: "Rotations d'épaules", detail: "2×10" }],
            exercises: [
              {
                name: oldName,
                setsCount: 3,
                reps: "8",
                weight: 9,
                weightType: "per_hand",
                restSeconds: 90,
                progressionNote: "",
              },
            ],
            cooldown: [{ name: "Étirement des pectoraux", detail: "30s par côté" }],
          },
        ],
      }), CATALOG);
    expect(r.errors).toEqual([]);
    expect(r.shouldImport).toBe(true);
    const names = r.plan.sessions[0].exercises.map((e) => e.name);
    expect(names).toContain(canonical);
    expect(names).not.toContain(oldName);
  });
});

/*
 * The pull-up bar is rigged at ONE height for a whole session and the user does not
 * re-rig mid-workout, so a session mixing a high-bar exercise with a low-bar
 * one cannot be performed as written. Same class as the bar-configuration
 * rule: a physical impossibility, not a judgement — which is why it is an
 * ERROR and not a warning.
 *
 * The prompt has stated this since 2026-08-11 (`buildBarHeightSection`), and
 * `barHeight` has been inert catalog data since then. This is the enforcement
 * half, deliberately shipped separately.
 */
describe("bar height (one rigging per session)", () => {
  // Read off the real catalog rather than hand-typed, so the fixture cannot
  // quietly describe exercises whose barHeight has since changed.
  const HAUTE = CATALOG.allExercises.filter((n) => CATALOG.descriptions[n].barHeight === "haute");
  const BASSE = CATALOG.allExercises.filter((n) => CATALOG.descriptions[n].barHeight === "basse");
  const barHeightErrors = (...names) =>
    validatePlanDomain(
      makePlan([makeSession("Haut du corps", names.map((n) => makeExercise(n, 0)))]),
      CATALOG
    ).errors.filter((e) => /hauteur de barre/i.test(e));

  // `>= 2` on the high-bar side is not padding: the same-height guard below
  // pairs HAUTE[0] with HAUTE[1], and with a single entry it would quietly
  // degrade into the one-exercise case already covered — a guard passing for
  // a reason that has nothing to do with what it claims to check.
  it("sanity check on the fixture: the catalog really does use both heights", () => {
    expect(HAUTE.length).toBeGreaterThanOrEqual(2);
    expect(BASSE.length).toBeGreaterThan(0);
  });

  it("blocks a session mixing a high-bar and a low-bar exercise", () => {
    expect(barHeightErrors(HAUTE[0], BASSE[0])).toHaveLength(1);
  });

  it("names both exercises, so the coach is told what to separate", () => {
    const [error] = barHeightErrors(HAUTE[0], BASSE[0]);
    expect(error).toContain(HAUTE[0]);
    expect(error).toContain(BASSE[0]);
    expect(error).toContain("Séance 1");
  });

  // FALSE-POSITIVE GUARDS. Over-rejection is the failure mode this project has
  // been burned by — four real production bypasses in the other direction, but
  // every loosening here needs its silent case pinned too.
  it("allows a session where every bar exercise is at the same height", () => {
    expect(barHeightErrors(...HAUTE.slice(0, 2))).toEqual([]);
    expect(barHeightErrors(...BASSE.slice(0, 1), ...BASSE.slice(0, 1))).toEqual([]);
  });

  it("allows a session with no bar exercise at all", () => {
    expect(barHeightErrors("Squat", "Pompes")).toEqual([]);
  });

  it("allows one bar exercise beside unrelated ones", () => {
    expect(barHeightErrors(BASSE[0], "Curl biceps")).toEqual([]);
    expect(barHeightErrors(HAUTE[0], "Squat")).toEqual([]);
  });

  // Warmup and cooldown are FREE TEXT and are deliberately not checked here:
  // the standing rule is that an unrecognised name there must be allowed, and
  // a mobility drill hanging from the bar is not a rigging change.
  it("ignores the warmup and cooldown entirely", () => {
    const session = makeSession("Haut du corps", [makeExercise(HAUTE[0], 0)], {
      warmup: [{ name: BASSE[0], detail: "2×10" }],
      cooldown: [{ name: BASSE[0], detail: "30s" }],
    });
    const errors = validatePlanDomain(makePlan([session]), CATALOG).errors;
    expect(errors.filter((e) => /hauteur de barre/i.test(e))).toEqual([]);
  });

  it("reports per session, not per plan", () => {
    const plan = makePlan([
      makeSession("Lundi", [makeExercise(HAUTE[0], 0)]),
      makeSession("Mardi", [makeExercise(BASSE[0], 0)]),
    ]);
    expect(validatePlanDomain(plan, CATALOG).errors.filter((e) => /hauteur de barre/i.test(e))).toEqual([]);
  });

  // Regression: 5df2b0c — a DEACTIVATED bar exercise still counted toward the
  // mix, so one line produced two errors: « sur liste noire » and then advice
  // about separating an exercise she has removed. It also put the suspenders
  // out of scope with the belt, since `buildBarHeightSection` filters the same
  // names out of the prompt.
  it("ignores a deactivated exercise, which the blacklist rule has already reported", () => {
    const withoutLowBar = buildCatalogViews({
      ...seed,
      exercises: seed.exercises.map((e) =>
        e.name === BASSE[0] ? { ...e, active: false, inactiveReason: "Douleur épaule" } : e
      ),
    });
    const errors = validatePlanDomain(
      makePlan([makeSession("Haut", [makeExercise(HAUTE[0], 0), makeExercise(BASSE[0], 0)])]),
      withoutLowBar
    ).errors;

    expect(errors.filter((e) => /hauteur de barre/i.test(e))).toEqual([]);
    // The control: the line IS still rejected, just once and for the right reason.
    expect(errors.filter((e) => /liste noire/i.test(e))).toHaveLength(1);
  });

  // Same discipline as every other rule here: the verdict must follow the
  // DOCUMENT it was handed, not a table compiled into the module.
  it("reads barHeight from the catalog it was given", () => {
    const flattened = buildCatalogViews({
      ...seed,
      exercises: seed.exercises.map((e) => (e.name === BASSE[0] ? { ...e, barHeight: "haute" } : e)),
    });
    expect(barHeightErrors(HAUTE[0], BASSE[0])).toHaveLength(1);
    const errors = validatePlanDomain(
      makePlan([makeSession("Haut du corps", [makeExercise(HAUTE[0], 0), makeExercise(BASSE[0], 0)])]),
      flattened
    ).errors.filter((e) => /hauteur de barre/i.test(e));
    expect(errors).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Moved here with their subjects from `coachNotice.test.js` on
 * 2026-08-23. Unchanged otherwise: the verdict→notice mapping, the
 * correction request and the rejected-plan digest are the same functions,
 * now beside the `evaluatePlanImport` that authors what they carry.
 * ------------------------------------------------------------------ */

describe("noticeForVerdict", () => {
  it("reports EVERY blocking error, not just the first", () => {
    const notice = noticeForVerdict({
      shouldImport: false,
      errors: ["Charge trop lourde", "Exercice inconnu", "Exercice blacklisté"],
      warnings: [],
    });
    expect(notice.tone).toBe("error");
    expect(notice.shouldImport).toBe(false);
    expect(notice.items).toEqual([
      "Charge trop lourde",
      "Exercice inconnu",
      "Exercice blacklisté",
    ]);
  });

  it("surfaces warnings after a successful import", () => {
    const notice = noticeForVerdict({
      shouldImport: true,
      errors: [],
      warnings: ["Charge arrondie à 9 kg"],
    });
    expect(notice.tone).toBe("success");
    expect(notice.shouldImport).toBe(true);
    expect(notice.items).toEqual(["Charge arrondie à 9 kg"]);
    expect(notice.title).toMatch(/ajustements/);
  });

  it("uses the plain success title when there is nothing to adjust", () => {
    const notice = noticeForVerdict({ shouldImport: true, errors: [], warnings: [] });
    expect(notice.tone).toBe("success");
    expect(notice.items).toEqual([]);
    expect(notice.title).not.toMatch(/ajustements/);
  });

  // Was "keeps the stage voice in every title". The user asked for a more direct
  // coach (2026-08-01); a verdict she has to act on is the last place for a
  // stage metaphor, since the title is what tells her whether the plan landed.
  it("states the outcome plainly in every title", () => {
    const titles = [
      noticeForVerdict({ shouldImport: false, errors: ["x"], warnings: [] }).title,
      noticeForVerdict({ shouldImport: true, errors: [], warnings: ["y"] }).title,
      noticeForVerdict({ shouldImport: true, errors: [], warnings: [] }).title,
    ];
    for (const t of titles) {
      expect(t).not.toMatch(/darling|chérie|rideau|en piste/i);
      expect(t).toMatch(/importé/i); // says whether it went in, either way
    }
  });

  it("tolerates a verdict with no errors or warnings arrays", () => {
    const notice = noticeForVerdict({ shouldImport: false });
    expect(notice.items).toEqual([]);
    expect(notice.tone).toBe("error");
  });
});

describe("canRequestCorrection", () => {
  it("is offered only when the import was blocked", () => {
    const blocked = noticeForVerdict({ shouldImport: false, errors: ["Séance 1 : trop lourd"], warnings: [] });
    expect(blocked.canRequestCorrection).toBe(true);

    const imported = noticeForVerdict({ shouldImport: true, errors: [], warnings: ["arrondi"] });
    expect(imported.canRequestCorrection).toBe(false);
  });

  // A rejection with nothing to say cannot be fixed by asking: the request
  // would carry an empty list and the coach would guess at what to change,
  // which is how a plan comes back different in ways nobody asked for.
  it("is NOT offered when the rejection carries no error to relay", () => {
    expect(noticeForVerdict({ shouldImport: false, errors: [], warnings: [] }).canRequestCorrection).toBe(false);
  });

  it("is a boolean on every branch, so the button never renders on `undefined`", () => {
    for (const verdict of [
      { shouldImport: false, errors: ["x"], warnings: [] },
      { shouldImport: true, errors: [], warnings: [] },
      { shouldImport: false },
      {},
    ]) {
      expect(typeof noticeForVerdict(verdict).canRequestCorrection).toBe("boolean");
    }
  });
});

describe("buildCorrectionRequest", () => {
  const ERRORS = [
    "Séance 1 (Haut du corps) : « Squat » dépasse le plafond (17 kg/main).",
    "Séance 2 (Bas du corps) : hauteur de barre incompatible.",
  ];

  it("relays every error verbatim", () => {
    const message = buildCorrectionRequest(ERRORS);
    for (const error of ERRORS) expect(message).toContain(error);
  });

  // The coach must return a WHOLE week. A patch — "change just that line" —
  // has nowhere to go: the import takes a complete payload, and there is no
  // merge path that could apply a fragment to the plan it rejected.
  it("asks for the complete programme, not a patch", () => {
    expect(buildCorrectionRequest(ERRORS)).toMatch(/complet/i);
  });

  it("says the plan was refused, so the coach is not guessing why it is being asked again", () => {
    expect(buildCorrectionRequest(ERRORS)).toMatch(/refus/i);
  });

  it("returns null when there is nothing to relay, rather than a bare demand", () => {
    expect(buildCorrectionRequest([])).toBeNull();
    expect(buildCorrectionRequest(null)).toBeNull();
    expect(buildCorrectionRequest(["  ", ""])).toBeNull();
  });

  it("drops blank entries but keeps the real ones", () => {
    const message = buildCorrectionRequest(["", "Séance 1 : trop lourd", "   "]);
    expect(message).toContain("Séance 1 : trop lourd");
    expect(message.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
  });
});

describe("summarizeRejectedPlan", () => {
  const PAYLOAD = {
    weekStart: "2026-08-17", weekEnd: "2026-08-23", coachNotes: "notes visibles",
    notebook: "CARNET PRIVE — jamais montré à Camille",
    sessions: [
      { name: "Haut du corps", warmup: [{ name: "Rotations", detail: "2×10" }], cooldown: [], exercises: [
        { name: "Squat", setsCount: 4, reps: "8", weight: 25, weightType: "per_hand", restSeconds: 90, progressionNote: "monte" },
        { name: "Pompes", setsCount: 3, reps: "10", weight: 0, weightType: "total", restSeconds: 60, progressionNote: "" },
      ]},
      { name: "Dos", warmup: [], cooldown: [], exercises: [
        { name: "Rowing haltère", setsCount: 3, reps: "12", weight: 7.5, weightType: "total", restSeconds: 90, progressionNote: "" },
      ]},
    ],
  };

  // THE load-bearing test. The payload carries the coach's private notebook,
  // and this digest becomes a USER turn — which `CoachConversation` renders as
  // her own words, straight through ReactMarkdown, with none of the guards that
  // protect an assistant turn. Reading named fields (never spreading the
  // payload) is what makes that structurally impossible rather than carefully
  // avoided.
  it("never carries the notebook, however the payload is shaped", () => {
    const hostile = {
      ...PAYLOAD,
      sessions: PAYLOAD.sessions.map((s) => ({ ...s, notebook: "CARNET PRIVE dans la séance" })),
    };
    for (const input of [PAYLOAD, hostile, JSON.stringify(hostile)]) {
      const summary = summarizeRejectedPlan(input);
      expect(summary).not.toMatch(/carnet/i);
      expect(summary).not.toMatch(/PRIVE/);
    }
  });

  it("names every session and every exercise, with its sets, reps and load", () => {
    const summary = summarizeRejectedPlan(PAYLOAD);
    expect(summary).toContain("Haut du corps");
    expect(summary).toContain("Dos");
    expect(summary).toContain("Squat 4×8 à 25 kg/main");
    expect(summary).toContain("Rowing haltère 3×12 à 7,5 kg");
  });

  // Regression: 2e92a4f — the digest left out warm-up and cool-down, so the coach was
  // asked to fix « Tapis de course » in a home cool-down it could not read.
  it("names warm-up and cool-down items, which the validator also rejects", () => {
    const payload = {
      ...PAYLOAD,
      sessions: [{
        name: "Maison",
        warmup: [{ name: "Tapis de course", detail: "5 min" }, { name: "Rotations", detail: "2×10" }],
        cooldown: [{ name: "Étirement dos", detail: "30s par côté" }],
        exercises: [{ name: "Pompes", setsCount: 3, reps: "10", weight: 0, weightType: "total" }],
        notebook: "CARNET PRIVE",
      }],
    };
    const summary = summarizeRejectedPlan(payload);
    expect(summary).toContain("échauffement : Tapis de course (5 min) ; Rotations (2×10)");
    expect(summary).toContain("retour au calme : Étirement dos (30s par côté)");
    expect(summary).not.toMatch(/PRIVE/);
  });

  it("renders a session without warm-up or cool-down without those segments", () => {
    const payload = { sessions: [{ name: "Dos", exercises: [{ name: "Tirage", setsCount: 3, reps: "10", weight: 0 }] }] };
    const summary = summarizeRejectedPlan(payload);
    expect(summary).not.toContain("échauffement");
    expect(summary).not.toContain("retour au calme");
    const empty = { sessions: [{ name: "Dos", warmup: [], cooldown: [], exercises: [] }] };
    expect(summarizeRejectedPlan(empty)).not.toContain("échauffement");
  });

  it("says bodyweight rather than 0 kg", () => {
    expect(summarizeRejectedPlan(PAYLOAD)).toContain("Pompes 3×10 au poids du corps");
  });

  it("states the week, since the errors name sessions by number", () => {
    expect(summarizeRejectedPlan(PAYLOAD)).toContain("17/08");
  });

  it("accepts the payload as a JSON string, which is how the bubble holds it", () => {
    expect(summarizeRejectedPlan(JSON.stringify(PAYLOAD))).toBe(summarizeRejectedPlan(PAYLOAD));
  });

  it("returns null for anything it cannot read, rather than a header with nothing under it", () => {
    expect(summarizeRejectedPlan(null)).toBeNull();
    expect(summarizeRejectedPlan("pas du JSON")).toBeNull();
    expect(summarizeRejectedPlan({ sessions: [] })).toBeNull();
  });
});

describe("buildCorrectionRequest with the rejected plan", () => {
  const ERRORS = ["Séance 1 (Haut du corps) : « Squat » dépasse le plafond (17 kg/main)."];
  const SUMMARY = "Semaine du 17/08 au 23/08\nSéance 1 — Haut du corps : Squat 4×8 à 25 kg/main";

  // Without this the request is unsatisfiable: `collapsePlan` rewrites the
  // rejected payload to `[programme émis : N séances, …]` before the model sees
  // history, and `generateExport` ships the CURRENT stored plan — which is the
  // previous week, since a rejected plan is never imported. The model would be
  // told to fix séance 2 with no idea what was in it, and would regenerate the
  // week from scratch.
  it("includes the plan being corrected", () => {
    const message = buildCorrectionRequest(ERRORS, SUMMARY);
    expect(message).toContain("Squat 4×8 à 25 kg/main");
    expect(message).toContain(ERRORS[0]);
  });

  // « Le programme que tu viens de proposer » is wrong whenever she imports an
  // older payload from her scrollback — every completed plan keeps its import
  // button — or when a newer coach turn landed while the notice sat open.
  it("points at the plan it quotes, never at 'the one you just sent'", () => {
    const message = buildCorrectionRequest(ERRORS, SUMMARY);
    expect(message).not.toMatch(/viens de proposer/i);
    expect(message).toMatch(/ci-dessous/i);
  });

  it("still asks for a correction when the plan could not be summarised", () => {
    const message = buildCorrectionRequest(ERRORS, null);
    expect(message).toContain(ERRORS[0]);
    expect(message).toMatch(/complet/i);
  });
});

/**
 * The unit of a held exercise. `metric` is the catalog's answer, stamped onto
 * the plan so nothing downstream has to re-derive it from prose.
 *
 * The `sets`/`reps` agreement is the point of the last test here: `sets` is
 * built by `planFromJson` from the PRE-normalisation `reps`, so normalising
 * `reps` without re-deriving `sets` leaves `3×45s` beside `reps: "45"` — two
 * sources for one fact, which is the reason `sets` is derived at all.
 */
describe("held exercises carry their unit as a field", () => {
  const hold = (reps, extra = {}) =>
    makePlan([
      makeSession("Traction", [
        { name: "Dead hang", sets: `3×${reps}`, setsCount: 3, reps, weight: 0, weightType: "total", restSeconds: 90, ...extra },
      ]),
    ]);
  const lineOf = (plan) => validatePlanDomain(plan, CATALOG).correctedPlan.sessions[0].exercises[0];

  it.each([["45s"], ["45 s"], ["45"], ["45 secondes"], ["45sec"]])(
    "strips the unit from %s, leaving a bare number",
    (reps) => {
      expect(lineOf(hold(reps))).toMatchObject({ metric: "seconds", reps: "45" });
    }
  );

  it("stamps the metric from the catalog, never from the payload", () => {
    // The payload claims repetitions; the catalog says this is a hold. The
    // catalog wins — the model does not get to declare the unit.
    expect(lineOf(hold("45", { metric: "reps" })).metric).toBe("seconds");
  });

  it("leaves a rep-counted exercise completely alone", () => {
    const plan = makePlan([makeSession("Haut du corps", [makeExercise("Rowing haltères", 12, "per_hand")])]);
    const line = validatePlanDomain(plan, CATALOG).correctedPlan.sessions[0].exercises[0];
    expect(line.reps).toBe("10");
    expect(line.sets).toBe("3×10");
    expect(line).not.toHaveProperty("metric");
  });

  it("warns without blocking when a hold's duration is not readable", () => {
    const { errors, warnings, correctedPlan } = validatePlanDomain(hold("30-40min"), CATALOG);
    expect(errors).toEqual([]);
    expect(warnings.join(" ")).toMatch(/durée lisible/i);
    // Kept verbatim rather than mangled — a lossy rewrite is worse than none.
    expect(correctedPlan.sessions[0].exercises[0].reps).toBe("30-40min");
  });

  it("re-derives `sets` so it can never contradict `reps`", () => {
    const line = lineOf(hold("45s"));
    expect(line.sets).toBe("3×45");
    expect(line.sets).toBe(`${line.setsCount}×${line.reps}`);
  });

  it("imports a hold cleanly end to end", () => {
    const verdict = evaluatePlanImport(JSON.stringify({
      weekStart: "2026-08-24", weekEnd: "2026-08-30", coachNotes: "",
      sessions: [{
        name: "Traction", warmup: [], cooldown: [],
        exercises: [{ name: "Dead hang", setsCount: 3, reps: "25s", weight: 0, weightType: "total", restSeconds: 90, progressionNote: "" }],
      }],
    }), CATALOG);

    expect(verdict.shouldImport).toBe(true);
    expect(verdict.errors).toEqual([]);
    expect(verdict.plan.sessions[0].exercises[0]).toMatchObject({ reps: "25", sets: "3×25", metric: "seconds" });
  });
});
