/**
 * The profile write is executed against Postgres (PGlite): "keeps the keys the
 * push omits" is a property of the SQL, and a mocked `sql` passes with either.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const database = { sql: null };
vi.mock("../functions/lib/db.js", () => ({
  getDb: () => database.sql,
  authorize: () => null,
  ok: (data) => ({ statusCode: 200, body: JSON.stringify(data) }),
  err: (msg, status = 500) => ({ statusCode: status, body: JSON.stringify({ error: msg }) }),
}));

const { handler } = await import("../functions/sync-profile.js");
const SCHEMA = readFileSync(new URL("../functions/lib/schema.sql", import.meta.url), "utf8");

/** A neon-style tagged-template client over PGlite. */
function sqlOver(db) {
  return async (strings, ...values) => {
    const text = strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ""), "");
    return (await db.query(text, values)).rows;
  };
}

const INVENTORY = {
  dumbbellOptionsKg: [3, 6], barEmptyKg: 2, barCount: 1, plateStock: [{ weightKg: 2.5, count: 2 }], ankleWeightKg: 1, owned: ["dumbbell"],
};
const SERVER_KEYS = { gender: "f", cycle: { enabled: true, lengthDays: 28 }, inventory: INVENTORY, coachNotes: "synthetic note" };

describe("sync-profile keeps what a push does not mention", () => {
  let db;
  const push = (profile) => handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ profile }) });
  const stored = async () => (await db.query("SELECT data FROM profile WHERE id = 1")).rows[0].data;

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(SCHEMA);
    database.sql = sqlOver(db);
    await db.query("INSERT INTO profile (id, data) VALUES (1, $1::jsonb)", [JSON.stringify({ name: "Camille", age: 30, ...SERVER_KEYS })]);
  });

  // Regression: a client bundle that predates the server-acted fields pushes a profile
  // without them (every settings change pushes the whole local profile), and the write
  // used to replace the row, erasing the inventory, the cycle and the coach notes.
  it("an old client's push keeps the patched keys", async () => {
    const res = await push({ name: "Camille", age: 31 });
    expect(res.statusCode).toBe(200);
    expect(await stored()).toEqual({ name: "Camille", age: 31, ...SERVER_KEYS });
  });

  it("a key the push carries still wins, so an edit lands", async () => {
    await push({ name: "Camille", coachNotes: "edited", cycle: { enabled: false, lengthDays: 28 } });
    const data = await stored();
    expect(data.coachNotes).toBe("edited");
    expect(data.cycle).toEqual({ enabled: false, lengthDays: 28 });
    expect(data.inventory).toEqual(INVENTORY);
  });

  it("an explicit null clears a key (omitting it does not)", async () => {
    await push({ name: "Camille", coachNotes: null });
    expect((await stored()).coachNotes).toBeNull();
  });

  it("keeps a field this build has never heard of", async () => {
    await db.query("UPDATE profile SET data = data || $1::jsonb WHERE id = 1", [JSON.stringify({ futureField: { a: 1 } })]);
    await push({ name: "Camille" });
    expect((await stored()).futureField).toEqual({ a: 1 });
  });

  it("creates the row on the first push", async () => {
    await db.query("DELETE FROM profile");
    await push({ name: "Camille" });
    expect(await stored()).toEqual({ name: "Camille" });
  });

  // Regression: the settings upsert read `profile.data || EXCLUDED.data` inside
  // `INSERT INTO settings`; Postgres rejects it (42P01, no `profile` in scope), the
  // outbox retries the resulting 500 in order, and every write queued behind it jammed.
  describe("the settings write", () => {
    const pushBody = (body) => handler({ httpMethod: "POST", headers: {}, body: JSON.stringify(body) });
    const storedSettings = async () => (await db.query("SELECT data FROM settings WHERE id = 1")).rows[0].data;

    it("inserts the row on the first push", async () => {
      const res = await pushBody({ settings: { restSeconds: 90 } });
      expect(res.statusCode).toBe(200);
      expect(await storedSettings()).toEqual({ restSeconds: 90 });
    });

    it("replaces the stored settings whole on a conflict", async () => {
      await pushBody({ settings: { restSeconds: 90, sound: true } });
      const res = await pushBody({ settings: { restSeconds: 120 } });
      expect(res.statusCode).toBe(200);
      expect(await storedSettings()).toEqual({ restSeconds: 120 });
    });

    it("saves settings and profile in the same push", async () => {
      const res = await pushBody({ profile: { name: "Camille", age: 32 }, settings: { restSeconds: 60 } });
      expect(res.statusCode).toBe(200);
      expect(await storedSettings()).toEqual({ restSeconds: 60 });
      expect(await stored()).toEqual({ name: "Camille", age: 32, ...SERVER_KEYS });
    });
  });
});
