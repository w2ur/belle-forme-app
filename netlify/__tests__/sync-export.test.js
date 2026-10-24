import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const mockSql = vi.fn();
vi.mock("../functions/lib/db.js", () => ({
  getDb: () => mockSql,
  authorize: (event) => {
    const token = (event.headers.authorization || "").replace("Bearer ", "");
    if (token !== "test-key") {
      return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
    }
    return null;
  },
  err: (msg, status = 500) => ({ statusCode: status, body: JSON.stringify({ error: msg }) }),
}));

const { handler } = await import("../functions/sync-export.js");

const event = { httpMethod: "GET", headers: { authorization: "Bearer test-key" } };

// The mock answers by table name, so the test does not depend on query order.
//
// The values are shaped the way the Neon driver hands them back, not as the
// strings a test would find convenient: every timestamptz is a JS Date, and a
// bare DATE is a Date at LOCAL midnight (postgres-date's `new Date(y, m, d)`).
// String fixtures are why the dump shipped writing "Thu Oct 01 2026 …" literals
// that no restore could read.
const localDate = (y, m, d) => new Date(y, m - 1, d);
const ROWS = {
  sessions: [{
    id: "s_1", date: localDate(2026, 9, 30), name: "Haut du corps",
    data: { exercises: [{ name: "Squat", sets: [{ reps: 10, weight: 11 }] }] },
    created_at: new Date("2026-09-30T08:00:00.123Z"), updated_at: new Date("2026-10-01T05:55:26.456Z"),
  }],
  plans: [{
    id: 7, week_start: localDate(2026, 9, 28), week_end: localDate(2026, 10, 4),
    data: { sessions: [] }, raw: null,
    created_at: new Date("2026-09-28T07:00:00Z"), updated_at: new Date("2026-09-28T07:00:00Z"),
  }],
  profile: [{ id: 1, data: { name: "Test" }, updated_at: new Date("2026-09-01T09:00:00Z") }],
  settings: [{ id: 1, data: { defaultTimer: 90 }, updated_at: new Date("2026-09-01T09:00:00Z") }],
  catalog: [{ id: 1, data: { exercises: [{ name: "L'exo" }] }, updated_at: new Date("2026-09-01T10:00:00Z") }],
  coach_notebook: [{ id: 1, content: "Note d'Alix", updated_at: new Date("2026-09-02T10:00:00Z") }],
  coach_messages: [
    { id: 1, role: "user", content: "Salut", created_at: new Date("2026-09-03T10:00:00Z") },
    { id: 2, role: "assistant", content: "C'est parti", created_at: new Date("2026-09-03T10:00:05Z") },
  ],
};

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockImplementation(async (strings) => {
    const text = strings.join(" ");
    const table = Object.keys(ROWS).find((t) => new RegExp(`FROM ${t}\\b`).test(text));
    return table ? ROWS[table] : [];
  });
});

describe("sync-export", () => {
  it("rejects unauthorized requests", async () => {
    const res = await handler({ httpMethod: "GET", headers: {} });
    expect(res.statusCode).toBe(401);
  });

  // Regression: B5 (2026-09-30 review) — the backup dumped four tables and missed
  // catalog, coach_notebook and coach_messages; the catalog cannot be regenerated.
  it("truncates and restores every table", async () => {
    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(
      "TRUNCATE sessions, plans, profile, settings, catalog, coach_notebook, coach_messages;"
    );
    expect(res.body).toContain("INSERT INTO catalog (id, data, updated_at) VALUES (1, '{\"exercises\":[{\"name\":\"L''exo\"}]}'::jsonb");
    expect(res.body).toContain("INSERT INTO coach_notebook (id, content, updated_at) VALUES (1, 'Note d''Alix'");
    const msgs = res.body.match(/INSERT INTO coach_messages \(role, content, created_at\)/g);
    expect(msgs).toHaveLength(2);
    expect(res.body).toContain("VALUES ('assistant', 'C''est parti', '2026-09-03T10:00:05.000Z')");
  });

  // Regression: 4702fbe — the dump restored catalog.updated_at with its old value. The
  // trigger only fires on UPDATE, so the restored row kept that stamp, and a
  // device whose mirror was newer ignored the restored catalog on every pull.
  it("restores the catalog with a fresh updated_at, never the dumped one", async () => {
    const res = await handler(event);
    const line = res.body.split("\n").find((l) => l.startsWith("INSERT INTO catalog "));
    expect(line).toMatch(/::jsonb, NOW\(\)\);$/);
    expect(line).not.toContain("2026-09-01T10:00:00");
  });

  it("emits one catalog INSERT per row", async () => {
    ROWS.catalog.push({ id: 2, data: {}, updated_at: "2026-09-01T11:00:00Z" });
    try {
      const res = await handler(event);
      expect(res.body.match(/INSERT INTO catalog /g)).toHaveLength(2);
    } finally {
      ROWS.catalog.pop();
    }
  });

  // Regression: c747701 — the dump wrote String(date) for every timestamptz the
  // driver returns as a Date, "Thu Oct 01 2026 05:55:26 GMT+0000 (…)", which
  // Postgres refuses: the whole BEGIN…COMMIT aborted, so the emergency backup
  // could restore nothing. Executed for real, against schema.sql, because only
  // Postgres knows which literals it accepts.
  // PGlite boots a whole Postgres in WASM: ~1 s alone, several under a full
  // parallel run, which the default 5 s timeout does not cover.
  it("produces a dump that restores into the real schema", { timeout: 30000 }, async () => {
    const res = await handler(event);
    const db = new PGlite();
    try {
      await db.exec(readFileSync(new URL("../functions/lib/schema.sql", import.meta.url), "utf8"));
      await db.exec(res.body);

      const one = async (q) => (await db.query(q)).rows[0];
      expect(await one("SELECT id, date::text AS date, name, data, updated_at = '2026-10-01T05:55:26.456Z' AS stamp FROM sessions"))
        .toEqual({ id: "s_1", date: "2026-09-30", name: "Haut du corps", data: ROWS.sessions[0].data, stamp: true });
      expect(await one("SELECT id, week_start::text AS ws, week_end::text AS we FROM plans"))
        .toEqual({ id: 7, ws: "2026-09-28", we: "2026-10-04" });
      expect(await one("SELECT data FROM profile")).toEqual({ data: { name: "Test" } });
      expect(await one("SELECT data FROM settings")).toEqual({ data: { defaultTimer: 90 } });
      expect(await one("SELECT data FROM catalog")).toEqual({ data: { exercises: [{ name: "L'exo" }] } });
      expect(await one("SELECT content FROM coach_notebook")).toEqual({ content: "Note d'Alix" });
      const msgs = (await db.query("SELECT role, content, created_at = '2026-09-03T10:00:05Z' AS stamp FROM coach_messages ORDER BY id")).rows;
      expect(msgs).toEqual([
        { role: "user", content: "Salut", stamp: false },
        { role: "assistant", content: "C'est parti", stamp: true },
      ]);
    } finally {
      await db.close();
    }
  });

  it("writes a DATE as the calendar day the driver parsed, in any time zone", async () => {
    const { sqlDate } = await import("../functions/sync-export.js");
    expect(sqlDate(localDate(2026, 1, 5))).toBe("'2026-01-05'");
    expect(sqlDate("2026-01-05")).toBe("'2026-01-05'");
    expect(sqlDate(null)).toBe("NULL");
  });
});
