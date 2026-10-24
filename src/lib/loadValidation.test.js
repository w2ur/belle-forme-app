import { describe, it, expect } from "vitest";
import { isLoadValid, roundToAchievable, checkSessionBarConfigurations } from "./loadValidation.js";
import seed from "../data/catalogSeed.json";
import { buildCatalogViews } from "./catalogTestkit.js";
import { TEST_INVENTORY } from "../constants/testInventory.js";

const CATALOG = buildCatalogViews(seed);

describe("the catalog's ceilings", () => {
  it("hold exactly the confirmed values, verbatim", () => {
    expect(CATALOG.ceilings).toEqual({
      "Pont fessier": { maxKg: 12, unit: "total" },
      "Extension triceps": { maxKg: 12, unit: "total" },
      // Kickback triceps, Turkish get-up and Russian twist joined the table with
      // the implement-union fix: it gave them a loaded bar, which removed the
      // bound the dumbbell maximum used to give them for free.
      "Kickback triceps": { maxKg: 12, unit: "total" },
      "Turkish get-up": { maxKg: 12, unit: "total" },
      "Russian twist": { maxKg: 12, unit: "total" },
      "Donkey kick": { maxKg: 1, unit: "total" },
      "Pont fessier unilatéral": { maxKg: 1, unit: "total" },
      "Squat": { maxKg: 18, unit: "per_hand" },
      "Soulevé de terre roumain": { maxKg: 18, unit: "per_hand" },
      // Added with the catalog extension: these four are
      // SINGLE_HAND_HELD_IMPLEMENTS exercises, so one loaded bar reaches
      // 25 kg. 12 kg restores the bound the dumbbells already gave
      // them, same reasoning as the rows above.
      "Squat gobelet": { maxKg: 12, unit: "total" },
      "Rowing unilatéral": { maxKg: 12, unit: "total" },
      "Pull-over": { maxKg: 12, unit: "total" },
      "Curl concentration": { maxKg: 12, unit: "total" },
    });
  });

  it("keys every ceiling on a real catalog exercise", () => {
    // These six names are the one place an exercise name is legitimately typed
    // by hand outside the catalog (a ceiling is per-exercise data that cannot
    // be derived). A typo or a rename would silently drop the ceiling — this
    // guard is what makes that impossible.
    for (const name of Object.keys(CATALOG.ceilings)) {
      expect(CATALOG.allExercises, `${name} should be a catalog exercise`).toContain(name);
    }
  });
});

describe("the catalog is a required argument", () => {
  it("throws rather than silently falling back", () => {
    expect(() => isLoadValid("Squat", 12, "per_hand")).toThrow(/catalog/i);
    expect(() => roundToAchievable("Squat", 12, "per_hand")).toThrow(/catalog/i);
    expect(() => checkSessionBarConfigurations([])).toThrow(/catalog/i);
  });

  it("throws BEFORE the input is inspected, so a bad weight cannot mask the missing catalog", () => {
    // `isLoadValid`/`roundToAchievable` answer NaN and unknown names without
    // ever reaching a catalog lookup. If the guard ran late, exactly those
    // paths would keep working without a catalog and the omission would
    // surface only once a real weight was validated — in production.
    expect(() => isLoadValid("Exercice inexistant", NaN, "total")).toThrow(/catalog/i);
    expect(() => roundToAchievable("Exercice inexistant", -5, "total")).toThrow(/catalog/i);
  });
});

describe("isLoadValid — 0 is always valid", () => {
  it.each([
    "Pont fessier",
    "Squat",
    "Pompes",
    "Elliptique",
    "Tirage vertical élastique",
    "Donkey kick",
  ])("0 kg is valid for %s", (exerciseName) => {
    expect(isLoadValid(exerciseName, 0, "total", CATALOG)).toBe(true);
    expect(isLoadValid(exerciseName, 0, "per_hand", CATALOG)).toBe(true);
  });
});

