// Seeds the catalog table of a NEW database from `src/data/catalogSeed.json`.
// Run once, after applying schema.sql. It refuses to touch a database that
// already has a catalog (see `seedCatalog`), so running it twice is harmless.
//   NEON_DATABASE_URL=... node scripts/seed-catalog.mjs
//
// `src/data/catalogSeed.json` IS NOT A DERIVED ARTIFACT ANY MORE, and there is
// nothing left to regenerate it with. It was generated once, from the
// build-time constants, by `scripts/build-catalog-seed.mjs`; that generator and
// the constants it read were both deleted when the catalog moved to Neon (git
// history preserves the derivation). The file is now two things and neither of
// them is "output": the day-one seed for a fresh database, and the committed
// fixture a large part of the test suite builds its catalog from.
//
// So: NEON IS THE SOURCE OF TRUTH. Once seeded, the user edits the document in the
// app and this file stops describing it. Nothing in the app reads the seed at
// runtime, and this script is the only thing that writes it. Do not try to
// regenerate the JSON; edit it by hand if a fixture ever needs to change.
import { neonSql } from "../netlify/functions/lib/neonClient.js";
import seed from "../src/data/catalogSeed.json" with { type: "json" };
import { seedCatalog } from "./catalog-seed-lib.mjs";

const url = process.env.NEON_DATABASE_URL;
if (!url) {
  console.error("NEON_DATABASE_URL is required");
  process.exit(1);
}

const { seeded, exercises } = await seedCatalog(neonSql(url), seed);
console.log(
  seeded
    ? `catalog seeded: ${exercises} exercises`
    : `catalog already present (${exercises} exercises): left untouched`,
);
