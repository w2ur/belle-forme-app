import { describe, it, expect, vi } from "vitest";
import {
  generateId,
  formatDate,
  formatDateShort,
  today,
  getExerciseGroup,
  getWeekStart,
  normalizeSessionNames,
  normalizePlanNames,
} from "./helpers.js";
import seed from "../data/catalogSeed.json";
import { buildCatalogViews } from "./catalogTestkit.js";

const iso = (d) => d.toISOString().split("T")[0];

const REAL_CATALOG = buildCatalogViews(seed);
const EMPTY_CATALOG = buildCatalogViews({ exercises: [] });

describe("generateId", () => {
  it("returns a string starting with 's_'", () => {
    const id = generateId();
    expect(typeof id).toBe("string");
    expect(id.startsWith("s_")).toBe(true);
  });

  it("returns unique values across multiple calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateId()));
    expect(ids.size).toBe(50);
  });

  it("contains a timestamp and random suffix", () => {
    const id = generateId();
    const parts = id.split("_");
    // s_ + timestamp + random
    expect(parts.length).toBe(3);
    expect(Number(parts[1])).toBeGreaterThan(0);
    expect(parts[2].length).toBeGreaterThan(0);
  });
});

describe("formatDate", () => {
  it("formats an ISO date string to French short date", () => {
    // new Date("2026-02-15") is parsed as UTC, displayed in local time
    const result = formatDate("2026-02-15");
    expect(result).toContain("15");
    expect(result.toLowerCase()).toMatch(/f[ée]v/);
    // Should contain a French weekday abbreviation
    expect(result.toLowerCase()).toMatch(/(lun|mar|mer|jeu|ven|sam|dim)/);
  });

  it("formats a Wednesday date correctly", () => {
    // 2026-02-11 is a Wednesday
    const result = formatDate("2026-02-11");
    expect(result).toContain("11");
    expect(result.toLowerCase()).toMatch(/mer/);
  });

  it("formats a date in December correctly", () => {
    const result = formatDate("2025-12-25");
    expect(result).toContain("25");
    expect(result.toLowerCase()).toMatch(/d[ée]c/);
  });
});

describe("formatDateShort", () => {
  it("formats '2026-02-15' to '15/02'", () => {
    const result = formatDateShort("2026-02-15");
    expect(result).toBe("15/02");
  });

  it("formats a single-digit day with leading zero", () => {
    const result = formatDateShort("2026-01-05");
    expect(result).toBe("05/01");
  });

  it("formats December dates correctly", () => {
    const result = formatDateShort("2025-12-01");
    expect(result).toBe("01/12");
  });
});

