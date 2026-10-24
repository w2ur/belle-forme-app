import { describe, it, expect } from "vitest";
import { coachWaitMessage, COACH_WAIT_STAGES, PLAN_WAIT_TEXT } from "./coachWait.js";

// The user waits 17-28 s before the first character, in front of a single line that
// never changes ("Je regarde tes données…"). A static placeholder held that long
// reads as a hung app rather than a busy one — she described the whole
// experience as "connexion instable".
//
// This lives in lib/ rather than inside CoachConversation for the reason the
// repo already applies to plan-import decisions: UI components are not tested
// here, so any logic that has to keep being right is kept out of them.
describe("coachWaitMessage", () => {
  it("greets the wait immediately, with no blank moment", () => {
    expect(coachWaitMessage(0)).toBeTruthy();
    expect(typeof coachWaitMessage(0)).toBe("string");
  });

  it("has moved on by the time the model is still thinking", () => {
    // The Gemini-era floor for a reply. Mistral is far faster (0.84-6.9 s to
    // headers), so this now asserts the weaker claim that the line has moved at
    // all by 15 s — which is the claim worth keeping either way.
    expect(coachWaitMessage(15000)).not.toBe(coachWaitMessage(0));
  });

  it("acknowledges a wait that has run long", () => {
    // The measured ceiling: one prod run never got model headers within 30 s.
    expect(coachWaitMessage(30000)).not.toBe(coachWaitMessage(15000));
  });

  // A placeholder that flickered backwards would look like a retry loop.
  it("never goes backwards as the wait grows", () => {
    let seen = coachWaitMessage(0);
    const order = [seen];
    for (let ms = 0; ms <= 60000; ms += 250) {
      const now = coachWaitMessage(ms);
      if (now !== seen) {
        expect(order).not.toContain(now); // never returns to an earlier stage
        order.push(now);
        seen = now;
      }
    }
    expect(order.length).toBeGreaterThan(1);
  });

  it("always has something to say, however long it takes", () => {
    for (const ms of [0, 1, 5000, 20000, 60000, 600000]) {
      expect(coachWaitMessage(ms).trim()).not.toBe("");
    }
  });

  // Guards against a negative elapsed time from a clock adjustment mid-wait.
  it("treats a nonsense elapsed time as the beginning of the wait", () => {
    expect(coachWaitMessage(-5000)).toBe(coachWaitMessage(0));
    expect(coachWaitMessage(undefined)).toBe(coachWaitMessage(0));
    expect(coachWaitMessage(NaN)).toBe(coachWaitMessage(0));
  });

  // The copy must not claim knowledge the client does not have. Nothing here
  // comes from the server — it is a timer — so it may describe the wait, never
  // report progress ("bientôt fini", a percentage, a countdown).
  // Regression: 2faf0f6 — the plan-emit wait showed the staged
  // discussion copy (PLAN_STREAMING_NOTE could never show: the emit path is
  // buffered, so `streaming` stays "").
  it("uses the programme line from the first tick in plan-emit mode, with no progress", () => {
    for (const ms of [0, 5000, 30000, 600000]) {
      const text = coachWaitMessage(ms, "plan-emit");
      expect(text).toBe(PLAN_WAIT_TEXT);
      expect(text).not.toMatch(/%|\d+\s*(s|sec|seconde|minute)/i);
      expect(text).not.toMatch(/presque|bientôt|plus que/i);
    }
    expect(coachWaitMessage(0, "discussion")).toBe(coachWaitMessage(0));
  });

  it("describes the wait without promising an arrival", () => {
    for (const stage of COACH_WAIT_STAGES) {
      expect(stage.text).not.toMatch(/%|\d+\s*(s|sec|seconde|minute)/i);
      expect(stage.text).not.toMatch(/presque|bientôt|plus que/i);
    }
  });
});
