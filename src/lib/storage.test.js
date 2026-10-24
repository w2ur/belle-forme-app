import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { storage } from "./storage.js";

/**
 * A Map-backed `localStorage`, installed on `globalThis` for the duration of a
 * test. The suite runs on the `node` environment (no jsdom), so there is no
 * `localStorage` unless one is provided — which is itself worth exercising:
 * `storage.js` wraps every access in try/catch precisely so that a runtime
 * without one, or a Safari private window that throws on write, degrades to the
 * fallback instead of taking the app down.
 */
function installStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  return store;
}

describe("the catalog mirror", () => {
  let store;

  beforeEach(() => {
    store = installStorage();
  });

  afterEach(() => {
    delete globalThis.localStorage;
    vi.restoreAllMocks();
  });

  it("returns null when nothing has ever been mirrored", () => {
    expect(storage.loadCatalog()).toBe(null);
  });

  it("round-trips the raw document with the server version it came from", () => {
    const doc = {
      exercises: [{ name: "Squat", group: "Lower Body", implementTypes: ["dumbbell"] }],
      aliases: { "Développé couché": "Développé couché au sol" },
      forbiddenNames: [{ name: "Hip thrust", reason: "Nécessite un banc" }],
    };
    storage.saveCatalog({ doc, updatedAt: "2026-09-30T10:00:00.123Z" });
    expect(storage.loadCatalog()).toEqual({ doc, updatedAt: "2026-09-30T10:00:00.123Z" });
  });

  // The document is stored RAW, not as `buildCatalogViews` output: the views are
  // derived and cheap to rebuild, and the lexique edits the document itself.
  it("stores the document under its own key, verbatim", () => {
    const doc = { exercises: [], aliases: {} };
    storage.saveCatalog({ doc, updatedAt: null });
    expect(JSON.parse(store.get("catalog"))).toEqual({ doc, updatedAt: null });
  });

  // Regression: B6 (2026-09-30 review) — the mirror used to hold the bare
  // document. A device that saved one before the update must still open its
  // catalog offline; with no known version, its first push is refused as
  // stale and replayed onto the server's copy rather than overwriting it.
  it("reads the old bare-document mirror, with no known version", () => {
    const doc = { exercises: [{ name: "Squat" }], aliases: {} };
    store.set("catalog", JSON.stringify(doc));
    expect(storage.loadCatalog()).toEqual({ doc, updatedAt: null });
  });

  it("does not collide with the plan or the sessions", () => {
    storage.saveCatalog({ doc: { exercises: [{ name: "Squat" }] }, updatedAt: null });
    storage.savePlan({ weekStart: "2026-08-11", sessions: [] });
    storage.saveSessions([{ id: "s_1", exercises: [] }]);

    expect(storage.loadCatalog()).toEqual({ doc: { exercises: [{ name: "Squat" }] }, updatedAt: null });
    expect(storage.loadPlan()).toEqual({ weekStart: "2026-08-11", sessions: [] });
    expect(storage.loadSessions([])).toEqual([{ id: "s_1", exercises: [] }]);
  });

  // A mirror that survives corruption matters more here than elsewhere: the
  // catalog gates the lexique, the picker and plan validation, and a throw at
  // mount would take the whole app with it rather than one feature.
  it("falls back to null on unparseable stored JSON", () => {
    store.set("catalog", "{not json");
    expect(storage.loadCatalog()).toBe(null);
  });

  it("falls back to null when localStorage is unavailable entirely", () => {
    delete globalThis.localStorage;
    expect(storage.loadCatalog()).toBe(null);
  });

  it("swallows a write that the browser refuses (quota, private mode)", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    globalThis.localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(() => storage.saveCatalog({ doc: { exercises: [] }, updatedAt: null })).not.toThrow();
    expect(consoleError).toHaveBeenCalled();
  });
});

describe("the sync outbox", () => {
  beforeEach(() => {
    installStorage();
  });

  afterEach(() => {
    delete globalThis.localStorage;
  });

  it("is empty when nothing has ever been queued", () => {
    expect(storage.loadOutbox()).toEqual({ queue: [], parked: [] });
  });

  // The outbox is the only copy of a write made offline: it has to survive the
  // tab being killed, parked entries included.
  it("round-trips queued and parked entries with the seq counter", () => {
    const outbox = {
      queue: [{ key: "session:a", kind: "session", payload: { id: "a" }, attempts: 2, seq: 3, at: "2026-09-30T10:00:00Z" }],
      parked: [{ key: "catalog", kind: "catalog", payload: { ops: [{ op: "deleteExercise", args: ["Squat"] }] }, attempts: 0, seq: 1 }],
      lastSeq: 3,
    };
    storage.saveOutbox(outbox);
    expect(storage.loadOutbox()).toEqual(outbox);
  });

  // readOutbox feeds a read-modify-write shared between tabs, so "no outbox"
  // and "could not read" must be different answers: treating a failed read as
  // empty would let the next write erase every queued entry.
  it("readOutbox tells an absent outbox (null) from an unreadable one (undefined)", () => {
    expect(storage.readOutbox()).toBeNull();
    expect(storage.saveOutbox({ queue: [], parked: [], lastSeq: 1 })).toBe(true);
    expect(storage.readOutbox()).toEqual({ queue: [], parked: [], lastSeq: 1 });
    globalThis.localStorage.getItem = () => { throw new Error("SecurityError"); };
    expect(storage.readOutbox()).toBeUndefined();
  });

  it("saveOutbox reports a failed write", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    globalThis.localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
    expect(storage.saveOutbox({ queue: [], parked: [] })).toBe(false);
    spy.mockRestore();
  });
});
