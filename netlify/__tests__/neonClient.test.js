import { describe, it, expect, afterEach, vi } from "vitest";
import { neonConfig } from "@neondatabase/serverless";
import { neonSql, applyNeonEndpoint } from "../functions/lib/neonClient.js";

// Self-hosting 2026-10-25: NEON_HTTP_ENDPOINT points the HTTP driver at a
// Neon-compatible proxy in front of plain Postgres; unset must stay exactly
// today's behaviour. Both paths are proved on the URL the driver actually
// fetches, not on the config object alone.
const HOST = "ep-test-123.example.test";
const DB_URL = ["postgresql://", "user:pw", "@", HOST, "/db"].join("");

async function fetchedUrl(read) {
  const fetchSpy = vi.fn(async () => { throw new Error("stop"); });
  vi.stubGlobal("fetch", fetchSpy);
  const sql = neonSql(DB_URL, read);
  await expect(sql`SELECT 1`).rejects.toThrow();
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  return String(fetchSpy.mock.calls[0][0]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  neonConfig.fetchEndpoint = undefined; // back to the driver default
});

describe("neonSql", () => {
  it("unset: the driver fetches Neon's own endpoint, derived from the URL's host", async () => {
    // The driver's default maps an `ep-…` host to `api.<rest of the host>`.
    expect(await fetchedUrl(() => undefined)).toBe("https://api.example.test/sql");
  });

  it("set: the driver fetches NEON_HTTP_ENDPOINT instead", async () => {
    const read = (name) => (name === "NEON_HTTP_ENDPOINT" ? "http://neon-proxy:4444/sql" : undefined);
    expect(await fetchedUrl(read)).toBe("http://neon-proxy:4444/sql");
  });

  it("a blank value counts as unset", () => {
    const config = {};
    applyNeonEndpoint(() => "   ", config);
    expect(config).toEqual({});
  });
});
