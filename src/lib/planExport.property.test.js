import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { generateExport } from "./planExport";
import { generateEquipmentLines } from "../constants/equipment";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Prototype key names that would collide with Object.prototype methods on a
 * plain {} map. These were the root cause of the prototype-pollution bug found
 * by initial property test runs; the list here documents the known dangerous
 * names so we can verify the fix holds and also filter them out of
 * fuzz-generation where prototype-name collisions are NOT what we're testing.
 */
const PROTO_NAMES = new Set([
  "constructor", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable",
  "toString", "toLocaleString", "valueOf", "__defineGetter__", "__defineSetter__",
  "__lookupGetter__", "__lookupSetter__", "__proto__",
]);

/** Arbitrary exercise name: non-empty, not a JS prototype key. */
const arbExName = fc
  .stringMatching(/^[a-zA-ZÀ-ɏ ]+$/)
  .filter((s) => s.trim().length > 0 && !PROTO_NAMES.has(s.trim()));

/** Arbitrary ISO date string (2024-01-01 to 2027-12-31), using integer offsets
 *  to avoid fc.date() generating invalid Date objects during shrinking. */
const BASE_MS = new Date("2024-01-01T00:00:00Z").getTime();
const MAX_OFFSET_DAYS = 365 * 4; // ~4 years
const arbDateISO = fc
  .integer({ min: 0, max: MAX_OFFSET_DAYS })
  .map((offset) => new Date(BASE_MS + offset * 86400000).toISOString().split("T")[0]);

/** Arbitrary set record {reps, weight}. */
const arbSet = fc.record({
  reps: fc.integer({ min: 1, max: 30 }),
  weight: fc.float({ min: 0, max: 200, noNaN: true, noDefaultInfinity: true })
    .map((w) => Math.round(w * 10) / 10),
});

/** Arbitrary exercise with a non-empty sets array. */
const arbExercise = fc.record({
  name: arbExName,
  sets: fc.array(arbSet, { minLength: 1, maxLength: 6 }),
  weightType: fc.constantFrom("total", "per_hand"),
});

/** Arbitrary session record. */
const arbSession = fc.record({
  id: fc.string({ maxLength: 20 }),
  name: arbExName,
  date: arbDateISO,
  duration_minutes: fc.oneof(
    fc.integer({ min: 10, max: 180 }),
    fc.constant(null)
  ),
  exercises: fc.array(arbExercise, { minLength: 0, maxLength: 5 }),
  general_notes: fc.oneof(fc.string({ maxLength: 100 }), fc.constant("")),
});

/** Arbitrary user profile. */
const arbProfile = fc.record({
  name: fc.string({ minLength: 1, maxLength: 30 }),
  age: fc.integer({ min: 16, max: 80 }),
  height: fc.integer({ min: 140, max: 220 }),
  weight: fc.integer({ min: 40, max: 150 }),
  experience: fc.string({ maxLength: 20 }),
  frequency: fc.string({ maxLength: 20 }),
  equipment: fc.oneof(
    fc.array(fc.string({ maxLength: 20 }), { maxLength: 5 }),
    fc.constant(null)
  ),
  goals: fc.string({ maxLength: 100 }),
  priorities: fc.string({ maxLength: 100 }),
});

/** Arbitrary planned exercise (as produced by planFromJson). */
const arbPlannedExercise = fc.record({
  name: arbExName,
  sets: fc.string({ maxLength: 20 }),
  setsCount: fc.integer({ min: 1, max: 10 }),
  reps: fc.string({ maxLength: 10 }),
  weight: fc.float({ min: 0, max: 200, noNaN: true, noDefaultInfinity: true })
    .map((w) => Math.round(w * 10) / 10),
  restSeconds: fc.integer({ min: 15, max: 180 }),
});

/** Arbitrary planned session. */
const arbPlannedSession = fc.record({
  name: arbExName,
  exercises: fc.array(arbPlannedExercise, { minLength: 1, maxLength: 4 }),
});

