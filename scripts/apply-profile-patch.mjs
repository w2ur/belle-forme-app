// Fills gaps in the stored profile from a JSON file. Idempotent: running it
// twice is the same as running it once.
//   NEON_DATABASE_URL=... node scripts/apply-profile-patch.mjs <patch.json> [--dry-run] [--overwrite]
//
// What it is for: data that used to live in code (a name, the equipment, coach
// notes) now lives in the profile document in Neon. An instance that predates
// that move gets its values here, once, from a file kept outside the public
// tree. It is also the quickest way to fill a profile from the command line.
//
// By default only keys the profile does NOT have are written, so it never
// undoes an edit made in the app. `--overwrite` makes the patch win for the keys
// it names. `--dry-run` prints what would change and writes nothing. Only key
// NAMES are printed, never values: a profile is personal data.
//
// The write is one statement (`patch || data`, existing keys win), so there is no
// read-modify-write window, and it bumps `updated_at`: every device's next pull
// picks the change up and the coach rebuilds its prompt from the new version.
import { readFileSync } from "node:fs";
import { neonSql } from "../netlify/functions/lib/neonClient.js";
import { planProfilePatch, parsePatchArgs, profilePatchSql } from "./profile-patch-lib.mjs";

let args;
try {
  args = parsePatchArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

const url = process.env.NEON_DATABASE_URL;
if (!url) {
  console.error("NEON_DATABASE_URL is required");
  process.exit(2);
}

let patch;
try {
  patch = JSON.parse(readFileSync(args.file, "utf8"));
} catch (e) {
  console.error(`cannot read ${args.file}: ${e.message}`);
  process.exit(2);
}

const sql = neonSql(url);
const rows = await sql`SELECT data FROM profile WHERE id = 1`;
const existing = rows[0]?.data ?? null;
const plan = planProfilePatch(existing, patch, { overwrite: args.overwrite });

if (plan.errors.length) {
  console.error("the resulting profile would be invalid, nothing written:");
  for (const message of plan.errors) console.error(`  - ${message}`);
  process.exit(1);
}

console.log(existing ? "profile row found" : "no profile row yet: it will be created");
console.log(`added:     ${plan.added.join(", ") || "(nothing)"}`);
if (args.overwrite) console.log(`changed:   ${plan.changed.join(", ") || "(nothing)"}`);
else console.log(`kept:      ${plan.kept.join(", ") || "(nothing)"}  (already set, left as is)`);

if (plan.unchanged && existing) {
  console.log("nothing to do.");
  process.exit(0);
}
if (args.dryRun) {
  console.log("dry run: nothing written.");
  process.exit(0);
}

await sql.query(profilePatchSql({ overwrite: args.overwrite }), [JSON.stringify(patch)]);
console.log("profile updated.");
