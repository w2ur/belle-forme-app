import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { annotateHistory, looksLikeTruncatedPlanFragment } from "../functions/lib/historyView.js";
import { isPlanPayload, planFromJson } from "../../src/lib/planFromJson.js";

const rowArb = fc.record({
  role: fc.constantFrom("user", "assistant"),
  content: fc.string({ minLength: 1, maxLength: 200 }),
  created_at: fc
    .integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2026, 11, 31) })
    .map((ms) => new Date(ms).toISOString()),
});

describe("annotateHistory — properties", () => {
  // The regression that raising HISTORY_WINDOW from 15 to 40 was fixing: the
  // coach losing the thread because turns went missing. Annotation must never
  // drop, reorder or re-role a turn.
  it("preserves count, order and every role", () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 40 }), (rows) => {
        const out = annotateHistory(rows);
        expect(out).toHaveLength(rows.length);
        rows.forEach((row, i) => expect(out[i].role).toBe(row.role));
      }),
      { numRuns: 1000 }
    );
  });

  // Widened by the plan-collapse feature: an assistant turn that IS a stored
  // plan payload, or the fragment of one truncated mid-stream, is deliberately
  // replaced by a marker (see `collapsePlan` in historyView.js) — that is the
  // whole point of Task 5. Every other turn — every user turn, and any
  // assistant turn that isn't plan-shaped — must still keep its original text
  // untouched (beyond the session-break prefix), which is what this property
  // continues to pin.
  it("never loses the original text of a turn, except a deliberately collapsed plan payload or fragment", () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 40 }), (rows) => {
        const out = annotateHistory(rows);
        rows.forEach((row, i) => {
          const isCollapsed =
            row.role === "assistant" &&
            (isPlanPayload(row.content) || looksLikeTruncatedPlanFragment(row.content));
          if (isCollapsed) return; // covered by the dedicated collapse property below
          expect(out[i].content).toContain(row.content);
        });
      }),
      { numRuns: 1000 }
    );
  });

  it("does not mutate the rows it was given", () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 40 }), (rows) => {
        const snapshot = JSON.parse(JSON.stringify(rows));
        annotateHistory(rows);
        expect(rows).toEqual(snapshot);
      }),
      { numRuns: 1000 }
    );
  });
});

// `rowArb` above generates fc.string() content, which will essentially never
// parse as plan-shaped JSON — so it gives zero coverage of the collapse. This
// block targets it directly: arbitrary session counts (including 0),
// arbitrary weekStart values (including null and non-dates), and arbitrary
// truncations of a valid payload (the exact shape a plan-emit reply cut
// mid-stream produces).
const sessionArb = fc.record({
  name: fc.string({ maxLength: 20 }),
  warmup: fc.constant([]),
  exercises: fc.constant([]),
  cooldown: fc.constant([]),
});

// null and non-date strings/numbers/booleans on purpose — `planFromJson`
// degrades a malformed weekStart to null rather than throwing, and the
// collapse marker must survive that without crashing or fabricating a date.
const weekStartArb = fc.oneof(
  fc.constant(null),
  fc.string({ maxLength: 20 }),
  fc.integer(),
  fc.boolean()
);

const planObjArb = fc.record({
  weekStart: weekStartArb,
  weekEnd: weekStartArb,
  coachNotes: fc.constant(""),
  notebook: fc.constant(""),
  sessions: fc.array(sessionArb, { maxLength: 8 }), // includes the empty (0-session) case
});

const TRUNCATION_NOTE_TEXT = "\n\n_(Réponse coupée avant la fin — demande-moi la suite.)_";

describe("annotateHistory — plan payload collapse properties", () => {
  // Covers: never throws, never emits a misleading session count, and
  // count/order/role stay preserved, over arbitrary plan shapes AND arbitrary
  // truncations of them (cut at any point, with or without the note
  // coach-chat.js appends to a checkpointed reply).
  it("collapses arbitrary plan payloads and truncations without throwing or inventing a count", () => {
    fc.assert(
      fc.property(
        planObjArb,
        fc.nat({ max: 2000 }),
        fc.boolean(),
        (planObj, cutRaw, appendNote) => {
          const full = JSON.stringify(planObj);
          const cut = Math.min(cutRaw, full.length);
          const truncated = full.slice(0, cut);
          const content = appendNote ? truncated + TRUNCATION_NOTE_TEXT : truncated;

          const rows = [
            { role: "user", content: "mon programme ?", created_at: "2026-08-11T09:00:00Z" },
            { role: "assistant", content, created_at: "2026-08-11T09:00:10Z" },
          ];

          const out = annotateHistory(rows);

          // Count, order and role preserved — the non-negotiable invariant.
          expect(out).toHaveLength(2);
          expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);

          // The stamp `annotateHistory` prepends is not what this property is
          // about — both roles carry one since 2026-08-24 — so it is removed
          // before comparing. Its own guards live in historyView.test.js.
          const collapsed = out[1].content.replace(/^(?:\[[^\n]*\]\n)+/, "");

          if (isPlanPayload(content)) {
            // Well-formed (including a genuine 0-session plan): the marker's
            // count must match what planFromJson actually built, never a
            // guess, and the raw payload must never leak.
            const { plan } = planFromJson(content);
            const count = plan?.sessions?.length ?? 0;
            expect(collapsed).toContain(`${count} séance`);
            expect(collapsed).not.toContain("weekStart");
          } else if (content.trimStart().startsWith("{")) {
            let parses = true;
            try {
              JSON.parse(content);
            } catch {
              parses = false;
            }
            if (!parses) {
              // A genuine fragment: collapsed to the fixed marker, no digits —
              // there is no reply left to count sessions from.
              expect(collapsed).toBe("[programme émis, réponse coupée]");
              expect(collapsed).not.toMatch(/\d/);
            } else {
              // Starts with "{" but parsed as valid non-plan JSON (e.g. "{}"):
              // isPlanPayload already said no, and the fragment heuristic must
              // not second-guess a payload that parsed fine.
              expect(collapsed).toBe(content);
            }
          } else {
            // Does not even start with "{" — never touched by either path.
            expect(collapsed).toBe(content);
          }
        }
      ),
      { numRuns: 1000 }
    );
  });
});
