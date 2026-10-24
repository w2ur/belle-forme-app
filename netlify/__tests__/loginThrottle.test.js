/**
 * The throttle's SQL is executed against Postgres (PGlite), not string-matched:
 * the window arithmetic and the per-address scoping are the whole behaviour, and
 * a string test passes with either wrong.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import {
  MAX_FAILED_ATTEMPTS, WINDOW_MINUTES, clientIp, beginAttempt, dropAttempt, clearFailures,
} from "../functions/lib/loginThrottle.js";

const SCHEMA = readFileSync(new URL("../functions/lib/schema.sql", import.meta.url), "utf8");

/** A neon-style tagged-template client over PGlite. */
function sqlOver(db) {
  return async (strings, ...values) => {
    const text = strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ""), "");
    return (await db.query(text, values)).rows;
  };
}

describe("login throttle", () => {
  let db;
  let sql;
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(SCHEMA);
    sql = sqlOver(db);
  });

  const backdate = (ip, minutes) =>
    db.query("UPDATE login_attempts SET created_at = NOW() - make_interval(mins => $2) WHERE ip = $1", [ip, minutes]);

  it("counts an attempt against its own address only, the attempt itself included", async () => {
    expect((await beginAttempt(sql, "1.1.1.1")).count).toBe(1);
    expect((await beginAttempt(sql, "1.1.1.1")).count).toBe(2);
    expect((await beginAttempt(sql, "2.2.2.2")).count).toBe(1);
    expect((await beginAttempt(sql, "3.3.3.3")).count).toBe(1);
  });

  it("forgets an attempt once it falls out of the window", async () => {
    await beginAttempt(sql, "1.1.1.1");
    await backdate("1.1.1.1", WINDOW_MINUTES + 1);
    expect((await beginAttempt(sql, "1.1.1.1")).count).toBe(1);
    await beginAttempt(sql, "4.4.4.4");
    await backdate("4.4.4.4", WINDOW_MINUTES - 1);
    expect((await beginAttempt(sql, "4.4.4.4")).count).toBe(2);
  });

  it("clears an address's slate after a correct password, and no one else's", async () => {
    await beginAttempt(sql, "1.1.1.1");
    await beginAttempt(sql, "2.2.2.2");
    await clearFailures(sql, "1.1.1.1");
    expect((await beginAttempt(sql, "1.1.1.1")).count).toBe(1);
    expect((await beginAttempt(sql, "2.2.2.2")).count).toBe(2);
  });

  it("takes back one refused attempt without touching the others", async () => {
    await beginAttempt(sql, "1.1.1.1");
    const refused = await beginAttempt(sql, "1.1.1.1");
    await dropAttempt(sql, refused.id);
    expect((await beginAttempt(sql, "1.1.1.1")).count).toBe(2);
  });

  it("sweeps rows older than a day when an attempt is recorded", async () => {
    await beginAttempt(sql, "1.1.1.1");
    await backdate("1.1.1.1", 60 * 25);
    await beginAttempt(sql, "2.2.2.2");
    const rows = await db.query("SELECT ip FROM login_attempts");
    expect(rows.rows.map((r) => r.ip)).toEqual(["2.2.2.2"]);
  });

  // Regression: a throttle that counts, then judges, then records lets every request
  // of a parallel burst read "under the limit" before any of them writes. Recording
  // first means the burst sees itself: at most MAX_FAILED_ATTEMPTS requests may count
  // as within the limit, however the statements interleave.
  it("never counts more than MAX_FAILED_ATTEMPTS of a parallel burst as within the limit", async () => {
    const burst = await Promise.all(Array.from({ length: 40 }, () => beginAttempt(sql, "9.9.9.9")));
    const within = burst.filter((a) => a.count <= MAX_FAILED_ATTEMPTS);
    expect(within.length).toBeLessThanOrEqual(MAX_FAILED_ATTEMPTS);
  });

  it("allows a handful of attempts before refusing", () => {
    expect(MAX_FAILED_ATTEMPTS).toBeGreaterThanOrEqual(3);
    expect(MAX_FAILED_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});

describe("clientIp", () => {
  const ip = (value) => clientIp({ "x-nf-client-connection-ip": value });

  it("reads the address Netlify stamps on the request", () => {
    expect(ip(" 203.0.113.9 ")).toBe("203.0.113.9");
  });

  // A request with no address must land in one shared bucket, not escape the throttle.
  it("falls back to a shared bucket rather than to no throttle", () => {
    for (const headers of [undefined, null, {}, { "x-nf-client-connection-ip": "" }, { "x-nf-client-connection-ip": 5 }]) {
      expect(clientIp(headers)).toBe("unknown");
    }
  });

  it("bounds a hostile header", () => {
    expect(ip("x".repeat(500))).toHaveLength(64);
  });

  // Regression: an IPv6 client owns a /64 and can send from any address inside it,
  // so keying on the full address gave it a fresh count per request.
  it("buckets an IPv6 address by its /64, however it is written", () => {
    const bucket = ip("2001:db8:aa:bb:1111:2222:3333:4444");
    expect(bucket).toBe("2001:db8:aa:bb::/64");
    expect(ip("2001:DB8:aa:bb:ffff::1")).toBe(bucket);
    expect(ip("2001:0db8:00aa:00bb::9")).toBe(bucket);
    expect(ip("2001:db8:aa:bb::")).toBe(bucket);
    expect(ip("2001:db8:aa:cc::1")).not.toBe(bucket);
  });

  it("expands a compressed prefix and ignores a zone id", () => {
    expect(ip("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ip("::1")).toBe("0:0:0:0::/64");
    expect(ip("fe80::1%en0")).toBe("fe80:0:0:0::/64");
  });

  it("treats an IPv4-mapped IPv6 address as the IPv4 client", () => {
    expect(ip("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });
});
