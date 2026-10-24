import { describe, it, expect } from "vitest";
import { foldForSearch, filterExerciseGroups } from "./exerciseSearch.js";

/** A miniature stand-in for `catalog.muscleGroups`, null-prototype like the real one. */
function groups(obj) {
  return Object.assign(Object.create(null), obj);
}

/** Raw document entries keyed by name, as `ExercisesTab` already builds them. */
function entries(pairs) {
  return new Map(pairs.map(([name, active]) => [name, { name, active }]));
}

const MUSCLE_GROUPS = groups({
  "Lower Body": ["Squat", "Squat sumo", "Fentes"],
  "Upper Body": ["Développé couché au sol", "Rowing"],
});

const ENTRIES = entries([
  ["Squat", true],
  ["Squat sumo", true],
  ["Fentes", false],
  ["Développé couché au sol", true],
  ["Rowing", false],
]);

const ALL = { muscleGroups: MUSCLE_GROUPS, entriesByName: ENTRIES, query: "", status: "all" };

describe("foldForSearch", () => {
  it("strips accents and lowercases", () => {
    expect(foldForSearch("Développé")).toBe("developpe");
  });

  it("is idempotent on already-folded text", () => {
    expect(foldForSearch("developpe")).toBe("developpe");
  });

  it("survives a non-string", () => {
    expect(foldForSearch(null)).toBe("");
    expect(foldForSearch(undefined)).toBe("");
  });
});

describe("filterExerciseGroups", () => {
  it("returns every group unchanged when the query is empty and status is all", () => {
    expect(filterExerciseGroups(ALL)).toEqual([
      ["Lower Body", ["Squat", "Squat sumo", "Fentes"]],
      ["Upper Body", ["Développé couché au sol", "Rowing"]],
    ]);
  });

  it("matches an unaccented query against an accented name", () => {
    expect(filterExerciseGroups({ ...ALL, query: "developpe" })).toEqual([
      ["Upper Body", ["Développé couché au sol"]],
    ]);
  });

  it("matches an accented query against the same name", () => {
    expect(filterExerciseGroups({ ...ALL, query: "Développé" })).toEqual([
      ["Upper Body", ["Développé couché au sol"]],
    ]);
  });

  it("ignores case", () => {
    expect(filterExerciseGroups({ ...ALL, query: "SQUAT" })).toEqual([
      ["Lower Body", ["Squat", "Squat sumo"]],
    ]);
  });

  it("matches on a substring, not only a prefix", () => {
    expect(filterExerciseGroups({ ...ALL, query: "sumo" })).toEqual([
      ["Lower Body", ["Squat sumo"]],
    ]);
  });

  it("ignores surrounding whitespace in the query", () => {
    expect(filterExerciseGroups({ ...ALL, query: "  squat  " })).toEqual([
      ["Lower Body", ["Squat", "Squat sumo"]],
    ]);
  });

  // The dangerous failure is a filter that silently matches everything, so this
  // guard is as load-bearing as the positive cases.
  it("returns an empty array when nothing matches, never the whole catalog", () => {
    expect(filterExerciseGroups({ ...ALL, query: "zzzz" })).toEqual([]);
  });

  it("drops a group left with no matches rather than rendering it empty", () => {
    const result = filterExerciseGroups({ ...ALL, query: "rowing" });
    expect(result.map(([group]) => group)).toEqual(["Upper Body"]);
  });

  it("keeps only active entries under status=active", () => {
    expect(filterExerciseGroups({ ...ALL, status: "active" })).toEqual([
      ["Lower Body", ["Squat", "Squat sumo"]],
      ["Upper Body", ["Développé couché au sol"]],
    ]);
  });

  it("keeps only deactivated entries under status=inactive", () => {
    expect(filterExerciseGroups({ ...ALL, status: "inactive" })).toEqual([
      ["Lower Body", ["Fentes"]],
      ["Upper Body", ["Rowing"]],
    ]);
  });

  it("treats a name with no document entry as active", () => {
    const orphan = new Map(ENTRIES);
    orphan.delete("Squat");
    const result = filterExerciseGroups({ ...ALL, entriesByName: orphan, status: "active" });
    expect(result[0][1]).toContain("Squat");
  });

  it("applies the query and the status together", () => {
    expect(filterExerciseGroups({ ...ALL, query: "squat", status: "inactive" })).toEqual([]);
  });

  it("preserves group order and the order of names inside a group", () => {
    const result = filterExerciseGroups({ ...ALL, query: "s" });
    expect(result[0][0]).toBe("Lower Body");
    expect(result[0][1]).toEqual(["Squat", "Squat sumo", "Fentes"]);
  });

  it("never throws on a malformed catalog", () => {
    expect(filterExerciseGroups({ muscleGroups: null, entriesByName: new Map(), query: "", status: "all" })).toEqual([]);
    expect(filterExerciseGroups({ muscleGroups: groups({ "Lower Body": null }), entriesByName: new Map(), query: "", status: "all" })).toEqual([]);
  });
});