describe("isLoadValid — unknown exercise / invalid weight, no throwing", () => {
  it("rejects an unknown exercise name, including at 0 kg", () => {
    expect(isLoadValid("Exercice inexistant", 5, "total", CATALOG)).toBe(false);
    expect(isLoadValid("Exercice inexistant", 0, "total", CATALOG)).toBe(false);
  });

  it("rejects a negative weight", () => {
    expect(isLoadValid("Squat", -1, "per_hand", CATALOG)).toBe(false);
  });

  it("rejects NaN", () => {
    expect(isLoadValid("Squat", NaN, "per_hand", CATALOG)).toBe(false);
  });
});

describe("isLoadValid — implement types", () => {
  it("a hand-held exercise accepts both its dumbbell values and its bar-only values", () => {
    // Updated 2026-07-26: this test used to assert 3 and 6 kg/main were INVALID
    // for `Développé couché au sol` "because there is no 3 or 6 kg dumbbell" — the
    // single-implement assumption this whole fix removes. Both are achievable
    // with a loaded bar in each hand, so both are valid; a value on neither
    // implement still is not.
    expect(isLoadValid("Développé couché au sol", 12, "per_hand", CATALOG)).toBe(true); // dumbbell
    expect(isLoadValid("Développé couché au sol", 5, "per_hand", CATALOG)).toBe(true); // bar only
    expect(isLoadValid("Développé couché au sol", 11, "per_hand", CATALOG)).toBe(true); // bar only
    expect(isLoadValid("Développé couché au sol", 8, "per_hand", CATALOG)).toBe(false); // neither
    expect(isLoadValid("Développé couché au sol", 5.5, "per_hand", CATALOG)).toBe(false); // neither
  });

  it("dual_bar_symmetric: 5 and 11 are valid (from the bar), unlike a dumbbell-only exercise", () => {
    expect(isLoadValid("Squat", 5, "per_hand", CATALOG)).toBe(true);
    expect(isLoadValid("Squat", 11, "per_hand", CATALOG)).toBe(true);
    expect(isLoadValid("Pont fessier", 5, "total", CATALOG)).toBe(false);
    expect(isLoadValid("Pont fessier", 11, "total", CATALOG)).toBe(false);
  });

  it("dual_bar_symmetric: 8 and 10 are on neither the dumbbells nor the bars and are invalid", () => {
    expect(isLoadValid("Squat", 8, "per_hand", CATALOG)).toBe(false);
    expect(isLoadValid("Squat", 10, "per_hand", CATALOG)).toBe(false);
  });

  it("single_bar_heavy: a valid integer member passes, a half-kilo value fails (strict pairing)", () => {
    expect(isLoadValid("Squat sumo", 13, "total", CATALOG)).toBe(true);
    expect(isLoadValid("Squat sumo", 13.5, "total", CATALOG)).toBe(false);
  });

  it("ankle_weight: only 0 or 1 is valid", () => {
    expect(isLoadValid("Donkey kick", 1, "total", CATALOG)).toBe(true);
    expect(isLoadValid("Donkey kick", 2, "total", CATALOG)).toBe(false);
    expect(isLoadValid("Donkey kick", 4, "total", CATALOG)).toBe(false);
  });

  it("cardio: any loaded weight is rejected, only 0 is valid", () => {
    expect(isLoadValid("Elliptique", 0, "total", CATALOG)).toBe(true);
    expect(isLoadValid("Elliptique", 5, "total", CATALOG)).toBe(false);
  });

  it("elastic: any loaded weight is rejected, only 0 is valid", () => {
    expect(isLoadValid("Tirage vertical élastique", 0, "total", CATALOG)).toBe(true);
    expect(isLoadValid("Tirage vertical élastique", 5, "total", CATALOG)).toBe(false);
  });

  it("bodyweight: any loaded weight is rejected, only 0 is valid", () => {
    expect(isLoadValid("Pompes", 0, "total", CATALOG)).toBe(true);
    expect(isLoadValid("Pompes", 5, "total", CATALOG)).toBe(false);
  });
});

