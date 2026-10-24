import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

// The throttle talks to Postgres, so the handler is tested against a real one
// (PGlite, built from schema.sql). `getDb` hands back whatever `database.sql` is.
const database = { sql: null, db: null };
vi.mock("../functions/lib/db.js", () => ({
  ok: (data) => ({ statusCode: 200, body: JSON.stringify(data) }),
  err: (msg, status = 500) => ({ statusCode: status, body: JSON.stringify({ error: msg }) }),
  getDb: () => {
    if (!database.sql) throw new Error("database unavailable");
    return database.sql;
  },
}));

/** A neon-style tagged-template client over PGlite. */
function sqlOver(db) {
  return async (strings, ...values) => {
    const text = strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ""), "");
    return (await db.query(text, values)).rows;
  };
}
const SCHEMA = readFileSync(new URL("../functions/lib/schema.sql", import.meta.url), "utf8");

const { handler } = await import("../functions/login.js");

// Synthetic test fixtures (not real credentials).
const PLAINTEXT = "open-sesame";
const HASH = crypto.createHash("sha256").update(PLAINTEXT).digest("hex");
const FAKE_KEY = ["fake", "sync", "token", "for", "tests"].join("-");

const postEvent = (body, ip) => ({
  httpMethod: "POST",
  headers: ip ? { "x-nf-client-connection-ip": ip } : {},
  body: body === undefined ? null : JSON.stringify(body),
});

describe("login", () => {
  beforeEach(async () => {
    process.env.APP_PASSWORD_HASH = HASH;
    process.env.SYNC_API_KEY = FAKE_KEY;
    const db = new PGlite();
    await db.exec(SCHEMA);
    database.db = db;
    database.sql = sqlOver(db);
  });

  it("returns the API key for the correct password", async () => {
    const res = await handler(postEvent({ password: PLAINTEXT }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).key).toBe(FAKE_KEY);
  });

  it("rejects a wrong password with 401 and never leaks the key", async () => {
    const res = await handler(postEvent({ password: "nope" }));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).key).toBeUndefined();
  });

  it("rejects a missing password with 400", async () => {
    const res = await handler(postEvent({}));
    expect(res.statusCode).toBe(400);
  });

  it("rejects non-POST methods with 405", async () => {
    const res = await handler({ httpMethod: "GET", headers: {} });
    expect(res.statusCode).toBe(405);
  });

  it("500s (without a key) when auth env is not configured", async () => {
    delete process.env.APP_PASSWORD_HASH;
    const res = await handler(postEvent({ password: PLAINTEXT }));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).key).toBeUndefined();
  });

  // The sync credential half of that check had no test, and it is exactly what
  // a mis-set env var name looks like: the var reads as undefined and the
  // correct password would otherwise be answered with `{"key": undefined}`.
  it("500s when the sync credential is missing, even for the right password", async () => {
    delete process.env.SYNC_API_KEY;
    const res = await handler(postEvent({ password: PLAINTEXT }));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).key).toBeUndefined();
  });

  describe("throttle on failed attempts", () => {
    const wrong = (ip) => handler(postEvent({ password: "nope" }, ip));

    it("refuses an address after five wrong passwords — even with the right one — and never sends the key", async () => {
      for (let i = 0; i < 5; i++) expect((await wrong("198.51.100.1")).statusCode).toBe(401);
      const locked = await handler(postEvent({ password: PLAINTEXT }, "198.51.100.1"));
      expect(locked.statusCode).toBe(429);
      expect(locked.headers["Retry-After"]).toBe("900");
      expect(JSON.parse(locked.body).key).toBeUndefined();
    });

    it("lets the fifth attempt through to the compare: the sixth is the first refused", async () => {
      for (let i = 0; i < 4; i++) await wrong("198.51.100.2");
      expect((await handler(postEvent({ password: PLAINTEXT }, "198.51.100.2"))).statusCode).toBe(200);
    });

    it("locks one address without locking the owner out from another", async () => {
      for (let i = 0; i < 5; i++) await wrong("198.51.100.3");
      expect((await wrong("198.51.100.3")).statusCode).toBe(429);
      expect((await handler(postEvent({ password: PLAINTEXT }, "203.0.113.7"))).statusCode).toBe(200);
    });

    it("clears the slate on a correct password, so earlier slips do not accumulate", async () => {
      for (let i = 0; i < 4; i++) await wrong("198.51.100.4");
      expect((await handler(postEvent({ password: PLAINTEXT }, "198.51.100.4"))).statusCode).toBe(200);
      for (let i = 0; i < 4; i++) expect((await wrong("198.51.100.4")).statusCode).toBe(401);
    });

    // Regression: a throttle that read the count before anyone had written let a parallel
    // burst of wrong passwords all through; recording first caps the burst at the limit.
    it("lets at most five of a parallel burst of wrong passwords reach the compare", async () => {
      const burst = await Promise.all(Array.from({ length: 30 }, () => wrong("198.51.100.8")));
      const codes = burst.map((r) => r.statusCode);
      const compared = codes.filter((c) => c === 401).length;
      expect(compared).toBeLessThanOrEqual(5);
      expect(compared + codes.filter((c) => c === 429).length).toBe(30);
    });

    it("does not let a locked address keep extending its own lock", async () => {
      for (let i = 0; i < 5; i++) await wrong("198.51.100.9");
      for (let i = 0; i < 4; i++) expect((await wrong("198.51.100.9")).statusCode).toBe(429);
      const rows = await database.db.query("SELECT COUNT(*)::int AS n FROM login_attempts WHERE ip = $1", ["198.51.100.9"]);
      expect(rows.rows[0].n).toBe(5);
    });

    it("puts requests with no address in one shared bucket instead of exempting them", async () => {
      for (let i = 0; i < 5; i++) await wrong(undefined);
      expect((await handler(postEvent({ password: PLAINTEXT }))).statusCode).toBe(429);
    });

    // An instance that has not applied the login_attempts table yet — or whose
    // database blinks — must still let its owner in. The throttle is a brake on
    // guessing; the passphrase is the boundary.
    it("fails open when the throttle's database is unavailable, and says so", async () => {
      database.sql = null;
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await handler(postEvent({ password: PLAINTEXT }, "198.51.100.5"));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).key).toBe(FAKE_KEY);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("still answers a wrong password with 401 when the throttle is unavailable", async () => {
      database.sql = null;
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect((await wrong("198.51.100.6")).statusCode).toBe(401);
      spy.mockRestore();
    });
  });
});
