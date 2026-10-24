import { describe, it, expect } from "vitest";
import { stepValue } from "./setInput.js";

describe("stepValue", () => {
  it("steps a plain number", () => {
    expect(stepValue("12", 1)).toBe("13");
    expect(stepValue("12", -1)).toBe("11");
  });

  it("steps weights by halves", () => {
    expect(stepValue("11", 0.5)).toBe("11.5");
    expect(stepValue("11.5", -0.5)).toBe("11");
  });

  it("keeps a duration's unit instead of turning it into NaN", () => {
    // A plank is planned as "45s"; Number("45s") is NaN, and tapping + used to
    // write the string "NaN" straight into the recorded set.
    expect(stepValue("45s", 1)).toBe("46s");
    expect(stepValue("45s", -1)).toBe("44s");
  });

  it("treats an empty field as zero", () => {
    expect(stepValue("", 1)).toBe("1");
    expect(stepValue(undefined, 1)).toBe("1");
    expect(stepValue(null, 0.5)).toBe("0.5");
  });

  it("never goes below the floor", () => {
    expect(stepValue("0", -1)).toBe("0");
    expect(stepValue("0.5", -1)).toBe("0");
  });

  it("never produces NaN, whatever is in the field", () => {
    for (const junk of ["abc", "--", " ", "kg", "12kg/main"]) {
      expect(stepValue(junk, 1)).not.toContain("NaN");
    }
  });

  it("rounds a stepped half to the nearest achievable half", () => {
    expect(stepValue("11.25", 0.5)).toBe("12");
  });
});

/**
 * Two shapes the old regex silently mangled. Both are real: `"30 s"` is what a
 * session recorded before the unit moved out of the value looks like, and
 * `"30-40min"` is the cardio prescription the coach emitted in production on
 * 16/08/2026.
 */
describe("values the stepper must not rewrite", () => {
  it("keeps the spacing the value was written with", () => {
    // Was "31s" — a value she never typed, appearing in her own record.
    expect(stepValue("30 s", 1)).toBe("31 s");
    expect(stepValue("30s", 1)).toBe("31s");
  });

  it.each([["10-12"], ["30-40min"], ["8 à 10"]])("leaves the range %s untouched", (range) => {
    // Was "1": the leading digits matched and everything after was discarded.
    expect(stepValue(range, 1)).toBe(range);
    expect(stepValue(range, -1)).toBe(range);
  });

  it("still steps an ordinary number and an ordinary unit", () => {
    expect(stepValue("10", 1)).toBe("11");
    expect(stepValue("45s", 5)).toBe("50s");
    expect(stepValue("12.5", 0.5)).toBe("13");
  });
});
