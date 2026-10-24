import { describe, it, expect } from "vitest";
import {
  sessionVolume,
  computeWeeklyVolume,
  computeStreak,
  computePRs,
  computeLoadStreaks,
  formatRepsWithUnit,
  formatSetsWithUnit,
  formatRecordedLoad,
  formatVolume,
} from "./stats.js";

describe("formatVolume", () => {
  // Regression: 7e19c96 — the history card read « 2 816  kg ». toLocaleString() puts a
  // narrow no-break space (U+202F, 4.5px in the mono face) between thousands,
  // and the template put an ordinary space (9px) before the unit, so the unit
  // gap was twice the separator. A bare toLocaleString() also follows the device
  // locale, which prints « 2,816 » on an English one.
  it("formats in French with the same narrow no-break space before kg", () => {
    expect(formatVolume(2816)).toBe("2 816 kg");
    expect(formatVolume(950)).toBe("950 kg");
  });
});
import seed from "../data/catalogSeed.json";
import { buildCatalogViews } from "./catalogTestkit.js";
import { normalizeSessionNames } from "./helpers.js";

// The aliases are the catalog's now, not a build-time constant: normalisation
// is only as good as the document the client pulled.
const catalog = buildCatalogViews(seed);

function makeSession(date, exercises) {
  return { id: `s_${date}`, date, name: "Test", exercises };
}

const ex = (name, sets) => ({ name, sets });

describe("sessionVolume", () => {
  it("sums reps × weight across every set", () => {
    const s = makeSession("2026-02-10", [
      ex("Squat", [
        { reps: 10, weight: 20 },
        { reps: 8, weight: 25 },
      ]),
    ]);
    // 10*20 + 8*25 = 400
    expect(sessionVolume(s)).toBe(400);
  });

  it("treats missing/invalid reps or weight as zero", () => {
    const s = makeSession("2026-02-10", [
      ex("Pompes", [{ reps: 15 }, { reps: 15, weight: undefined }]),
    ]);
    expect(sessionVolume(s)).toBe(0);
  });

  it("sums across multiple exercises", () => {
    const s = makeSession("2026-02-10", [
      ex("A", [{ reps: 5, weight: 10 }]),
      ex("B", [{ reps: 5, weight: 10 }]),
    ]);
    expect(sessionVolume(s)).toBe(100);
  });

  // Regression: acadfb7 — seconds × kg counted as tonnage, and a
  // per-hand load counted once although both hands carry it.
  it("skips sets of an exercise whose metric is seconds", () => {
    const s = makeSession("2026-02-10", [
      { name: "Lest", metric: "seconds", sets: [{ reps: 45, weight: 10 }] },
      ex("B", [{ reps: 5, weight: 10 }]),
    ]);
    expect(sessionVolume(s)).toBe(50);
  });

  it("doubles the weight when weightType is per_hand", () => {
    const s = makeSession("2026-02-10", [
      { name: "Curl", weightType: "per_hand", sets: [{ reps: 10, weight: 8 }] },
    ]);
    expect(sessionVolume(s)).toBe(160);
  });

  it("contributes 0 for an exercise with sets: []", () => {
    const s = makeSession("2026-02-10", [ex("Skipped", [])]);
    expect(sessionVolume(s)).toBe(0);
  });
});

describe("computeWeeklyVolume", () => {
  it("buckets sessions of the same calendar week together", () => {
    // 2026-02-10 (Tue) and 2026-02-15 (Sun) are the SAME calendar week.
    const sessions = [
      makeSession("2026-02-10", [ex("Squat", [{ reps: 10, weight: 20 }])]),
      makeSession("2026-02-15", [ex("Squat", [{ reps: 10, weight: 20 }])]),
    ];
    const result = computeWeeklyVolume(sessions);
    expect(result).toHaveLength(1);
    expect(result[0].weekStart).toBe("2026-02-09");
    expect(result[0].volume).toBe(400);
  });

  it("Sunday session lands in its own week, not the next one (regression)", () => {
    // Sunday 2026-02-15 and Monday 2026-02-16 are DIFFERENT weeks.
    const sessions = [
      makeSession("2026-02-15", [ex("Squat", [{ reps: 10, weight: 10 }])]),
      makeSession("2026-02-16", [ex("Squat", [{ reps: 10, weight: 10 }])]),
    ];
    const result = computeWeeklyVolume(sessions);
    const keys = result.map((r) => r.weekStart);
    expect(keys).toContain("2026-02-09"); // Sunday's week
    expect(keys).toContain("2026-02-16"); // Monday's week
    expect(result).toHaveLength(2);
  });

  it("returns buckets in chronological order", () => {
    const sessions = [
      makeSession("2026-03-02", [ex("A", [{ reps: 1, weight: 1 }])]),
      makeSession("2026-02-09", [ex("A", [{ reps: 1, weight: 1 }])]),
    ];
    const keys = computeWeeklyVolume(sessions).map((r) => r.weekStart);
    expect(keys).toEqual(["2026-02-09", "2026-03-02"]);
  });

  it("returns an empty array for no sessions", () => {
    expect(computeWeeklyVolume([])).toEqual([]);
  });
});

