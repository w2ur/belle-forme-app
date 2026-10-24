// Pure part of `scripts/apply-profile-patch.mjs`, split out so it can be
// unit-tested without a database.
import { validateProfile } from "../src/lib/profileDoc.js";

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What applying a patch to the stored profile would do.
 *
 * By default a patch only FILLS GAPS: a key the profile already has is kept,
 * whatever the patch says. That is what makes the script idempotent and safe
 * to re-run, and it is the same rule the SQL uses (`patch || data` — the right
 * operand wins), so the preview and the write cannot disagree. `overwrite`
 * flips the precedence for the keys the patch names, nothing else.
 *
 * Only top-level keys are compared: `cycle` and `inventory` are replaced or
 * kept as wholes, never merged field by field, so a half-merged inventory can
 * not exist.
 *
 * @param {object|null} existing - the stored profile, null when there is no row.
 * @param {unknown} patch
 * @param {{ overwrite?: boolean }} [options]
 * @returns {{ merged: object|null, added: string[], changed: string[], kept: string[], unchanged: boolean, errors: string[] }}
 */
export function planProfilePatch(existing, patch, { overwrite = false } = {}) {
  if (!isPlainObject(patch)) {
    return { merged: null, added: [], changed: [], kept: [], unchanged: true, errors: ["The patch must be a JSON object."] };
  }
  const base = isPlainObject(existing) ? existing : {};
  const added = [];
  const changed = [];
  const kept = [];
  for (const key of Object.keys(patch)) {
    if (!Object.hasOwn(base, key)) added.push(key);
    else if (!same(base[key], patch[key])) (overwrite ? changed : kept).push(key);
  }
  const merged = overwrite ? { ...base, ...patch } : { ...patch, ...base };
  const errors = validateProfile(merged).errors;
  return {
    merged: errors.length ? null : merged,
    added, changed, kept,
    unchanged: added.length === 0 && changed.length === 0,
    errors,
  };
}

/**
 * The write, as one statement with the patch as $1 (a JSON string). `||` on
 * jsonb lets its RIGHT operand win a key, so the default puts the stored row
 * on the right (it fills gaps) and `overwrite` puts the patch there. One
 * statement means no read-modify-write window; `updated_at` is bumped so the
 * devices pull and the coach rebuilds its prompt.
 */
export function profilePatchSql({ overwrite = false } = {}) {
  const merge = overwrite ? "profile.data || EXCLUDED.data" : "EXCLUDED.data || profile.data";
  return `INSERT INTO profile (id, data, updated_at) VALUES (1, $1::jsonb, NOW())
ON CONFLICT (id) DO UPDATE SET data = ${merge}, updated_at = NOW()`;
}

/** The CLI flags. A typo fails here instead of running a write with the wrong meaning. */
export function parsePatchArgs(argv) {
  const out = { file: null, overwrite: false, dryRun: false };
  for (const a of argv) {
    if (a === "--overwrite") out.overwrite = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--")) throw new Error(`unknown argument "${a}"`);
    else if (out.file === null) out.file = a;
    else throw new Error(`unexpected extra argument "${a}"`);
  }
  if (!out.file) throw new Error("usage: node scripts/apply-profile-patch.mjs <patch.json> [--dry-run] [--overwrite]");
  return out;
}