describe("isLoadValid — an exercise is not locked to one implement (the four production false rejections)", () => {
  // Regression: 3851ab9 — validation checked the prescribed weight against the
  // ONE implement the catalog tagged the exercise with, but which
  // implement carries the load is not a property of the exercise: most
  // hand-held movements take either the adjustable dumbbells or the two
  // loadable bars. On the first real use the layer rejected four loads the user can
  // genuinely lift and `roundToAchievable` silently cut them down — 12 kg/hand
  // to 9 kg on both main lower-body lifts, a 25% reduction presented as
  // a correction.
  it.each([
    ["Rowing haltères", 11, "per_hand", "a loaded bar in each hand"],
    ["Curl biceps", 5, "per_hand", "a loaded bar in each hand"],
    ["Squat", 12, "per_hand", "the 12 kg dumbbells"],
    ["Soulevé de terre roumain", 15, "per_hand", "the dumbbells"],
  ])("%s at %skg%s is valid (%s)", (name, weight, weightType) => {
    expect(isLoadValid(name, weight, weightType, CATALOG)).toBe(true);
  });

  it.each([
    ["Rowing haltères", 11, "per_hand"],
    ["Curl biceps", 5, "per_hand"],
    ["Squat", 12, "per_hand"],
    ["Soulevé de terre roumain", 15, "per_hand"],
  ])("%s at %skg is never rounded down", (name, weight, weightType) => {
    const result = roundToAchievable(name, weight, weightType, CATALOG);
    expect(result.weightKg).toBe(weight);
    expect(result.changed).toBe(false);
    expect(result.warning).toBeNull();
  });
});

