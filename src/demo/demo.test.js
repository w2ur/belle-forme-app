// @vitest-environment node
/**
 * The demo shares an origin with the owner's real app (/demo/ on the same
 * site), so its whole safety rests on two properties tested here: it reads and
 * writes only its own prefixed keys, and it never reaches the API.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { namespacedStorage, DEMO_PREFIX } from "./storage.js";
import { installDemo, resetDemo, isApiRequest } from "./install.js";
import { storage } from "../lib/storage.js";

/** A Storage over a Map, with the real app's keys already in it. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
}

const REAL = {
  fittrack_sync_key: "real-key",
  sessions: '[{"id":"real"}]',
  profile: '{"name":"Real"}',
  currentPlan: '{"weekStart":"2026-01-05"}',
  catalog: '{"doc":{},"updatedAt":null}',
  outbox: '{"queue":[{"key":"session:real"}],"parked":[]}',
  fittrack_coach_transcript_v2: "[]",
};

/** A window-shaped object whose storages are own, configurable properties, like a browser's. */
function fakeWindow() {
  const win = { location: { href: "https://example.test/demo/" }, fetch: vi.fn(async () => new Response("ok")) };
  const local = fakeStorage(REAL);
  const session = fakeStorage({ fittrack_coach_draft: "real draft" });
  Object.defineProperty(win, "localStorage", { configurable: true, enumerable: true, get: () => local });
  Object.defineProperty(win, "sessionStorage", { configurable: true, enumerable: true, get: () => session });
  return { win, local, session };
}

afterEach(() => { delete globalThis.localStorage; });

describe("namespacedStorage", () => {
  it("prefixes every key, and clear() removes only its own", () => {
    const backing = fakeStorage({ sessions: "real" });
    const ns = namespacedStorage(backing);
    ns.setItem("sessions", "demo");
    expect(backing.getItem("sessions")).toBe("real");
    expect(backing.getItem(`${DEMO_PREFIX}sessions`)).toBe("demo");
    expect(ns.getItem("sessions")).toBe("demo");
    expect(ns.length).toBe(1);
    expect(ns.key(0)).toBe("sessions");
    ns.clear();
    expect([...backing.map.keys()]).toEqual(["sessions"]);
  });

  it("never sees a real key", () => {
    const ns = namespacedStorage(fakeStorage(REAL));
    for (const key of Object.keys(REAL)) expect(ns.getItem(key)).toBeNull();
    expect(ns.length).toBe(0);
  });
});

describe("installDemo", () => {
  it("seeds through the app's own storage layer without touching a real key, and reset leaves them too", () => {
    const { win, local, session } = fakeWindow();
    installDemo(win, new Date(2026, 9, 25, 12));
    // The app's storage module reads the bare `localStorage` global, exactly as in the browser.
    globalThis.localStorage = win.localStorage;
    expect(storage.loadSessions([]).length).toBeGreaterThan(10);
    expect(storage.loadProfile(null).name).toBe("Nora");
    storage.saveSessions([{ id: "demo-edit" }]);
    storage.saveOutbox({ queue: [], parked: [] });
    win.sessionStorage.setItem("fittrack_coach_draft", "demo draft");

    const realKeys = Object.keys(REAL);
    for (const k of realKeys) expect(local.getItem(k), k).toBe(REAL[k]);
    for (const k of local.map.keys()) expect(realKeys.includes(k) || k.startsWith(DEMO_PREFIX), k).toBe(true);
    expect(session.getItem("fittrack_coach_draft")).toBe("real draft");
    // The demo never holds a sync key, so the app stays in local-only mode.
    expect(win.localStorage.getItem("fittrack_sync_key")).toBeNull();

    resetDemo(win, new Date(2026, 9, 25, 12));
    for (const k of realKeys) expect(local.getItem(k), k).toBe(REAL[k]);
    expect(session.getItem("fittrack_coach_draft")).toBe("real draft");
    expect(storage.loadSessions([]).some((s) => s.id === "demo-edit")).toBe(false);
  });

  it("seeds once: a reload keeps the visitor's changes", () => {
    const { win, local } = fakeWindow();
    installDemo(win);
    win.localStorage.setItem("sessions", "[]");
    installDemo(win); // a second install on the same page is a no-op
    // A reload: a fresh window over the same backing storage.
    const reloaded = { location: win.location, fetch: vi.fn() };
    Object.defineProperty(reloaded, "localStorage", { configurable: true, get: () => local });
    Object.defineProperty(reloaded, "sessionStorage", { configurable: true, get: () => fakeStorage() });
    installDemo(reloaded);
    expect(reloaded.localStorage.getItem("sessions") === "[]").toBe(true);
  });

  it("refuses every API request and lets the rest through", async () => {
    const { win } = fakeWindow();
    const realFetch = win.fetch;
    installDemo(win);
    for (const url of ["/api/sync-pull", "/api/login", "https://example.test/api/coach-chat", "/api"]) {
      await expect(win.fetch(url)).rejects.toThrow(/API/);
    }
    await expect(win.fetch(new Request("https://example.test/api/sync-sessions", { method: "POST" }))).rejects.toThrow();
    expect(realFetch).not.toHaveBeenCalled();
    await win.fetch("/demo/assets/app.js");
    expect(realFetch).toHaveBeenCalledTimes(1);
    expect(isApiRequest("/apis/x", "https://example.test/")).toBe(false);
  });
});
