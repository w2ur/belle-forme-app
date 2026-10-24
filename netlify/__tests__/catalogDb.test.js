/**
 * `loadCatalog` is the load-bearing half of the outage ruling: it is what turns
 * a missing catalog into a loud failure instead of a coach inventing movements
 * The user cannot do. It is mocked in `coach-chat.test.js` — which asserts the
 * handler's reaction to a throw, not that anything actually throws — so without
 * this file the guard itself is executed by nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadCatalog } from "../functions/lib/catalogDb.js";

/** A tagged-template `sql` client, the shape `getDb()` returns. */
const mockSql = vi.fn();

const DOC = { version: 1, exercises: [{ name: "Squat", group: "Lower Body" }] };

describe("loadCatalog", () => {
  beforeEach(() => mockSql.mockReset());

  // No row at all. `rows[0]?.data` is undefined, and the optional chaining is
  // what stops this being a TypeError instead of the intended error.
  it("refuses to answer when the row is missing", async () => {
    mockSql.mockResolvedValueOnce([]);
    await expect(loadCatalog(mockSql)).rejects.toThrow(/catalog is empty or missing/);
  });

  // The dangerous shape, because it fails no query: a document with no
  // exercises reads to every consumer as a deliberate empty catalog rather than
  // as a broken read.
  it("treats a document with no exercises as no catalog", async () => {
    mockSql.mockResolvedValueOnce([{ data: { version: 1, exercises: [] }, updated_at: "2026-08-14T08:10:54.805Z" }]);
    await expect(loadCatalog(mockSql)).rejects.toThrow(/refusing to answer without an exercise list/);
  });

  it("returns the document and its timestamp when the row is good", async () => {
    const updated = new Date("2026-08-14T08:10:54.805Z");
    mockSql.mockResolvedValueOnce([{ data: DOC, updated_at: updated }]);

    const { doc, updatedAt } = await loadCatalog(mockSql);
    expect(doc).toBe(DOC);
    // Passed through untouched, milliseconds included: this value is the
    // prompt cache's key, and anything that coarsens it makes a warm isolate
    // serve stale prompts (see catalogVersionKey in coach-chat.js).
    expect(updatedAt).toBe(updated);
    // The read is pinned to the single-row table, not to "whatever comes first".
    const queryText = mockSql.mock.calls[0][0].join("?");
    expect(queryText).toContain("FROM catalog");
    expect(queryText).toContain("id = 1");
    expect(queryText).toContain("updated_at");
  });
});