describe("isLoadValid — widening the implement set never widens a ceiling", () => {
  it("Pont fessier stays dumbbell-only: the bar-only values are still rejected", () => {
    // Only a dumbbell balances on the hips (a loaded bar does not), so 5 and 11 kg,
    // which exist on the bar only, must stay invalid here — the one exercise the
    // single-implement model got right.
    expect(isLoadValid("Pont fessier", 5, "total", CATALOG)).toBe(false);
    expect(isLoadValid("Pont fessier", 11, "total", CATALOG)).toBe(false);
  });

  it("Pont fessier is still valid at its 12 kg ceiling and invalid above it", () => {
    expect(isLoadValid("Pont fessier", 12, "total", CATALOG)).toBe(true);
    expect(isLoadValid("Pont fessier", 15, "total", CATALOG)).toBe(false);
  });

  it("Squat at 19kg/main is still rejected, even though its implement set grew", () => {
    expect(isLoadValid("Squat", 19, "per_hand", CATALOG)).toBe(false);
  });

  it("INVARIANT: no exercise that gained a single loaded bar lost the bound its dumbbell set gave it", () => {
    // Generalizes what the review caught one exercise at a time (Kickback
    // triceps, Turkish get-up, then Russian twist): adding `single_bar_heavy`
    // to a dumbbell exercise lifts its reachable maximum from the dumbbell max
    // to the single bar's maximum. Widening an implement set must only ADD
    // options, never REMOVE a bound — so every exercise that got that widening
    // needs a ceiling at or below the dumbbell maximum. Enforced here rather
    // than remembered, so the
    // next widening cannot repeat the omission.
    const dumbbellMax = Math.max(...CATALOG.inventory.achievable.dumbbell);
    // Squat sumo is the one legitimate exemption: it was `single_bar_heavy`
    // BEFORE this change too, so gaining the dumbbells widened nothing.
    const NOT_WIDENED = ["Squat sumo"];

    const widened = Object.entries(CATALOG.descriptions).filter(
      ([name, entry]) =>
        !NOT_WIDENED.includes(name) &&
        entry.implementTypes.includes("dumbbell") &&
        entry.implementTypes.includes("single_bar_heavy")
    );
    expect(widened.length, "the invariant should still have exercises to guard").toBeGreaterThan(0);

    for (const [name] of widened) {
      const ceiling = CATALOG.ceilings[name];
      expect(ceiling, `${name} gained a loaded bar and needs a ceiling`).toBeDefined();
      expect(ceiling.unit, `${name} is a single implement, so its ceiling is a total`).toBe("total");
      expect(ceiling.maxKg, `${name} ceiling must not exceed the dumbbell maximum`).toBeLessThanOrEqual(
        dumbbellMax
      );
    }
  });

  it("Extension triceps is still capped at 12 kg total, single loaded bar or not", () => {
    expect(isLoadValid("Extension triceps", 12, "total", CATALOG)).toBe(true);
    expect(isLoadValid("Extension triceps", 13, "total", CATALOG)).toBe(false);
  });

  it.each(["Kickback triceps", "Turkish get-up", "Russian twist"])(
    "%s keeps the 12 kg bound, without losing the bar-only values",
    (name) => {
      // Regression: 8395c78 — widening these single hand-held exercises to
      // "dumbbell OR one loaded bar" removed their implicit cap (the
      // dumbbell maximum) and let a heavy one-arm kickback validate. The bound
      // belongs in the catalog's per-exercise ceiling, not in a narrower implement set: 5 and
      // 7 kg must stay valid, since rejecting those is the bug that fix removed.
      expect(isLoadValid(name, 12, "total", CATALOG)).toBe(true);
      expect(isLoadValid(name, 13, "total", CATALOG)).toBe(false);
      expect(isLoadValid(name, 17, "total", CATALOG)).toBe(false);
      expect(isLoadValid(name, 5, "total", CATALOG)).toBe(true);
      expect(isLoadValid(name, 7, "total", CATALOG)).toBe(true);
    }
  );

  it.each(["Kickback triceps", "Turkish get-up", "Russian twist"])(
    "%s clamps an over-ceiling weight down to 12 kg and reports it as at-ceiling",
    (name) => {
      const result = roundToAchievable(name, 20, "total", CATALOG);
      expect(result.weightKg).toBe(12);
      expect(result.changed).toBe(true);
      expect(result.warning).toMatch(/[Pp]lafond/);
      expect(result.atCeiling).toBe(true);
    }
  );

  it("bodyweight, elastic and cardio still accept only 0", () => {
    for (const name of ["Pompes", "Tirage vertical élastique", "Elliptique"]) {
      expect(isLoadValid(name, 0, "total", CATALOG), `${name} at 0`).toBe(true);
      for (const weight of [2, 2.5, 3, 5, 12]) {
        expect(isLoadValid(name, weight, "total", CATALOG), `${name} at ${weight}`).toBe(false);
      }
    }
  });

  it("ankle-weight exercises are unchanged: 0 or the ankle weight, nothing else", () => {
    for (const name of ["Donkey kick", "Fire hydrant", "Pont fessier unilatéral"]) {
      expect(isLoadValid(name, 0, "total", CATALOG), `${name} at 0`).toBe(true);
      expect(isLoadValid(name, 1, "total", CATALOG), `${name} at 1`).toBe(true);
      expect(isLoadValid(name, 2, "total", CATALOG), `${name} at 2`).toBe(false);
      expect(isLoadValid(name, 1.5, "total", CATALOG), `${name} at 1.5`).toBe(false);
    }
  });
});

describe("isLoadValid — per_hand vs total distinction", () => {
  it("Squat at 19kg/main fails (per-hand ceiling of 18)", () => {
    expect(isLoadValid("Squat", 19, "per_hand", CATALOG)).toBe(false);
  });

  it("Squat at 18kg/main passes (exactly at the ceiling)", () => {
    expect(isLoadValid("Squat", 18, "per_hand", CATALOG)).toBe(true);
  });

  it("Pont fessier at 15kg total fails (total ceiling of 12)", () => {
    expect(isLoadValid("Pont fessier", 15, "total", CATALOG)).toBe(false);
  });

  it("Pont fessier at 12kg total passes (exactly at the ceiling)", () => {
    expect(isLoadValid("Pont fessier", 12, "total", CATALOG)).toBe(true);
  });
});

