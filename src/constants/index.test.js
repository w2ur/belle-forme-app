/**
 * What is left in `src/constants/index.js` once the catalog moved to Neon.
 *
 * Everything this file used to assert about `EXERCISE_DESCRIPTIONS`,
 * `ALL_EXERCISES`, `MUSCLE_GROUPS`, `EXERCISE_BLACKLIST` and
 * `getExerciseLocations` now lives in `src/data/catalogSeed.test.js`, running
 * the same invariants against `buildCatalogViews(seed)`. Nothing was dropped in
 * the move except one assertion `buildCatalogViews` makes structurally true —
 * see that file's header.
 *
 * `equipment.test.js` covers the load model; the cycle windows and
 * `CLEAN_SESSIONS_BEFORE_LOAD_INCREASE` are parity-tested against
 * `docs/claude-project/instructions.md` in `netlify/__tests__/`.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_PROFILE,
  normalizeBlacklistName,
  resolveCycle,
  cycleWindowsFor,
  CYCLE_LENGTH_RANGE_DAYS,
} from "./index.js";

describe("DEFAULT_PROFILE", () => {
  it("carries no personal data: a new install starts empty", () => {
    expect(DEFAULT_PROFILE.name).toBe("");
    expect(DEFAULT_PROFILE.gender).toBe("");
    expect(DEFAULT_PROFILE.age).toBeNull();
    expect(DEFAULT_PROFILE.height).toBeNull();
    expect(DEFAULT_PROFILE.weight).toBeNull();
    expect(DEFAULT_PROFILE.coachNotes).toBe("");
  });

  it("starts with cycle periodization OFF and no inventory (the starter applies)", () => {
    expect(DEFAULT_PROFILE.cycle.enabled).toBe(false);
    expect(DEFAULT_PROFILE.inventory).toBeNull();
    expect(resolveCycle(DEFAULT_PROFILE)).toBeNull();
  });
});

describe("resolveCycle — opt-in", () => {
  const on = (lengthDays) => ({ cycle: { enabled: true, lengthDays } });

  it("is null unless the profile switched it on", () => {
    expect(resolveCycle(undefined)).toBeNull();
    expect(resolveCycle({})).toBeNull();
    expect(resolveCycle({ cycle: { enabled: false, lengthDays: 28 } })).toBeNull();
    expect(resolveCycle({ cycle: { lengthDays: 28 } })).toBeNull();
  });

  it("returns the windows derived from the stated length", () => {
    const cycle = resolveCycle(on(25));
    expect(cycle.cycleLengthDays).toBe(25);
    expect(cycle.highEnergyDays).toEqual({ from: 6, to: 18 });
    expect(cycle.lowEnergyFromDay).toBe(19);
    expect(cycle.mesocycle).toHaveLength(4);
  });

  it("treats an implausible length as off rather than guessing", () => {
    expect(resolveCycle(on(5))).toBeNull();
    expect(resolveCycle(on(90))).toBeNull();
    expect(resolveCycle(on("28"))).not.toBeNull();
    expect(resolveCycle(on(28.5))).toBeNull();
    expect(resolveCycle(on(null))).toBeNull();
  });
});

describe("cycleWindowsFor", () => {
  it("keeps the low-energy window directly after the high-energy one, inside the cycle", () => {
    for (let length = CYCLE_LENGTH_RANGE_DAYS.min; length <= CYCLE_LENGTH_RANGE_DAYS.max; length++) {
      const { highEnergyDays, lowEnergyFromDay } = cycleWindowsFor(length);
      expect(lowEnergyFromDay).toBe(highEnergyDays.to + 1);
      expect(highEnergyDays.from).toBeLessThan(highEnergyDays.to);
      expect(lowEnergyFromDay).toBeLessThanOrEqual(length);
    }
  });
});

describe("normalizeBlacklistName", () => {
  // The last catalog-shaped export here, and the one both blacklist matchers
  // build on — `catalog.js`'s whole-name lookup and `planValidation.js`'s
  // looser substring variant. It is pinned directly rather than only through
  // them, because a change to it moves BOTH verdicts at once.
  it("trims, lowercases and strips diacritics", () => {
    expect(normalizeBlacklistName("  Élévations frontales  ")).toBe("elevations frontales");
    expect(normalizeBlacklistName("RUSSIAN TWIST")).toBe("russian twist");
  });

  it("makes the accented and unaccented spellings of a name compare equal", () => {
    // Regression: coordinator review, 2026-07-26 — Finding 2. constraints.md's
    // own table spells it without accents; without this the entry's reason and
    // replacement were lost behind a generic "introuvable" error.
    expect(normalizeBlacklistName("Elevations frontales")).toBe(
      normalizeBlacklistName("Élévations frontales")
    );
  });
});
