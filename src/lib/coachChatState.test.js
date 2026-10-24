import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  canSend, historyAction, errorAfterHistory, errorAfterHistoryFailure, HISTORY_ERROR,
  refreshAfterSend, historyStaleAfterFailure,
} from "./coachChatState.js";

describe("canSend", () => {
  // Regression: 981a499 — two taps in one frame both read busy=false from a stale closure.
  it("refuses an empty message, a busy chat, or no client", () => {
    expect(canSend({ message: "hi", busy: false, client: {} })).toBe(true);
    expect(canSend({ message: "", busy: false, client: {} })).toBe(false);
    expect(canSend({ message: "hi", busy: true, client: {} })).toBe(false);
    expect(canSend({ message: "hi", busy: false, client: null })).toBe(false);
  });
});

// The generation moves when a send starts AND when it ends.
describe("historyAction", () => {
  // Regression: 981a499 — a history GET that landed after she sent a question replaced the
  // transcript and erased the question still in flight.
  it("ignores a GET that resolves while a send is in flight", () => {
    expect(historyAction({ issuedGen: 1, gen: 1, busy: true })).toBe("ignore");
  });

  // Regression: 2e711df — a GET issued before a send that had finished by the time it resolved
  // replaced the transcript, wiping the reply she had just read or shortening a cut reply to the
  // server's checkpoint.
  it("ignores a GET when a send ended while it was out", () => {
    expect(historyAction({ issuedGen: 1, gen: 2, busy: false })).toBe("ignore");
  });

  // Regression: 5d3527b — the merge matched rows by role+content and duplicated or dropped
  // turns, and its « refetch » branch looped with no delay and no bound; neither exists now.
  it("ignores a GET when a send started while it was out, ended or not", () => {
    expect(historyAction({ issuedGen: 0, gen: 1, busy: true })).toBe("ignore");
    expect(historyAction({ issuedGen: 0, gen: 2, busy: false })).toBe("ignore");
  });

  it("applies a GET when no send ran while it was out", () => {
    expect(historyAction({ issuedGen: 2, gen: 2, busy: false })).toBe("apply");
  });

  it("only ever applies or ignores, and applies only when idle and unchanged", () => {
    fc.assert(
      fc.property(fc.nat(), fc.nat(), fc.boolean(), (issuedGen, gen, busy) => {
        const action = historyAction({ issuedGen, gen, busy });
        expect(action).toBe(!busy && gen === issuedGen ? "apply" : "ignore");
      }),
      { numRuns: 1000 },
    );
  });
});

describe("errorAfterHistory", () => {
  // Regression: a4ed5ad — a successful history GET cleared the error unconditionally, erasing
  // the banner a concurrent send had just raised (not sent, cut, plan not generated, correction).
  it("keeps an error a send raised", () => {
    const sendError = "Message non envoyé. Ton texte est revenu dans le champ, réessaie.";
    expect(errorAfterHistory(sendError, "apply")).toBe(sendError);
  });

  it("clears the refresh's own banner, and leaves no error as none", () => {
    expect(errorAfterHistory(HISTORY_ERROR, "apply")).toBeNull();
    expect(errorAfterHistory(null, "apply")).toBeNull();
  });

  // Regression: 6efb51f — an IGNORED result cleared « pas encore synchronisée » though it
  // applied nothing, so the screen claimed to be in sync with a server it had not read.
  it("leaves the error unchanged when the result was ignored", () => {
    expect(errorAfterHistory(HISTORY_ERROR, "ignore")).toBe(HISTORY_ERROR);
    expect(errorAfterHistory(null, "ignore")).toBeNull();
  });
});

describe("errorAfterHistoryFailure", () => {
  // Regression: 5836598 — a failed history refresh set its banner unconditionally, replacing
  // the send, cut-reply, plan or correction error that told her what to do next.
  it("keeps an error a send raised", () => {
    const cut = "Réponse interrompue. Recharge la conversation pour voir ce qui a été enregistré.";
    expect(errorAfterHistoryFailure(cut)).toBe(cut);
  });

  it("raises its own banner when nothing else is showing", () => {
    expect(errorAfterHistoryFailure(null)).toBe(HISTORY_ERROR);
    expect(errorAfterHistoryFailure(HISTORY_ERROR)).toBe(HISTORY_ERROR);
  });
});

describe("refreshAfterSend", () => {
  // Regression: ceb2e3a — an ignored GET was never re-issued, so turns from another device
  // stayed missing for the whole app session once she had sent before the mount GET landed.
  it("refreshes once after a send when the thread is stale", () => {
    expect(refreshAfterSend({ stale: true, cut: false })).toBe(true);
  });

  it("never refreshes after a cut reply, which the server may hold shorter", () => {
    expect(refreshAfterSend({ stale: true, cut: true })).toBe(false);
  });

  it("does nothing when the thread is not stale", () => {
    expect(refreshAfterSend({ stale: false, cut: false })).toBe(false);
  });
});

describe("historyStaleAfterFailure", () => {
  it("is stale when a send's error hid the refresh banner", () => {
    expect(historyStaleAfterFailure("Message non envoyé. Ton texte est revenu dans le champ, réessaie.")).toBe(true);
  });

  it("is not, when the refresh banner itself shows", () => {
    expect(historyStaleAfterFailure(null)).toBe(false);
    expect(historyStaleAfterFailure(HISTORY_ERROR)).toBe(false);
  });
});