describe("isLoadValid — the six ceilings", () => {
  it("Pont fessier: 12 total passes, 12.5 total fails", () => {
    expect(isLoadValid("Pont fessier", 12, "total", CATALOG)).toBe(true);
    expect(isLoadValid("Pont fessier", 12.5, "total", CATALOG)).toBe(false);
  });

  it("Extension triceps: 12 total passes, 12.5 total fails", () => {
    expect(isLoadValid("Extension triceps", 12, "total", CATALOG)).toBe(true);
    expect(isLoadValid("Extension triceps", 12.5, "total", CATALOG)).toBe(false);
  });

  it("Donkey kick: 1 total passes, above 1 fails", () => {
    expect(isLoadValid("Donkey kick", 1, "total", CATALOG)).toBe(true);
    expect(isLoadValid("Donkey kick", 1.5, "total", CATALOG)).toBe(false);
  });

  it("Pont fessier unilatéral: 1 total passes, above 1 fails", () => {
    expect(isLoadValid("Pont fessier unilatéral", 1, "total", CATALOG)).toBe(true);
    expect(isLoadValid("Pont fessier unilatéral", 1.5, "total", CATALOG)).toBe(false);
  });

  it("Squat: 18 per_hand passes, 19 per_hand fails", () => {
    expect(isLoadValid("Squat", 18, "per_hand", CATALOG)).toBe(true);
    expect(isLoadValid("Squat", 19, "per_hand", CATALOG)).toBe(false);
  });

  it("Soulevé de terre roumain: 18 per_hand passes, 19 per_hand fails", () => {
    expect(isLoadValid("Soulevé de terre roumain", 18, "per_hand", CATALOG)).toBe(true);
    expect(isLoadValid("Soulevé de terre roumain", 19, "per_hand", CATALOG)).toBe(false);
  });
});

describe("roundToAchievable — never rounds up, never throws", () => {
  it("0 kg stays 0 kg, unchanged, no warning", () => {
    expect(roundToAchievable("Squat", 0, "per_hand", CATALOG)).toEqual({
      weightKg: 0,
      changed: false,
      warning: null,
      atCeiling: false,
    });
  });

  it("an already-achievable weight is returned unchanged", () => {
    expect(roundToAchievable("Développé couché au sol", 12, "per_hand", CATALOG)).toEqual({
      weightKg: 12,
      changed: false,
      warning: null,
      atCeiling: false,
    });
  });

  it("9.5kg/main on a dual-bar exercise rounds down to 9", () => {
    const result = roundToAchievable("Squat", 9.5, "per_hand", CATALOG);
    expect(result.weightKg).toBe(9);
    expect(result.changed).toBe(true);
    expect(result.warning).toMatch(/matériel disponible/);
  });

  it("2kg on a dual-bar exercise (below its 3kg minimum) rounds down to 0", () => {
    const result = roundToAchievable("Squat", 2, "per_hand", CATALOG);
    expect(result.weightKg).toBe(0);
    expect(result.changed).toBe(true);
    expect(result.warning).toMatch(/matériel disponible/);
  });

  it("clamps to the ceiling before snapping, and the clamped value is itself achievable", () => {
    const result = roundToAchievable("Pont fessier", 15, "total", CATALOG);
    expect(result.weightKg).toBe(12);
    expect(result.changed).toBe(true);
    expect(result.warning).toMatch(/[Pp]lafond/);
    expect(result.atCeiling).toBe(true);
    expect(isLoadValid("Pont fessier", result.weightKg, "total", CATALOG)).toBe(true);
  });

  it("a Squat above the per-hand ceiling clamps down to 18", () => {
    const result = roundToAchievable("Squat", 25, "per_hand", CATALOG);
    expect(result.weightKg).toBe(18);
    expect(result.changed).toBe(true);
    expect(result.warning).toMatch(/[Pp]lafond/);
    expect(result.atCeiling).toBe(true);
  });

  it("warns and treats the number as total load when /main is used on a non-bilateral exercise", () => {
    const result = roundToAchievable("Pont fessier", 9, "per_hand", CATALOG);
    expect(result.weightKg).toBe(9);
    expect(result.changed).toBe(false);
    expect(result.warning).toMatch(/\/main/);
  });

  it("unknown exercise name returns the error shape without throwing", () => {
    expect(roundToAchievable("Exercice inexistant", 5, "total", CATALOG)).toEqual({
      weightKg: 0,
      changed: true,
      warning: expect.stringContaining("inconnu"),
      atCeiling: false,
    });
  });

  it("negative weight returns the error shape without throwing", () => {
    const result = roundToAchievable("Squat", -5, "per_hand", CATALOG);
    expect(result.weightKg).toBe(0);
    expect(result.changed).toBe(true);
    expect(result.warning).toEqual(expect.any(String));
  });

  it("NaN weight returns the error shape without throwing", () => {
    const result = roundToAchievable("Squat", NaN, "per_hand", CATALOG);
    expect(result.weightKg).toBe(0);
    expect(result.changed).toBe(true);
    expect(result.warning).toEqual(expect.any(String));
  });
});