describe("computeStreak", () => {
  it("returns 0 for no sessions", () => {
    expect(computeStreak([])).toBe(0);
  });

  it("returns 1 for a single week of activity", () => {
    expect(
      computeStreak([makeSession("2026-02-11", [ex("A", [{ reps: 1, weight: 1 }])])])
    ).toBe(1);
  });

  it("counts consecutive weeks", () => {
    const sessions = [
      makeSession("2026-02-09", [ex("A", [{ reps: 1, weight: 1 }])]),
      makeSession("2026-02-16", [ex("A", [{ reps: 1, weight: 1 }])]),
      makeSession("2026-02-23", [ex("A", [{ reps: 1, weight: 1 }])]),
    ];
    expect(computeStreak(sessions)).toBe(3);
  });

  it("breaks the streak on a skipped week", () => {
    const sessions = [
      makeSession("2026-02-09", [ex("A", [{ reps: 1, weight: 1 }])]),
      // skip week of 2026-02-16
      makeSession("2026-02-23", [ex("A", [{ reps: 1, weight: 1 }])]),
    ];
    // Most recent week counts as 1, previous consecutive week is missing.
    expect(computeStreak(sessions)).toBe(1);
  });

  it("does not double-count two sessions in the same week", () => {
    const sessions = [
      makeSession("2026-02-10", [ex("A", [{ reps: 1, weight: 1 }])]),
      makeSession("2026-02-12", [ex("A", [{ reps: 1, weight: 1 }])]),
    ];
    expect(computeStreak(sessions)).toBe(1);
  });
});

describe("computePRs", () => {
  it("keeps the heaviest set per exercise across sessions", () => {
    const sessions = [
      makeSession("2026-02-10", [
        ex("Squat", [
          { reps: 8, weight: 60 },
          { reps: 8, weight: 65 },
        ]),
      ]),
      makeSession("2026-02-11", [ex("Squat", [{ reps: 8, weight: 50 }])]),
    ];
    const prs = computePRs(sessions);
    expect(prs.Squat.weight).toBe(65);
    expect(prs.Squat.date).toBe("2026-02-10");
  });

  it("tracks bodyweight (0 kg) exercises with a zero PR", () => {
    const prs = computePRs([
      makeSession("2026-02-10", [ex("Pompes", [{ reps: 20, weight: 0 }])]),
    ]);
    expect(prs.Pompes.weight).toBe(0);
  });

  it("returns an empty object for no sessions", () => {
    expect(computePRs([])).toEqual({});
  });

  // Regression: e78a710 — a skipped exercise finalises with sets: [], and
  // Math.max() of an empty array is -Infinity. An exercise that was only ever
  // skipped would sit in the PR map as a record of -Infinity, which
  // JSON.stringify turns into null and every reader takes for a real entry.
  it("ignores an exercise with no recorded sets instead of storing -Infinity", () => {
    const prs = computePRs([
      makeSession("2026-02-10", [{ name: "Squat", sets: [], weightType: "total" }]),
      makeSession("2026-02-12", [ex("Squat", [{ reps: 10, weight: 20 }])]),
    ]);
    expect(prs.Squat.weight).toBe(20);
  });

  it("omits an exercise that was only ever skipped", () => {
    const prs = computePRs([makeSession("2026-02-10", [{ name: "Squat", sets: [] }])]);
    expect(prs.Squat).toBeUndefined();
  });
});

