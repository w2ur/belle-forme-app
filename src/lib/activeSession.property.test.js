import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createFromPlanned, validateSet, leaveExercise, skipExercise, back, moveExercise, finalize } from "./activeSession.js";

const OPTS = { id: "s", date: "2026-07-27", startedAt: "2026-07-27T09:00:00.000Z", weekStart: null };

const plannedArb = fc.record({
  name: fc.constant("Séance"),
  exercises: fc.array(
    fc.record({
      name: fc.string({ minLength: 1, maxLength: 12 }),
      setsCount: fc.integer({ min: 1, max: 5 }),
      reps: fc.constant("10"),
      weight: fc.double({ min: 0, max: 40, noNaN: true, noDefaultInfinity: true }),
      weightType: fc.constantFrom("total", "per_hand"),
      metric: fc.constantFrom("reps", "seconds"),
      restSeconds: fc.integer({ min: 30, max: 180 }),
    }),
    { minLength: 1, maxLength: 6 }
  ),
});

/**
 * An arbitrary sequence of the moves the user can make.
 *
 * `move` carries unbounded-ish indices on purpose: `moveExercise` is supposed
 * to no-op on anything out of range or behind the cursor, so feeding it only
 * legal pairs would test the arithmetic and never the guards.
 */
const moveArb = fc.oneof(
  fc.constant({ t: "validate" }),
  fc.constant({ t: "leave" }),
  fc.constant({ t: "back" }),
  fc.record({
    t: fc.constant("move"),
    from: fc.integer({ min: 0, max: 7 }),
    to: fc.integer({ min: 0, max: 7 }),
  })
);

function applyMoves(state, moves) {
  return moves.reduce((s, move) => {
    if (move.t === "validate") return validateSet(s, { reps: "10", weight: "12" });
    if (move.t === "leave") return leaveExercise(s);
    if (move.t === "move") return moveExercise(s, move.from, move.to);
    return back(s);
  }, state);
}

/** The exercises as an order-independent bag, for conservation assertions. */
const bag = (exercises) => exercises.map((e) => `${e.name}|${e.metric ?? "reps"}`).sort();