/** Arbitrary current plan (nullable). */
const arbCurrentPlan = fc.oneof(
  fc.constant(null),
  fc.record({
    weekStart: fc.constant("2026-06-01"),
    weekEnd: fc.constant("2026-06-07"),
    coachNotes: fc.string({ maxLength: 100 }),
    sessions: fc.array(arbPlannedSession, { minLength: 0, maxLength: 3 }),
  })
);

// ---------------------------------------------------------------------------
// Property tests — generateExport
// ---------------------------------------------------------------------------

describe("generateExport property tests", () => {
  describe("no-crash invariants", () => {
    it("never throws for any combination of sessions, profile, and plan", () => {
      fc.assert(
        fc.property(
          fc.array(arbSession, { maxLength: 15 }),
          arbProfile,
          arbCurrentPlan,
          (sessions, profile, plan) => {
            expect(() => generateExport(sessions, profile, plan)).not.toThrow();
          }
        ),
        { numRuns: 300 }
      );
    });

    it("always returns a non-empty string", () => {
      fc.assert(
        fc.property(
          fc.array(arbSession, { maxLength: 10 }),
          arbProfile,
          arbCurrentPlan,
          (sessions, profile, plan) => {
            const result = generateExport(sessions, profile, plan);
            expect(typeof result).toBe("string");
            expect(result.length).toBeGreaterThan(0);
          }
        ),
        { numRuns: 300 }
      );
    });

    it("always includes the FITTRACK EXPORT header", () => {
      fc.assert(
        fc.property(
          fc.array(arbSession, { maxLength: 10 }),
          arbProfile,
          arbCurrentPlan,
          (sessions, profile, plan) => {
            const result = generateExport(sessions, profile, plan);
            expect(result).toContain("=== FITTRACK EXPORT ===");
          }
        ),
        { numRuns: 300 }
      );
    });

    it("always includes the PROFIL section", () => {
      fc.assert(
        fc.property(
          fc.array(arbSession, { maxLength: 5 }),
          arbProfile,
          arbCurrentPlan,
          (sessions, profile, plan) => {
            const result = generateExport(sessions, profile, plan);
            expect(result).toContain("PROFIL :");
          }
        ),
        { numRuns: 300 }
      );
    });

    it("always includes the TENDANCES section", () => {
      fc.assert(
        fc.property(
          fc.array(arbSession, { maxLength: 5 }),
          arbProfile,
          arbCurrentPlan,
          (sessions, profile, plan) => {
            const result = generateExport(sessions, profile, plan);
            expect(result).toContain("TENDANCES :");
          }
        ),
        { numRuns: 300 }
      );
    });
  });

  describe("session count invariants", () => {
    it("shows 'Aucune séance enregistrée' exactly when sessions is empty", () => {
      fc.assert(
        fc.property(arbProfile, arbCurrentPlan, (profile, plan) => {
          const result = generateExport([], profile, plan);
          expect(result).toContain("Aucune séance enregistrée.");
        }),
        { numRuns: 200 }
      );
    });

    it("does NOT show 'Aucune séance' when at least one session is present", () => {
      fc.assert(
        fc.property(
          fc.array(arbSession, { minLength: 1, maxLength: 10 }),
          arbProfile,
          arbCurrentPlan,
          (sessions, profile, plan) => {
            const result = generateExport(sessions, profile, plan);
            expect(result).not.toContain("Aucune séance enregistrée.");
          }
        ),
        { numRuns: 200 }
      );
    });

    it("shows at most 10 sessions in the recent sessions block", () => {
      fc.assert(
        fc.property(
          fc.array(arbSession, { minLength: 11, maxLength: 20 }),
          arbProfile,
          arbCurrentPlan,
          (sessions, profile, plan) => {
            const result = generateExport(sessions, profile, plan);
            // Count session header lines (emoji date prefix).
            const sessionLines = result
              .split("\n")
              .filter((l) => l.startsWith("📅"));
            expect(sessionLines.length).toBeLessThanOrEqual(10);
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  describe("plan adherence invariants", () => {
    it("never shows ADHÉRENCE section when plan is null", () => {
      fc.assert(
        fc.property(
          fc.array(arbSession, { maxLength: 5 }),
          arbProfile,
          (sessions, profile) => {
            const result = generateExport(sessions, profile, null);
            expect(result).not.toContain("ADHÉRENCE AU PLAN");
          }
        ),
        { numRuns: 200 }
      );
    });

    it("never shows ADHÉRENCE section when plan has empty sessions", () => {
      fc.assert(
        fc.property(
          fc.array(arbSession, { maxLength: 5 }),
          arbProfile,
          fc.record({
            weekStart: fc.constant("2026-06-01"),
            weekEnd: fc.constant("2026-06-07"),
            coachNotes: fc.constant(""),
            sessions: fc.constant([]),
          }),
          (sessions, profile, plan) => {
            const result = generateExport(sessions, profile, plan);
            expect(result).not.toContain("ADHÉRENCE AU PLAN");
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("profile section invariants", () => {
    // The name is printed TRIMMED, and a blank one is left out (4857643, cf38ff5), so the
    // invariant is about the trimmed name — a whitespace-only one has nothing to include.
    it("always includes the trimmed profile name in the output", () => {
      fc.assert(
        fc.property(
          fc.constant([]),
          arbProfile,
          (sessions, profile) => {
            const result = generateExport(sessions, profile, null);
            expect(result).toContain(profile.name.trim());
          }
        ),
        { numRuns: 200 }
      );
    });

    // The equipment line is DERIVED from the physical inventory and ignores
    // `profile.equipment` entirely. That was a deliberate change: the stored
    // profile had drifted from the real inventory and the user could neither see
    // nor fix it, so a stale stored string was being fed to the coach as
    // fact. This test therefore asserts the derivation WINS over whatever
    // `profile.equipment` holds — including null, which used to render
    // "non renseigné".
    it("always derives the equipment line from the inventory, whatever profile.equipment holds", () => {
      const derived = generateEquipmentLines().join(", ");

      fc.assert(
        fc.property(
          fc.constant([]),
          arbProfile,
          fc.oneof(fc.constant(null), fc.constant(undefined), fc.constant(""), fc.string()),
          (sessions, profile, storedEquipment) => {
            const result = generateExport(sessions, { ...profile, equipment: storedEquipment }, null);
            expect(result).toContain(`- Équipement : ${derived}`);
            expect(result).not.toContain("non renseigné");
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("regression: prototype-named exercises do not crash generateExport", () => {
    // Regression: exerciseHistory and prs were plain {} objects, so exercise
    // names matching Object.prototype keys ("valueOf", "toString", etc.) caused
    // exerciseHistory[name] to return the inherited method instead of an array,
    // crashing with "exerciseHistory[name].push is not a function". Fixed by
    // switching to Object.create(null) with explicit hasOwnProperty checks.
    const PROTO_KEYS_UNDER_TEST = ["valueOf", "toString", "constructor", "hasOwnProperty"];

    PROTO_KEYS_UNDER_TEST.forEach((prototypeName) => {
      it(`does not crash when exercise is named "${prototypeName}"`, () => {
        const session = {
          id: "s_1",
          name: "Test",
          date: "2026-06-02",
          duration_minutes: 40,
          exercises: [
            {
              name: prototypeName,
              sets: [{ reps: 10, weight: 20 }],
              weightType: "total",
            },
          ],
          general_notes: "",
        };
        const profile = {
          name: "Test",
          age: 30,
          height: 170,
          weight: 70,
          experience: "2 ans",
          frequency: "3x/semaine",
          equipment: ["Haltères"],
          goals: "Forme",
          priorities: "Upper body",
        };
        expect(() => generateExport([session, session, session], profile, null)).not.toThrow();
      });
    });
  });
});
