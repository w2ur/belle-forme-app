// @vitest-environment node
/**
 * The two guards that only a real build can prove, because they are about what
 * the bundler kept: the real app ships no demo code and no fixtures, and the
 * demo ships no path to the API. Both builds go to a temp directory.
 *
 * Each check has its control in the other bundle — the demo markers must be IN
 * the demo bundle, "/api/" must be IN the real one — so a build that silently
 * emitted nothing, or a marker that drifted, cannot pass as clean.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { build } from "vite";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_PREFIX } from "./storage.js";
import { DEMO_COACH_LABEL } from "./coach.js";
import { DEMO_PERSONA_NAME } from "./fixtures.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Strings that exist only in demo code and fixtures. */
const DEMO_MARKERS = [DEMO_PREFIX, DEMO_COACH_LABEL, "Démo — données fictives", "demo_seeded", `"${DEMO_PERSONA_NAME}"`, "Mauvaise nuit"];

function jsOf(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(jsOf(full));
    else if (/\.(js|html)$/.test(entry)) out.push(readFileSync(full, "utf8"));
  }
  return out.join("\n");
}

let tmp;
let real;
let demo;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "bf-bundle-"));
  const opts = (mode, outDir) => ({
    root: ROOT, mode, logLevel: "silent", configFile: path.join(ROOT, "vite.config.js"),
    build: { outDir, emptyOutDir: true },
  });
  await build(opts("production", path.join(tmp, "real")));
  await build(opts("demo", path.join(tmp, "demo")));
  real = jsOf(path.join(tmp, "real"));
  demo = jsOf(path.join(tmp, "demo"));
}, 120_000);

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("bundles", () => {
  it("the real bundle carries no demo code and no fixtures", () => {
    for (const marker of DEMO_MARKERS) expect(real.includes(marker), marker).toBe(false);
  });

  it("control: every marker is in the demo bundle", () => {
    for (const marker of DEMO_MARKERS) expect(demo.includes(marker), marker).toBe(true);
  });

  it("the demo bundle carries no API path at all", () => {
    expect(demo.includes("/api")).toBe(false);
  });

  it("control: the real bundle does call the API", () => {
    expect(real.includes("/api/")).toBe(true);
  });

  it("the demo registers no service worker; the real one stays out of /demo/", () => {
    expect(readdirSync(path.join(tmp, "demo"))).not.toContain("sw.js");
    expect(demo).not.toMatch(/serviceWorker\.register|registerSW/);
    const sw = readFileSync(path.join(tmp, "real", "sw.js"), "utf8");
    expect(sw).toMatch(/\\\/demo/); // the navigation denylist
    expect(sw).not.toMatch(/url:"demo\//);
  });
});
