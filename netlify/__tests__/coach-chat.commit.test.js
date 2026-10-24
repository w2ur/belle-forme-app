// How a rung COMMITS, and what happens when a committed reply turns out empty.
//
// One monotonic event: a rung commits at the first non-whitespace character the
// notebook splitter forwards (the first non-whitespace payload character on
// plan-emit). Nothing re-judges the accumulated reply while it streams; the
// reply is judged once, at the end, and a committed reply that cleans to
// nothing is rolled back. The scenarios below are the round-5 probes (P1-P6),
// each turned into the outcome the design now promises.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MODEL_LADDER } from "../functions/lib/providers.js";
import seed from "../../src/data/catalogSeed.json";

vi.mock("../functions/lib/db.js", () => ({ authorizeToken: (h) => h === "Bearer test-key", getDb: () => ({}) }));
vi.mock("../functions/lib/catalogDb.js", () => ({
  loadCatalog: async () => ({ doc: seed, updatedAt: "2026-08-11T10:00:00Z" }),
}));
vi.mock("../functions/lib/profileDb.js", async () => {
  const { TEST_PROFILE } = await import("./testProfile.js");
  return { loadProfile: async () => ({ data: TEST_PROFILE, updatedAt: "2026-08-11T09:00:00Z" }) };
});
const callChatStream = vi.fn();
vi.mock("../functions/lib/providers.js", async (importActual) => ({
  ...(await importActual()),
  callChatStream: (...a) => callChatStream(...a),
}));
let nextId;
const writes = [];
const coachDb = {
  loadNotebook: vi.fn().mockResolvedValue(""),
  loadRecentMessages: vi.fn().mockResolvedValue([]),
  loadAllMessages: vi.fn().mockResolvedValue([]),
  appendMessage: vi.fn(async (role, content) => {
    const id = nextId++;
    writes.push(["insert", id, role, content]);
    return id;
  }),
  updateMessage: vi.fn(async (id, content) => void writes.push(["update", id, content])),
  deleteMessages: vi.fn(async (ids) => void writes.push(["delete", ids])),
  saveNotebook: vi.fn().mockResolvedValue(),
  recordUsage: vi.fn().mockResolvedValue(),
};
vi.mock("../functions/lib/coachDb.js", () => coachDb);

// Pass-through spies: behaviour is the real module's. They exist to COUNT how
// often the handler judges the whole accumulated reply.
const judged = { n: 0 };
vi.mock("../../src/lib/coachStream.js", async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    cleanVisibleReply: (...a) => (judged.n++, actual.cleanVisibleReply(...a)),
  };
});

const { default: handler } = await import("../edge-functions/coach-chat.js");
const { finalizeStream } = await import("../../src/lib/coachStream.js");

const enc = new TextEncoder();
const sse = (deltas, { finishReason = "stop" } = {}) =>
  new ReadableStream({
    start(c) {
      for (const d of deltas) c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`));
      c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`));
      c.close();
    },
  });
const R1 = MODEL_LADDER[0].model;
const LAST = MODEL_LADDER.at(-1).model;
const rung1 = (deltas) => ({ res: { ok: true, body: sse(deltas) }, model: R1, attempts: [], nextRung: 1, firstTextTimeoutMs: 60_000 });
const lastRung = (deltas) => ({ res: { ok: true, body: sse(deltas) }, model: LAST, attempts: [], nextRung: null, firstTextTimeoutMs: null });

// A stream with pauses: strings are deltas, numbers are waits in ms.
const slowSse = (steps) =>
  new ReadableStream({
    async start(c) {
      for (const st of steps) {
        if (typeof st === "number") await new Promise((r) => setTimeout(r, st));
        else c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: st } }] })}\n\n`));
      }
      c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`));
      c.close();
    },
  });
const slowRung1 = (steps, budget) => ({ res: { ok: true, body: slowSse(steps) }, model: R1, attempts: [], nextRung: 1, firstTextTimeoutMs: budget });

