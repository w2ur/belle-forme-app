import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { planFromJson, isPlanPayload } from "./planFromJson.js";

const movementArb = fc.record({
  name: fc.string(),
  detail: fc.string(),
});

const exerciseArb = fc.record({
  name: fc.string(),
  setsCount: fc.integer({ min: 1, max: 10 }),
  reps: fc.string({ minLength: 1 }),
  weight: fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
  weightType: fc.constantFrom("total", "per_hand"),
  restSeconds: fc.integer({ min: 0, max: 300 }),
  progressionNote: fc.string(),
});

const planArb = fc.record({
  weekStart: fc.constant("2026-08-11"),
  weekEnd: fc.constant("2026-08-17"),
  coachNotes: fc.string(),
  notebook: fc.string(),
  sessions: fc.array(
    fc.record({
      name: fc.string(),
      warmup: fc.array(movementArb, { maxLength: 4 }),
      exercises: fc.array(exerciseArb, { maxLength: 6 }),
      cooldown: fc.array(movementArb, { maxLength: 4 }),
    }),
    { minLength: 1, maxLength: 5 },
  ),
});

describe("planFromJson properties", () => {
  it("never throws and always yields a plan for a schema-valid payload", () => {
    fc.assert(
      fc.property(planArb, (payload) => {
        const { plan, errors } = planFromJson(payload);
        expect(errors).toEqual([]);
        expect(plan).not.toBeNull();
      }),
      { numRuns: 1000 },
    );
  });

  it("gives every exercise a non-empty sets display string", () => {
    fc.assert(
      fc.property(planArb, (payload) => {
        const { plan } = planFromJson(payload);
        for (const s of plan.sessions) {
          for (const ex of s.exercises) {
            expect(ex.sets.length).toBeGreaterThan(0);
            expect(ex.sets).toBe(`${ex.setsCount}×${ex.reps}`);
          }
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("preserves session, exercise, warmup and cooldown counts exactly", () => {
    fc.assert(
      fc.property(planArb, (payload) => {
        const { plan } = planFromJson(payload);
        expect(plan.sessions).toHaveLength(payload.sessions.length);
        payload.sessions.forEach((s, i) => {
          expect(plan.sessions[i].exercises).toHaveLength(s.exercises.length);
          expect(plan.sessions[i].warmup).toHaveLength(s.warmup.length);
          expect(plan.sessions[i].cooldown).toHaveLength(s.cooldown.length);
        });
      }),
      { numRuns: 1000 },
    );
  });

  it("round-trips through JSON.stringify unchanged", () => {
    fc.assert(
      fc.property(planArb, (payload) => {
        expect(isPlanPayload(JSON.stringify(payload))).toBe(true);
        expect(planFromJson(JSON.stringify(payload)).plan)
          .toEqual(planFromJson(payload).plan);
      }),
      { numRuns: 1000 },
    );
  });
});