describe("computeLoadStreaks", () => {
  it("counts consecutive sessions at the same top load", () => {
    const sessions = [
      makeSession("2026-02-01", [ex("Squat", [{ reps: 8, weight: 12 }])]),
      makeSession("2026-02-08", [ex("Squat", [{ reps: 8, weight: 12 }])]),
      makeSession("2026-02-15", [ex("Squat", [{ reps: 8, weight: 12 }])]),
    ];
    expect(computeLoadStreaks(sessions).Squat).toEqual({
      load: 12,
      weightType: "total",
      sessions: 3,
      since: "2026-02-01",
    });
  });

  it("uses the heaviest set of a session as that session's load", () => {
    const sessions = [
      makeSession("2026-02-08", [
        ex("Squat", [
          { reps: 8, weight: 10 },
          { reps: 6, weight: 14 },
        ]),
      ]),
    ];
    expect(computeLoadStreaks(sessions).Squat.load).toBe(14);
  });

  it("breaks the run when the load increases, counting only the newer sessions", () => {
    const sessions = [
      makeSession("2026-02-01", [ex("Squat", [{ reps: 8, weight: 12 }])]),
      makeSession("2026-02-08", [ex("Squat", [{ reps: 8, weight: 12 }])]),
      makeSession("2026-02-15", [ex("Squat", [{ reps: 8, weight: 14 }])]),
    ];
    expect(computeLoadStreaks(sessions).Squat).toMatchObject({ load: 14, sessions: 1, since: "2026-02-15" });
  });

  it("restarts the run after a dip rather than resuming the earlier one", () => {
    // 12 -> 12 -> 10 (deload) -> 12. The two oldest 12kg sessions do NOT count
    // towards the current run: she has done this load once since the dip.
    const sessions = [
      makeSession("2026-02-01", [ex("Squat", [{ reps: 8, weight: 12 }])]),
      makeSession("2026-02-08", [ex("Squat", [{ reps: 8, weight: 12 }])]),
      makeSession("2026-02-15", [ex("Squat", [{ reps: 8, weight: 10 }])]),
      makeSession("2026-02-22", [ex("Squat", [{ reps: 8, weight: 12 }])]),
    ];
    expect(computeLoadStreaks(sessions).Squat).toMatchObject({ load: 12, sessions: 1, since: "2026-02-22" });
  });

  it("tracks each exercise independently", () => {
    const sessions = [
      makeSession("2026-02-01", [ex("Squat", [{ reps: 8, weight: 12 }]), ex("Curl biceps", [{ reps: 12, weight: 5 }])]),
      makeSession("2026-02-08", [ex("Squat", [{ reps: 8, weight: 12 }]), ex("Curl biceps", [{ reps: 12, weight: 7 }])]),
    ];
    const streaks = computeLoadStreaks(sessions);
    expect(streaks.Squat.sessions).toBe(2);
    expect(streaks["Curl biceps"]).toMatchObject({ load: 7, sessions: 1 });
  });

  it("carries the per-hand weight type through from the logged exercise", () => {
    const sessions = [
      makeSession("2026-02-08", [{ name: "Squat", weightType: "per_hand", sets: [{ reps: 8, weight: 12 }] }]),
    ];
    expect(computeLoadStreaks(sessions).Squat.weightType).toBe("per_hand");
  });

  it("treats bodyweight exercises as a load of 0 and still counts the run", () => {
    const sessions = [
      makeSession("2026-02-01", [ex("Pompes", [{ reps: 15 }])]),
      makeSession("2026-02-08", [ex("Pompes", [{ reps: 20 }])]),
    ];
    expect(computeLoadStreaks(sessions).Pompes).toMatchObject({ load: 0, sessions: 2 });
  });

  it("ignores an exercise entry with no recorded sets", () => {
    const sessions = [makeSession("2026-02-08", [ex("Squat", [])])];
    expect(computeLoadStreaks(sessions).Squat).toBeUndefined();
  });

  it("does not read Object.prototype for prototype-named exercises", () => {
    const sessions = [makeSession("2026-02-08", [ex("valueOf", [{ reps: 8, weight: 5 }])])];
    expect(computeLoadStreaks(sessions).valueOf).toMatchObject({ load: 5, sessions: 1 });
  });

  it("returns an empty object for no sessions, and never throws on junk", () => {
    expect(computeLoadStreaks([])).toEqual({});
    expect(computeLoadStreaks(null)).toEqual({});
    expect(computeLoadStreaks([{ date: "2026-02-08" }])).toEqual({});
  });

  it("does not count a session where the exercise was skipped", () => {
    const streaks = computeLoadStreaks([
      makeSession("2026-02-12", [{ name: "Squat", weightType: "total", status: "skipped", sets: [] }]),
      makeSession("2026-02-10", [{ ...ex("Squat", [{ reps: 10, weight: 20 }]), status: "complete" }]),
    ]);
    expect(streaks.Squat.sessions).toBe(1);
  });

  it("does not count a partial session toward the clean run", () => {
    const streaks = computeLoadStreaks([
      makeSession("2026-02-12", [{ ...ex("Squat", [{ reps: 10, weight: 20 }]), status: "partial" }]),
      makeSession("2026-02-10", [{ ...ex("Squat", [{ reps: 10, weight: 20 }]), status: "complete" }]),
    ]);
    expect(streaks.Squat.sessions).toBe(1);
  });

  it("still counts a legacy session that predates the status field", () => {
    // Every session recorded before mode séance carries no `status`. Treating
    // those as unclean would silently reset every counter to zero on the day
    // this shipped, and the coach would conclude she has been stuck forever.
    const streaks = computeLoadStreaks([
      makeSession("2026-02-12", [ex("Squat", [{ reps: 10, weight: 20 }])]),
      makeSession("2026-02-10", [ex("Squat", [{ reps: 10, weight: 20 }])]),
    ]);
    expect(streaks.Squat.sessions).toBe(2);
  });
});