async function ask(message = "Q ?") {
  const res = await handler(new Request("http://localhost/api/coach-chat", {
    method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    body: JSON.stringify({ message }),
  }));
  const r = res.body.getReader();
  const d = new TextDecoder();
  let raw = "";
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    raw += d.decode(value, { stream: true });
  }
  return { raw, client: finalizeStream(raw) };
}

const userInserts = () => writes.filter((w) => w[0] === "insert" && w[2] === "user");
const deletes = () => writes.filter((w) => w[0] === "delete").map((w) => w[1]);
/** What the transcript holds once every write has landed, by id. */
function transcript() {
  const rows = new Map();
  for (const w of writes) {
    if (w[0] === "insert") rows.set(w[1], { role: w[2], content: w[3] });
    else if (w[0] === "update") rows.get(w[1]).content = w[2];
    else for (const id of w[1]) rows.delete(id);
  }
  return [...rows.values()];
}
const usage = () => coachDb.recordUsage.mock.calls.at(-1)[0];

// A bracketed first line LONGER than the old 60-character partial hold, ending
// on a time — so it is an annotation-shaped line once it closes.
const LONG = "[Rappel important pour ta séance de jeudi prochain au club, départ prévu 18:30]";
const STAMP = "[dim. 30 août, 17:15]";

