import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

// The real handler against a real Postgres built from schema.sql (PGlite, in
// process), with the client's replay on top. The unit tests prove the replay
// logic; only this proves the ids survive the server — the JSONB round trip,
// the validator, the version check — so that a lost response replays as done.
let db;
vi.mock("../functions/lib/db.js", () => ({
  // Neon's tagged-template driver, over PGlite: rows, not a result object.
  getDb: () => async (strings, ...values) => {
    const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ""), "");
    const params = values.map((v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v));
    return (await db.query(text, params)).rows;
  },
  authorize: () => null,
  ok: (data) => ({ statusCode: 200, body: JSON.stringify(data) }),
  err: (message, status = 500) => ({ statusCode: status, body: JSON.stringify({ error: message }) }),
}));

const { handler } = await import("../functions/sync-catalog.js");
const { sendCatalogOps } = await import("../../src/lib/catalogSync.js");
const { blankExercise } = await import("../../src/lib/catalogForm.js");

const ex = (name) => ({
  ...blankExercise(), name, group: "Upper Body",
  description: "Un haltère dans chaque main, tirer vers les hanches",
  formCues: "Dos plat", intent: "Le tirage horizontal",
  implementTypes: ["dumbbell", "dual_bar_symmetric"], equipmentNeeds: ["dumbbell"],
});

// The client's pushCatalog, against the handler: 409 carries the row as body.
async function pushCatalog(body) {
  const res = await handler({ httpMethod: "PUT", body: JSON.stringify(body) });
  const parsed = JSON.parse(res.body);
  if (res.statusCode !== 200) throw Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode, body: parsed });
  return parsed;
}

async function row() {
  return (await db.query("SELECT data, updated_at FROM catalog WHERE id = 1")).rows[0];
}

// PGlite boots a whole Postgres in WASM: ~1 s alone, several under a full
// parallel run, which the default 5 s timeout does not cover.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

beforeEach(async () => {
  db = new PGlite();
  await db.exec(readFileSync(new URL("../functions/lib/schema.sql", import.meta.url), "utf8"));
  await db.query("INSERT INTO catalog (id, data) VALUES (1, $1)", [JSON.stringify({ version: 1, exercises: [ex("A")], aliases: {} })]);
});
afterEach(async () => { await db.close(); });

describe("catalog replay against the real endpoint", () => {
  // Regression: d76bf4d — see catalogSync.test.js; this is the same lost response,
  // end to end through Postgres.
  it.each([
    ["add then deactivate", [
      { id: "op-add", op: "upsertExercise", args: [ex("X"), null] },
      { id: "op-off", op: "setExerciseActive", args: ["X", false, "2026-10-01"] },
    ]],
    ["add then rename", [
      { id: "op-add", op: "upsertExercise", args: [ex("X"), null] },
      { id: "op-ren", op: "applyRename", args: ["X", "Y"] },
      { id: "op-up", op: "upsertExercise", args: [ex("Y"), "Y"] },
    ]],
  ])("a committed %s whose response was lost is not applied twice", async (_label, ops) => {
    const start = await row();
    const base = { doc: start.data, updatedAt: start.updated_at.toISOString() };

    // The PUT commits; its response never reaches the device.
    await sendCatalogOps({ base, ops, push: pushCatalog });
    const committed = await row();
    expect(committed.data.appliedOps).toEqual(ops.map((o) => o.id));

    // The outbox retries from the same stale mirror: 409, replay onto the row.
    const replay = await sendCatalogOps({ base, ops, push: pushCatalog });
    const after = await row();
    expect(replay.doc).toEqual(after.data);
    expect(after.data).toEqual(committed.data);
    // No second write: the version did not move.
    expect(after.updated_at.getTime()).toBe(committed.updated_at.getTime());
  });
});
