import { describe, it, expect } from "vitest";
import { upsertSession } from "./sessionsReducer.js";

describe("upsertSession", () => {
  // Regression (2026-09-30 review): « Rejouer » then « Enregistrer » produced a
  // session with a NEW id passed as an edit; `map` found nothing and dropped it.
  it("upsert with an unknown id prepends instead of dropping", () => {
    const prev = [{ id: "a", name: "A" }];
    expect(upsertSession(prev, { id: "b", name: "B" })).toEqual([{ id: "b", name: "B" }, { id: "a", name: "A" }]);
  });
  it("upsert with a known id replaces in place, preserving order", () => {
    const prev = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
    expect(upsertSession(prev, { id: "b", name: "B2" })).toEqual([{ id: "a", name: "A" }, { id: "b", name: "B2" }]);
  });
});