describe("roundToAchievable — the six ceilings clamp correctly (structured tempo/reps/unilateral field)", () => {
  it("Pont fessier: 15 total clamps down to 12 (at ceiling)", () => {
    const result = roundToAchievable("Pont fessier", 15, "total", CATALOG);
    expect(result.weightKg).toBe(12);
    expect(result.changed).toBe(true);
    expect(result.atCeiling).toBe(true);
  });

  it("Extension triceps: 15 total clamps down to 12 (at ceiling)", () => {
    const result = roundToAchievable("Extension triceps", 15, "total", CATALOG);
    expect(result.weightKg).toBe(12);
    expect(result.changed).toBe(true);
    expect(result.atCeiling).toBe(true);
  });

  it("Donkey kick: 4 total clamps down to 1 (at ceiling)", () => {
    const result = roundToAchievable("Donkey kick", 4, "total", CATALOG);
    expect(result.weightKg).toBe(1);
    expect(result.changed).toBe(true);
    expect(result.atCeiling).toBe(true);
  });

  it("Pont fessier unilatéral: 4 total clamps down to 1 (at ceiling)", () => {
    const result = roundToAchievable("Pont fessier unilatéral", 4, "total", CATALOG);
    expect(result.weightKg).toBe(1);
    expect(result.changed).toBe(true);
    expect(result.atCeiling).toBe(true);
  });

  it("Squat: 25 per_hand clamps down to 18 (at ceiling)", () => {
    const result = roundToAchievable("Squat", 25, "per_hand", CATALOG);
    expect(result.weightKg).toBe(18);
    expect(result.changed).toBe(true);
    expect(result.atCeiling).toBe(true);
  });

  it("Soulevé de terre roumain: 25 per_hand clamps down to 18 (at ceiling)", () => {
    const result = roundToAchievable("Soulevé de terre roumain", 25, "per_hand", CATALOG);
    expect(result.weightKg).toBe(18);
    expect(result.changed).toBe(true);
    expect(result.atCeiling).toBe(true);
  });
});

describe("roundToAchievable — atCeiling field", () => {
  it("is true when the input was already exactly at the ceiling (no clamp needed)", () => {
    const result = roundToAchievable("Squat", 18, "per_hand", CATALOG);
    expect(result.changed).toBe(false);
    expect(result.atCeiling).toBe(true);
  });

  it("is true when the input got clamped down to the ceiling", () => {
    const result = roundToAchievable("Pont fessier", 20, "total", CATALOG);
    expect(result.changed).toBe(true);
    expect(result.weightKg).toBe(12);
    expect(result.atCeiling).toBe(true);
  });

  it("is false when the exercise has no ceiling entry, even at its implement's own max", () => {
    // Développé couché is a dumbbell exercise with no ceiling in the catalog;
    // 18kg/main is the dumbbell implement's own max, not a declared ceiling.
    const result = roundToAchievable("Développé couché au sol", 18, "per_hand", CATALOG);
    expect(result.weightKg).toBe(18);
    expect(result.atCeiling).toBe(false);
  });

  it("is false when the exercise has a ceiling but the result sits below it", () => {
    const result = roundToAchievable("Squat", 5, "per_hand", CATALOG);
    expect(result.weightKg).toBe(5);
    expect(result.atCeiling).toBe(false);
  });
});

