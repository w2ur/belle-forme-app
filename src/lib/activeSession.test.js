import { today } from "./helpers.js";
import { describe, it, expect } from "vitest";
import {
  createFromPlanned, validateSet, leaveExercise, back,
  toggleChecklistItem, finalize, restore, currentExercise, moveExercise, sessionForCoach,
  markQuit, markResumed, stampActive,
} from "./activeSession.js";

const PLANNED = {
  name: "Haut du corps",
  warmup: [{ name: "Vélo", detail: "5min" }],
  cooldown: [{ name: "Étirements", detail: "3min" }],
  exercises: [
    { name: "Rowing", setsCount: 3, reps: "12", weight: 11, weightType: "per_hand", restSeconds: 90, progressionNote: "" },
    { name: "Développé", setsCount: 2, reps: "10", weight: 9, weightType: "per_hand", restSeconds: 60, progressionNote: "tempo lent" },
  ],
};
const OPTS = { id: "s1", date: "2026-07-27", startedAt: "2026-07-27T09:00:00.000Z", weekStart: "2026-07-27" };
const make = () => createFromPlanned(PLANNED, OPTS);

describe("createFromPlanned", () => {
  it("expands setsCount into that many unvalidated set rows", () => {
    const s = make();
    expect(s.exercises[0].sets).toHaveLength(3);
    expect(s.exercises[0].sets.every((x) => x.done === false)).toBe(true);
  });

  it("keeps the planned values separate from the recorded ones", () => {
    const s = make();
    expect(s.exercises[0].plannedReps).toBe("12");
    expect(s.exercises[0].plannedWeight).toBe(11);
    expect(s.exercises[0].sets[0].reps).toBe("");
    expect(s.exercises[0].sets[0].weight).toBe("");
  });

  it("starts every exercise pending, with the cursor at the first set", () => {
    const s = make();
    expect(s.exercises.every((e) => e.status === "pending")).toBe(true);
    expect(s.cursor).toEqual({ exercise: 0, set: 0 });
  });

  it("carries warmup and cooldown as unchecked checklist items", () => {
    const s = make();
    expect(s.warmup).toEqual([{ name: "Vélo", detail: "5min", done: false }]);
    expect(s.cooldown[0].done).toBe(false);
  });

  it("tolerates a planned session with no warmup or cooldown", () => {
    const s = createFromPlanned({ name: "X", exercises: [] }, OPTS);
    expect(s.warmup).toEqual([]);
    expect(s.cooldown).toEqual([]);
  });
});

describe("validateSet", () => {
  it("records the values and marks the set done", () => {
    const s = validateSet(make(), { reps: "12", weight: "11" });
    expect(s.exercises[0].sets[0]).toEqual({ reps: "12", weight: "11", done: true });
  });

  it("advances to the next set within the exercise", () => {
    const s = validateSet(make(), { reps: "12", weight: "11" });
    expect(s.cursor).toEqual({ exercise: 0, set: 1 });
  });

  it("does not mutate the input state", () => {
    const before = make();
    validateSet(before, { reps: "12", weight: "11" });
    expect(before.exercises[0].sets[0].done).toBe(false);
  });

  it("marks the exercise complete and moves on after the last set", () => {
    let s = make();
    for (let i = 0; i < 3; i++) s = validateSet(s, { reps: "12", weight: "11" });
    expect(s.exercises[0].status).toBe("complete");
    expect(s.cursor).toEqual({ exercise: 1, set: 0 });
  });

  it("is a no-op once every exercise is done", () => {
    let s = make();
    for (let i = 0; i < 5; i++) s = validateSet(s, { reps: "1", weight: "1" });
    const done = s;
    expect(validateSet(done, { reps: "9", weight: "9" })).toEqual(done);
  });
});

describe("leaveExercise", () => {
  it("marks an exercise with no validated sets as skipped", () => {
    const s = leaveExercise(make());
    expect(s.exercises[0].status).toBe("skipped");
    expect(s.cursor.exercise).toBe(1);
  });

  it("marks an exercise with some validated sets as partial", () => {
    let s = validateSet(make(), { reps: "12", weight: "11" });
    s = leaveExercise(s);
    expect(s.exercises[0].status).toBe("partial");
  });

  it("marks an exercise with every set validated as complete", () => {
    let s = make();
    for (let i = 0; i < 3; i++) s = validateSet(s, { reps: "12", weight: "11" });
    // validateSet already advanced; go back and leave it explicitly
    s = leaveExercise(back(s));
    expect(s.exercises[0].status).toBe("complete");
  });
});

