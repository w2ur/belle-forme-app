import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { planProfilePatch, parsePatchArgs, profilePatchSql } from "./profile-patch-lib.mjs";
import { TEST_INVENTORY } from "../src/constants/testInventory.js";

const patch = { gender: "m", cycle: { enabled: false, lengthDays: 28 }, inventory: TEST_INVENTORY };

describe("planProfilePatch", () => {
  it("fills the gaps of a profile saved before these fields existed", () => {
    const plan = planProfilePatch({ name: "Noa", age: 30 }, patch);
    expect(plan.errors).toEqual([]);
    expect(plan.added).toEqual(["gender", "cycle", "inventory"]);
    expect(plan.merged).toMatchObject({ name: "Noa", age: 30, gender: "m" });
    expect(plan.unchanged).toBe(false);
  });

  // The idempotence the owner relies on: run it twice, the second run is a no-op.
  it("is idempotent: applying its own result changes nothing", () => {
    const first = planProfilePatch({ name: "Noa" }, patch);
    const second = planProfilePatch(first.merged, patch);
    expect(second.unchanged).toBe(true);
    expect(second.added).toEqual([]);
    expect(second.merged).toEqual(first.merged);
  });

  it("never undoes an edit made in the app: an existing key wins over the patch", () => {
    const plan = planProfilePatch({ name: "Noa", gender: "f" }, patch);
    expect(plan.merged.gender).toBe("f");
    expect(plan.kept).toEqual(["gender"]);
    expect(plan.added).toEqual(["cycle", "inventory"]);
  });

  it("lets the patch win only when asked to, and only for the keys it names", () => {
    const plan = planProfilePatch({ name: "Noa", gender: "f", age: 30 }, patch, { overwrite: true });
    expect(plan.merged).toMatchObject({ name: "Noa", gender: "m", age: 30 });
    expect(plan.changed).toEqual(["gender"]);
    expect(plan.kept).toEqual([]);
  });

  it("creates the profile when there is no row yet", () => {
    const plan = planProfilePatch(null, { name: "Noa", ...patch });
    expect(plan.merged.name).toBe("Noa");
    expect(plan.added).toContain("name");
  });

  it("compares nested values as wholes: an inventory is replaced or kept, never half-merged", () => {
    const other = { ...TEST_INVENTORY, dumbbellOptionsKg: [3] };
    const plan = planProfilePatch({ name: "Noa", inventory: other }, patch);
    expect(plan.merged.inventory).toEqual(other);
    expect(plan.kept).toContain("inventory");
  });

  it("refuses a patch that would leave an invalid profile, and returns no document", () => {
    const plan = planProfilePatch({ name: "Noa" }, { gender: "x" });
    expect(plan.merged).toBeNull();
    expect(plan.errors.length).toBeGreaterThan(0);
  });

  it("refuses a patch that is not an object", () => {
    for (const bad of [null, [], "x", 3]) {
      const plan = planProfilePatch({ name: "Noa" }, bad);
      expect(plan.merged).toBeNull();
      expect(plan.errors).toEqual(["The patch must be a JSON object."]);
    }
  });

  it("mirrors the SQL precedence (patch || data): the merged object equals the database result", () => {
    const existing = { name: "Noa", gender: "f" };
    const sqlResult = { ...patch, ...existing }; // jsonb `patch || data`: right operand wins
    expect(planProfilePatch(existing, patch).merged).toEqual(sqlResult);
  });
});

describe("parsePatchArgs", () => {
  it("reads the file and the flags", () => {
    expect(parsePatchArgs(["p.json"])).toEqual({ file: "p.json", overwrite: false, dryRun: false });
    expect(parsePatchArgs(["p.json", "--dry-run", "--overwrite"])).toEqual({ file: "p.json", overwrite: true, dryRun: true });
  });

  it("fails on a missing file, a typo or an extra argument rather than running a write with the wrong meaning", () => {
    expect(() => parsePatchArgs([])).toThrow(/usage/);
    expect(() => parsePatchArgs(["p.json", "--overwite"])).toThrow(/unknown argument/);
    expect(() => parsePatchArgs(["a.json", "b.json"])).toThrow(/extra/);
  });
});

// The SQL is executed, not string-matched: the merge direction is the whole
// point, and a string test would pass with the operands swapped.
describe("profilePatchSql, run against Postgres", () => {
  const setup = async (stored) => {
    const db = new PGlite();
    await db.exec("CREATE TABLE profile (id INTEGER PRIMARY KEY DEFAULT 1, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())");
    if (stored) await db.query("INSERT INTO profile (id, data, updated_at) VALUES (1, $1, '2000-01-01T00:00:00Z')", [JSON.stringify(stored)]);
    return db;
  };
  const read = async (db) => (await db.query("SELECT data, updated_at FROM profile WHERE id = 1")).rows[0];

  it("fills gaps and keeps what is stored, exactly as planProfilePatch predicts", async () => {
    const stored = { name: "Noa", gender: "f" };
    const db = await setup(stored);
    await db.query(profilePatchSql(), [JSON.stringify(patch)]);
    expect((await read(db)).data).toEqual(planProfilePatch(stored, patch).merged);
    expect((await read(db)).data.gender).toBe("f");
  });

  it("is idempotent: the second run leaves the data as the first left it", async () => {
    const db = await setup({ name: "Noa" });
    await db.query(profilePatchSql(), [JSON.stringify(patch)]);
    const once = (await read(db)).data;
    await db.query(profilePatchSql(), [JSON.stringify(patch)]);
    expect((await read(db)).data).toEqual(once);
  });

  it("lets the patch win with overwrite, and bumps updated_at", async () => {
    const db = await setup({ name: "Noa", gender: "f" });
    await db.query(profilePatchSql({ overwrite: true }), [JSON.stringify(patch)]);
    const row = await read(db);
    expect(row.data.gender).toBe("m");
    expect(row.data.name).toBe("Noa");
    expect(new Date(row.updated_at).getFullYear()).toBeGreaterThan(2020);
  });

  it("creates the row when there is none", async () => {
    const db = await setup(null);
    await db.query(profilePatchSql(), [JSON.stringify({ name: "Noa", ...patch })]);
    expect((await read(db)).data.name).toBe("Noa");
  });
});