describe("finalize invariant", () => {
  it("never emits a set that was not validated, under any interleaving", () => {
    fc.assert(
      fc.property(plannedArb, fc.array(moveArb, { maxLength: 40 }), (planned, moves) => {
        const final = applyMoves(createFromPlanned(planned, OPTS), moves);
        const session = finalize(final, { durationMinutes: 30 });

        const emitted = session.exercises.reduce((n, ex) => n + ex.sets.length, 0);
        const validated = final.exercises.reduce((n, ex) => n + ex.sets.filter((s) => s.done).length, 0);
        expect(emitted).toBe(validated);
      }),
      { numRuns: 1000 }
    );
  });

  it("keeps every exercise, so a skip is recorded rather than vanishing", () => {
    fc.assert(
      fc.property(plannedArb, fc.array(moveArb, { maxLength: 40 }), (planned, moves) => {
        const final = applyMoves(createFromPlanned(planned, OPTS), moves);
        const session = finalize(final, { durationMinutes: 30 });
        expect(session.exercises).toHaveLength(planned.exercises.length);
      }),
      { numRuns: 1000 }
    );
  });

  it("only ever labels an exercise with no emitted sets as skipped", () => {
    fc.assert(
      fc.property(plannedArb, fc.array(moveArb, { maxLength: 40 }), (planned, moves) => {
        const final = applyMoves(createFromPlanned(planned, OPTS), moves);
        for (const ex of finalize(final, { durationMinutes: 30 }).exercises) {
          if (ex.sets.length === 0) expect(ex.status).toBe("skipped");
          else expect(ex.status).not.toBe("skipped");
        }
      }),
      { numRuns: 1000 }
    );
  });

  it("never moves the cursor outside the exercise list", () => {
    fc.assert(
      fc.property(plannedArb, fc.array(moveArb, { maxLength: 40 }), (planned, moves) => {
        const final = applyMoves(createFromPlanned(planned, OPTS), moves);
        expect(final.cursor.exercise).toBeGreaterThanOrEqual(0);
        expect(final.cursor.exercise).toBeLessThanOrEqual(planned.exercises.length);
        expect(final.cursor.set).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 1000 }
    );
  });
});

/**
 * `metric` is the unit a set is counted in, and it travels with the exercise
 * rather than being looked up from the catalog when a record is read — so it
 * has to survive every move the user can make, not just the happy path. A hold that
 * loses its unit somewhere between `Commencer` and `Terminer` is a hold that
 * silently becomes repetitions in her history, with nothing to signal it.
 */
describe("the unit of a set survives the séance", () => {
  it("carries `metric` from the plan to the stored session, under any interleaving", () => {
    fc.assert(
      fc.property(plannedArb, fc.array(moveArb, { maxLength: 40 }), (planned, moves) => {
        const final = applyMoves(createFromPlanned(planned, OPTS), moves);
        const session = finalize(final, { durationMinutes: 30 });

        // Compared as a BAG, not position by position: reordering is now one
        // of the moves, so `session.exercises[i]` no longer corresponds to
        // `planned.exercises[i]`. Absent means repetitions, so the assertion
        // is on the NORMALISED reading rather than on the key being present —
        // otherwise this would pin the encoding instead of the meaning.
        expect(bag(session.exercises)).toEqual(bag(planned.exercises));
      }),
      { numRuns: 1000 }
    );
  });
});

/**
 * Reordering a running séance must not be able to rewrite its history.
 *
 * The cursor is the floor: everything behind it has been left, and its status
 * and skip reason are statements about what happened that travel to the coach
 * through `generateExport`. A drag that could reach back there would turn a
 * record into a guess.
 */
describe("moveExercise conserves the séance", () => {
  it("never adds, drops or alters an exercise, under any interleaving", () => {
    fc.assert(
      fc.property(plannedArb, fc.array(moveArb, { maxLength: 40 }), (planned, moves) => {
        const final = applyMoves(createFromPlanned(planned, OPTS), moves);
        expect(bag(final.exercises)).toEqual(bag(planned.exercises));
      }),
      { numRuns: 1000 }
    );
  });

  it("leaves everything behind the cursor untouched", () => {
    fc.assert(
      fc.property(
        plannedArb,
        fc.array(moveArb, { maxLength: 40 }),
        fc.integer({ min: 0, max: 7 }),
        fc.integer({ min: 0, max: 7 }),
        (planned, moves, from, to) => {
          const before = applyMoves(createFromPlanned(planned, OPTS), moves);
          const after = moveExercise(before, from, to);
          const floor = before.cursor.exercise;
          expect(after.exercises.slice(0, floor)).toEqual(before.exercises.slice(0, floor));
          expect(after.cursor.exercise).toBe(floor);
        }
      ),
      { numRuns: 1000 }
    );
  });

  // Existence is not enough, and asserting only that was a check that could
  // not fail on the bug it looked like it covered. `SetRow` renders a `done`
  // set as the read-only completed row and every non-current set as `—`, so a
  // cursor parked on a validated set leaves NO ✓ button anywhere: she cannot
  // record the sets she has left. That is exactly the state reached by
  // validating a set, moving the exercise away, and coming back to it — the
  // headline flow of this feature.
  it("always leaves the cursor on a set she can still record", () => {
    fc.assert(
      fc.property(plannedArb, fc.array(moveArb, { maxLength: 40 }), (planned, moves) => {
        const final = applyMoves(createFromPlanned(planned, OPTS), moves);
        const at = final.exercises[final.cursor.exercise];
        if (!at) return; // past the end: the séance is over, there is no set
        expect(final.cursor.set).toBeGreaterThanOrEqual(0);
        expect(final.cursor.set).toBeLessThan(at.sets.length);
        // Unless every set is done, in which case there is nothing left to
        // land on and the last row is the honest place to be.
        if (at.sets.some((x) => !x.done)) expect(at.sets[final.cursor.set].done).toBe(false);
      }),
      { numRuns: 1000 }
    );
  });
});

/**
 * « Passer » is a statement of intent, « Suivant › » is a move. They called the
 * same function until 2026-08-23, so the three-way status only ever described
 * what she happened to type.
 */
describe("skipExercise states intent, leaveExercise infers it", () => {
  // The status stays DERIVED and the REASON is what skipping adds. An early
  // draft forced `skipped` regardless, which broke the documented invariant
  // that a skipped exercise carries `sets: []`: `finalize` keeps every
  // validated set, so an exercise she half-did and abandoned was stored as
  // `skipped` with two real sets, reported to the coach as « passé (non
  // réalisé) », and credited with a new record by `computePRs` on the same
  // date. Two contradictory facts about one exercise.
  it("records the reason without ever lying about what she did", () => {
    fc.assert(
      fc.property(plannedArb, fc.array(moveArb, { maxLength: 40 }), (planned, moves) => {
        const state = applyMoves(createFromPlanned(planned, OPTS), moves);
        const at = state.cursor.exercise;
        if (at >= state.exercises.length) return; // nothing left to skip
        const ex = state.exercises[at];
        const done = ex.sets.filter((s) => s.done).length;
        const after = skipExercise(state, { reason: "materiel" });

        expect(after.exercises[at].skipReason).toBe("materiel");
        expect(after.cursor.exercise).toBe(at + 1);
        // Exactly `statusFor`: `skipped` iff nothing was validated, `complete`
        // iff everything was. The DIFFERENCE between « Passer » and
        // « Suivant › » is the reason, not a different verdict about what she
        // did — a button cannot make a set she validated stop existing.
        const expected = done === 0 ? "skipped" : done === ex.sets.length ? "complete" : "partial";
        expect(after.exercises[at].status).toBe(expected);

        const stored = finalize(after, { durationMinutes: 30 }).exercises[at];
        if (stored.status === "skipped") expect(stored.sets).toEqual([]);
        else expect(stored.sets.length).toBe(done);
      }),
      { numRuns: 1000 }
    );
  });

  it("leaves `leaveExercise` inferring the status exactly as before", () => {
    fc.assert(
      fc.property(plannedArb, fc.array(moveArb, { maxLength: 40 }), (planned, moves) => {
        const state = applyMoves(createFromPlanned(planned, OPTS), moves);
        const at = state.cursor.exercise;
        if (at >= state.exercises.length) return;
        const ex = state.exercises[at];
        const done = ex.sets.filter((s) => s.done).length;
        const expected = done === 0 ? "skipped" : done === ex.sets.length ? "complete" : "partial";
        expect(leaveExercise(state).exercises[at].status).toBe(expected);
      }),
      { numRuns: 1000 }
    );
  });

  // Going back reopens the exercise, so the reason must not survive: leaving
  // « matériel » on a set she went on to do would send the coach a fact that
  // is no longer true.
  it("clears the reason when the exercise is reopened", () => {
    const state = createFromPlanned({ name: "S", exercises: [
      { name: "A", setsCount: 1, reps: "10", weight: 0, weightType: "total", restSeconds: 60 },
      { name: "B", setsCount: 1, reps: "10", weight: 0, weightType: "total", restSeconds: 60 },
    ] }, OPTS);
    const skipped = skipExercise(state, { reason: "materiel" });
    expect(skipped.exercises[0].skipReason).toBe("materiel");
    const reopened = back(skipped);
    expect(reopened.exercises[0].skipReason).toBe("");
    expect(reopened.exercises[0].status).toBe("pending");
  });

  it("carries the reason into the stored session, and omits it when there is none", () => {
    const state = createFromPlanned({ name: "S", exercises: [
      { name: "A", setsCount: 1, reps: "10", weight: 0, weightType: "total", restSeconds: 60 },
      { name: "B", setsCount: 1, reps: "10", weight: 0, weightType: "total", restSeconds: 60 },
    ] }, OPTS);
    const session = finalize(skipExercise(skipExercise(state, { reason: "materiel" }), { reason: "" }), { durationMinutes: 30 });
    expect(session.exercises[0]).toMatchObject({ status: "skipped", skipReason: "materiel", sets: [] });
    expect(session.exercises[1].status).toBe("skipped");
    expect(session.exercises[1]).not.toHaveProperty("skipReason");
  });
});