describe("coach-chat: the commit and the rollback", () => {
  beforeEach(() => {
    nextId = 100;
    writes.length = 0;
    judged.n = 0;
    callChatStream.mockReset();
    Object.values(coachDb).forEach((f) => f.mockClear());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  // The false-positive guard for P1 below: text after the line is a reply.
  it("P1: a long bracket line on rung 1 commits it, and a reply after it is kept whole", async () => {
    callChatStream.mockResolvedValueOnce(rung1([LONG.slice(0, 65), LONG.slice(65), "\nOui, 12 kg."]));
    const { client } = await ask();
    expect(callChatStream).toHaveBeenCalledTimes(1);
    expect(client.text).toBe("Oui, 12 kg.");
    expect(transcript()).toEqual([{ role: "user", content: "Q ?" }, { role: "assistant", content: "Oui, 12 kg." }]);
    expect(deletes()).toEqual([]);
    expect(usage()).toMatchObject({ model: R1, modelsSkipped: 0 });
    expect(usage().ttftMs).not.toBeNull();
  });

  // Regression: 3c38237 — rung 1 counted a >60-char bracket line as visible
  // while it streamed (past the partial hold), committed and banked on it, then
  // counted it invisible once it closed, and rolled back through a guard
  // documented as unreachable — in two DELETEs, so a failure between them left
  // her question orphaned. The rollback is now the designed outcome of a
  // committed reply that cleans to nothing, in one statement.
  it("P1: the same line ALONE on rung 1 commits it and ends in rollback, never a fallthrough", async () => {
    callChatStream.mockResolvedValueOnce(rung1([LONG.slice(0, 65), LONG.slice(65)])).mockResolvedValueOnce(lastRung(["Vraie réponse."]));
    const { client } = await ask();
    expect(callChatStream).toHaveBeenCalledTimes(1);
    expect(client.text).toBe("");
    expect(transcript()).toEqual([]);
    expect(deletes()).toEqual([[100]]); // her row alone: the open line was never checkpointed
    expect(usage().ttftMs).toBeNull();
  });

  it("P1b: the same line alone on the LAST rung rolls back its own rows in one statement", async () => {
    callChatStream.mockResolvedValueOnce(lastRung([LONG.slice(0, 65), LONG.slice(65)]));
    const { client, raw } = await ask();
    expect(client.text).toBe("");
    expect(raw).toContain(LONG.slice(0, 20)); // it WAS sent: the client holds it off screen
    expect(userInserts()).toHaveLength(1);
    expect(deletes()).toEqual([[100]]); // her row alone: the open line was never checkpointed
    expect(transcript()).toEqual([]);
    expect(usage().ttftMs).toBeNull();
    expect(console.warn).toHaveBeenCalledWith("coach-chat: committed reply left nothing visible; rolling back its rows");
  });

  // Regression: 3c38237 — a short unclosed bracket on the last rung was
  // held by the partial predicate and never judged without it on one path, so
  // her one-line answer was dropped.
  it("P2: a short unclosed bracket on the last rung is a visible reply", async () => {
    callChatStream.mockResolvedValueOnce(lastRung(["[Oui, 3 séries"]));
    const { client } = await ask();
    expect(client.text).toBe("[Oui, 3 séries");
    expect(transcript()).toEqual([{ role: "user", content: "Q ?" }, { role: "assistant", content: "[Oui, 3 séries" }]);
    expect(deletes()).toEqual([]);
  });

  it("P3: a stamp in pieces then text — her row first, the clean text stored", async () => {
    callChatStream.mockResolvedValueOnce(lastRung(["[dim. 30 ao", "ût, 17:15]\n", "Oui, 12."]));
    const { client } = await ask();
    expect(client.text).toBe("Oui, 12.");
    expect(writes[0]).toEqual(["insert", 100, "user", "Q ?"]);
    expect(transcript()).toEqual([{ role: "user", content: "Q ?" }, { role: "assistant", content: "Oui, 12." }]);
  });

  // The accepted trade-off of a commit on the first non-whitespace character:
  // a stamp is non-whitespace, so a rung that writes ONLY a stamp commits.
  it("P4: a stamp alone on rung 1 commits it and rolls back rather than falling through", async () => {
    callChatStream.mockResolvedValueOnce(rung1([`${STAMP}\n`])).mockResolvedValueOnce(lastRung(["Réponse."]));
    const { client } = await ask();
    expect(callChatStream).toHaveBeenCalledTimes(1);
    expect(client.text).toBe("");
    expect(transcript()).toEqual([]);
  });

  // Regression: 3c38237 — the commit was judged on RAW text, so a rung-1
  // reply that was only a notebook block committed and never fell through,
  // while banking went by the splitter's output: nothing banked, no answer.
  it("P6: a notebook-only rung 1 falls through, and its notebook is not committed", async () => {
    callChatStream
      .mockResolvedValueOnce(rung1(["<<<NOTEBOOK>>>\n+ note du rung abandonné\n<<<END>>>"]))
      .mockResolvedValueOnce(lastRung(["Réponse."]));
    const { client } = await ask();
    expect(callChatStream).toHaveBeenCalledTimes(2);
    expect(client.text).toBe("Réponse.");
    expect(transcript()).toEqual([{ role: "user", content: "Q ?" }, { role: "assistant", content: "Réponse." }]);
    expect(coachDb.saveNotebook).not.toHaveBeenCalled();
    expect(usage()).toMatchObject({ model: LAST, modelsSkipped: 1 });
  });

  it("keeps the answering rung's notebook when the rung before it was abandoned", async () => {
    callChatStream
      .mockResolvedValueOnce(rung1(["<<<NOTEBOOK>>>\n+ abandonnée\n<<<END>>>"]))
      .mockResolvedValueOnce(lastRung(["Réponse.", "<<<NOTEBOOK>>>\n+ retenue\n<<<END>>>"]));
    await ask();
    expect(coachDb.saveNotebook).toHaveBeenCalledTimes(1);
    expect(coachDb.saveNotebook.mock.calls[0][0]).toContain("retenue");
    expect(coachDb.saveNotebook.mock.calls[0][0]).not.toContain("abandonnée");
  });

  // Rollback is a designed path now, exercised by real input rather than by a
  // predicate made to lie. A stamp split so that its opening is forwarded on
  // its own: « [dim » is text while it is alone, so it commits the rung, banks
  // her question; the checkpoint now strips the partial stamp too, so no reply
  // row is written for it, and the closing bracket makes the whole line an
  // echoed stamp, so the reply cleans to nothing and her row alone is undone.
  it("rolls back her row, and only that, in one statement", async () => {
    callChatStream.mockResolvedValueOnce(lastRung(["[dim. 30 août, 17", ":15]\n", "<<<NOTEBOOK>>>\n+ n\n<<<END>>>"]));
    const { client } = await ask();
    expect(client.text).toBe("");
    expect(writes.filter((w) => w[0] === "insert").map((w) => [w[1], w[2]])).toEqual([[100, "user"]]);
    expect(deletes()).toEqual([[100]]);
    expect(transcript()).toEqual([]);
    expect(usage().ttftMs).toBeNull();
    // A closed notebook from the answering rung is durable memory either way.
    expect(coachDb.saveNotebook).toHaveBeenCalledTimes(1);
  });

  // Regression: ce5f573 — the first-text budget abandoned a rung whose first
  // visible text was still HELD by the notebook splitter (under its 13-char
  // look-ahead), throwing away an answer already on its way.
  it("R6-1: a rung whose short first text is held by the splitter is kept past its budget", async () => {
    callChatStream
      .mockResolvedValueOnce(slowRung1(["Un,", 300, " deux, trois, quatre."], 100))
      .mockResolvedValueOnce(lastRung(["Medium."]));
    const { client } = await ask();
    expect(callChatStream).toHaveBeenCalledTimes(1);
    expect(client.text).toBe("Un, deux, trois, quatre.");
    expect(usage()).toMatchObject({ model: R1, modelsSkipped: 0 });
  });

  // The control: nothing held and nothing forwarded is still abandoned.
  it("R6-1: a rung that says nothing past its budget is still abandoned", async () => {
    callChatStream
      .mockResolvedValueOnce(slowRung1(["  ", 300, "tard."], 100))
      .mockResolvedValueOnce(lastRung(["Medium."]));
    const { client } = await ask();
    expect(callChatStream).toHaveBeenCalledTimes(2);
    expect(client.text).toBe("Medium.");
  });

  // Regression: ce5f573 — a checkpoint cleaned the reply with the STRICT
  // stamp rule, so a stamp cut mid-way ("[dim") was written as a reply row.
  it("R6-2: a stamp cut mid-way is never checkpointed as a reply row", async () => {
    callChatStream.mockResolvedValueOnce(lastRung(["[dim. 30 août, 17", ":15]\n", "Oui, 12."]));
    const { client } = await ask();
    expect(client.text).toBe("Oui, 12.");
    const replyWrites = writes.filter((w) => (w[0] === "insert" && w[2] === "assistant") || w[0] === "update");
    for (const w of replyWrites) expect(JSON.stringify(w)).not.toContain("[dim");
    expect(transcript()).toEqual([{ role: "user", content: "Q ?" }, { role: "assistant", content: "Oui, 12." }]);
  });

  // Regression: ce5f573 — one failed rollback DELETE left her question banked
  // while the client handed it back for a resend.
  it("R6-3: a rollback DELETE that fails once is retried", async () => {
    coachDb.deleteMessages.mockImplementationOnce(async () => {
      throw new Error("neon blip");
    });
    callChatStream.mockResolvedValueOnce(lastRung([`${STAMP}\n`]));
    await ask();
    expect(coachDb.deleteMessages).toHaveBeenCalledTimes(2);
    expect(deletes()).toEqual([[100]]);
    expect(transcript()).toEqual([]);
  });


  // Regression: 3c38237 — every delta re-ran the visible-reply predicate
  // over the WHOLE accumulated reply: O(n²), ~145 ms of CPU on a 60 KB reply
  // against a 50 ms edge budget. The whole reply is now judged a constant
  // number of times per request (checkpoints are time-bound, CHECKPOINT_MS).
  it("judges the whole reply a constant number of times, however many deltas", async () => {
    const counts = [];
    for (const n of [50, 3000]) {
      judged.n = 0;
      callChatStream.mockResolvedValueOnce(lastRung(Array.from({ length: n }, (_, k) => `mot${k} `)));
      const { client } = await ask();
      expect(client.text.startsWith("mot0 mot1")).toBe(true);
      counts.push(judged.n);
    }
    expect(counts[1]).toBe(counts[0]);
    expect(counts[1]).toBeLessThanOrEqual(4);
  });
});
