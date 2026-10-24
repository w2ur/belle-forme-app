import { describe, it, expect } from "vitest";
import { draftFromPlanned } from "./plannedSession.js";

const planned = {
  name: "Haut du corps",
  exercises: [
    { name: "Rowing", setsCount: 3, reps: "12", weight: 11, weightType: "per_hand", restSeconds: 90 },
    { name: "Développé", setsCount: 2, reps: "10", weight: 0, weightType: "total", restSeconds: 60 },
  ],
};

describe("draftFromPlanned", () => {
  it("expands setsCount into that many set rows", () => {
    const draft = draftFromPlanned(planned, { id: "s1", date: "2026-07-27" });
    expect(draft.exercises[0].sets).toHaveLength(3);
    expect(draft.exercises[1].sets).toHaveLength(2);
  });

  it("carries the planned reps and weight into every row as a starting point", () => {
    const draft = draftFromPlanned(planned, { id: "s1", date: "2026-07-27" });
    expect(draft.exercises[0].sets.every((s) => s.reps === "12" && s.weight === "11")).toBe(true);
  });

  it("leaves a bodyweight exercise's weight blank rather than writing 0", () => {
    const draft = draftFromPlanned(planned, { id: "s1", date: "2026-07-27" });
    expect(draft.exercises[1].sets.every((s) => s.weight === "")).toBe(true);
  });

  it("preserves weightType, which is ambiguous by a factor of two if lost", () => {
    const draft = draftFromPlanned(planned, { id: "s1", date: "2026-07-27" });
    expect(draft.exercises[0].weightType).toBe("per_hand");
    expect(draft.exercises[1].weightType).toBe("total");
  });

  it("uses the id and date it is given, never inventing them", () => {
    const draft = draftFromPlanned(planned, { id: "abc", date: "2026-01-02" });
    expect(draft.id).toBe("abc");
    expect(draft.date).toBe("2026-01-02");
  });

  it("defaults a missing setsCount to one row rather than zero", () => {
    const draft = draftFromPlanned(
      { name: "X", exercises: [{ name: "A", reps: "8", weight: 5 }] },
      { id: "s", date: "2026-07-27" }
    );
    expect(draft.exercises[0].sets).toHaveLength(1);
  });
});

// Regression: 6a4806f — the `Fait` button saved planned reps and weights as if
// they had been performed, so invented numbers entered the user's history and fed
// the coach's own recommendations. A draft is a draft: nothing reaches storage
// until she confirms it in the form.
describe("the Fait fabrication", () => {
  it("produces a draft, not a saved session — the caller must go through the form", () => {
    const draft = draftFromPlanned(planned, { id: "s1", date: "2026-07-27" });
    // The marker of an unconfirmed draft: duration and notes are empty, because
    // only the user can supply them. A fabricated "completed" session had them too.
    expect(draft.duration_minutes).toBe("");
    expect(draft.general_notes).toBe("");
  });
});
