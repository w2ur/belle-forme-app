// Stamps `metric: "seconds"` onto the held exercises in the LIVE catalog
// document. One-shot, idempotent, and a read-modify-write of the row that is
// already there — never a re-seed.
//
//   NEON_DATABASE_URL=... node scripts/migrate-catalog-metric.mjs          # dry run
//   NEON_DATABASE_URL=... node scripts/migrate-catalog-metric.mjs --write  # commit
//
// Why a script rather than "the user flips five switches in the Exercices tab":
// absent `metric` means `"reps"`, so until these five are stamped the coach
// keeps prescribing a hold in repetitions and the app keeps recording it as
// one. That is a correctness gap that should not wait on a chore.
//
// WHY IT MUST BE AN UPDATE, not an INSERT ... ON CONFLICT with a fresh
// document: `schema.sql` installs a BEFORE UPDATE trigger that stamps
// `updated_at = NOW()`, and `catalog.updated_at` is the CACHE KEY the coach's
// edge function builds its three system prompts against. A write that left the
// key unchanged would leave warm isolates serving prompts for a catalog that no
// longer exists. Reading the row, editing it, and writing it back also means
// every edit the user has made since the day-one seed survives — which
// `seed-catalog.mjs` would flatten. Do not "simplify" this into that.
import { neonSql } from "../netlify/functions/lib/neonClient.js";

// Matched by NAME because the name is the primary key for her history, and
// because a catalog entry may have been renamed since the seed — an alias
// would then point here. Anything not found is REPORTED rather than skipped
// silently: a hold that is not stamped is the whole failure this script exists
// to prevent, and it must not be invisible.
const HOLDS = ["Dead hang", "Chaise murale", "Gainage planche", "Gainage latéral", "Hollow Body"];

const url = process.env.NEON_DATABASE_URL;
if (!url) {
  console.error("NEON_DATABASE_URL is required");
  process.exit(1);
}
const write = process.argv.includes("--write");

const sql = neonSql(url);
const [row] = await sql`SELECT data FROM catalog WHERE id = 1`;
if (!row?.data) {
  console.error("no catalog row — refusing to create one (this is a migration, not a seed)");
  process.exit(2);
}

const doc = row.data;
const exercises = Array.isArray(doc.exercises) ? doc.exercises : [];
if (exercises.length === 0) {
  console.error("catalog document has no exercises — refusing to write");
  process.exit(2);
}

const byName = new Map(exercises.map((ex) => [ex?.name, ex]));
const missing = HOLDS.filter((name) => !byName.has(name));
const changed = [];
const already = [];

for (const name of HOLDS) {
  const ex = byName.get(name);
  if (!ex) continue;
  if (ex.metric === "seconds") already.push(name);
  else {
    ex.metric = "seconds";
    changed.push(name);
  }
}

console.log(`catalog: ${exercises.length} exercises`);
if (already.length) console.log(`already in seconds : ${already.join(", ")}`);
console.log(`to stamp           : ${changed.join(", ") || "(none)"}`);
if (missing.length) console.log(`NOT FOUND          : ${missing.join(", ")}`);

// A hold that is not in the document is not a no-op — it means this list and
// the live catalog have diverged, and stamping the rest would look like a
// clean run. Exit 1 is "a finding", per the portfolio convention.
if (missing.length) {
  console.error("\nrefusing to write: resolve the missing names first (renamed? deleted?)");
  process.exit(1);
}

if (!write) {
  console.log("\ndry run — nothing written. Re-run with --write to commit.");
  process.exit(0);
}

if (changed.length === 0) {
  console.log("\nnothing to do.");
  process.exit(0);
}

await sql`UPDATE catalog SET data = ${doc} WHERE id = 1`;
const [after] = await sql`SELECT updated_at FROM catalog WHERE id = 1`;
console.log(`\nwritten. updated_at is now ${after.updated_at} — the coach's prompt cache will rebuild.`);
