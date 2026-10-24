/**
 * `loadProfile` is what lets the coach know the inventory its loads are checked
 * against. It is mocked in `coach-chat.test.js`, which asserts the handler's
 * reaction to a throw and to an absent row, so without this file the loader
 * itself is executed by nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadProfile } from "../functions/lib/profileDb.js";
import { TEST_PROFILE } from "./testProfile.js";

const mockSql = vi.fn();

describe("loadProfile", () => {
  beforeEach(() => mockSql.mockReset());

  // A fresh database has no row until the first profile save. That is a state,
  // not a failure: the coach answers in neutral words with the starter inventory.
  // Dated at the epoch so the prompt cache has a stable key for "no profile yet".
  it("returns null data, dated at the epoch, when there is no row", async () => {
    mockSql.mockResolvedValueOnce([]);
    const out = await loadProfile(mockSql);
    expect(out.data).toBeNull();
    expect(new Date(out.updatedAt).getTime()).toBe(0);
  });

  it("returns the document and its timestamp, untouched, when the row is good", async () => {
    const updated = new Date("2026-10-01T08:10:54.805Z");
    mockSql.mockResolvedValueOnce([{ data: TEST_PROFILE, updated_at: updated }]);
    const out = await loadProfile(mockSql);
    expect(out.data).toBe(TEST_PROFILE);
    expect(out.updatedAt).toBe(updated);
  });

  it("reads a row whose data column is null as no profile, but keeps its timestamp", async () => {
    const updated = new Date("2026-10-01T08:10:54.805Z");
    mockSql.mockResolvedValueOnce([{ data: null, updated_at: updated }]);
    const out = await loadProfile(mockSql);
    expect(out.data).toBeNull();
    expect(out.updatedAt).toBe(updated);
  });

  // Unlike an absent row, a failed query must reach the caller: swallowing it
  // would answer with the starter inventory over a real one.
  it("lets a failed query throw", async () => {
    mockSql.mockRejectedValueOnce(new Error("neon down"));
    await expect(loadProfile(mockSql)).rejects.toThrow("neon down");
  });
});