// Regression: (pending) — exercise names are the primary key for history.
// Renaming one without normalising on read restarts its load streak at zero, and
// the coach then withholds an increase she has already earned. Guarded, not
// assumed: canonicalExerciseName was stubbed to identity once, and this test
// failed (two entries of one session each) exactly as it must.
describe("renamed exercises keep their history", () => {
  it("counts a run recorded under both the old and the new name as one", () => {
    const [oldName, canonical] = Object.entries(catalog.aliases)[0];
    const raw = [
      { date: "2026-08-04", exercises: [{ name: canonical, sets: [{ weight: 10, done: true }] }] },
      { date: "2026-08-01", exercises: [{ name: oldName, sets: [{ weight: 10, done: true }] }] },
    ];
    const streaks = computeLoadStreaks(normalizeSessionNames(raw, catalog));
    expect(Object.keys(streaks)).toEqual([canonical]);
    expect(streaks[canonical].sessions).toBe(2);
  });

  it("keeps one personal record across the rename, not two", () => {
    const [oldName, canonical] = Object.entries(catalog.aliases)[0];
    const raw = [
      { date: "2026-08-04", exercises: [{ name: canonical, sets: [{ weight: 12 }] }] },
      { date: "2026-08-01", exercises: [{ name: oldName, sets: [{ weight: 14 }] }] },
    ];
    const prs = computePRs(normalizeSessionNames(raw, catalog));
    expect(Object.keys(prs)).toEqual([canonical]);
    expect(prs[canonical].weight).toBe(14);
  });
});

/**
 * The unit moved out of the value on 2026-08-23, so every surface that renders
 * a count has to put it back. One function, because `WeeklyPlan`, `PlanCard`,
 * `SessionDetail` and `generateExport` all render it and a second
 * implementation is how the weight convention nearly drifted.
 */
describe("formatRepsWithUnit / formatSetsWithUnit", () => {
  it("leaves a rep count exactly as it was", () => {
    expect(formatRepsWithUnit("10", undefined)).toBe("10");
    expect(formatRepsWithUnit("10", "reps")).toBe("10");
    expect(formatSetsWithUnit("3×10", "reps")).toBe("3×10");
  });

  it("names the unit on a hold", () => {
    expect(formatRepsWithUnit("45", "seconds")).toBe("45 s");
    expect(formatSetsWithUnit("3×45", "seconds")).toBe("3×45 s");
  });

  // A value that already carries a unit must not get a second one: the coach
  // emits "30-40min" for cardio, and "30-40min s" is nonsense.
  it.each([["30-40min"], ["10-12"], [""]])("passes %s through untouched", (value) => {
    expect(formatRepsWithUnit(value, "seconds")).toBe(value);
  });

  it("survives a malformed sets string rather than inventing one", () => {
    expect(formatSetsWithUnit("bizarre", "seconds")).toBe("bizarre");
    expect(formatSetsWithUnit(undefined, "seconds")).toBe("");
  });
});

