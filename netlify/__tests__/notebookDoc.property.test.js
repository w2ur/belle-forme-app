import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  applyNotebookOps,
  notebookLines,
  parseNotebookOps,
} from "../functions/lib/notebookDoc.js";

/**
 * The property this module exists for.
 *
 * The wholesale write it replaces had exactly one failure mode, and it was
 * total: whatever the model emitted BECAME the notebook, so a rung-2 reply that
 * wrote three lines destroyed everything older in the same statement. Measured
 * in production on 2026-08-30, and invisible — no error, no log line, nothing in
 * the suite that could see it.
 *
 * Enumerated cases cannot cover that. What has to hold is a statement about
 * EVERY block the model could emit, so it is stated as one: no sequence of
 * operations can lose a stored line except by removing it on purpose.
 */

/** A notebook line: never blank, never a `- 12` that would read as a removal. */
const line = fc
  .string({ minLength: 1, maxLength: 60 })
  .map((s) => s.replace(/[\r\n]/g, " ").trim())
  .filter((s) => s.length > 0 && !/^[-*•+]/.test(s) && !/^\d+$/.test(s));

const notebook = fc.array(line, { maxLength: 12 }).map((ls) => ls.join("\n"));

/** Whatever the model might send back, including nothing and including noise. */
const block = fc.array(
  fc.oneof(
    line.map((l) => `+ ${l}`),
    fc.integer({ min: -3, max: 25 }).map((n) => `- ${n}`),
    line, // unmarked: the model ignoring the format
    fc.constant(""),
  ),
  { maxLength: 8 },
).map((ls) => ls.join("\n"));

describe("applyNotebookOps — invariants", () => {
  it("loses a stored line ONLY to an explicit removal of that line", () => {
    fc.assert(
      fc.property(notebook, block, (previous, emitted) => {
        const before = notebookLines(previous);
        const ops = parseNotebookOps(emitted);
        const { content } = applyNotebookOps(previous, ops);
        const after = notebookLines(content);

        // Every line that was in range of no removal is still there.
        const doomed = new Set(
          ops.removes
            .filter((n) => Number.isInteger(n) && n >= 1 && n <= before.length)
            .map((n) => n - 1),
        );
        const survivors = before.filter((_, i) => !doomed.has(i));
        for (const kept of survivors) expect(after).toContain(kept);
      }),
      { numRuns: 500 },
    );
  });

  it("cannot empty a non-empty notebook without removing every line", () => {
    fc.assert(
      fc.property(notebook, block, (previous, emitted) => {
        const before = notebookLines(previous);
        const ops = parseNotebookOps(emitted);
        const { content } = applyNotebookOps(previous, ops);
        if (before.length === 0) return;
        if (notebookLines(content).length > 0) return;
        // Emptied — then every index must have been named.
        const named = new Set(ops.removes.filter((n) => n >= 1 && n <= before.length));
        expect(named.size).toBe(before.length);
      }),
      { numRuns: 500 },
    );
  });

  it("never throws, whatever the model sends", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (previous, emitted) => {
        expect(() => applyNotebookOps(previous, parseNotebookOps(emitted))).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it("is idempotent: replaying the same block changes nothing the second time", () => {
    fc.assert(
      fc.property(notebook, fc.array(line, { maxLength: 5 }), (previous, adds) => {
        const emitted = adds.map((l) => `+ ${l}`).join("\n");
        const once = applyNotebookOps(previous, parseNotebookOps(emitted)).content;
        const twice = applyNotebookOps(once, parseNotebookOps(emitted)).content;
        expect(notebookLines(twice)).toEqual(notebookLines(once));
      }),
      { numRuns: 300 },
    );
  });
});