describe("today", () => {
  it("returns a string in ISO date format (YYYY-MM-DD)", () => {
    const result = today();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("matches the current Paris calendar date", () => {
    const expected = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
    expect(today()).toBe(expected);
  });

  // Regression: 1c011de — UTC dated a séance logged just after midnight in Paris to the previous day.
  it("returns the Paris date between 00:00 and 01:59 local time, whatever the runtime TZ", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-01T00:30:00+02:00"));
      expect(today()).toBe("2026-10-01");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getExerciseGroup", () => {
  it("returns 'Upper Body' for an upper body exercise", () => {
    expect(getExerciseGroup("Développé couché au sol", REAL_CATALOG)).toBe("Upper Body");
    expect(getExerciseGroup("Curl biceps", REAL_CATALOG)).toBe("Upper Body");
    expect(getExerciseGroup("Shrugs", REAL_CATALOG)).toBe("Upper Body");
  });

  it("returns 'Lower Body' for a lower body exercise", () => {
    expect(getExerciseGroup("Squat", REAL_CATALOG)).toBe("Lower Body");
    expect(getExerciseGroup("Fentes bulgares", REAL_CATALOG)).toBe("Lower Body");
    expect(getExerciseGroup("Pont fessier", REAL_CATALOG)).toBe("Lower Body");
  });

  it("returns 'Full Body' for a full body exercise", () => {
    expect(getExerciseGroup("Burpees", REAL_CATALOG)).toBe("Full Body");
    expect(getExerciseGroup("Thruster", REAL_CATALOG)).toBe("Full Body");
  });

  it("returns 'Core' for a core exercise", () => {
    expect(getExerciseGroup("Gainage planche", REAL_CATALOG)).toBe("Core");
    expect(getExerciseGroup("Russian twist", REAL_CATALOG)).toBe("Core");
  });

  it("returns 'Cardio' for a cardio exercise", () => {
    expect(getExerciseGroup("Elliptique", REAL_CATALOG)).toBe("Cardio");
    expect(getExerciseGroup("Course", REAL_CATALOG)).toBe("Cardio");
  });

  it("returns 'Autre' for a name the catalog does not recognize", () => {
    expect(getExerciseGroup("Yoga", REAL_CATALOG)).toBe("Autre");
    expect(getExerciseGroup("", REAL_CATALOG)).toBe("Autre");
    expect(getExerciseGroup("Some Random Exercise", REAL_CATALOG)).toBe("Autre");
  });

  // A DISPLAY consumer, not a validator: "Autre" is a real classification and
  // must not be reused for "there is no catalog to check against" — that is a
  // different fact (see getExerciseGroup's doc comment) and is reported as ""
  // (no badge) instead.
  it("returns '' rather than 'Autre' when there is no catalog", () => {
    expect(getExerciseGroup("Squat", null)).toBe("");
  });

  it("returns '' rather than 'Autre' for a degenerate (empty) catalog", () => {
    expect(getExerciseGroup("Squat", EMPTY_CATALOG)).toBe("");
  });
});

describe("normalizeSessionNames", () => {
  const [oldName, canonical] = Object.entries(REAL_CATALOG.aliases)[0];
  const raw = [{ id: "s_1", date: "2026-08-01", exercises: [{ name: oldName, sets: [] }] }];

  it("rewrites a retired name to its canonical one with a real catalog", () => {
    const result = normalizeSessionNames(raw, REAL_CATALOG);
    expect(result[0].exercises[0].name).toBe(canonical);
  });

  it("passes sessions through unchanged with a null catalog", () => {
    expect(normalizeSessionNames(raw, null)).toEqual(raw);
  });

  it("passes sessions through unchanged with a degenerate (empty) catalog", () => {
    expect(normalizeSessionNames(raw, EMPTY_CATALOG)).toEqual(raw);
  });

  // THE CASE THIS TEST EXISTS FOR (fix round 1 Important finding): without the
  // `if (!isUsableCatalog(catalog)) return sessions;` early return,
  // canonicalExerciseName(name, null) THROWS ("a catalog is required — there
  // is no fallback, by design"), which would throw during the useState
  // initialiser in useSessionData.js — a blank app on first mount, exactly the
  // path this guard exists for. Falsified by hand: temporarily removing the
  // early return in helpers.js made this test fail with that exact message,
  // confirmed by running `npx vitest run src/lib/helpers.test.js`, then the
  // return was restored.
  it("does not throw when the catalog is missing", () => {
    expect(() => normalizeSessionNames(raw, null)).not.toThrow();
  });
});

describe("normalizePlanNames", () => {
  const [oldName, canonical] = Object.entries(REAL_CATALOG.aliases)[0];
  const plan = {
    weekStart: "2026-08-11",
    sessions: [{ name: "Séance A", exercises: [{ name: oldName, sets: "3x10" }] }],
  };

  it("rewrites a retired name to its canonical one with a real catalog", () => {
    const result = normalizePlanNames(plan, REAL_CATALOG);
    expect(result.sessions[0].exercises[0].name).toBe(canonical);
  });

  it("passes the plan through unchanged with a null catalog", () => {
    expect(normalizePlanNames(plan, null)).toEqual(plan);
  });

  it("passes the plan through unchanged with a degenerate (empty) catalog", () => {
    expect(normalizePlanNames(plan, EMPTY_CATALOG)).toEqual(plan);
  });

  it("does not throw when the catalog is missing", () => {
    expect(() => normalizePlanNames(plan, null)).not.toThrow();
  });
});

describe("getWeekStart", () => {
  it("returns the same Monday for a Monday", () => {
    // 2026-02-09 is a Monday
    expect(iso(getWeekStart("2026-02-09"))).toBe("2026-02-09");
  });

  it("returns the week's Monday for a mid-week day (Wednesday)", () => {
    // 2026-02-11 is a Wednesday
    expect(iso(getWeekStart("2026-02-11"))).toBe("2026-02-09");
  });

  it("returns the week's Monday for a Saturday", () => {
    // 2026-02-14 is a Saturday
    expect(iso(getWeekStart("2026-02-14"))).toBe("2026-02-09");
  });

  it("maps Sunday to the Monday that STARTED its week, not the next Monday", () => {
    // Regression: getDate() - getDay() + 1 mapped Sunday to the following
    // Monday (2026-02-16), corrupting streaks and weekly volume.
    // 2026-02-15 is a Sunday; its week started Monday 2026-02-09.
    expect(iso(getWeekStart("2026-02-15"))).toBe("2026-02-09");
  });

  it("handles a year boundary (week spanning December into January)", () => {
    // 2021-01-01 is a Friday; its week started Monday 2020-12-28.
    expect(iso(getWeekStart("2021-01-01"))).toBe("2020-12-28");
  });

  it("is timezone-independent for a plain ISO date string", () => {
    expect(iso(getWeekStart("2026-02-15"))).toBe("2026-02-09");
  });

  it("accepts a Date instance", () => {
    expect(iso(getWeekStart(new Date("2026-02-15T12:00:00Z")))).toBe("2026-02-09");
  });

  it("returns a Date at UTC midnight", () => {
    const d = getWeekStart("2026-02-11");
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCSeconds()).toBe(0);
    expect(d.getUTCMilliseconds()).toBe(0);
  });
});
