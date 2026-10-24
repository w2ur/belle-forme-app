/**
 * The seed write is executed against Postgres (PGlite): "does not replace a live
 * catalog" is a property of the SQL, and a mocked `sql` passes with either.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { seedCatalog } from "./catalog-seed-lib.mjs";
import seed from "../src/data/catalogSeed.json";

const SCHEMA = readFileSync(new URL("../netlify/functions/lib/schema.sql", import.meta.url), "utf8");

/** A neon-style tagged-template client over PGlite. */
function sqlOver(db) {
  return async (strings, ...values) => {
    const text = strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ""), "");
    return (await db.query(text, values)).rows;
  };
}

describe("seedCatalog", () => {
  let db;
  let sql;
  const stored = async () => (await db.query("SELECT data, updated_at FROM catalog WHERE id = 1")).rows[0];

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(SCHEMA);
    sql = sqlOver(db);
  });

  it("seeds an empty database with the whole document", async () => {
    const result = await seedCatalog(sql, seed);
    expect(result).toEqual({ seeded: true, exercises: seed.exercises.length });
    expect((await stored()).data).toEqual(seed);
  });

  // Regression: the write used to be ON CONFLICT DO UPDATE, so a re-run against a
  // live database replaced every edit the user had made with the day-one catalog.
  it("leaves a live catalog exactly as it is", async () => {
    const live = { ...seed, exercises: seed.exercises.slice(0, 3), aliases: { Mine: "Squat" } };
    await db.query("INSERT INTO catalog (id, data, updated_at) VALUES (1, $1::jsonb, '2026-01-01T00:00:00Z')", [JSON.stringify(live)]);
    const before = await stored();

    const result = await seedCatalog(sql, seed);

    expect(result).toEqual({ seeded: false, exercises: 3 });
    const after = await stored();
    expect(after.data).toEqual(live);
    expect(after.updated_at).toEqual(before.updated_at);
  });

  it("is a no-op the second time it runs", async () => {
    await seedCatalog(sql, seed);
    const first = await stored();
    expect((await seedCatalog(sql, seed)).seeded).toBe(false);
    expect(await stored()).toEqual(first);
  });
});
