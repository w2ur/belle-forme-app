import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { toAnthropicMessages, EMPTY_TURN_NOTE, WINDOW_START_NOTE } from "../functions/lib/anthropic.js";

const turn = fc.record({ role: fc.constantFrom("user", "assistant"), content: fc.oneof(fc.constant(""), fc.string()) });

describe("toAnthropicMessages (property)", () => {
  it("opens on a user turn, ends where the input ends, and drops nothing", () => {
    fc.assert(
      fc.property(fc.array(turn, { minLength: 1 }), (history) => {
        const { system, turns } = toAnthropicMessages([{ role: "system", content: "S" }, ...history]);
        expect(system).toBe("S");
        expect(turns[0].role).toBe("user");
        expect(turns.at(-1).role).toBe(history.at(-1).role);
        const guarded = history[0].role !== "user";
        if (guarded) expect(turns[0].content).toBe(WINDOW_START_NOTE);
        const kept = guarded ? turns.slice(1) : turns;
        expect(kept).toHaveLength(history.length);
        kept.forEach((t, i) => {
          expect(t.role).toBe(history[i].role);
          expect(t.content).toBe(history[i].content.trim() ? history[i].content : EMPTY_TURN_NOTE);
        });
      })
    );
  });
});
