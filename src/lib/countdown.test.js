import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { remainingSeconds, secondsToStart } from "./countdown.js";

// Regression: 0eb518f — countdowns decremented per setInterval tick, so a
// backgrounded iOS tab showed more time left than real.
describe("remainingSeconds", () => {
  it("rounds up to whole seconds", () => {
    expect(remainingSeconds(10_000, 0)).toBe(10);
    expect(remainingSeconds(10_000, 1)).toBe(10);
    expect(remainingSeconds(10_000, 9_001)).toBe(1);
  });

  it("is 0 at and after the end", () => {
    expect(remainingSeconds(5_000, 5_000)).toBe(0);
    expect(remainingSeconds(5_000, 99_000)).toBe(0);
  });

  it("is monotone non-increasing in now, and 0 once now >= endAt", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1e10 }),
        fc.integer({ min: 0, max: 1e10 }),
        fc.integer({ min: 0, max: 1e10 }),
        (endAt, a, b) => {
          const [t1, t2] = a <= b ? [a, b] : [b, a];
          expect(remainingSeconds(endAt, t2)).toBeLessThanOrEqual(remainingSeconds(endAt, t1));
          if (t2 >= endAt) expect(remainingSeconds(endAt, t2)).toBe(0);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

// Regression: 673ea35 — Start after the timer rang used `timeLeft ?? selected`, kept 0 and rang again at once.
describe("secondsToStart", () => {
  it("restarts from the selection when never started", () => {
    expect(secondsToStart(null, 90)).toBe(90);
  });
  it("restarts from the selection once the timer has rung (0)", () => {
    expect(secondsToStart(0, 90)).toBe(90);
  });
  it("resumes the remaining time after a pause", () => {
    expect(secondsToStart(37, 90)).toBe(37);
  });
});
