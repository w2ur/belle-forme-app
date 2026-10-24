/**
 * The system prompts used to be three module-level constants, built once per
 * isolate. That is the CPU budget the coach's whole edge-function architecture
 * rests on (50 ms per request), and a catalog that lives in Neon cannot be read
 * at module scope. The cache is how the property survives the move.
 */
import { describe, it, expect, vi } from "vitest";
import { buildPromptCache } from "../edge-functions/coach-chat.js";

describe("the prompt cache", () => {
  it("builds once for an unchanged catalog and rebuilds when it changes", () => {
    const build = vi.fn((doc) => ({ discussion: `d${doc.version}`, plan: "p", planEmit: "e" }));
    const cache = buildPromptCache(build);

    const a = cache.get({ version: 1 }, "2026-08-11T10:00:00Z");
    const b = cache.get({ version: 1 }, "2026-08-11T10:00:00Z");
    expect(build).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);

    cache.get({ version: 2 }, "2026-08-11T11:00:00Z");
    expect(build).toHaveBeenCalledTimes(2);
  });

  // Neon hands back a Date for a timestamptz column, and two Dates for the same
  // instant are never `===`. Keying on the value itself would rebuild every
  // prompt on every request — the exact cost this exists to avoid, and silently.
  it("keys on the timestamp's value, not on object identity", () => {
    const build = vi.fn(() => ({ discussion: "d", plan: "p", planEmit: "e" }));
    const cache = buildPromptCache(build);

    cache.get({ version: 1 }, new Date("2026-08-11T10:00:00Z"));
    cache.get({ version: 1 }, new Date("2026-08-11T10:00:00Z"));
    expect(build).toHaveBeenCalledTimes(1);
  });

  // The other half of the same problem, and the one that costs correctness
  // rather than CPU. `String(date)` renders to the SECOND, so two writes inside
  // the same second share a key and a warm isolate serves the older prompts
  // for as long as it lives — while reading the newer document.
  it("distinguishes two writes inside the same second", () => {
    const build = vi.fn((doc) => ({ discussion: `d${doc.version}`, plan: "p", planEmit: "e" }));
    const cache = buildPromptCache(build);

    const first = cache.get({ version: 1 }, new Date("2026-08-14T08:10:54.005Z"));
    const second = cache.get({ version: 2 }, new Date("2026-08-14T08:10:54.805Z"));

    expect(build).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    expect(second.discussion).toBe("d2");
  });

  // `schema.sql` gives `updated_at` a DEFAULT NOW() and — until this round — no
  // ON UPDATE trigger, so an editor that forgets the clause can leave the column
  // null or frozen. Undatable means uncacheable: rebuild rather than serve a
  // version we cannot identify, and never throw. `new Date(undefined)
  // .toISOString()` raises a RangeError, which would take down the one request
  // path that has to stay debuggable.
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an unparseable value", "not-a-timestamp"],
  ])("rebuilds rather than throwing when updated_at is %s", (_label, updatedAt) => {
    const build = vi.fn(() => ({ discussion: "d", plan: "p", planEmit: "e" }));
    const cache = buildPromptCache(build);

    expect(() => {
      cache.get({ version: 1 }, updatedAt);
      cache.get({ version: 1 }, updatedAt);
    }).not.toThrow();
    expect(build).toHaveBeenCalledTimes(2);
  });

  // The profile is the second document the prompts are built from (persona,
  // inventory, cycle switch, notes). A key that only watched the catalog would
  // keep serving the old persona and the old loads after a profile edit —
  // silently, since nothing errors.
  describe("keyed on the catalog AND the profile", () => {
    const build = () => vi.fn(({ profile }) => ({ discussion: `d-${profile.name}`, plan: "p", planEmit: "e" }));
    const CATALOG_AT = "2026-08-11T10:00:00Z";

    it("rebuilds when only the profile changed", () => {
      const fn = build();
      const cache = buildPromptCache(fn);
      cache.get({ profile: { name: "A" } }, [CATALOG_AT, "2026-10-01T09:00:00Z"]);
      const after = cache.get({ profile: { name: "B" } }, [CATALOG_AT, "2026-10-01T09:00:01Z"]);
      expect(fn).toHaveBeenCalledTimes(2);
      expect(after.discussion).toBe("d-B");
    });

    it("builds once when neither changed, whatever the objects' identity", () => {
      const fn = build();
      const cache = buildPromptCache(fn);
      cache.get({ profile: { name: "A" } }, [new Date(CATALOG_AT), new Date("2026-10-01T09:00:00Z")]);
      cache.get({ profile: { name: "A" } }, [new Date(CATALOG_AT), new Date("2026-10-01T09:00:00Z")]);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("rebuilds when only the catalog changed", () => {
      const fn = build();
      const cache = buildPromptCache(fn);
      cache.get({ profile: { name: "A" } }, [CATALOG_AT, "2026-10-01T09:00:00Z"]);
      cache.get({ profile: { name: "A" } }, ["2026-08-11T11:00:00Z", "2026-10-01T09:00:00Z"]);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    // One undatable part makes the whole key undatable: serving a prompt built
    // from a document version we cannot identify is the bug the key prevents.
    it.each([
      ["a null profile timestamp", [CATALOG_AT, null]],
      ["an unparseable profile timestamp", [CATALOG_AT, "nope"]],
      ["a null catalog timestamp", [null, "2026-10-01T09:00:00Z"]],
    ])("rebuilds rather than throwing on %s", (_label, versions) => {
      const fn = build();
      const cache = buildPromptCache(fn);
      expect(() => {
        cache.get({ profile: { name: "A" } }, versions);
        cache.get({ profile: { name: "A" } }, versions);
      }).not.toThrow();
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });
});