describe("back", () => {
  it("returns to the previous exercise with its sets intact", () => {
    let s = validateSet(make(), { reps: "12", weight: "11" });
    s = leaveExercise(s);
    s = back(s);
    expect(s.cursor.exercise).toBe(0);
    expect(s.exercises[0].sets[0].done).toBe(true);
  });

  it("is a no-op on the first exercise", () => {
    const s = make();
    expect(back(s)).toEqual(s);
  });

  it("reopens a left exercise so it can be continued", () => {
    let s = leaveExercise(make());
    s = back(s);
    expect(s.exercises[0].status).toBe("pending");
  });
});

describe("toggleChecklistItem", () => {
  it("flips a warmup item and leaves the rest alone", () => {
    const s = toggleChecklistItem(make(), "warmup", 0);
    expect(s.warmup[0].done).toBe(true);
    expect(s.cooldown[0].done).toBe(false);
  });

  it("ignores an out-of-range index", () => {
    const s = make();
    expect(toggleChecklistItem(s, "warmup", 9)).toEqual(s);
  });
});

describe("finalize", () => {
  it("keeps only validated sets", () => {
    let s = make();
    s = validateSet(s, { reps: "12", weight: "11" });
    s = leaveExercise(s);
    const session = finalize(s, { durationMinutes: 45 });
    expect(session.exercises[0].sets).toHaveLength(1);
  });

  it("records a skipped exercise rather than dropping it", () => {
    const session = finalize(leaveExercise(make()), { durationMinutes: 10 });
    expect(session.exercises[0].name).toBe("Rowing");
    expect(session.exercises[0].status).toBe("skipped");
    expect(session.exercises[0].sets).toEqual([]);
  });

  it("produces the storage session shape", () => {
    const session = finalize(make(), { durationMinutes: 30 });
    expect(session).toMatchObject({
      id: "s1", date: "2026-07-27", name: "Haut du corps", duration_minutes: 30,
    });
    expect(session.exercises[0].weightType).toBe("per_hand");
  });

  it("carries general_notes through", () => {
    const s = { ...make(), general_notes: "Épaule droite tendue" };
    expect(finalize(s, { durationMinutes: 5 }).general_notes).toBe("Épaule droite tendue");
  });
});