describe("checkSessionBarConfigurations", () => {
  it("flags a session needing two distinct dual-bar configurations (Squat 5/main + RDL 11/main)", () => {
    const result = checkSessionBarConfigurations([
      { name: "Squat", weight: 5, weightType: "per_hand" },
      { name: "Soulevé de terre roumain", weight: 11, weightType: "per_hand" },
    ], CATALOG);
    expect(result.count).toBe(2);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/Squat/);
    expect(result.warnings[0]).toMatch(/Soulevé de terre roumain/);
    expect(result.warnings[0]).toMatch(/5/);
    expect(result.warnings[0]).toMatch(/11/);
  });

  it("does not flag a session whose bar-capable lines are all dumbbell-achievable (Squat 6/main + RDL 12/main)", () => {
    // Regression: 3de0e22 — "this line uses a bar" was inferred from the
    // exercise's implement type, so every Squat/RDL line counted as a plating
    // even at 6 or 12 kg/main, which are dumbbell values. A line needs plates
    // only when its load is NOT achievable with the dumbbells.
    const result = checkSessionBarConfigurations([
      { name: "Squat", weight: 6, weightType: "per_hand" },
      { name: "Soulevé de terre roumain", weight: 12, weightType: "per_hand" },
    ], CATALOG);
    expect(result.count).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it("flags a dumbbell-named exercise whose load only exists on the bar (Rowing haltères 11/main + Curl biceps 5/main)", () => {
    // The mirror image: the implement type said "dumbbell", but 11 and 5 kg/main
    // exist only on the bars, so this session really does need two platings.
    const result = checkSessionBarConfigurations([
      { name: "Rowing haltères", weight: 11, weightType: "per_hand" },
      { name: "Curl biceps", weight: 5, weightType: "per_hand" },
    ], CATALOG);
    expect(result.count).toBe(2);
    expect(result.warnings).toHaveLength(1);
  });

  it("does not flag a session that only varies dumbbell loads", () => {
    const result = checkSessionBarConfigurations([
      { name: "Développé couché au sol", weight: 9, weightType: "per_hand" },
      { name: "Curl biceps", weight: 6, weightType: "per_hand" },
      { name: "Pont fessier", weight: 12, weightType: "total" },
    ], CATALOG);
    expect(result.count).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it("does not flag two bar-based lines at the same configuration", () => {
    const result = checkSessionBarConfigurations([
      { name: "Squat", weight: 5, weightType: "per_hand" },
      { name: "Soulevé de terre roumain", weight: 5, weightType: "per_hand" },
    ], CATALOG);
    expect(result.count).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  it("does not flag a bar line at the empty-bar weight, or at 0", () => {
    const atEmptyBar = checkSessionBarConfigurations([
      { name: "Squat", weight: 3, weightType: "per_hand" },
    ], CATALOG);
    expect(atEmptyBar.count).toBe(0);
    expect(atEmptyBar.warnings).toEqual([]);

    const atZero = checkSessionBarConfigurations([
      { name: "Squat", weight: 0, weightType: "per_hand" },
    ], CATALOG);
    expect(atZero.count).toBe(0);
    expect(atZero.warnings).toEqual([]);
  });

  it("flags a session mixing a dual_bar_symmetric line and a single_bar_heavy line at plated loads", () => {
    const result = checkSessionBarConfigurations([
      { name: "Squat", weight: 5, weightType: "per_hand" },
      { name: "Squat sumo", weight: 5, weightType: "total" },
    ], CATALOG);
    expect(result.count).toBe(2);
    expect(result.warnings).toHaveLength(1);
  });

  it("produces no warning and a count of 0 for a session with no bar-based exercises", () => {
    const result = checkSessionBarConfigurations([
      { name: "Pompes", weight: 0, weightType: "total" },
      { name: "Tirage vertical élastique", weight: 0, weightType: "total" },
    ], CATALOG);
    expect(result.count).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it("does not throw on an empty session, missing input, or malformed lines", () => {
    expect(() => checkSessionBarConfigurations([], CATALOG)).not.toThrow();
    expect(checkSessionBarConfigurations([], CATALOG)).toEqual({ count: 0, configurations: [], warnings: [] });

    expect(() => checkSessionBarConfigurations(null, CATALOG)).not.toThrow();
    expect(checkSessionBarConfigurations(null, CATALOG)).toEqual({ count: 0, configurations: [], warnings: [] });

    expect(() => checkSessionBarConfigurations(undefined, CATALOG)).not.toThrow();

    const malformed = checkSessionBarConfigurations([
      null,
      {},
      { name: "Squat" },
      { name: "Squat", weight: NaN, weightType: "per_hand" },
      { name: "Squat", weight: -5, weightType: "per_hand" },
      { name: "Exercice inexistant", weight: 12, weightType: "per_hand" },
    ], CATALOG);
    expect(malformed.count).toBe(0);
    expect(malformed.warnings).toEqual([]);
  });
});

describe("ceilings on the new single-hand-held exercises", () => {
  const CAPPED = ["Squat gobelet", "Rowing unilatéral", "Pull-over", "Curl concentration"];

  it.each(CAPPED)("%s is capped at 12 kg total", (name) => {
    expect(CATALOG.ceilings[name]).toEqual({ maxKg: 12, unit: "total" });
  });

  // CONTROL: without the ceiling these reach single_bar_heavy's 25 kg maximum.
  // This asserts the bound actually bites rather than that a table row exists —
  // 17 kg IS in the achievable union for a SINGLE_HAND_HELD exercise, so the
  // only thing that can reject it is the ceiling.
  // `isLoadValid` returns a BOOLEAN, not a result object.
  it.each(CAPPED)("%s rejects 17 kg, which its implement set can physically produce", (name) => {
    expect(CATALOG.inventory.achievable.single_bar_heavy).toContain(17);
    expect(isLoadValid(name, 17, "total", CATALOG)).toBe(false);
    expect(isLoadValid(name, 12, "total", CATALOG)).toBe(true);
  });
});

// The loads are a function of the inventory the catalog was built with: nothing
// in this file may depend on a constant number of kilos baked into the code.
describe("loads follow the catalog's inventory", () => {
  const withInventory = (inventory) => buildCatalogViews(seed, { ...TEST_INVENTORY, ...inventory });

  it("accepts the ankle weight the user owns and refuses the one they do not (Fire hydrant, no ceiling)", () => {
    const heavier = withInventory({ ankleWeightKg: 3 });
    expect(isLoadValid("Fire hydrant", 3, "total", heavier)).toBe(true);
    expect(isLoadValid("Fire hydrant", 1, "total", heavier)).toBe(false);
    expect(isLoadValid("Fire hydrant", 1, "total", CATALOG)).toBe(true);
  });

  it("rounds a dumbbell exercise to the dumbbells the user owns", () => {
    const rack = withInventory({ dumbbellOptionsKg: [3, 6, 9], barCount: 0 });
    expect(isLoadValid("Développé couché au sol", 6, "per_hand", rack)).toBe(true);
    expect(isLoadValid("Développé couché au sol", 5.5, "per_hand", rack)).toBe(false);
    expect(roundToAchievable("Développé couché au sol", 7, "per_hand", rack).weightKg).toBe(6);
  });

  it("offers no load beyond the bodyweight when the user owns neither dumbbells nor bars", () => {
    const bare = withInventory({ dumbbellOptionsKg: [], barCount: 0 });
    expect(isLoadValid("Développé couché au sol", 4, "per_hand", bare)).toBe(false);
    expect(isLoadValid("Développé couché au sol", 0, "per_hand", bare)).toBe(true);
  });

  // Regression: an empty bar (no plates mounted) is not a plate manipulation, and
  // its weight is the inventory's — not a constant. With a 3 kg bar, 3 kg/main is
  // the empty bar and 13 kg/main is the only plated load.
  it("treats the inventory's own empty-bar weight as not needing plates", () => {
    const heavyBar = withInventory({ dumbbellOptionsKg: [], barEmptyKg: 3, plateStock: [{ weightKg: 5, count: 4 }] });
    const result = checkSessionBarConfigurations([
      { name: "Squat", weight: 3, weightType: "per_hand" },
      { name: "Soulevé de terre roumain", weight: 13, weightType: "per_hand" },
    ], heavyBar);
    expect(result.count).toBe(1);
    expect(result.configurations[0].perImplementKg).toBe(13);
  });
});
