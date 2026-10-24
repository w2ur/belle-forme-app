import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { buildMessages, alignHistoryWindow } from "../functions/lib/coachPrompt.js";

/**
 * buildMessages is pure, so the invariant it exists to hold is worth proving over
 * arbitrary transcripts rather than over the four shapes someone thought to list.
 *
 * The invariant: THE LIST ALWAYS ENDS ON A USER TURN. Mistral rejects anything
 * else with HTTP 400 ("Expected last role User or Tool") — verified by live call
 * on 2026-08-03 — so a transcript shape nobody enumerated does not degrade the
 * answer, it removes the coach entirely until someone reads a function log.
 *
 * The transcript is not sanitised anywhere upstream: coach_messages is whatever
 * survived a run, and runs get killed mid-reply. Runs of consecutive user turns
 * and transcripts ending either way are all ordinary states, which is precisely
 * why the enumerated-cases test is not enough on its own.
 */
const turn = fc.record({
  role: fc.constantFrom("user", "assistant"),
  content: fc.string({ minLength: 1, maxLength: 40 }),
});

describe("buildMessages — properties over arbitrary transcripts", () => {
  it("always ends on a user turn carrying her message, for any role sequence", () => {
    fc.assert(
      fc.property(
        fc.array(turn, { maxLength: 30 }),
        fc.string({ minLength: 1, maxLength: 40 }),
        (history, userMessage) => {
          const msgs = buildMessages({
            systemPrompt: "SYS",
            notebook: "NB",
            exportContext: "EXP",
            history,
            userMessage,
          });

          // The cacheable prefix is byte-identical whatever follows it.
          expect(msgs[0]).toEqual({ role: "system", content: "SYS" });

          const last = msgs[msgs.length - 1];
          expect(last.role).toBe("user");
          expect(last.content).toContain(userMessage);
          expect(last.content).toContain("EXP");

          // No turn is dropped and none is reordered — the regression that
          // raising HISTORY_WINDOW from 15 to 40 was fixing. The history occupies
          // exactly the slots after the system message.
          expect(msgs.slice(1, 1 + history.length).map((m) => m.role)).toEqual(
            history.map((t) => t.role)
          );
          // Always exactly one appended turn, whatever the transcript ended on.
          // This used to be `+ (history.at(-1)?.role === "user" ? 1 : 2)`, which
          // encoded the merge branch: when the transcript ended on an unanswered
          // question, her new message was folded INTO that old turn and the model
          // answered both. Appending unconditionally is the fix.
          expect(msgs.length).toBe(history.length + 2);
        }
      ),
      { numRuns: 1000 }
    );
  });

  // buildMessages reads and rewrites the last turn's content. Doing that on the
  // caller's array would corrupt the transcript loaded from Neon, and the damage
  // would only show up as the notebook and export being echoed back into a later
  // prompt — a leak that reads as a model quirk rather than as aliasing.
  it("never mutates the history it was given", () => {
    fc.assert(
      fc.property(fc.array(turn, { maxLength: 20 }), (history) => {
        const before = JSON.stringify(history);
        buildMessages({
          systemPrompt: "SYS",
          notebook: "NB",
          exportContext: "EXP",
          history,
          userMessage: "U1",
        });
        expect(JSON.stringify(history)).toBe(before);
      }),
      { numRuns: 1000 }
    );
  });
});

/**
 * alignHistoryWindow over every transcript length, in the PRODUCTION load shape:
 * the loader returns the last `window + block - 1` rows plus the table's total,
 * never an ever-growing list. A version computing the drop from rows.length is
 * indistinguishable from the right one on a growing list and slides by one row
 * per turn on the real one — which is the whole cache miss this exists to stop.
 */
describe("alignHistoryWindow — properties in the production load shape", () => {
  const W = 40, B = 10, LIMIT = W + B - 1;
  const table = (t) =>
    Array.from({ length: t }, (_, i) => ({ id: i + 1, role: i % 2 ? "assistant" : "user", content: `m${i + 1}` }));
  const kept = (t) => alignHistoryWindow(table(t).slice(-LIMIT), { window: W, block: B, total: t });

  it("keeps a suffix of the table whose length is in [min(t, window), window + block - 1]", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2000 }), (t) => {
        const out = kept(t);
        expect(out.length).toBeGreaterThanOrEqual(Math.min(t, W));
        expect(out.length).toBeLessThanOrEqual(LIMIT);
        expect(out.map((r) => r.id)).toEqual(table(t).slice(-out.length).map((r) => r.id));
      }),
      { numRuns: 1000 }
    );
  });

  it("the first kept row moves only when the table crosses a block boundary", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2000 }), (t) => {
        const a = kept(t), b = kept(t + 1);
        const boundary = t + 1 > W && (t + 1 - W) % B === 0;
        if (!a.length) return;
        if (boundary) expect(b[0].id).not.toBe(a[0].id);
        else expect(b[0].id).toBe(a[0].id);
      }),
      { numRuns: 1000 }
    );
  });
});
