import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every relative import in the tree resolves to a file that exists.
 *
 * **This is a build check the test suite could not otherwise make, and the gap
 * is structural rather than an oversight.** UI components are not unit-tested
 * by convention, so a component importing a deleted module is imported by
 * nothing the suite runs: on 2026-08-23 the whole suite passed green against a
 * tree where `npm run build` failed on
 * `Could not resolve "../lib/coachNotice.js"` from two importers. `eslint`
 * cannot see it either — the config carries no `eslint-plugin-import`, so
 * `npm run lint` was green on the same tree. Only `vite build` caught it, and
 * only in CI, which is the one place a red result is advisory rather than
 * blocking (branch protection needs GitHub Pro on a private repo).
 *
 * It reads the source as TEXT rather than importing it, deliberately: importing
 * a component would need a DOM, and the point is to check the modules nothing
 * imports.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// The trees `vite build` and the Netlify bundler actually compile. `.worktrees/`
// is excluded for the same reason `vite.config.js` excludes it from the test
// glob: a worktree is a full second checkout inside the repo, and a dangling
// import in a feature branch is that branch's problem, not this tree's.
const SCANNED = ["src", "netlify/functions", "netlify/edge-functions", "netlify/__tests__"];
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".netlify", ".worktrees", ".git"]);

const SOURCE_EXTENSIONS = /\.(js|jsx)$/;

/**
 * `from "…"`, a bare side-effect `import "…"`, and dynamic `import("…")`.
 * Only the specifier is captured; whether the import is type-only or has a
 * clause does not change what has to exist on disk.
 */
const SPECIFIER_PATTERNS = [
  /\bfrom\s+["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXTENSIONS.test(entry)) out.push(full);
  }
  return out;
}

function sourceFiles() {
  return SCANNED.filter((dir) => existsSync(join(ROOT, dir))).flatMap((dir) =>
    walk(join(ROOT, dir))
  );
}

function relativeSpecifiers(file) {
  const source = readFileSync(file, "utf8");
  const found = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const [, specifier] of source.matchAll(pattern)) {
      if (specifier.startsWith(".")) found.add(specifier);
    }
  }
  return [...found];
}

/**
 * Vite's own resolution order, minus what this repo does not use. Every
 * relative import here carries its extension; the extensionless and directory
 * forms are accepted anyway so that adding one is not a spurious failure.
 * A `?raw`-style query is stripped — it addresses the same file.
 */
function resolves(fromFile, specifier) {
  const target = resolve(dirname(fromFile), specifier.split("?")[0]);
  const candidates = [
    target,
    `${target}.js`,
    `${target}.jsx`,
    join(target, "index.js"),
    join(target, "index.jsx"),
  ];
  return candidates.some((path) => existsSync(path) && statSync(path).isFile());
}

describe("module resolution", () => {
  const files = sourceFiles();

  // The control for the check itself: an empty file list would make every
  // assertion below pass by scanning nothing, which is the shape of a green
  // run that covered zero code.
  it("scans the trees that are actually built", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.includes("/src/components/"))).toBe(true);
    expect(files.some((f) => f.includes("/netlify/edge-functions/"))).toBe(true);
  });

  it("resolves every relative import to a file that exists", () => {
    const dangling = [];
    for (const file of files) {
      for (const specifier of relativeSpecifiers(file)) {
        if (!resolves(file, specifier)) {
          dangling.push(`${relative(ROOT, file)} → ${specifier}`);
        }
      }
    }
    expect(dangling).toEqual([]);
  });

  // Proves the walk-and-match half can fail, independently of the tree being
  // correct today: without it, a regex that silently stopped matching anything
  // would leave the assertion above green forever.
  it("would catch an import of a file that does not exist", () => {
    const realFile = join(ROOT, "src/lib/planValidation.js");
    expect(resolves(realFile, "./planFromJson.js")).toBe(true);
    expect(resolves(realFile, "./coachNotice.js")).toBe(false);
  });
});