describe("restore", () => {
  it("round-trips a serialised state", () => {
    const s = validateSet(make(), { reps: "12", weight: "11" });
    expect(restore(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("rejects null, non-objects and empty payloads", () => {
    for (const bad of [null, undefined, 0, "", "abc", []]) expect(restore(bad)).toBeNull();
  });

  it("rejects a payload from a future or missing schema version", () => {
    const s = make();
    expect(restore({ ...s, version: 99 })).toBeNull();
    expect(restore({ ...s, version: undefined })).toBeNull();
  });

  it("rejects a payload whose exercises are malformed", () => {
    const s = make();
    expect(restore({ ...s, exercises: "nope" })).toBeNull();
    expect(restore({ ...s, cursor: null })).toBeNull();
  });
});

describe("currentExercise", () => {
  it("returns the exercise under the cursor, or null when finished", () => {
    expect(currentExercise(make()).name).toBe("Rowing");
    let s = make();
    for (let i = 0; i < 5; i++) s = validateSet(s, { reps: "1", weight: "1" });
    expect(currentExercise(s)).toBeNull();
  });

  // Regression: 9150929 — « Suivant » on the last exercise used to be wired to
  // finish; leaving it must land on the finished screen (null), keep every
  // recorded set, and derive the status rather than force `skipped`.
  it("leaving the last exercise lands on the finished screen without losing sets", () => {
    let s = leaveExercise(make());
    s = validateSet(s, { reps: "10", weight: "9" });
    s = leaveExercise(s);
    expect(currentExercise(s)).toBeNull();
    const last = s.exercises[1];
    expect(last.sets.filter((x) => x.done)).toHaveLength(1);
    expect(last.status).toBe("partial");
  });
});

describe("moveExercise", () => {
  // A three-exercise séance: the two-exercise PLANNED above cannot express
  // "moved past something that is neither first nor last".
  const PLANNED3 = {
    ...PLANNED,
    exercises: [
      ...PLANNED.exercises,
      { name: "Gainage", setsCount: 2, reps: "45", weight: 0, restSeconds: 60, progressionNote: "" },
    ],
  };
  const make3 = () => createFromPlanned(PLANNED3, OPTS);
  const names = (s) => s.exercises.map((e) => e.name);

  it("moves an upcoming exercise up without touching the cursor", () => {
    const s = moveExercise(make3(), 2, 1);
    expect(names(s)).toEqual(["Rowing", "Gainage", "Développé"]);
    expect(s.cursor).toEqual({ exercise: 0, set: 0 });
  });

  it("moves the CURRENT exercise down, so the next one becomes current", () => {
    // « La barre est prise, je le fais plus tard » — the whole point of
    // letting the current exercise move: it must not go through « passé ».
    const s = moveExercise(make3(), 0, 2);
    expect(names(s)).toEqual(["Développé", "Gainage", "Rowing"]);
    expect(currentExercise(s).name).toBe("Développé");
    expect(s.exercises.every((e) => e.status === "pending")).toBe(true);
  });

  it("carries the sets and status of the moved exercise with it", () => {
    let s = validateSet(make3(), { reps: "12", weight: "11" });
    s = moveExercise(s, 0, 2);
    expect(names(s)).toEqual(["Développé", "Gainage", "Rowing"]);
    expect(s.exercises[2].sets[0]).toEqual({ reps: "12", weight: "11", done: true });
  });

  it("refuses to move an exercise that is already behind the cursor", () => {
    const s = leaveExercise(make3());
    expect(moveExercise(s, 0, 2)).toEqual(s);
  });

  it("refuses to drop an exercise behind the cursor", () => {
    const s = leaveExercise(make3());
    expect(moveExercise(s, 2, 0)).toEqual(s);
  });

  it("is a no-op when from and to are the same, or out of range", () => {
    const s = make3();
    expect(moveExercise(s, 1, 1)).toEqual(s);
    expect(moveExercise(s, 5, 0)).toEqual(s);
    expect(moveExercise(s, 0, 9)).toEqual(s);
  });

  it("recomputes cursor.set onto the first undone set of the new current exercise", () => {
    // Without this, a cursor left at set 2 of a half-done exercise points at
    // an already-validated row of whatever exercise now sits at the cursor.
    let s = validateSet(make3(), { reps: "12", weight: "11" });
    s = validateSet(s, { reps: "12", weight: "11" });
    expect(s.cursor).toEqual({ exercise: 0, set: 2 });
    s = moveExercise(s, 0, 2);
    expect(currentExercise(s).name).toBe("Développé");
    expect(s.cursor.set).toBe(0);
  });

  it("leaves the cursor's set alone when the move happens entirely after it", () => {
    let s = validateSet(make3(), { reps: "12", weight: "11" });
    expect(s.cursor).toEqual({ exercise: 0, set: 1 });
    s = moveExercise(s, 2, 1);
    expect(currentExercise(s).name).toBe("Rowing");
    expect(s.cursor).toEqual({ exercise: 0, set: 1 });
  });

  it("falls back to the last set when the exercise at the cursor has none undone", () => {
    let s = make3();
    for (let i = 0; i < 3; i++) s = validateSet(s, { reps: "12", weight: "11" });
    // `back` reopens a fully validated exercise, so there is no undone set to
    // land on — the only state in which the fallback is reachable.
    s = back(s);
    expect(s.cursor).toEqual({ exercise: 0, set: 2 });
    s = moveExercise(s, 1, 2);
    expect(currentExercise(s).name).toBe("Rowing");
    expect(s.cursor.set).toBe(2);
  });

  it("lands on a recordable set when she comes back to a half-done exercise", () => {
    // The headline flow: one set done, the bar is taken, she moves the
    // exercise away and reaches it again later. Landing on set 0 there leaves
    // no ✓ button anywhere — `SetRow` draws a validated set as the read-only
    // completed row and every non-current set as `—` — so the exercise is a
    // dead end and only « Suivant › » or « Passer » gets her out.
    let s = validateSet(make3(), { reps: "12", weight: "11" });
    s = moveExercise(s, 0, 2);
    s = leaveExercise(leaveExercise(s));
    expect(currentExercise(s).name).toBe("Rowing");
    expect(s.cursor.set).toBe(1);
    expect(currentExercise(s).sets[s.cursor.set].done).toBe(false);
  });

  it("never mutates the input state", () => {
    const s = make3();
    const before = JSON.stringify(s);
    moveExercise(s, 0, 2);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe("sessionForCoach", () => {
  it("passes a draft through and gives null for no draft or a malformed one", () => {
    const state = createFromPlanned(PLANNED, { id: "a", date: "2026-10-01", startedAt: 1 });
    expect(sessionForCoach(state)).toMatchObject({ name: state.name, cursor: state.cursor });
    expect(sessionForCoach(null)).toBeNull();
    expect(sessionForCoach(undefined)).toBeNull();
    expect(sessionForCoach({ name: "x" })).toBeNull();
    expect(sessionForCoach({ exercises: [] })).toBeNull();
  });

  it("carries `current`: screen open, or dated today", () => {
    const old = createFromPlanned(PLANNED, { id: "a", date: "2020-01-06", startedAt: 1 });
    const fresh = createFromPlanned(PLANNED, { id: "b", date: today(), startedAt: 1 });
    expect(sessionForCoach(old, false).current).toBe(false);
    expect(sessionForCoach(old, true).current).toBe(true);
    expect(sessionForCoach(fresh, false).current).toBe(true);
    expect(old.current).toBeUndefined();
  });

  // Regression: 8e91bb8 — a draft dated today read « SÉANCE EN COURS » hours after she quit it
  // with the X, which held her to the 1-3 sentence mid-séance brevity rule.
  it("is not current once she quit with the X, even today", () => {
    const fresh = createFromPlanned(PLANNED, { id: "b", date: today(), startedAt: 1 });
    expect(sessionForCoach(markQuit(fresh), false).current).toBe(false);
  });

  it("stays current when the screen was closed by navigation, and again once resumed", () => {
    const fresh = createFromPlanned(PLANNED, { id: "b", date: today(), startedAt: 1 });
    // Navigation closes the screen without marking the draft.
    expect(sessionForCoach(fresh, false).current).toBe(true);
    const resumed = markResumed(markQuit(fresh));
    expect(resumed.quit).toBeUndefined();
    expect(sessionForCoach(resumed, false).current).toBe(true);
    // An open screen is live whatever the mark says.
    expect(sessionForCoach(markQuit(fresh), true).current).toBe(true);
  });

  // Regression: 3268cd9 — a draft from an earlier day that she resumed today and then left by
  // navigation read as not current, though she was mid-workout.
  it("is current when an earlier draft was resumed today, then left by navigation", () => {
    const old = createFromPlanned(PLANNED, { id: "a", date: "2020-01-06", startedAt: 1 });
    expect(sessionForCoach(markResumed(old), false).current).toBe(true);
    expect(sessionForCoach(markResumed(markQuit(old)), false).current).toBe(true);
  });

  it("is not current when the resume was on another day, or she quit after it", () => {
    const old = createFromPlanned(PLANNED, { id: "a", date: "2020-01-06", startedAt: 1 });
    expect(sessionForCoach(markResumed(old, "2020-01-07"), false).current).toBe(false);
    expect(sessionForCoach(markQuit(markResumed(old)), false).current).toBe(false);
  });

  // Regression: 6a4c045 — a séance still running past midnight, then left by navigation, read
  // as not current: liveness keyed on the START date, not on the day she last worked on it.
  it("is current when a draft started yesterday was worked on today, then left by navigation", () => {
    const crosser = createFromPlanned(PLANNED, { id: "m", date: "2020-01-06", startedAt: 1 });
    expect(sessionForCoach(stampActive(crosser), false).current).toBe(true);
  });

  it("is not current when it was last worked on another day", () => {
    const stale = stampActive(createFromPlanned(PLANNED, { id: "s", date: "2020-01-06", startedAt: 1 }), "2020-01-06");
    expect(sessionForCoach(stale, false).current).toBe(false);
    // Stamped today, then quit with the X: the mark still wins.
    expect(sessionForCoach(markQuit(stampActive(stale)), false).current).toBe(false);
  });

  it("falls back to the start date for a draft written before the stamp existed", () => {
    const legacy = createFromPlanned(PLANNED, { id: "l", date: today(), startedAt: 1 });
    expect(legacy.activeOn).toBeUndefined();
    expect(sessionForCoach(legacy, false).current).toBe(true);
  });

  it("keeps the mark through restore, so a killed tab still knows she quit", () => {
    const quit = markQuit(createFromPlanned(PLANNED, { id: "b", date: today(), startedAt: 1 }));
    expect(restore(JSON.parse(JSON.stringify(quit))).quit).toBe(true);
  });
});
