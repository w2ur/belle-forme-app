import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { isLoadValid, roundToAchievable } from "./loadValidation.js";
import seed from "../data/catalogSeed.json";
import { buildCatalogViews } from "./catalogTestkit.js";

const CATALOG = buildCatalogViews(seed);

// Project convention: 1e-6 tolerance, not 1e-10 — too tight at scale.
const EPS = 1e-6;

describe("loadValidation properties", () => {
  it("roundToAchievable never exceeds the input weight and its output is always a valid load", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CATALOG.allExercises),
        fc.constantFrom("per_hand", "total"),
        fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
        (exerciseName, weightType, w) => {
          const result = roundToAchievable(exerciseName, w, weightType, CATALOG);

          expect(result.weightKg).toBeLessThanOrEqual(w + EPS);
          expect(isLoadValid(exerciseName, result.weightKg, weightType, CATALOG)).toBe(true);
        }
      ),
      { numRuns: 1000 }
    );
  });
});
