import { describe, it, expect } from "vitest";
import { loadDraft, saveDraft, draftToKeep, DRAFT_KEY } from "./coachDraft.js";

function memoryStore() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

describe("coach draft", () => {
  // Regression: 9139b31 — a 401 on send cleared her typed question from the
  // composer and sent the app to the gate, which unmounted the hook holding it:
  // the question was gone once she had typed the password.
  it("a send refused with 401 keeps her question for the remount", () => {
    const store = memoryStore();
    saveDraft(draftToKeep({ draft: "", message: "Mes genoux ?", consumesDraft: true }), store);
    expect(loadDraft(store)).toBe("Mes genoux ?");
  });

  it("keeps what she typed since over the question it sent", () => {
    expect(draftToKeep({ draft: "autre chose", message: "Q", consumesDraft: true })).toBe("autre chose");
  });

  it("never puts an app-composed request in the composer", () => {
    expect(draftToKeep({ draft: "", message: "Prépare-moi mon programme", consumesDraft: false })).toBe("");
    expect(draftToKeep({ draft: "à moitié", message: "correction", consumesDraft: false })).toBe("à moitié");
  });

  it("an empty draft clears the stored one", () => {
    const store = memoryStore();
    saveDraft("x", store);
    saveDraft("", store);
    expect(store.getItem(DRAFT_KEY)).toBeNull();
    expect(loadDraft(store)).toBe("");
  });

  it("a store that throws loses the draft quietly", () => {
    const broken = { getItem: () => { throw new Error("locked"); }, setItem: () => { throw new Error("quota"); }, removeItem: () => {} };
    expect(() => saveDraft("x", broken)).not.toThrow();
    expect(loadDraft(broken)).toBe("");
    expect(loadDraft(undefined)).toBe("");
  });
});