/**
 * A held exercise progresses in TIME. Until 2026-08-23 `computePRs` read
 * `weight` for everything, so a dead hang sat at 0 kg forever and going
 * 20s → 25s → 30s — the exact progression the coach prescribed all through the
 * 16/08 transcript — produced no record at all.
 */
describe("computePRs on held exercises", () => {
  const hold = (date, reps) => ({
    date,
    exercises: [{ name: "Dead hang", metric: "seconds", weightType: "total", sets: reps.map((r) => ({ reps: r, weight: "" })) }],
  });

  it("records the longest hold, not a 0 kg weight", () => {
    const prs = computePRs([hold("2026-08-17", ["20", "20"]), hold("2026-08-21", ["25", "22"])]);
    expect(prs["Dead hang"]).toMatchObject({ metric: "seconds", seconds: 25, date: "2026-08-21" });
    expect(prs["Dead hang"].weight).toBeUndefined();
  });

  it("does not let a shorter later hold overwrite the record", () => {
    const prs = computePRs([hold("2026-08-17", ["30"]), hold("2026-08-21", ["20"])]);
    expect(prs["Dead hang"].seconds).toBe(30);
    expect(prs["Dead hang"].date).toBe("2026-08-17");
  });

  it("leaves a weight record for a rep-counted exercise untouched", () => {
    const prs = computePRs([
      { date: "2026-08-17", exercises: [{ name: "Squat", weightType: "per_hand", sets: [{ reps: "10", weight: "15" }] }] },
    ]);
    expect(prs["Squat"]).toMatchObject({ weight: 15, weightType: "per_hand" });
    expect(prs["Squat"].metric).toBeUndefined();
  });

  // The migration edge: the SAME exercise logged before the field existed
  // (no metric, weight 0) and after. A 0 kg reading carries no information and
  // must not clobber a real duration.
  it("prefers a duration over a pre-migration 0 kg reading, in either order", () => {
    const legacy = { date: "2026-08-10", exercises: [{ name: "Dead hang", weightType: "total", sets: [{ reps: "20", weight: "" }] }] };
    expect(computePRs([legacy, hold("2026-08-21", ["25"])])["Dead hang"]).toMatchObject({ metric: "seconds", seconds: 25 });
    expect(computePRs([hold("2026-08-21", ["25"]), legacy])["Dead hang"]).toMatchObject({ metric: "seconds", seconds: 25 });
  });

  // Math.max() of nothing is -Infinity, which JSON turns into null and every
  // reader takes for a record. The guard is old; this pins it for the new path.
  it("emits nothing for a hold that was only ever skipped", () => {
    const prs = computePRs([{ date: "2026-08-17", exercises: [{ name: "Dead hang", metric: "seconds", status: "skipped", sets: [] }] }]);
    expect(prs["Dead hang"]).toBeUndefined();
  });

  it("does not turn an unreadable duration into a record", () => {
    const prs = computePRs([hold("2026-08-17", ["30-40min"])]);
    expect(prs["Dead hang"].seconds).toBe(0);
  });
});

// Regression: 9e441fb — SessionDetail printed « kg total » / « 0kg total » for bodyweight sets
// and invented « total » for sets recorded before weightType existed.
describe("formatRecordedLoad", () => {
  it("shows nothing for a bodyweight or empty set", () => {
    for (const w of ["", 0, "0", null, undefined, "abc"]) {
      expect(formatRecordedLoad(w, "total")).toBe("");
      expect(formatRecordedLoad(w, undefined)).toBe("");
    }
  });
  it("marks per-hand and total loads explicitly", () => {
    expect(formatRecordedLoad("12", "per_hand")).toBe("12kg/main");
    expect(formatRecordedLoad(20, "total")).toBe("20kg total");
  });
  it("prints a legacy set without weightType as a bare number, with no invented convention", () => {
    expect(formatRecordedLoad("17", undefined)).toBe("17kg");
  });
});
