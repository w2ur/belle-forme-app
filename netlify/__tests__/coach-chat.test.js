import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import seed from "../../src/data/catalogSeed.json";
import { TEST_PROFILE } from "./testProfile.js";
import { TEST_INVENTORY } from "../../src/constants/testInventory.js";
import { STARTER_INVENTORY } from "../../src/constants/equipment.js";

vi.mock("../functions/lib/db.js", () => ({
  authorizeToken: (h) => h === "Bearer test-key",
  // The handler hands this to `loadCatalog`, which is mocked below and never
  // looks at it. Nothing here may reach a real Neon client.
  getDb: () => ({}),
}));
// The catalog read is the one memory read that is NOT caught: the coach does
// not answer without an exercise list.
const loadCatalog = vi.fn();
vi.mock("../functions/lib/catalogDb.js", () => ({ loadCatalog: (...a) => loadCatalog(...a) }));
// The profile read is not caught either: the coach does not answer without the
// inventory its loads are checked against.
const loadProfile = vi.fn();
vi.mock("../functions/lib/profileDb.js", () => ({ loadProfile: (...a) => loadProfile(...a) }));
const callChatStream = vi.fn();
vi.mock("../functions/lib/providers.js", async (importActual) => ({
  ...(await importActual()),
  callChatStream: (...a) => callChatStream(...a),
}));
const coachDb = {
  loadNotebook: vi.fn().mockResolvedValue("carnet"),
  loadRecentMessages: vi.fn().mockResolvedValue([]),
  loadAllMessages: vi.fn().mockResolvedValue([{ role: "user", content: "salut", created_at: "t" }]),
  // Returns an id, as the real INSERT ... RETURNING does: the reply row is
  // rewritten as it streams, so the caller needs something to rewrite.
  appendMessage: vi.fn().mockResolvedValue(42),
  updateMessage: vi.fn().mockResolvedValue(),
  deleteMessages: vi.fn().mockResolvedValue(),
  saveNotebook: vi.fn().mockResolvedValue(),
  recordUsage: vi.fn().mockResolvedValue(),
};
vi.mock("../functions/lib/coachDb.js", () => coachDb);

const { default: handler, TRUNCATION_NOTE, HISTORY_WINDOW, CHECKPOINT_MS, promptCacheKeyFor } =
  await import("../edge-functions/coach-chat.js");
const { HISTORY_BLOCK } = await import("../functions/lib/coachPrompt.js");
const { finalizeStream, STREAM_END_MARKER, STREAM_ERROR_MARKER } =
  await import("../../src/lib/coachStream.js");
const { PLAN_JSON_SCHEMA, PLAN_SCHEMA_NAME, buildPlanJsonSchema } = await import("../../src/lib/planSchema.js");
const { offeredExerciseNames } = await import("../functions/lib/coachPrompt.js");
const { buildPromptInputs } = await import("../functions/lib/coachPromptInputs.js");
const { buildCatalogViews } = await import("../../src/lib/catalogTestkit.js");
const { isPlanPayload } = await import("../../src/lib/planFromJson.js");

/** What the client would end up showing: the marker consumed, the verdict read. */
const shown = (raw) => finalizeStream(raw);

/** The last text written to the reply row, whichever call wrote it. */
function persistedReply() {
  const updates = coachDb.updateMessage.mock.calls;
  if (updates.length) return updates[updates.length - 1][1];
  const inserts = coachDb.appendMessage.mock.calls.filter((c) => c[0] === "assistant");
  return inserts.length ? inserts[inserts.length - 1][1] : null;
}

const enc = new TextEncoder();
const sseChunk = (obj) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
const deltaChunk = (content) => sseChunk({ choices: [{ delta: { content } }] });

// Build a ReadableStream of SSE bytes from assistant content deltas.
//
// The default is "stop" because that is what a real completed stream sends, and
// the fixture defaulting to null quietly made every happy-path test assert the
// behaviour of a BROKEN stream. Pass `{ finishReason: null }` to get the
// gemini-3.5-flash failure of 2026-08-03 — a stream that closes, reports usage,
// and never declares why it ended.
function sseStream(deltas, { finishReason = "stop" } = {}) {
  return new ReadableStream({
    start(c) {
      for (const d of deltas) c.enqueue(deltaChunk(d));
      if (finishReason) c.enqueue(sseChunk({ choices: [{ delta: {}, finish_reason: finishReason }] }));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

// A stream that dies partway, the way a quota cut-off or a dropped connection
// looks from inside the function. Deltas are emitted from `pull`, one per read:
// enqueueing them up front in `start` would be pointless, because
// controller.error() resets the queue and the reader would never see them.
function sseStreamThatDies(deltas) {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < deltas.length) return void c.enqueue(deltaChunk(deltas[i++]));
      c.error(new Error("upstream died"));
    },
  });
}

const answered = (body) => ({ res: { ok: true, body }, model: "mistral-medium-2604", attempts: [] });

async function readAll(res) {
  const r = res.body.getReader(); const dec = new TextDecoder(); let s = "";
  for (;;) { const { done, value } = await r.read(); if (done) break; s += dec.decode(value, { stream: true }); }
  return s;
}
const req = (method, body, extraHeaders = {}) => new Request("http://localhost/api/coach-chat", {
  method,
  headers: { authorization: "Bearer test-key", "content-type": "application/json", ...extraHeaders },
  body: body ? JSON.stringify(body) : undefined,
});
/** What the CURRENT client bundle sends (sync.js): it strips the keepalive byte, and says so. */
const KEEPALIVE_CLIENT = { "x-coach-stream": "keepalive" };

describe("coach-chat", () => {
  beforeEach(() => {
    callChatStream.mockReset();
    Object.values(coachDb).forEach((f) => f.mockClear());
    coachDb.loadNotebook.mockResolvedValue("carnet");
    coachDb.loadRecentMessages.mockResolvedValue([]);
    coachDb.appendMessage.mockResolvedValue(42);
    loadCatalog.mockReset();
    loadProfile.mockReset();
    // One fixed `updatedAt` across the suite, so the prompt cache builds the
    // three prompts once and every later test reads them back.
    loadCatalog.mockResolvedValue({ doc: seed, updatedAt: "2026-08-11T10:00:00Z" });
    loadProfile.mockResolvedValue({ data: TEST_PROFILE, updatedAt: "2026-08-11T09:00:00Z" });
  });

  it("rejects unauthorized requests", async () => {
    const res = await handler(new Request("http://localhost/api/coach-chat", { method: "GET", headers: {} }));
    expect(res.status).toBe(401);
  });

  it("GET returns chat history", async () => {
    const res = await handler(req("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toBe("salut");
  });

  it("POST streams visible text, hides the notebook, and persists both", async () => {
    callChatStream.mockResolvedValueOnce(
      answered(sseStream(["Beau ", "travail.", "<<<NOTEBOOK>>>", "Camille préfère le matin.", "<<<END>>>"]))
    );
    const res = await handler(req("POST", { message: "j'ai fini", exportContext: "EXPORT" }));
    expect(res.status).toBe(200);
    const { text, interrupted } = shown(await readAll(res));
    expect(text).toBe("Beau travail.");
    expect(interrupted).toBe(false);
    expect(text).not.toContain("NOTEBOOK");
    expect(coachDb.appendMessage).toHaveBeenCalledWith("user", "j'ai fini");
    expect(persistedReply()).toBe("Beau travail.");
    expect(coachDb.saveNotebook).toHaveBeenCalledWith("carnet\nCamille préfère le matin.");
  });

  // Regression: user feedback 2026-08-01 — "the flow of messages is lost from one
  // session to another". Both writes used to happen after the stream fully
  // drained, so ANY interruption erased the whole exchange from coach_messages
  // while it still sat on her screen. Reopening the app made it vanish.
  it("persists the question and the partial reply when the stream dies mid-answer", async () => {
    callChatStream.mockResolvedValueOnce(answered(sseStreamThatDies(["Commence par ", "le gainage"])));
    const res = await handler(req("POST", { message: "quoi ce soir ?" }));
    expect(res.status).toBe(200);
    const text = await readAll(res);
    // Every character that arrived is kept, including the tail the splitter was
    // still holding back when the upstream died.
    expect(text).toContain("Commence par le gainage");
    expect(text).toContain(TRUNCATION_NOTE.trim());
    expect(coachDb.appendMessage).toHaveBeenCalledWith("user", "quoi ce soir ?");
    expect(persistedReply()).toContain("Commence par le gainage");
  });

  // Regression: user feedback 2026-08-01 — "some answers are not complete". The
  // parser threw finish_reason away, so a reply cut off by max_tokens looked
  // exactly like a finished one.
  it("marks a reply the model had to cut short", async () => {
    callChatStream.mockResolvedValueOnce(
      answered(sseStream(["Séance 1 — Jambes"], { finishReason: "length" }))
    );
    const res = await handler(req("POST", { message: "programme" }));
    const text = await readAll(res);
    expect(text).toContain(TRUNCATION_NOTE.trim());
    // and she still sees it after a reload, not just live
    expect(persistedReply()).toContain(TRUNCATION_NOTE.trim());
  });

  it("leaves a normally-finished reply unmarked", async () => {
    callChatStream.mockResolvedValueOnce(answered(sseStream(["Voilà."], { finishReason: "stop" })));
    const { text, interrupted } = shown(await readAll(await handler(req("POST", { message: "ok" }))));
    expect(text).toBe("Voilà.");
    expect(interrupted).toBe(false);
    // The provisional note every checkpoint writes must not survive into a
    // finished reply — the final write is the one that decides.
    expect(persistedReply()).toBe("Voilà.");
  });

  /**
   * Regression: production 2026-08-30. The stored notebook came back as 495
   * characters, three lines, all dated that day, with zero standing decisions —
   * weeks of memory replaced by one reply. Every request that day had been
   * answered by `mistral-small-2603` (6 of 6, `models_skipped: 1`), and the
   * prompt's « reprends-le en ENTIER » was one instruction standing in front of
   * a destructive write.
   *
   * At the unit level this is `notebookDoc`'s property test. It is repeated here
   * because the defect lived at the SEAM: `applyNotebookOps` can be perfect and
   * the notebook still be destroyed if `finish()` goes on calling `saveNotebook`
   * with the raw block.
   */
  it("does not erase the notebook when the model emits one short line", async () => {
    coachDb.loadNotebook.mockResolvedValueOnce(
      "Décision (05/03) : bas du corps à 2×12 kg.\nObjectif (12/03) : dix pompes d'affilée."
    );
    callChatStream.mockResolvedValueOnce(answered(sseStream([
      "Bien joué.", "<<<NOTEBOOK>>>+ Objectif (20/03) : handstand.<<<END>>>",
    ])));
    await readAll(await handler(req("POST", { message: "j'ai fini" })));

    const saved = coachDb.saveNotebook.mock.calls.at(-1)[0];
    expect(saved).toContain("2×12 kg");
    expect(saved).toContain("dix pompes");
    expect(saved).toContain("handstand");
  });

  it("writes nothing at all when the reply carries no notebook block", async () => {
    coachDb.loadNotebook.mockResolvedValueOnce("Décision (05/03) : bas du corps à 2×12 kg.");
    callChatStream.mockResolvedValueOnce(answered(sseStream(["Oui, 10 par côté."])));
    await readAll(await handler(req("POST", { message: "l'oiseau ?" })));
    expect(coachDb.saveNotebook).not.toHaveBeenCalled();
  });

  it("removes only the line the model numbered", async () => {
    coachDb.loadNotebook.mockResolvedValueOnce(
      "Décision (05/03) : bas du corps à 2×12 kg.\nRendez-vous le 03/03."
    );
    callChatStream.mockResolvedValueOnce(answered(sseStream([
      "Noté.", "<<<NOTEBOOK>>>- 2<<<END>>>",
    ])));
    await readAll(await handler(req("POST", { message: "arrête avec le rendez-vous" })));
    expect(coachDb.saveNotebook).toHaveBeenCalledWith("Décision (05/03) : bas du corps à 2×12 kg.");
  });

  // A half-streamed block carries half-written operations, and a half-written
  // `- 12` is a removal nobody asked for.
  it("does not touch the notebook when its block never closes", async () => {
    callChatStream.mockResolvedValueOnce(
      answered(sseStreamThatDies(["Bien joué.", "<<<NOTEBOOK>>>", "moitié de mémo"]))
    );
    await readAll(await handler(req("POST", { message: "hi" })));
    expect(coachDb.saveNotebook).not.toHaveBeenCalled();
    expect(persistedReply()).toContain("Bien joué.");
  });

  it("keeps answering when the database is unreachable", async () => {
    coachDb.loadNotebook.mockRejectedValueOnce(new Error("neon down"));
    coachDb.loadRecentMessages.mockRejectedValueOnce(new Error("neon down"));
    coachDb.appendMessage.mockRejectedValue(new Error("neon down"));
    coachDb.updateMessage.mockRejectedValue(new Error("neon down"));
    callChatStream.mockResolvedValueOnce(answered(sseStream(["Toujours là."])));
    const res = await handler(req("POST", { message: "hi" }));
    expect(res.status).toBe(200);
    expect(shown(await readAll(res)).text).toBe("Toujours là.");
    coachDb.appendMessage.mockResolvedValue(42);
    coachDb.updateMessage.mockResolvedValue();
  });

  it("gives the model a working-memory window wider than a couple of exchanges", async () => {
    callChatStream.mockResolvedValueOnce(answered(sseStream(["ok"])));
    await readAll(await handler(req("POST", { message: "hi" })));
    // One block minus one more than the window: enough to place a block-aligned
    // window of HISTORY_WINDOW..HISTORY_WINDOW + HISTORY_BLOCK - 1 rows.
    expect(coachDb.loadRecentMessages).toHaveBeenCalledWith(HISTORY_WINDOW + HISTORY_BLOCK - 1);
    expect(HISTORY_WINDOW).toBeGreaterThan(15);
  });

  // The production shape: the table holds hundreds of rows, the loader returns
  // only its tail, and Neon hands `total` back as a bigint STRING. The window
  // must be placed from that total — a window computed from the tail length
  // slides by one row per turn and the prefix cache never hits.
  it("places the history window on a block boundary counted from the table total", async () => {
    const tail = Array.from({ length: HISTORY_WINDOW + HISTORY_BLOCK - 1 }, (_, k) => {
      const i = 305 - (HISTORY_WINDOW + HISTORY_BLOCK - 1) + k; // absolute index, table of 305 rows
      return { role: i % 2 ? "assistant" : "user", content: `m${i + 1}`, total: "305" };
    });
    coachDb.loadRecentMessages.mockResolvedValueOnce(tail);
    callChatStream.mockResolvedValueOnce(answered(sseStream(["ok"])));
    await readAll(await handler(req("POST", { message: "hi" })));

    const history = callChatStream.mock.calls[0][0].slice(1, -1);
    // floor((305 - 40) / 10) * 10 = 260: the window opens on row 261 and keeps 45.
    expect(history).toHaveLength(45);
    expect(history[0].content).toContain("m261");
    expect(history.at(-1).content).toContain("m305");
    for (const m of history) expect(Object.keys(m).sort()).toEqual(["content", "role"]);
  });

  // Mistral matches the key on prefix and the three mode prompts differ in
  // bytes, so the key names the mode AND the catalog version — the same ISO
  // discipline as buildPromptCache, never String(date).
  it("sends a prompt cache key naming the mode and the catalog version", async () => {
    callChatStream.mockResolvedValueOnce(answered(sseStream(["ok"])));
    await readAll(await handler(req("POST", { message: "hi", mode: "plan" })));
    // ...and the profile version too: the persona, the inventory and the notes
    // are part of the prompt, so a profile edit must move the key.
    expect(callChatStream.mock.calls[0][1].promptCacheKey).toBe("belle-forme:plan:2026-08-11T10:00:00.000Z|2026-08-11T09:00:00.000Z");
  });

  // The eval harness builds its key with this same function, so the two cannot
  // drift; an undatable catalog sends no key rather than a wrong one.
  it("promptCacheKeyFor names the served mode and the ISO catalog version, or nothing", () => {
    expect(promptCacheKeyFor("plan-emit", "2026-08-11T10:00:00Z")).toBe("belle-forme:plan-emit:2026-08-11T10:00:00.000Z");
    expect(promptCacheKeyFor("brief", new Date("2026-08-11T10:00:00Z"))).toBe("belle-forme:discussion:2026-08-11T10:00:00.000Z");
    expect(promptCacheKeyFor("plan", null)).toBeUndefined();
    expect(promptCacheKeyFor("plan", "not a date")).toBeUndefined();
    expect(promptCacheKeyFor("plan", "2026-08-11T10:00:00Z", "2026-08-11T09:00:00Z"))
      .toBe("belle-forme:plan:2026-08-11T10:00:00.000Z|2026-08-11T09:00:00.000Z");
    expect(promptCacheKeyFor("plan", "2026-08-11T10:00:00Z", null)).toBeUndefined();
  });

  it("names an unknown mode by the prompt that actually serves it", async () => {
    callChatStream.mockResolvedValueOnce(answered(sseStream(["ok"])));
    await readAll(await handler(req("POST", { message: "hi", mode: "brief" })));
    expect(callChatStream.mock.calls[0][1].promptCacheKey).toBe("belle-forme:discussion:2026-08-11T10:00:00.000Z|2026-08-11T09:00:00.000Z");
  });

  // Regression: (pending) — the source of the orphan questions. Her message was
  // banked the moment a model ACCEPTED the request, but the reply is only written
  // when there is visible text. A model that accepted and then said nothing —
  // killed early, or a reply that was entirely a notebook block — left her
  // question in coach_messages with no answer after it, permanently.
  it("banks nothing when a model accepted but never said anything visible", async () => {
    callChatStream.mockResolvedValueOnce(
      answered(sseStream(["<<<NOTEBOOK>>>", "Camille préfère le matin.", "<<<END>>>"]))
    );
    await readAll(await handler(req("POST", { message: "et demain ?" })));

    expect(coachDb.appendMessage).not.toHaveBeenCalledWith("user", "et demain ?");
    // The notebook still lands — that IS durable memory, and it closed properly.
    expect(coachDb.saveNotebook).toHaveBeenCalledWith("carnet\nCamille préfère le matin.");
  });

  it("banks her question before the reply, so the transcript stays in order", async () => {
    callChatStream.mockResolvedValueOnce(answered(sseStream(["Quatre séries."])));
    await readAll(await handler(req("POST", { message: "combien ?" })));

    const roles = coachDb.appendMessage.mock.calls.map((c) => c[0]);
    expect(roles[0]).toBe("user");
    expect(roles).toContain("assistant");
  });

  it("still banks her question when the reply is cut mid-answer", async () => {
    // The case the accept-time boundary existed to protect. It must keep working.
    callChatStream.mockResolvedValueOnce(answered(sseStreamThatDies(["Commence par ", "le gainage"])));
    await readAll(await handler(req("POST", { message: "quoi ce soir ?" })));
    expect(coachDb.appendMessage).toHaveBeenCalledWith("user", "quoi ce soir ?");
  });

  // Regression: (pending) — the user 2026-08-05, "he brings up questions from four
  // days ago out of the blue". The model was handed forty messages with no
  // timestamps, so a week of conversation read as one live thread.
  it("hands the model a history that carries its own dates and breaks", async () => {
    coachDb.loadRecentMessages.mockResolvedValueOnce([
      { role: "user", content: "vieille question", created_at: "2026-08-01T10:00:00Z" },
      { role: "assistant", content: "vieille réponse", created_at: "2026-08-01T10:01:00Z" },
      { role: "user", content: "question sans réponse", created_at: "2026-08-04T10:00:00Z" },
    ]);
    callChatStream.mockResolvedValueOnce(answered(sseStream(["ok"])));
    await readAll(await handler(req("POST", { message: "et aujourd'hui ?" })));

    const messages = callChatStream.mock.calls[0][0];
    const history = messages.slice(1, -1).map((m) => m.content).join("\n");
    expect(history).toContain("nouvelle conversation");
    expect(history).toContain("restée sans réponse");
    expect(history).toMatch(/\[.*ao[ûu]t.*\].*vieille question/);
  });

  it("POST returns 400 when message is missing", async () => {
    const res = await handler(req("POST", { exportContext: "x" }));
    expect(res.status).toBe(400);
  });

  // Nothing is banked when the whole ladder is down: the client keeps her draft
  // so she can resend, and the transcript is not left holding a stranded question.
  // The signal is in-band now — see "answering before the model does" below for
  // why a status code can no longer carry it.
  it("POST reports total ladder failure in-band, without stranding the question", async () => {
    callChatStream.mockResolvedValueOnce({ res: null, model: null, attempts: [{ model: "x", status: 429 }] });
    const res = await handler(req("POST", { message: "hi" }));
    expect(res.status).toBe(200);
    const { failed, text } = finalizeStream(await readAll(res));
    expect(failed).toBe(true);
    expect(text).toBe("");
    expect(coachDb.appendMessage).not.toHaveBeenCalled();
  });

  // Our own response headers used to be held for as long as the model took to
  // return its own — 17-28 s measured on prod — against an edge limit of 40 s.
  // One run on 2026-08-02 never got model headers within 30 s at all. The margin
  // was never comfortable; it was just untested.
  describe("answering before the model does", () => {
    it("returns the response while the model is still thinking", async () => {
      let release;
      const modelIsThinking = new Promise((r) => { release = r; });
      callChatStream.mockImplementationOnce(async () => {
        await modelIsThinking;
        return answered(sseStream(["Voilà ta séance de jeudi."]));
      });

      const pending = handler(req("POST", { message: "programme" }));
      // If the handler still awaited callChatStream, this race would time out —
      // the model promise is not resolved until the line after it.
      const winner = await Promise.race([
        pending.then(() => "response"),
        new Promise((r) => setTimeout(() => r("still-blocked"), 50)),
      ]);
      expect(winner).toBe("response");

      release();
      const res = await pending;
      expect(res.status).toBe(200);
      expect(shown(await readAll(res)).text).toBe("Voilà ta séance de jeudi.");
    });

    // The failure marker must not be mistaken for a cut-off reply: one asks her
    // to resend, the other to reload. Sending both would be ambiguous.
    it("sends the failure marker alone, never alongside the end marker", async () => {
      callChatStream.mockResolvedValueOnce({ res: null, model: null, attempts: [] });
      const raw = await readAll(await handler(req("POST", { message: "hi" })));
      expect(raw).toContain(STREAM_ERROR_MARKER);
      expect(raw).not.toContain(STREAM_END_MARKER);
    });

    // No model answered, so nothing was spent and there is nothing to account
    // for. A row here would be a request that never happened.
    it("records no usage when no model ever answered", async () => {
      callChatStream.mockResolvedValueOnce({ res: null, model: null, attempts: [] });
      await readAll(await handler(req("POST", { message: "hi" })));
      expect(coachDb.recordUsage).not.toHaveBeenCalled();
    });
  });

  // Three request kinds, two of which cannot produce a programme at all. The
  // marker for "this prompt can emit" is the section that replaced the text
  // format; the schema on the request is the other half, and both are asserted
  // together because either one alone would let a plan through the wrong door.
  describe("discussion, plan and plan-emit modes", () => {
    const systemPromptOf = () => callChatStream.mock.calls[0][0][0].content;
    const optsOf = () => callChatStream.mock.calls[0][1] ?? {};
    const send = async (body) => {
      callChatStream.mockResolvedValueOnce(answered(sseStream(["ok"])));
      await readAll(await handler(req("POST", body)));
    };

    it("defaults to discussion, where the coach is not told it produces a programme", async () => {
      await send({ message: "combien de séries ?" });
      expect(systemPromptOf()).not.toContain("## Ce que tu produis ici");
      expect(optsOf().responseFormat).toBeUndefined();
    });

    it("keeps plan mode conversational: it sees the week and still cannot write it", async () => {
      await send({ message: "pourquoi le pont fessier ?", mode: "plan" });
      expect(systemPromptOf()).not.toContain("## Ce que tu produis ici");
      expect(systemPromptOf()).toMatch(/TU NE PEUX PAS MODIFIER LE PROGRAMME/);
      expect(optsOf().responseFormat).toBeUndefined();
    });

    it("attaches the plan schema, and the emit prompt, only on plan-emit", async () => {
      await send({ message: "ma semaine", mode: "plan-emit" });
      expect(systemPromptOf()).toContain("## Ce que tu produis ici");
      const catalog = buildCatalogViews(seed);
      const { structure } = buildPromptInputs(catalog);
      const expected = buildPlanJsonSchema(
        offeredExerciseNames(structure.exerciseAvailability, catalog.blacklist)
      );
      expect(optsOf().responseFormat).toEqual({
        type: "json_schema",
        json_schema: { name: PLAN_SCHEMA_NAME, schema: expected, strict: true },
      });
    });

    // The point of the whole change, asserted at the wire rather than at the
    // builder: what actually reaches the API constrains the exercise name to
    // the catalog. Built from the SAME document the handler was given, so it
    // cannot pass against a stale hand-copied list.
    it("sends an exercise-name enum drawn from the catalog it was handed", async () => {
      await send({ message: "ma semaine", mode: "plan-emit" });
      const schema = optsOf().responseFormat.json_schema.schema;
      const names =
        schema.properties.sessions.items.properties.exercises.items.properties.name.enum;
      expect(Array.isArray(names)).toBe(true);
      expect(names.length).toBeGreaterThan(20);
      expect(names).toContain("Squat");
      // The four names the model invented on 2026-08-16, none of which exist.
      for (const invented of [
        "Traction assistée",
        "Gainage latéral jambe soulevée",
        "Gainage planche pieds au mur",
        "Poirier dos au mur",
      ]) {
        expect(names, `${invented} must be unemittable`).not.toContain(invented);
      }
      // ...while the real names they decorated are all offered.
      for (const real of ["Gainage latéral", "Gainage planche", "Traction australienne"]) {
        expect(names).toContain(real);
      }
      // The base schema is untouched, so nothing else can pick it up enumless.
      expect(
        PLAN_JSON_SCHEMA.properties.sessions.items.properties.exercises.items.properties.name.enum
      ).toBeUndefined();
    });

    it("treats an unknown mode as discussion rather than trusting the client", async () => {
      await send({ message: "x", mode: "PLAN; DROP" });
      expect(systemPromptOf()).not.toContain("## Ce que tu produis ici");
      expect(optsOf().responseFormat).toBeUndefined();
    });

    // A prototype key is exactly the sort of string that reaches a mode lookup,
    // and a plain object would answer it with something truthy.
    it("treats a prototype key as discussion, not as a system prompt", async () => {
      await send({ message: "x", mode: "constructor" });
      expect(typeof systemPromptOf()).toBe("string");
      expect(systemPromptOf()).toMatch(/coach fitness personnel de Camille/);
    });
  });

  // The profile is the other document the prompt is built from: who the coach
  // talks to, what equipment the loads are checked against, whether the cycle
  // section exists. Nothing about a particular user lives in code.
  describe("the profile the coach is given", () => {
    const ask = async (extra = {}) => {
      callChatStream.mockResolvedValueOnce(answered(sseStream(["ok"])));
      await readAll(await handler(req("POST", { message: "salut", ...extra })));
      const messages = callChatStream.mock.calls.at(-1)[0];
      return { system: messages[0].content, last: messages.at(-1).content };
    };
    let tick = 0;
    // A fresh updatedAt per profile, as a real edit would give: the prompt
    // cache is keyed on it and is shared across the whole file.
    const withProfile = (data) => loadProfile.mockResolvedValue({
      data,
      updatedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, ++tick)).toISOString(),
    });

    it("names the person and agrees with the profile's gender", async () => {
      withProfile({ ...TEST_PROFILE, name: "Noa", gender: "m" });
      const { system, last } = await ask();
      expect(system).toContain("coach fitness personnel de Noa");
      expect(system).toContain("Tu le suis semaine après");
      expect(system).not.toContain("Camille");
      expect(last).toContain("## Message de Noa");
      expect(last).toContain("## Données actuelles de Noa");
    });

    it("builds the load lists from the profile's inventory", async () => {
      withProfile({
        ...TEST_PROFILE,
        inventory: { ...TEST_INVENTORY, dumbbellOptionsKg: [3, 6, 9], barCount: 0 },
      });
      const { system } = await ask();
      expect(system).toContain("Haltères (1 paire réglable, par main) : 3, 6, 9 kg.");
      expect(system).not.toContain("Barres chargeables (par main");
    });

    it("leaves the cycle section out unless the profile opted in", async () => {
      withProfile({ ...TEST_PROFILE });
      expect((await ask()).system).not.toContain("## Cycle et périodisation");
      withProfile({ ...TEST_PROFILE, cycle: { enabled: true, lengthDays: 30 } });
      const on = (await ask()).system;
      expect(on).toContain("## Cycle et périodisation");
      expect(on).toContain("Cycle d'environ 30 jours");
    });

    it("splices the coach notes in as written, tokens included", async () => {
      withProfile({ ...TEST_PROFILE, coachNotes: "Aime les séances courtes. {{she}} $& ok" });
      const { system } = await ask();
      expect(system).toContain("## Ce que tu sais de Camille");
      expect(system).toContain("Aime les séances courtes. {{she}} $& ok");
    });

    it("rebuilds the prompts when the profile changes, and only then", async () => {
      withProfile({ ...TEST_PROFILE, name: "Alix" });
      const first = await ask();
      const second = await ask();
      expect(second.system).toBe(first.system);
      withProfile({ ...TEST_PROFILE, name: "Brune" });
      expect((await ask()).system).toContain("coach fitness personnel de Brune");
    });

    it("answers a fresh database with no profile row, in neutral words and with the starter inventory", async () => {
      loadProfile.mockResolvedValue({ data: null, updatedAt: new Date(0) });
      const { system, last } = await ask();
      expect(system).toContain("coach fitness personnel de l'utilisatrice");
      expect(last).toContain("## Message de l'utilisatrice");
      expect(system).toContain(`Haltères (1 paire réglable, par main) : ${STARTER_INVENTORY.dumbbellOptionsKg.join(", ")} kg.`);
    });

    // Like the catalog: a coach that cannot read the inventory would prescribe
    // loads the user cannot lift.
    it("refuses to answer when the profile cannot be read", async () => {
      loadProfile.mockRejectedValueOnce(new Error("neon down"));
      const res = await handler(req("POST", { message: "quoi ce soir ?" }));
      const { failed, text } = finalizeStream(await readAll(res));
      expect(failed).toBe(true);
      expect(text).toBe("");
      expect(callChatStream).not.toHaveBeenCalled();
      expect(coachDb.appendMessage).not.toHaveBeenCalled();
    });
  });

  it("rejects a method that is neither GET nor POST", async () => {
    const res = await handler(req("PUT"));
    expect(res.status).toBe(405);
  });

  // The exercise list is read from Neon per request now, not compiled in. Two
  // properties hold it together: it must cost no extra latency, and it must
  // never be missing.
  describe("the catalog the coach is given", () => {
    it("reaches the model as the exercises the document actually carries", async () => {
      callChatStream.mockResolvedValueOnce(answered(sseStream(["ok"])));
      await readAll(await handler(req("POST", { message: "hi" })));

      const systemPrompt = callChatStream.mock.calls[0][0][0].content;
      const squat = seed.exercises.find((e) => e.name === "Squat");
      expect(systemPrompt).toContain(squat.description);
      // ...and `intent` stays the user's, on this path too: the document carries it
      // and the prompt must not. Owner ruling 2026-08-11.
      expect(systemPrompt).not.toContain(squat.intent);
    });

    // Every serial Neon round trip lands in `headers_ms`, the written go-paid
    // trigger. Proved by DEADLOCK rather than by assertion, and the deadlock is
    // MUTUAL on purpose: each read announces that it has started and then waits
    // for the other to have started before it resolves. Under either
    // serialisation — memory-then-catalog or catalog-then-memory — whichever
    // read goes first waits forever for one that has not been issued yet, and
    // the test times out instead of passing.
    //
    // A one-way wait is not enough here, and that is not hypothetical: with only
    // `loadNotebook` waiting on the catalog, the test stayed GREEN under
    // `const catalog = await loadCatalog(...)` followed by the memory pair —
    // which is both the more natural refactor (the prompts read as a
    // prerequisite) and exactly the extra round trip this property forbids.
    it("issues the catalog read alongside the memory reads, never after them", async () => {
      let catalogStarted;
      let notebookStarted;
      const catalogHasStarted = new Promise((r) => { catalogStarted = r; });
      const notebookHasStarted = new Promise((r) => { notebookStarted = r; });
      loadCatalog.mockImplementationOnce(async () => {
        catalogStarted();
        await notebookHasStarted;
        return { doc: seed, updatedAt: "2026-08-11T10:00:00Z" };
      });
      coachDb.loadNotebook.mockImplementationOnce(async () => {
        notebookStarted();
        await catalogHasStarted;
        return "carnet";
      });

      callChatStream.mockResolvedValueOnce(answered(sseStream(["ok"])));
      const res = await handler(req("POST", { message: "hi" }));
      expect(shown(await readAll(res)).text).toBe("ok");
      expect(loadCatalog).toHaveBeenCalledTimes(1);
    });

    // Unlike the notebook and the history, this read is NOT caught. A coach with
    // no exercise list invents movements the user cannot do, and a wrong plan reads
    // to her as a coaching decision rather than as a bug. So the request fails
    // the way total ladder failure fails: her text goes back to the composer,
    // and nothing is written down.
    it("refuses to answer at all when the catalog cannot be read", async () => {
      loadCatalog.mockRejectedValueOnce(new Error("neon down"));
      const res = await handler(req("POST", { message: "quoi ce soir ?" }));

      expect(res.status).toBe(200);
      const { failed, text } = finalizeStream(await readAll(res));
      expect(failed).toBe(true);
      expect(text).toBe("");
      expect(callChatStream).not.toHaveBeenCalled();
      expect(coachDb.appendMessage).not.toHaveBeenCalled();
      expect(coachDb.recordUsage).not.toHaveBeenCalled();
    });

    // An empty document is the dangerous shape, not a dead connection: it fails
    // no query, and a prompt built from it would offer the user nothing while reading
    // as a deliberate choice. `loadCatalog` throws on it, and this pins that the
    // handler treats that throw exactly like an outage.
    it("treats an empty catalog document as no catalog at all", async () => {
      loadCatalog.mockImplementationOnce(async () => {
        throw new Error("catalog is empty or missing — refusing to answer without an exercise list");
      });
      const { failed } = finalizeStream(await readAll(await handler(req("POST", { message: "hi" }))));
      expect(failed).toBe(true);
      expect(callChatStream).not.toHaveBeenCalled();
    });
  });

  // Regression: user feedback 2026-08-03 — "il corrige tout le programme quand je
  // pose une question". Prod that morning: gemini-3.5-flash returned headers
  // after 99 s, emitted 43 tokens, and closed the stream with finish_reason
  // null. The reader loop ended normally and the usage chunk arrived, so neither
  // `interrupted` nor `finish_reason === "length"` matched — a 155-character
  // fragment ending mid-word was banked as a complete answer.
  //
  // What made that expensive is the second half. The fragment was the opening of
  // an apology; the user resent her question; the next model read its own severed
  // apology out of the transcript, agreed harder, and rewrote her programme.
  // Marking it is what stops a dropped stream from becoming a position.
  describe("a stream that closes without saying why", () => {
    it("marks the reply as cut, on screen AND in the transcript", async () => {
      callChatStream.mockResolvedValueOnce(
        answered(sseStream(["Camille, tu as raison de me recadrer, j'ai manqué de"], { finishReason: null }))
      );
      const { text } = shown(await readAll(await handler(req("POST", { message: "utile les Shrugs ?" }))));

      expect(text).toContain(TRUNCATION_NOTE.trim());
      // The persisted half is the one that matters: it is what the model reads
      // back on her next turn. Without it the fragment argues for itself.
      expect(persistedReply()).toContain(TRUNCATION_NOTE.trim());
    });

    // The false-positive guard. Marking every reply would be its own regression —
    // she would be told each answer was cut short.
    it("leaves a reply that ended on stop unmarked", async () => {
      callChatStream.mockResolvedValueOnce(answered(sseStream(["Voilà, c'est complet."])));
      const { text } = shown(await readAll(await handler(req("POST", { message: "et donc ?" }))));

      expect(text).toBe("Voilà, c'est complet.");
      expect(persistedReply()).not.toContain(TRUNCATION_NOTE.trim());
    });
  });

  // Regression: user feedback 2026-08-02 — replies cut mid-sentence, and gone
  // from the transcript afterwards. Netlify kills a streamed invocation at 10 s
  // and NOTHING after that point runs: no catch, no finally, no persistence. The
  // only defence is to have already written the reply down while it streamed.
  describe("surviving an interruption nothing in this process can catch", () => {
    it("banks the reply while it is still streaming, not only at the end", async () => {
      callChatStream.mockResolvedValueOnce(answered(sseStreamThatDies(["Commence par ", "le gainage"])));
      await readAll(await handler(req("POST", { message: "quoi ce soir ?" })));

      const inserted = coachDb.appendMessage.mock.calls.find((c) => c[0] === "assistant")?.[1];
      // Written before the upstream died, so it holds a PREFIX of the answer —
      // which is the whole proof: nothing at the end of the run produced it.
      expect(inserted).toContain("Commence p");
      expect(inserted).not.toContain("gainage");
      // ...and it is stored as unfinished, because at that instant it is.
      expect(inserted).toContain(TRUNCATION_NOTE.trim());
      // The end of the run then rewrites the same row with everything that made
      // it to her screen.
      expect(persistedReply()).toContain("Commence par le gainage");
    });

    it("rewrites the same bubble at every checkpoint instead of adding one", async () => {
      vi.useFakeTimers();
      try {
        const deltas = Array.from({ length: 4 }, (_, i) => `Bloc ${i} de texte assez long pour compter. `);
        let i = 0;
        const stream = new ReadableStream({
          pull(c) {
            if (i >= deltas.length) return void c.close();
            // Each chunk lands one checkpoint interval after the previous one.
            vi.advanceTimersByTime(CHECKPOINT_MS + 1);
            c.enqueue(deltaChunk(deltas[i++]));
          },
        });
        callChatStream.mockResolvedValueOnce(answered(stream));
        await readAll(await handler(req("POST", { message: "raconte" })));

        const assistantInserts = coachDb.appendMessage.mock.calls.filter((c) => c[0] === "assistant");
        expect(assistantInserts).toHaveLength(1);
        expect(coachDb.updateMessage.mock.calls.length).toBeGreaterThan(1);
        // Every rewrite targets the row the first insert returned.
        for (const [id] of coachDb.updateMessage.mock.calls) expect(id).toBe(42);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops checkpointing rather than duplicating when the insert returns no id", async () => {
      coachDb.appendMessage.mockResolvedValue(null);
      callChatStream.mockResolvedValueOnce(answered(sseStream(["Un.", " Deux.", " Trois."])));
      await readAll(await handler(req("POST", { message: "hi" })));

      const assistantWrites = coachDb.appendMessage.mock.calls.filter((c) => c[0] === "assistant");
      // One provisional row from the checkpoint that came back empty-handed,
      // one authoritative row at the end — never a new bubble every two seconds.
      expect(assistantWrites.length).toBeLessThanOrEqual(2);
      expect(coachDb.updateMessage).not.toHaveBeenCalled();
    });

    it("ends the stream with a marker, and never persists it", async () => {
      callChatStream.mockResolvedValueOnce(answered(sseStream(["Voilà."], { finishReason: "stop" })));
      const raw = await readAll(await handler(req("POST", { message: "ok" })));

      // The marker means "this function got to the end of its own work". A
      // killed invocation cannot emit it, which is exactly what makes it useful.
      expect(raw.endsWith(STREAM_END_MARKER)).toBe(true);
      expect(persistedReply()).not.toContain(STREAM_END_MARKER);
    });

    it("marks the transcript as unfinished when the reply really was cut", async () => {
      callChatStream.mockResolvedValueOnce(answered(sseStreamThatDies(["Séance 1 — Jambes, quatre séries."])));
      const raw = await readAll(await handler(req("POST", { message: "programme" })));

      // The function survived the upstream dying, so it still says so itself and
      // still closes the protocol properly.
      expect(raw.endsWith(STREAM_END_MARKER)).toBe(true);
      expect(shown(raw).interrupted).toBe(false);
      expect(shown(raw).text).toContain(TRUNCATION_NOTE.trim());
      expect(persistedReply()).toContain(TRUNCATION_NOTE.trim());
    });
  });

  // The notebook is « JAMAIS montré à l'utilisateur », and on the emit path it was going
  // out on the wire, into coach_messages, back down on every history GET and
  // into localStorage under fittrack_coach_transcript. Nothing rendered it —
  // that was verified independently — but it was one devtools panel away, which
  // for content defined by her not reading it is the same thing as showing her.
  describe("the private notebook on the plan-emit path", () => {
    const NOTE = "Camille a mal au genou droit depuis mardi, on retire les fentes.";
    const planPayload = (extra = {}) =>
      JSON.stringify({
        weekStart: "2026-08-10",
        weekEnd: "2026-08-16",
        coachNotes: "Belle semaine, on garde le rythme.",
        sessions: [{ name: "Haut du corps", warmup: [], exercises: [], cooldown: [] }],
        notebook: NOTE,
        ...extra,
      });

    /** The payload as the model streams it: many small deltas, split anywhere. */
    const inDeltas = (text, size = 17) =>
      text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? [];

    const emit = (body) => req("POST", { message: "ma semaine", mode: "plan-emit", ...body });

    it("keeps the notebook out of the stream and out of the transcript", async () => {
      callChatStream.mockResolvedValueOnce(answered(sseStream(inDeltas(planPayload()))));
      const raw = await readAll(await handler(emit()));

      expect(raw).not.toContain("genou droit");
      expect(raw).not.toContain("notebook");
      expect(persistedReply()).not.toContain("genou droit");
      expect(persistedReply()).not.toContain("notebook");

      // The controls. Without these the two assertions above would also pass on
      // a handler that streamed and persisted nothing at all, which is exactly
      // the way this proof could look green while being worthless.
      expect(raw).toContain("Belle semaine");
      expect(persistedReply()).toContain("Belle semaine");

      // ...and it is still an importable plan once it gets there.
      const { text } = shown(raw);
      expect(isPlanPayload(text)).toBe(true);
      expect(JSON.parse(text)).not.toHaveProperty("notebook");
      expect(JSON.parse(text).sessions).toHaveLength(1);
    });

    it("writes the notebook where it belongs instead", async () => {
      callChatStream.mockResolvedValueOnce(answered(sseStream(inDeltas(planPayload()))));
      await readAll(await handler(emit()));
      expect(coachDb.saveNotebook).toHaveBeenCalledWith(`carnet\n${NOTE}`);
    });

    // The buffered payload is unusable until it is complete — the user is shown a
    // placeholder for the whole stream, never the JSON — so a checkpoint could
    // only bank a fragment that can never be imported and that she never read.
    // Its absence is what turns a killed emit into "resend" rather than into a
    // « Programme interrompu » bubble stranded in the transcript forever.
    it("never checkpoints a half-written payload into the transcript", async () => {
      vi.useFakeTimers();
      try {
        const deltas = inDeltas(planPayload(), 40);
        let i = 0;
        const stream = new ReadableStream({
          pull(c) {
            if (i >= deltas.length) return void c.close();
            vi.advanceTimersByTime(CHECKPOINT_MS + 1);
            c.enqueue(deltaChunk(deltas[i++]));
          },
        });
        callChatStream.mockResolvedValueOnce(answered(stream));
        await readAll(await handler(emit()));

        expect(coachDb.updateMessage).not.toHaveBeenCalled();
        const assistantWrites = coachDb.appendMessage.mock.calls.filter((c) => c[0] === "assistant");
        expect(assistantWrites).toHaveLength(1);
        expect(assistantWrites[0][1]).not.toContain("genou droit");
      } finally {
        vi.useRealTimers();
      }
    });

    // A payload cut mid-object is not a plan and never will be: there is no
    // partial week to import, and the fragment can carry the notebook field.
    // Nothing goes out, nothing is banked, and her question is not stranded.
    it("emits nothing and banks nothing when the payload was cut mid-object", async () => {
      const cut = planPayload().slice(0, 90);
      callChatStream.mockResolvedValueOnce(answered(sseStreamThatDies(inDeltas(cut))));
      const raw = await readAll(await handler(emit()));

      expect(shown(raw).text).toBe("");
      expect(coachDb.appendMessage).not.toHaveBeenCalled();
      expect(coachDb.saveNotebook).not.toHaveBeenCalled();
      // The tokens were still spent, so the request is still accounted for.
      expect(coachDb.recordUsage).toHaveBeenCalledTimes(1);
      expect(coachDb.recordUsage.mock.calls[0][0].ttftMs).toBeNull();
    });

    // The disclosed false positive, now closed. TRUNCATION_NOTE is appended
    // whenever finish_reason is anything but "stop" — including the null seen in
    // production on 2026-08-03 — which made a COMPLETE plan fail JSON.parse on
    // the client and show « Programme interrompu ». A payload that parses whole
    // is closed by definition; the braces are stronger evidence than the header.
    it("does not decorate a payload that arrived whole, whatever the finish reason", async () => {
      callChatStream.mockResolvedValueOnce(
        answered(sseStream(inDeltas(planPayload()), { finishReason: null }))
      );
      const raw = await readAll(await handler(emit()));

      expect(raw).not.toContain(TRUNCATION_NOTE.trim());
      expect(isPlanPayload(shown(raw).text)).toBe(true);
      expect(persistedReply()).not.toContain(TRUNCATION_NOTE.trim());
    });

    it("still closes the protocol so the client knows the exchange settled", async () => {
      callChatStream.mockResolvedValueOnce(answered(sseStream(inDeltas(planPayload()))));
      const raw = await readAll(await handler(emit()));
      expect(raw.endsWith(STREAM_END_MARKER)).toBe(true);
      expect(persistedReply()).not.toContain(STREAM_END_MARKER);
    });

    it("banks her question once the payload is on its way, and only then", async () => {
      callChatStream.mockResolvedValueOnce(answered(sseStream(inDeltas(planPayload()))));
      await readAll(await handler(emit()));
      const roles = coachDb.appendMessage.mock.calls.map((c) => c[0]);
      expect(roles).toEqual(["user", "assistant"]);
    });
  });

  // Regression: production, weeks of replies ending on a VISIBLE
  // `### **Carnet mis à jour (privé)**` section. The sentinel was never emitted,
  // so saveNotebook was never called — the coach had no long-term memory at all
  // — and the user read the notes written about her.
  describe("the private notebook when the model writes it as markdown", () => {
    it("captures a trailing Carnet section and keeps it off her screen", async () => {
      callChatStream.mockResolvedValueOnce(answered(sseStream([
        "Beau travail cette semaine.\n\n",
        "### **Carnet mis à jour (privé)**\n",
        "- Camille préfère le matin.\n- On reste à 15 kg/main.",
      ])));
      const raw = await readAll(await handler(req("POST", { message: "j'ai fini" })));

      expect(shown(raw).text.trim()).toBe("Beau travail cette semaine.");
      expect(raw).not.toContain("Carnet mis à jour");
      expect(persistedReply()).not.toContain("Carnet mis à jour");
      // Both lines arrive unmarked — the markdown fallback is the model
      // ignoring the protocol entirely — so they land as adds on top of the
      // stored notebook. `parseNotebookOps` is tolerant in that one direction
      // for exactly this reason: an add can never delete.
      expect(coachDb.saveNotebook).toHaveBeenCalledWith(
        "carnet\nCamille préfère le matin.\nOn reste à 15 kg/main."
      );
    });

    // A heading has no terminator, so a reply cut inside one is indistinguishable
    // from a finished one INSIDE the splitter, and half an operations block can
    // carry half a removal, so the caller — the only thing that knows the finish
    // reason — has to refuse it. A closed <<<END>>> block on the same cut reply still lands:
    // that one proved itself.
    it("refuses a heading-sourced notebook when the reply was cut short", async () => {
      callChatStream.mockResolvedValueOnce(answered(sseStreamThatDies([
        "Beau travail.\n\n### Carnet mis à jour\n", "- moitié de mém",
      ])));
      await readAll(await handler(req("POST", { message: "j'ai fini" })));
      expect(coachDb.saveNotebook).not.toHaveBeenCalled();
    });

    it("still accepts a block that closed, even on a cut reply", async () => {
      callChatStream.mockResolvedValueOnce(answered(sseStreamThatDies([
        "Beau travail.<<<NOTEBOOK>>>note complète<<<END>>>", " et la suite qui sera coupée",
      ])));
      await readAll(await handler(req("POST", { message: "j'ai fini" })));
      expect(coachDb.saveNotebook).toHaveBeenCalledWith("carnet\nnote complète");
    });
  });

  // Regression: 7cf40bb — the upstream's last SSE line can arrive with
  // no trailing newline, and it is the line carrying finish_reason and usage.
  // Left in the parser buffer it was dropped: the reply lost its last words,
  // read as « no finish_reason », and its usage row recorded nothing. The flush
  // runs per rung through the block-aware parser, so thinking on that last
  // line is still withheld.
  it("flushes an unterminated last SSE line: its text, finish_reason and usage, never its thinking", async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(deltaChunk("Beau travail, "));
        c.enqueue(enc.encode(`data: ${JSON.stringify({
          choices: [{
            delta: { content: [
              { type: "thinking", thinking: [{ type: "text", text: "secret" }], closed: true },
              { type: "text", text: "à jeudi." },
            ] },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 50, completion_tokens: 5 },
        })}`));
        c.close();
      },
    });
    callChatStream.mockResolvedValueOnce(answered(body));
    const out = shown(await readAll(await handler(req("POST", { message: "hi" }))));
    expect(out.text).toBe("Beau travail, à jeudi.");
    expect(out.text).not.toMatch(/secret/);
    expect(coachDb.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      finishReason: "stop",
      promptTokens: 50,
      completionTokens: 5,
      thinkingChars: "secret".length,
    }));
  });

  // Usage accounting exists to answer the cost question with measurements
  // instead of assumptions. It is only worth anything if it actually fires, and
  // it is the kind of code that can be silently dead for weeks — nothing user-
  // facing changes when it stops working.
  describe("usage accounting", () => {
    // The real shape: usage arrives on its own trailing chunk, after
    // finish_reason, with an EMPTY choices array.
    const streamWithUsage = (usage) => new ReadableStream({
      start(c) {
        c.enqueue(deltaChunk("Beau travail."));
        c.enqueue(sseChunk({ choices: [{ delta: {}, finish_reason: "stop" }] }));
        c.enqueue(sseChunk({ choices: [], usage }));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });

    it("records the token counts the provider reported", async () => {
      callChatStream.mockResolvedValueOnce({
        res: { ok: true, body: streamWithUsage({
          prompt_tokens: 9000,
          completion_tokens: 700,
          prompt_tokens_details: { cached_tokens: 4000 },
        }) },
        model: "mistral-medium-2604",
        attempts: [{ model: "skipped-one", status: 429 }],
      });
      await readAll(await handler(req("POST", { message: "hi" })));

      expect(coachDb.recordUsage).toHaveBeenCalledTimes(1);
      expect(coachDb.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
        model: "mistral-medium-2604",
        modelsSkipped: 1,
        promptTokens: 9000,
        cachedTokens: 4000,
        completionTokens: 700,
        finishReason: "stop",
      }));
    });

    it("defaults rungRetries to zero when the provider result omits it", async () => {
      callChatStream.mockResolvedValueOnce(answered(streamWithUsage({ prompt_tokens: 100, completion_tokens: 10 })));
      await readAll(await handler(req("POST", { message: "hi" })));

      expect(coachDb.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ rungRetries: 0 }));
    });

    // Absent is not zero. If the compatibility layer omits cached_tokens, this
    // must stay null — recording 0 would read as "caching is not working" and
    // would be indistinguishable from a real measurement of that.
    it("records an unreported cache figure as null, never as zero", async () => {
      callChatStream.mockResolvedValueOnce({
        res: { ok: true, body: streamWithUsage({ prompt_tokens: 9000, completion_tokens: 700 }) },
        model: "mistral-medium-2604",
        attempts: [],
      });
      await readAll(await handler(req("POST", { message: "hi" })));

      const recorded = coachDb.recordUsage.mock.calls[0][0];
      expect(recorded.cachedTokens).toBeNull();
      expect(recorded.promptTokens).toBe(9000);
    });

    // Without this column a chat answer and a whole generated week share one
    // completion_tokens distribution, and the median (769 tokens since
    // 2026-08-07) cannot be read as a statement about either. It is the metric
    // the brevity work is measured against, and it could not be split after the
    // fact — nothing else in the row says which kind of request produced it.
    it("records which mode answered", async () => {
      callChatStream.mockResolvedValueOnce(answered(sseStream(["Salut."])));
      await readAll(await handler(req("POST", { message: "hi", mode: "discussion" })));
      expect(coachDb.recordUsage.mock.calls[0][0].mode).toBe("discussion");
    });

    // The NORMALIZED mode, never what the client sent. A body carrying an
    // unknown mode is answered in discussion mode — recording its own word for
    // it would describe a request that never happened, and would fragment the
    // very distribution the column exists to make readable.
    it("records the mode that actually served the request, not the one asked for", async () => {
      callChatStream.mockResolvedValueOnce(answered(sseStream(["Salut."])));
      await readAll(await handler(req("POST", { message: "hi", mode: "bref" })));
      expect(coachDb.recordUsage.mock.calls[0][0].mode).toBe("discussion");
    });

    // An interrupted request still burned tokens. Dropping those rows would bias
    // the sample toward the cheap cases, which is the wrong direction to be wrong in.
    it("still records when the stream is cut mid-reply", async () => {
      callChatStream.mockResolvedValueOnce(answered(sseStreamThatDies(["Beau "])));
      await readAll(await handler(req("POST", { message: "hi" })));

      expect(coachDb.recordUsage).toHaveBeenCalledTimes(1);
      expect(coachDb.recordUsage.mock.calls[0][0].finishReason).toBe("stream_cut");
    });

    // The user waits 17-28 s in front of a placeholder before the first character.
    // Every attempt to explain that split was arithmetic on estimates, because
    // the only clock the table had was coach_messages.created_at — stamped AFTER
    // the model returned headers, so structurally blind to the interval in
    // question. These three durations are what makes the next decision evidence.
    it("measures the wait to headers, to the first character, and to the end", async () => {
      vi.useFakeTimers();
      try {
        // The model spends this long on prefill + hidden reasoning tokens before
        // it answers us at all.
        callChatStream.mockImplementationOnce(async () => {
          vi.advanceTimersByTime(19000);
          let step = 0;
          // highWaterMark 0 so `pull` fires only on a real read. With the
          // default of 1 the stream pre-pulls at construction — i.e. inside this
          // mock, before the handler has stamped headersMs — which would move
          // the first-token delay to the wrong side of the measurement.
          return answered(new ReadableStream({
            pull(c) {
              if (step === 0) {
                vi.advanceTimersByTime(800); // headers out, first token still coming
                // Longer than the splitter's 13-character holdback, or nothing
                // reaches the client until the final flush and ttft measures the
                // end of the stream instead of its beginning.
                c.enqueue(deltaChunk("Salut Camille, on regarde ça ensemble."));
              } else if (step === 1) {
                vi.advanceTimersByTime(4000); // the visible stream itself
                c.enqueue(sseChunk({ choices: [{ delta: {}, finish_reason: "stop" }] }));
              } else {
                c.close();
              }
              step++;
            },
          }, new CountQueuingStrategy({ highWaterMark: 0 })));
        });
        await readAll(await handler(req("POST", { message: "hi" })));

        const recorded = coachDb.recordUsage.mock.calls[0][0];
        expect(recorded.headersMs).toBe(19000);
        expect(recorded.ttftMs).toBe(19800);
        expect(recorded.totalMs).toBe(23800);
      } finally {
        vi.useRealTimers();
      }
    });

    // "We waited and never got a character" is a measurement. Recording it as 0
    // would average the failures in as if they had been instant.
    it("records no time-to-first-token when no visible character ever arrived", async () => {
      callChatStream.mockResolvedValueOnce(answered(sseStreamThatDies([])));
      await readAll(await handler(req("POST", { message: "hi" })));

      const recorded = coachDb.recordUsage.mock.calls[0][0];
      expect(recorded.ttftMs).toBeNull();
      expect(typeof recorded.headersMs).toBe("number");
    });

    // The reply is the product; the analytics row is not. A failure here must
    // never reach the user.
    it("does not cost her the answer when the usage write fails", async () => {
      coachDb.recordUsage.mockRejectedValueOnce(new Error("neon down"));
      callChatStream.mockResolvedValueOnce(answered(sseStream(["Beau ", "travail."])));
      const res = await handler(req("POST", { message: "hi" }));
      expect(await readAll(res)).toContain("Beau travail.");
      expect(res.status).toBe(200);
    });
  });
  // Regression: 2026-10-01 — zai-glm-5-3 (rung 1) streams `content` as typed
  // blocks and cannot turn reasoning off. Thinking is the model reasoning about
  // her health data: it must reach neither her screen, the transcript, the
  // notebook nor the plan payload, whatever it happens to contain.
  describe("a reasoning rung's typed blocks", () => {
    const THINK = "SECRET-RAISONNEMENT sur son genou";
    const thinking = (text) => [{ type: "thinking", thinking: [{ type: "text", text }], closed: true }];
    const textBlock = (text) => [{ type: "text", text }];

    it("shows and banks the text blocks only", async () => {
      callChatStream.mockResolvedValueOnce(
        answered(sseStream(["", thinking(THINK), [...thinking(" fin."), ...textBlock("Oui, ")], "90 secondes suffisent."]))
      );
      const raw = await readAll(await handler(req("POST", { message: "90 s de repos ?" })));
      expect(shown(raw).text).toBe("Oui, 90 secondes suffisent.");
      expect(raw).not.toContain("SECRET");
      expect(persistedReply()).toBe("Oui, 90 secondes suffisent.");
      expect(coachDb.appendMessage).toHaveBeenCalledWith("user", "90 s de repos ?");
    });

    // A sentinel written INSIDE the thinking must not open a notebook block: the
    // splitter only ever sees visible text.
    it("never lets a sentinel in the thinking write the notebook", async () => {
      callChatStream.mockResolvedValueOnce(
        answered(sseStream([thinking("<<<NOTEBOOK>>>- 1<<<END>>>"), textBlock("D'accord.")]))
      );
      await readAll(await handler(req("POST", { message: "ok" })));
      expect(coachDb.saveNotebook).not.toHaveBeenCalled();
      expect(persistedReply()).toBe("D'accord.");
    });

    // The eval saw this once (next-week, 2026-10-01): the whole budget spent
    // thinking, finish=length, no visible text. It must take the existing
    // empty-reply path — nothing banked, the question handed back by the client
    // — and never become a silent empty bubble.
    it("treats a thinking-only reply as no reply, and says so in the log", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      callChatStream.mockResolvedValueOnce(
        answered(sseStream([thinking(THINK), thinking(" encore")], { finishReason: "length" }))
      );
      const raw = await readAll(await handler(req("POST", { message: "et la semaine ?" })));

      expect(raw.endsWith(STREAM_END_MARKER)).toBe(true);
      expect(shown(raw).text).toBe(""); // useCoachChat throws "empty reply" on this
      expect(raw).not.toContain("SECRET");
      expect(coachDb.appendMessage).not.toHaveBeenCalled();
      expect(coachDb.recordUsage.mock.calls[0][0]).toMatchObject({
        ttftMs: null,
        finishReason: "length",
        thinkingChars: (THINK + " encore").length,
      });
      // Once, from the rung loop: the empty-reply path does not repeat it.
      expect(warn).toHaveBeenCalledWith("coach-chat: last rung silent:", "mistral-medium-2604", {
        timedOut: false,
        interrupted: false,
        finish: "length",
        thinkingChars: (THINK + " encore").length,
      });
      expect(warn).not.toHaveBeenCalledWith("coach-chat: no visible text from", expect.anything(), expect.anything());
      warn.mockRestore();
    });

    it("imports a plan whose JSON arrives in text blocks after thinking", async () => {
      const payload = JSON.stringify({
        weekStart: "2026-10-05",
        weekEnd: "2026-10-11",
        coachNotes: "Semaine calme.",
        sessions: [{ name: "Haut du corps", warmup: [], exercises: [], cooldown: [] }],
        notebook: "note privée",
      });
      callChatStream.mockResolvedValueOnce(
        answered(sseStream([thinking(THINK), textBlock(payload.slice(0, 40)), payload.slice(40)]))
      );
      const raw = await readAll(await handler(req("POST", { message: "ma semaine", mode: "plan-emit" })));
      const { text } = shown(raw);
      expect(isPlanPayload(text)).toBe(true);
      expect(raw).not.toContain("SECRET");
      expect(raw).not.toContain("note privée");
      expect(coachDb.saveNotebook).toHaveBeenCalledWith("carnet\nnote privée");
    });
  });
  // Regression: 2562009 — zai-glm-5-3 returns headers in ~1 s and thinks
  // AFTER them, so the header timeout had already committed the ladder to it.
  // A rung-1 reply that was all thinking (finish=length or stop, nothing
  // visible) ended on the empty-reply path and Medium was never tried.
  describe("a non-final rung that thinks and says nothing", () => {
    const THINK = "SECRET-RAISONNEMENT";
    const thinking = (text) => [{ type: "thinking", thinking: [{ type: "text", text }], closed: true }];
    const textBlock = (text) => [{ type: "text", text }];
    const GLM = "zai-glm-5-3";
    const MEDIUM = "mistral-medium-2604";
    const rung = (model, body, nextRung, firstTextTimeoutMs = 15_000) => ({
      res: { ok: true, body }, model, attempts: [], rungRetries: 0, nextRung, firstTextTimeoutMs,
    });

    let warn;
    beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
    afterEach(() => warn.mockRestore());

    for (const finishReason of ["length", "stop"]) {
      it(`falls to the next rung when rung 1 only thinks (finish=${finishReason})`, async () => {
        callChatStream
          .mockResolvedValueOnce(rung(GLM, sseStream([thinking(THINK), thinking(" encore")], { finishReason }), 1))
          .mockResolvedValueOnce(rung(MEDIUM, sseStream(["Oui, ", "lundi."]), 2));
        const raw = await readAll(await handler(req("POST", { message: "lundi ?" })));

        expect(shown(raw)).toMatchObject({ text: "Oui, lundi.", interrupted: false });
        expect(raw).not.toContain("SECRET");
        expect(callChatStream).toHaveBeenCalledTimes(2);
        expect(callChatStream.mock.calls[0][1].startAt).toBe(0);
        expect(callChatStream.mock.calls[1][1].startAt).toBe(1);
        // Banked once, by the rung that answered.
        expect(coachDb.appendMessage.mock.calls.filter((c) => c[0] === "user")).toEqual([["user", "lundi ?"]]);
        expect(persistedReply()).toBe("Oui, lundi.");
        const usage = coachDb.recordUsage.mock.calls[0][0];
        expect(usage).toMatchObject({ model: MEDIUM, modelsSkipped: 1, finishReason: "stop" });
        expect(usage.ttftMs).not.toBeNull();
        expect(warn).toHaveBeenCalledWith(
          "coach-chat: falling to the next rung:",
          JSON.stringify({ model: GLM, error: "no visible text", finish: finishReason, thinkingChars: (THINK + " encore").length })
        );
      });
    }

    // Regression: b6b60b7 — the abandoned rung's parser was replaced and
    // its usage discarded, so a fallthrough under-counted what the request cost.
    it("adds an abandoned rung's tokens to the usage row", async () => {
      const usageStream = (u, deltas = []) =>
        new ReadableStream({
          start(c) {
            for (const d of deltas) c.enqueue(deltaChunk(d));
            c.enqueue(sseChunk({ choices: [{ delta: {}, finish_reason: "stop" }], usage: u }));
            c.enqueue(enc.encode("data: [DONE]\n\n"));
            c.close();
          },
        });
      callChatStream
        .mockResolvedValueOnce(rung(GLM, usageStream({ prompt_tokens: 1000, completion_tokens: 400, prompt_tokens_details: { cached_tokens: 800 } }, [thinking(THINK)]), 1))
        .mockResolvedValueOnce(rung(MEDIUM, usageStream({ prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } }, ["Oui."]), 2));
      await readAll(await handler(req("POST", { message: "lundi ?" })));
      expect(coachDb.recordUsage.mock.calls[0][0]).toMatchObject({
        model: MEDIUM,
        promptTokens: 2000,
        completionTokens: 420,
        cachedTokens: 800,
        thinkingChars: THINK.length,
      });
    });

    // Regression: 1548532 — a whitespace-only delta set sawText, so a rung
    // that emitted "\n" and then only thought was committed and ended empty.
    it("treats a whitespace-only delta as no text", async () => {
      callChatStream
        .mockResolvedValueOnce(rung(GLM, sseStream(["\n", thinking(THINK)], { finishReason: "stop" }), 1))
        .mockResolvedValueOnce(rung(MEDIUM, sseStream(["Oui."]), 2));
      const raw = await readAll(await handler(req("POST", { message: "lundi ?" })));
      expect(callChatStream).toHaveBeenCalledTimes(2);
      expect(shown(raw).text.trim()).toBe("Oui.");
      expect(coachDb.recordUsage.mock.calls[0][0]).toMatchObject({ model: MEDIUM, modelsSkipped: 1 });
    });

    // Regression: d2e979e — whitespace no longer committed a rung but was
    // still forwarded through send(), which banks her question and stamps
    // ttftMs. Twenty spaces, then only thinking, then a ladder with nothing
    // below: the error marker AND a banked question with no answer, so a
    // resend banked it twice (the 2026-08-05 orphan-question bug).
    it("sends and banks nothing for whitespace before a fallthrough that finds no rung", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      callChatStream
        .mockResolvedValueOnce(rung(GLM, sseStream([" ".repeat(20), thinking(THINK)], { finishReason: "stop" }), 1))
        .mockResolvedValueOnce({ res: null, model: null, attempts: [{ model: MEDIUM, status: 503 }], rungRetries: 0 });
      const raw = await readAll(await handler(req("POST", { message: "allô ?" })));
      expect(raw).toBe(STREAM_ERROR_MARKER);
      expect(coachDb.appendMessage).not.toHaveBeenCalled();
      console.error.mockRestore();
    });

    it("does not let the abandoned rung's whitespace lead the next rung's reply", async () => {
      callChatStream
        .mockResolvedValueOnce(rung(GLM, sseStream([" ".repeat(20), thinking(THINK)], { finishReason: "stop" }), 1))
        .mockResolvedValueOnce(rung(MEDIUM, sseStream(["Oui."]), 2));
      const raw = await readAll(await handler(req("POST", { message: "lundi ?" })));
      expect(raw.startsWith("Oui.")).toBe(true);
      expect(coachDb.appendMessage.mock.calls.filter((c) => c[0] === "user")).toHaveLength(1);
    });

    // Same regression, last rung: splitter.end() flushed the held-back
    // whitespace through send(), which banked her question with no reply row.
    it("banks nothing when the last rung says only whitespace and then thinks", async () => {
      callChatStream.mockResolvedValueOnce(
        rung("mistral-medium-2604", sseStream([" ".repeat(20), "\n", thinking(THINK)], { finishReason: "stop" }), null, null)
      );
      const raw = await readAll(await handler(req("POST", { message: "et la semaine ?" })));
      expect(shown(raw).text.trim()).toBe("");
      expect(raw.endsWith(STREAM_END_MARKER)).toBe(true);
      expect(coachDb.appendMessage).not.toHaveBeenCalled();
      expect(coachDb.recordUsage.mock.calls[0][0].ttftMs).toBeNull();
    });

    // Regression: 34b6136 — send() banked on visible.trim() while finish()
    // wrote the reply only when cleanVisibleReply (which strips an echoed date
    // stamp) was non-empty. A last rung replying only « [dim. 30 août, 17:15] »
    // banked her question, left a « [dim. 30 » checkpoint row, and the client
    // handed the question back — so a resend banked it twice.
    //
    // Since 3c38237 a stamp COMMITS the rung (it is non-whitespace) and the
    // reply is judged once at the end, so the guarantee is now held by the
    // rollback: whatever the commit wrote is deleted, and the transcript ends
    // as if nothing had been asked.
    describe("an echoed date stamp is not a reply", () => {
      const STAMP = "[dim. 30 août, 17:15]";

      for (const [name, deltas] of [
        ["a stamp alone", [STAMP]],
        ["a stamp in pieces", ["[dim. 30", " août, 17:15]"]],
        ["a stamp then a notebook block", [`${STAMP}\n`, "<<<NOTEBOOK>>>\n+ note\n<<<END>>>"]],
      ]) {
        it(`leaves no row behind on the last rung: ${name}`, async () => {
          callChatStream.mockResolvedValueOnce(rung("mistral-medium-2604", sseStream(deltas), null, null));
          const raw = await readAll(await handler(req("POST", { message: "et la semaine ?" })));
          expect(shown(raw).text).toBe("");
          // Banked at the commit, then rolled back with whatever else it wrote.
          expect(coachDb.appendMessage.mock.calls.filter((c) => c[0] === "user")).toEqual([["user", "et la semaine ?"]]);
          const ids = coachDb.deleteMessages.mock.calls.flatMap((c) => c[0]);
          expect(ids).toContain(42);
          // One id per row it wrote: her question, plus a checkpoint row if one landed.
          expect(ids).toHaveLength(1 + coachDb.appendMessage.mock.calls.filter((c) => c[0] === "assistant").length);
          expect(coachDb.recordUsage.mock.calls[0][0].ttftMs).toBeNull();
        });
      }

      it("banks once and stores the clean text when real text follows the stamp", async () => {
        callChatStream.mockResolvedValueOnce(rung("mistral-medium-2604", sseStream([`${STAMP}\n`, "Oui, ", "lundi."]), null, null));
        const raw = await readAll(await handler(req("POST", { message: "lundi ?" })));
        expect(shown(raw).text).toBe("Oui, lundi.");
        expect(coachDb.appendMessage.mock.calls.filter((c) => c[0] === "user")).toEqual([["user", "lundi ?"]]);
        expect(persistedReply()).toBe("Oui, lundi.");
        expect(coachDb.deleteMessages).not.toHaveBeenCalled();
      });

      // The accepted trade-off of committing on the first non-whitespace
      // character (3c38237): a stamp-only rung 1 no longer falls through.
      // It is rare (the stamp is normally followed by text) and it fails
      // safe: her question comes back to the composer, nothing is left behind.
      it("commits a rung 1 that says only a stamp, and rolls it back instead of falling through", async () => {
        callChatStream
          .mockResolvedValueOnce(rung(GLM, sseStream([STAMP], { finishReason: "stop" }), 1))
          .mockResolvedValueOnce(rung(MEDIUM, sseStream(["Oui."]), 2));
        const raw = await readAll(await handler(req("POST", { message: "lundi ?" })));
        expect(callChatStream).toHaveBeenCalledTimes(1);
        expect(shown(raw).text).toBe("");
        expect(coachDb.deleteMessages.mock.calls.flatMap((c) => c[0])).toContain(42);
        expect(coachDb.recordUsage.mock.calls[0][0]).toMatchObject({ model: GLM, modelsSkipped: 0, ttftMs: null });
      });
    });

    // Leading whitespace on a rung that DOES answer is part of its reply.
    it("keeps whitespace that precedes real text on the committed rung", async () => {
      callChatStream.mockResolvedValueOnce(rung(GLM, sseStream(["\n", "Oui", " lundi."]), 1));
      const raw = await readAll(await handler(req("POST", { message: "lundi ?" })));
      expect(raw.startsWith("\nOui lundi.")).toBe(true);
    });

    // Regression: 5842903 — "answered by" fired at headers, so an abandoned
    // thinking rung was logged as the model that answered.
    it("logs 'committed to' only for the rung that wrote text", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      callChatStream
        .mockResolvedValueOnce(rung(GLM, sseStream([thinking(THINK)], { finishReason: "stop" }), 1))
        .mockResolvedValueOnce(rung(MEDIUM, sseStream(["Oui."]), 2));
      await readAll(await handler(req("POST", { message: "lundi ?" })));
      const committed = log.mock.calls.filter((c) => c[0] === "coach-chat: committed to").map((c) => c[1]);
      log.mockRestore();
      expect(committed).toEqual([MEDIUM]);
    });

    // Regression: c8b3531 — a last rung that only thought was logged as
    // "answered by", the line that means a reply exists, so the log of an
    // empty-reply request named a model as having answered it.
    it("logs a silent last rung as silent, never as committed", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      callChatStream.mockResolvedValueOnce(
        rung("mistral-medium-2604", sseStream([thinking(THINK)], { finishReason: "length" }), null, null)
      );
      await readAll(await handler(req("POST", { message: "et la semaine ?" })));
      const lines = log.mock.calls.map((c) => c[0]);
      log.mockRestore();
      expect(lines).not.toContain("coach-chat: committed to");
      expect(lines).not.toContain("coach-chat: answered by");
      expect(warn).toHaveBeenCalledWith("coach-chat: last rung silent:", "mistral-medium-2604", expect.any(Object));
    });

    // Regression: 054d2af — a silent last rung logged "last rung silent"
    // in the loop AND "no visible text from" on the empty-reply path: one
    // request, two warnings.
    it("logs exactly the usage row it records, on the answered and the exhausted path", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      callChatStream.mockResolvedValueOnce(rung(MEDIUM, sseStream(["Oui."]), 2));
      await readAll(await handler(req("POST", { message: "lundi ?" })));
      callChatStream
        .mockResolvedValueOnce(rung(GLM, sseStream([thinking(THINK)], { finishReason: "stop" }), 1))
        .mockResolvedValueOnce({ res: null, model: null, attempts: [{ model: MEDIUM, status: 503 }], rungRetries: 0 });
      await readAll(await handler(req("POST", { message: "allô ?" })));
      const logged = log.mock.calls.filter((c) => c[0] === "coach-chat: usage").map((c) => JSON.parse(c[1]));
      log.mockRestore();
      console.error.mockRestore();
      const recorded = coachDb.recordUsage.mock.calls.map((c) => JSON.parse(JSON.stringify(c[0])));
      expect(recorded.map((r) => r.finishReason)).toEqual(["stop", "ladder_exhausted"]);
      // The answered line also carries the RAW upstream finish reason, which
      // has no column; the exhausted line has no upstream to report.
      expect(logged).toEqual([{ ...recorded[0], finish: "stop" }, recorded[1]]);
    });

    it("logs a silent last rung once", async () => {
      callChatStream.mockResolvedValueOnce(
        rung("mistral-medium-2604", sseStream([thinking(THINK)], { finishReason: "length" }), null, null)
      );
      await readAll(await handler(req("POST", { message: "et la semaine ?" })));
      const lines = warn.mock.calls.map((c) => c[0]).filter((l) => /silent|no visible text/.test(l));
      expect(lines).toEqual(["coach-chat: last rung silent:"]);
    });

    it("still logs a committed rung that left nothing visible", async () => {
      callChatStream.mockResolvedValueOnce(
        rung("mistral-medium-2604", sseStream(["[dim. 30 août, 17:15]\n"]), null, null)
      );
      await readAll(await handler(req("POST", { message: "et la semaine ?" })));
      const lines = warn.mock.calls.map((c) => c[0]).filter((l) => /silent|no visible text/.test(l));
      expect(lines).toEqual(["coach-chat: no visible text from"]);
    });

    // A notebook-only reply never commits (the splitter forwards nothing), so
    // on the last rung it is a silent rung, logged once, in the loop.
    it("logs a notebook-only last rung as silent", async () => {
      callChatStream.mockResolvedValueOnce(
        rung("mistral-medium-2604", sseStream(["<<<NOTEBOOK>>>\n+ note\n<<<END>>>"]), null, null)
      );
      await readAll(await handler(req("POST", { message: "et la semaine ?" })));
      const lines = warn.mock.calls.map((c) => c[0]).filter((l) => /silent|no visible text/.test(l));
      expect(lines).toEqual(["coach-chat: last rung silent:"]);
    });

    // Regression: 3c38237 — a silent last rung on plan-emit was logged in
    // the loop AND as « plan-emit produced no usable payload »: one request,
    // two warnings.
    it("logs a silent last rung once on plan-emit too", async () => {
      callChatStream.mockResolvedValueOnce(
        rung("mistral-medium-2604", sseStream([thinking(THINK)], { finishReason: "length" }), null, null)
      );
      await readAll(await handler(req("POST", { message: "ma semaine", mode: "plan-emit" })));
      const lines = warn.mock.calls.map((c) => c[0]).filter((l) => /silent|no visible text|no usable payload/.test(l));
      expect(lines).toEqual(["coach-chat: last rung silent:"]);
    });

    // A rung that keeps thinking without ever closing the stream: the first-text
    // budget is the only thing that ends it, and the abandoned body is cancelled
    // so the model stops generating.
    it("abandons a rung that is still thinking when its first-text budget runs out", async () => {
      let cancelled = false;
      const thinksForever = new ReadableStream({
        start(c) { c.enqueue(sseChunk({ choices: [{ delta: { content: thinking(THINK) } }] })); },
        cancel() { cancelled = true; },
      });
      callChatStream
        .mockResolvedValueOnce(rung(GLM, thinksForever, 1, 20))
        .mockResolvedValueOnce(rung(MEDIUM, sseStream(["Voilà."]), 2));
      const t0 = Date.now();
      const raw = await readAll(await handler(req("POST", { message: "et alors ?" })));

      expect(shown(raw).text).toBe("Voilà.");
      expect(cancelled).toBe(true);
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(coachDb.recordUsage.mock.calls[0][0]).toMatchObject({ model: MEDIUM, modelsSkipped: 1 });
      expect(warn).toHaveBeenCalledWith(
        "coach-chat: falling to the next rung:",
        expect.stringContaining('"error":"no visible text within 20 ms"')
      );
    });

    // The false-positive guard: thinking FOLLOWED by text is a normal reply, and
    // the budget stops at the first text — a slow writer is never cut.
    it("keeps a rung that thinks and then writes, however long it then takes", async () => {
      let i = 0;
      const chunks = [
        sseChunk({ choices: [{ delta: { content: thinking(THINK) } }] }),
        // Longer than the splitter's 13-character hold, so the rung commits
        // before the pause: the commit is the first character the splitter
        // FORWARDS, not the first one the model writes.
        sseChunk({ choices: [{ delta: { content: textBlock("Un, deux, trois, ") } }] }),
        "pause",
        sseChunk({ choices: [{ delta: { content: "quatre." }, finish_reason: "stop" }] }),
      ];
      const slowWriter = new ReadableStream({
        async pull(c) {
          if (i >= chunks.length) return c.close();
          const next = chunks[i++];
          if (next === "pause") return new Promise((r) => setTimeout(r, 60)); // past the 20 ms budget
          c.enqueue(next);
        },
      });
      callChatStream.mockResolvedValueOnce(rung(GLM, slowWriter, 1, 20));
      const raw = await readAll(await handler(req("POST", { message: "combien ?" })));

      expect(callChatStream).toHaveBeenCalledTimes(1);
      expect(shown(raw)).toMatchObject({ text: "Un, deux, trois, quatre.", interrupted: false });
      expect(coachDb.recordUsage.mock.calls[0][0]).toMatchObject({ model: GLM, modelsSkipped: 0 });
    });

    // The last rung has nowhere to go: no budget, no fallthrough, and a
    // thinking-only reply there takes the existing empty-reply path.
    it("never abandons the last rung", async () => {
      callChatStream.mockResolvedValueOnce(
        rung("mistral-medium-2604", sseStream([thinking(THINK)], { finishReason: "length" }), null, null)
      );
      const raw = await readAll(await handler(req("POST", { message: "et la semaine ?" })));
      expect(callChatStream).toHaveBeenCalledTimes(1);
      expect(shown(raw).text).toBe("");
      expect(raw.endsWith(STREAM_END_MARKER)).toBe(true);
      expect(coachDb.appendMessage).not.toHaveBeenCalled();
    });

    // Falling through and then finding no rung that answers is total failure,
    // not an empty reply: the error marker and nothing banked.
    //
    // Regression: 923c455 — the early return skipped recordUsage, so
    // the abandoned rung's tokens (the expensive thinking) were lost exactly
    // when the request answered nothing. The row is written with model NULL.
    it("reports total failure when the rungs below refuse, and still records what the abandoned rung cost", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const thinkingWithUsage = new ReadableStream({
        start(c) {
          c.enqueue(deltaChunk(thinking(THINK)));
          c.enqueue(sseChunk({ choices: [{ delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 900, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 100 } } }));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      callChatStream
        .mockResolvedValueOnce(rung(GLM, thinkingWithUsage, 1))
        // Two DISTINCT refused rungs below the abandoned one — the count is
        // of models, so the same id twice would read as one refusal.
        .mockResolvedValueOnce({ res: null, model: null, attempts: [{ model: MEDIUM, status: 503 }, { model: "mistral-large-4", status: 503 }], rungRetries: 0 });
      const raw = await readAll(await handler(req("POST", { message: "allô ?" })));
      expect(shown(raw).failed).toBe(true);
      expect(coachDb.appendMessage).not.toHaveBeenCalled();
      expect(coachDb.recordUsage).toHaveBeenCalledTimes(1);
      expect(coachDb.recordUsage.mock.calls[0][0]).toMatchObject({
        model: null,
        modelsSkipped: 3,
        promptTokens: 900,
        cachedTokens: 100,
        completionTokens: 300,
        thinkingChars: THINK.length,
        finishReason: "ladder_exhausted",
        headersMs: null,
        ttftMs: null,
        mode: "discussion",
      });
      console.error.mockRestore();
    });

    // The emit path buffers, so "no visible text" means no payload byte at all
    // — and its budget is chosen by mode in providers.js, which needs the mode.
    it("falls through on plan-emit too, and tells callChatStream the mode", async () => {
      const payload = JSON.stringify({
        weekStart: "2026-10-05", weekEnd: "2026-10-11", coachNotes: "ok",
        sessions: [{ name: "Haut", warmup: [], exercises: [], cooldown: [] }], notebook: "n",
      });
      callChatStream
        .mockResolvedValueOnce(rung(GLM, sseStream([thinking(THINK)], { finishReason: "length" }), 1, 40_000))
        .mockResolvedValueOnce(rung(MEDIUM, sseStream([payload]), 2, 40_000));
      const raw = await readAll(await handler(req("POST", { message: "ma semaine", mode: "plan-emit" })));
      expect(isPlanPayload(shown(raw).text)).toBe(true);
      expect(callChatStream.mock.calls[0][1].mode).toBe("plan-emit");
      expect(callChatStream.mock.calls[1][1].mode).toBe("plan-emit");
    });
  });
});

// Regression: 5009b6a — 2026-10-06, Large 4 on rung 1 writes at 20-70 tok/s,
// so the BUFFERED plan-emit path carried no bytes for 40-185 s; whether the
// edge, the CDN or iOS Safari close an idle stream before that was never
// measured. The server now ticks STREAM_KEEPALIVE_MARKER every
// EMIT_KEEPALIVE_MS while it buffers — protocol, never text: not through
// send(), so no ttft and no banked question, and stripped by the client.
const { EMIT_KEEPALIVE_MS } = await import("../edge-functions/coach-chat.js");
const { STREAM_KEEPALIVE_MARKER } = await import("../../src/lib/coachStream.js");

describe("the plan-emit keepalive", () => {
  // Outside the main describe, so its beforeEach does not run here: clear the
  // two mocks these tests count on, or an earlier test's calls are counted.
  beforeEach(() => {
    coachDb.appendMessage.mockClear();
    coachDb.recordUsage.mockClear();
  });
  const payload = JSON.stringify({
    weekStart: "2026-10-07",
    weekEnd: "2026-10-13",
    coachNotes: "Semaine allégée.",
    sessions: [{ name: "Push", warmup: [], exercises: [], cooldown: [] }],
    notebook: "rien",
  });
  /** A model that stays silent for `silentMs` of fake time, then writes the whole payload. */
  const silentThen = (silentMs, chunks) => async () => {
    let step = 0;
    return answered(
      new ReadableStream(
        {
          pull(c) {
            if (step === 0) {
              vi.advanceTimersByTime(silentMs);
              c.enqueue(deltaChunk(chunks));
            } else if (step === 1) {
              c.enqueue(sseChunk({ choices: [{ delta: {}, finish_reason: "stop" }] }));
            } else {
              c.close();
            }
            step++;
          },
        },
        new CountQueuingStrategy({ highWaterMark: 0 })
      )
    );
  };

  it("ticks one byte per interval while the payload is buffered, then stops and sends the payload whole", async () => {
    vi.useFakeTimers();
    try {
      callChatStream.mockImplementationOnce(silentThen(EMIT_KEEPALIVE_MS * 2 + 1, payload));
      const raw = await readAll(await handler(req("POST", { message: "ma semaine", mode: "plan-emit" }, KEEPALIVE_CLIENT)));
      const open = raw.indexOf("{");
      expect(open).toBeGreaterThan(0);
      // Two intervals elapsed: exactly two ticks, and nothing else, before the payload.
      expect(raw.slice(0, open)).toBe(STREAM_KEEPALIVE_MARKER.repeat(2));
      // The byte is protocol: the client's judgement sees a complete, importable plan.
      const { text, interrupted } = shown(raw);
      expect(interrupted).toBe(false);
      expect(isPlanPayload(text)).toBe(true);
      expect(text).not.toContain(STREAM_KEEPALIVE_MARKER);
      // Not a commit: her question was banked once, by the payload, not by a tick.
      expect(coachDb.appendMessage.mock.calls.filter(([role]) => role === "user")).toHaveLength(1);
      expect(coachDb.recordUsage.mock.calls[0][0].ttftMs).toBe(EMIT_KEEPALIVE_MS * 2 + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never ticks on a chat reply, which streams its own bytes", async () => {
    vi.useFakeTimers();
    try {
      callChatStream.mockImplementationOnce(silentThen(EMIT_KEEPALIVE_MS * 2 + 1, "Oui, 90 secondes suffisent amplement ici."));
      const raw = await readAll(await handler(req("POST", { message: "90 s de repos ?" }, KEEPALIVE_CLIENT)));
      expect(raw).not.toContain(STREAM_KEEPALIVE_MARKER);
      expect(shown(raw).text).toMatch(/^Oui, 90 secondes/);
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression: 0a351d6 — review round 4. The PWA is registerType 'prompt', so
  // a bundle from before the keepalive can run on her iPad for days after the
  // deploy; it does not strip the byte and would render `\u0016\u0016{…}` as
  // text, unimportable. The byte goes only to a client that announced it.
  it("never ticks for a client that did not announce it can strip the byte (an old installed bundle)", async () => {
    vi.useFakeTimers();
    try {
      callChatStream.mockImplementationOnce(silentThen(EMIT_KEEPALIVE_MS * 2 + 1, payload));
      const raw = await readAll(await handler(req("POST", { message: "ma semaine", mode: "plan-emit" })));
      expect(raw).not.toContain(STREAM_KEEPALIVE_MARKER);
      expect(raw.startsWith("{")).toBe(true); // exactly what the old bundle expects
      expect(isPlanPayload(shown(raw).text)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Regression: 92ce052 — review round 2 of the Large 4 swap, 2026-10-06. On the
// emit path nothing is sent or banked until the payload parses, so a rung that
// committed on `{` and then looped (« 13.0,13.0,… », measured) or stopped at
// finish=length used to end the request on PLAN_ERROR with Medium never tried
// — and with the keepalive holding the connection, after up to ~13 minutes.
// A non-final emit rung answers only with a payload that parses, within its
// payload budget; otherwise the ladder falls through exactly as for silence.
const { PLAN_EMIT_PAYLOAD_TIMEOUT_MS } = await import("../functions/lib/providers.js");

describe("an emit rung that writes no parseable payload is abandoned for the next rung", () => {
  // Outside the main describe: clear what these tests count, including the
  // ladder mock's call list, or earlier tests' calls are counted.
  beforeEach(() => {
    coachDb.appendMessage.mockClear();
    coachDb.recordUsage.mockClear();
    callChatStream.mockClear();
  });
  const good = JSON.stringify({
    weekStart: "2026-10-07",
    weekEnd: "2026-10-13",
    coachNotes: "Semaine allégée.",
    sessions: [{ name: "Push", warmup: [], exercises: [], cooldown: [] }],
    notebook: "rien",
  });
  const emitRung = (model, body, nextRung) => ({
    res: { ok: true, body },
    model,
    attempts: [],
    nextRung,
    firstTextTimeoutMs: nextRung === null ? null : 40_000,
    payloadTimeoutMs: nextRung === null ? null : PLAN_EMIT_PAYLOAD_TIMEOUT_MS,
  });
  const emit = () => req("POST", { message: "ma semaine", mode: "plan-emit" });

  it("falls through when the stream ends on a degenerate payload, and the next rung's plan is what she gets", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      callChatStream
        .mockResolvedValueOnce(
          emitRung("mistral-large-4", sseStream(['{"weekStart":"2026-10-07","sessions":[{"name":"Jambes","exercises":[{"weight":', "13.0,13.0,13.0,13.0,13.0,"], { finishReason: "length" }), 1)
        )
        .mockResolvedValueOnce(emitRung("mistral-medium-2604", sseStream([good]), null));
      const raw = await readAll(await handler(emit()));
      const { text, interrupted } = shown(raw);
      expect(interrupted).toBe(false);
      expect(isPlanPayload(text)).toBe(true);
      expect(JSON.parse(text).sessions[0].name).toBe("Push");
      expect(text).not.toContain("13.0,13.0");
      expect(callChatStream).toHaveBeenCalledTimes(2);
      expect(callChatStream.mock.calls[1][1].startAt).toBe(1);
      expect(warn).toHaveBeenCalledWith("coach-chat: falling to the next rung:", expect.stringContaining("payload did not parse"));
      // Round 4: on emit "committed to" names the rung whose payload PARSED, never
      // the one that merely opened a `{` and was then abandoned.
      const committed = log.mock.calls.filter((c) => c[0] === "coach-chat: committed to").map((c) => c[1]);
      expect(committed).toEqual(["mistral-medium-2604"]);
      // Her question was banked once, by the plan that parsed, and the row names the answerer.
      expect(coachDb.appendMessage.mock.calls.filter(([role]) => role === "user")).toHaveLength(1);
      expect(coachDb.recordUsage.mock.calls[0][0]).toMatchObject({ model: "mistral-medium-2604", modelsSkipped: 1, mode: "plan-emit" });
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it("falls through when the payload budget runs out mid-payload, cancelling the rung", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let cancelled = false;
      const stalling = new ReadableStream(
        {
          pull(c) {
            // First `{` within the first-text budget, then nothing more, ever.
            if (!this.started) {
              this.started = true;
              c.enqueue(deltaChunk('{"weekStart":"2026-10-07",'));
              return;
            }
            // Second pull: let the payload budget expire while this read hangs.
            vi.advanceTimersByTime(PLAN_EMIT_PAYLOAD_TIMEOUT_MS + 1);
            return new Promise(() => {});
          },
          cancel() {
            cancelled = true;
          },
        },
        new CountQueuingStrategy({ highWaterMark: 0 })
      );
      callChatStream
        .mockResolvedValueOnce(emitRung("mistral-large-4", stalling, 1))
        .mockResolvedValueOnce(emitRung("mistral-medium-2604", sseStream([good]), null));
      const raw = await readAll(await handler(emit()));
      const { text } = shown(raw);
      expect(isPlanPayload(text)).toBe(true);
      expect(cancelled).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        "coach-chat: falling to the next rung:",
        expect.stringContaining(`no complete payload within ${PLAN_EMIT_PAYLOAD_TIMEOUT_MS} ms`)
      );
      expect(coachDb.recordUsage.mock.calls[0][0]).toMatchObject({ model: "mistral-medium-2604", modelsSkipped: 1 });
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("on the LAST rung keeps the old verdict: no payload, nothing banked, her question comes back", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      callChatStream.mockResolvedValueOnce(emitRung("zai-glm-5-3", sseStream(['{"weekStart":"2026-10-07","sessions":[{"weight":', "13.0,13.0,"], { finishReason: "length" }), null));
      const raw = await readAll(await handler(emit()));
      expect(shown(raw).text).toBe("");
      expect(callChatStream).toHaveBeenCalledTimes(1);
      expect(coachDb.appendMessage).not.toHaveBeenCalled();
    } finally {
      console.warn.mockRestore();
      console.error.mockRestore();
    }
  });
});

// Regression: 68c5f07 — review round 3 of the Large 4 swap, 2026-10-06. The
// payload budget abandoned the rung whenever it fired, even when the JSON
// object had already closed and only the final usage/finish chunk was late:
// a complete plan was discarded for the next rung's.
describe("a payload budget that fires after the object closed keeps the plan", () => {
  beforeEach(() => {
    coachDb.appendMessage.mockClear();
    coachDb.recordUsage.mockClear();
    callChatStream.mockClear();
  });

  it("accepts the already-parseable buffer and never asks the next rung", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const complete = JSON.stringify({
        weekStart: "2026-10-07",
        weekEnd: "2026-10-13",
        coachNotes: "Semaine allégée.",
        sessions: [{ name: "Push", warmup: [], exercises: [], cooldown: [] }],
        notebook: "rien",
      });
      let cancelled = false;
      const closedThenSilent = new ReadableStream(
        {
          pull(c) {
            if (!this.started) {
              this.started = true;
              c.enqueue(deltaChunk(complete)); // the whole object, closed
              return;
            }
            // The finish/usage chunk never comes; the budget expires while this read hangs.
            vi.advanceTimersByTime(PLAN_EMIT_PAYLOAD_TIMEOUT_MS + 1);
            return new Promise(() => {});
          },
          cancel() {
            cancelled = true;
          },
        },
        new CountQueuingStrategy({ highWaterMark: 0 })
      );
      callChatStream.mockResolvedValueOnce({
        res: { ok: true, body: closedThenSilent },
        model: "mistral-large-4",
        attempts: [],
        nextRung: 1,
        firstTextTimeoutMs: 40_000,
        payloadTimeoutMs: PLAN_EMIT_PAYLOAD_TIMEOUT_MS,
      });
      const raw = await readAll(await handler(req("POST", { message: "ma semaine", mode: "plan-emit" })));
      const { text, interrupted } = shown(raw);
      expect(isPlanPayload(text)).toBe(true);
      expect(JSON.parse(text).sessions[0].name).toBe("Push");
      expect(interrupted).toBe(false);
      expect(cancelled).toBe(true); // the upstream is still cancelled: nothing more to read
      expect(callChatStream).toHaveBeenCalledTimes(1); // rung 1 answered; no fallthrough
      expect(warn).not.toHaveBeenCalledWith("coach-chat: falling to the next rung:", expect.anything());
      // Round 4: kept is not truncated — no « incomplete reply » warning, and the
      // row says why its finish reason and tokens are unknown rather than null.
      expect(warn).not.toHaveBeenCalledWith("coach-chat: incomplete reply from", expect.anything(), expect.anything());
      expect(coachDb.recordUsage.mock.calls[0][0]).toMatchObject({
        model: "mistral-large-4",
        modelsSkipped: 0,
        finishReason: "payload_kept_at_deadline",
      });
      // The kept payload still went through the parsed re-serialisation: no notebook on the wire.
      expect(text).not.toContain("notebook");
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});

// Regression: aad73ac — review round 5. The emit floor stopped by its payload
// budget wrote finish_reason NULL — the same as an upstream that closed without
// saying why — and logged nothing naming the budget, so the one way the floor
// is ever timed out was the one case nobody could count.
describe("the emit floor stopped by its payload budget says so", () => {
  beforeEach(() => {
    coachDb.appendMessage.mockClear();
    coachDb.recordUsage.mockClear();
    callChatStream.mockClear();
  });

  it("records finish_reason payload_budget and names the budget in the log", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let cancelled = false;
      const stalling = new ReadableStream(
        {
          pull(c) {
            if (!this.started) {
              this.started = true;
              c.enqueue(deltaChunk('{"weekStart":"2026-10-07",'));
              return;
            }
            vi.advanceTimersByTime(PLAN_EMIT_PAYLOAD_TIMEOUT_MS + 1);
            return new Promise(() => {});
          },
          cancel() {
            cancelled = true;
          },
        },
        new CountQueuingStrategy({ highWaterMark: 0 })
      );
      // The FLOOR: no next rung, no first-text budget, but the payload budget.
      callChatStream.mockResolvedValueOnce({
        res: { ok: true, body: stalling },
        model: "zai-glm-5-3",
        attempts: [],
        nextRung: null,
        firstTextTimeoutMs: null,
        payloadTimeoutMs: PLAN_EMIT_PAYLOAD_TIMEOUT_MS,
      });
      const raw = await readAll(await handler(req("POST", { message: "ma semaine", mode: "plan-emit" })));
      expect(shown(raw).text).toBe("");
      expect(cancelled).toBe(true);
      expect(callChatStream).toHaveBeenCalledTimes(1);
      expect(coachDb.appendMessage).not.toHaveBeenCalled();
      expect(coachDb.recordUsage.mock.calls[0][0]).toMatchObject({ model: "zai-glm-5-3", finishReason: "payload_budget", mode: "plan-emit" });
      expect(warn).toHaveBeenCalledWith(
        "coach-chat: plan-emit produced no usable payload",
        expect.objectContaining({ payloadBudget: `no complete payload within ${PLAN_EMIT_PAYLOAD_TIMEOUT_MS} ms` })
      );
    } finally {
      warn.mockRestore();
      console.error.mockRestore();
      vi.useRealTimers();
    }
  });
});

// Regression: 26dc156 — review round 6. The emit floor stopped by its payload
// budget BEFORE writing a byte took the « last rung silent » branch, which
// logged nothing about the budget and suppressed the only line that did.
describe("the emit floor stopped by its budget while still silent names the budget too", () => {
  beforeEach(() => {
    coachDb.recordUsage.mockClear();
    callChatStream.mockClear();
  });

  it("logs the budget on the silent-last-rung line and records payload_budget", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const silentThenStall = new ReadableStream(
        {
          pull(c) {
            if (!this.started) {
              this.started = true;
              c.enqueue(sseChunk({ choices: [{ delta: { content: "" } }] })); // the model "thinks": no visible byte
              return;
            }
            vi.advanceTimersByTime(PLAN_EMIT_PAYLOAD_TIMEOUT_MS + 1);
            return new Promise(() => {});
          },
          cancel() {},
        },
        new CountQueuingStrategy({ highWaterMark: 0 })
      );
      callChatStream.mockResolvedValueOnce({
        res: { ok: true, body: silentThenStall },
        model: "zai-glm-5-3",
        attempts: [],
        nextRung: null,
        firstTextTimeoutMs: null,
        payloadTimeoutMs: PLAN_EMIT_PAYLOAD_TIMEOUT_MS,
      });
      const raw = await readAll(await handler(req("POST", { message: "ma semaine", mode: "plan-emit" })));
      expect(shown(raw).text).toBe("");
      expect(warn).toHaveBeenCalledWith(
        "coach-chat: last rung silent:",
        "zai-glm-5-3",
        expect.objectContaining({ payloadBudget: `no complete payload within ${PLAN_EMIT_PAYLOAD_TIMEOUT_MS} ms` })
      );
      expect(coachDb.recordUsage.mock.calls[0][0]).toMatchObject({ model: "zai-glm-5-3", finishReason: "payload_budget" });
    } finally {
      warn.mockRestore();
      console.error.mockRestore();
      vi.useRealTimers();
    }
  });
});

// The Claude rungs (2026-10-12): the handler must read each rung's body with
// that rung's parser. Before createParserFor, an Anthropic stream went through
// the Mistral parser, which reads `choices[0].delta` and found nothing in
// Anthropic events: every Claude reply would have been an empty one.
describe("coach-chat on an Anthropic rung", () => {
  const fixture = (name) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
  const textOf = (sse) => sse.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)))
    .filter((e) => e.delta?.type === "text_delta").map((e) => e.delta.text).join("");
  /** The recorded wire bytes, in 64-byte slices as a socket would deliver them. */
  const wireStream = (sse) => new ReadableStream({
    start(c) {
      const bytes = enc.encode(sse);
      for (let i = 0; i < bytes.length; i += 64) c.enqueue(bytes.slice(i, i + 64));
      c.close();
    },
  });
  const opusRung = (body, extra = {}) => ({ res: { ok: true, body }, model: "claude-opus-5-5", provider: "anthropic", attempts: [], ...extra });

  beforeEach(() => {
    callChatStream.mockReset();
    Object.values(coachDb).forEach((f) => f.mockClear());
    coachDb.loadNotebook.mockResolvedValue("carnet");
    coachDb.loadRecentMessages.mockResolvedValue([]);
    coachDb.appendMessage.mockResolvedValue(42);
    loadCatalog.mockReset();
    loadCatalog.mockResolvedValue({ doc: seed, updatedAt: "2026-08-11T10:00:00Z" });
    loadProfile.mockReset();
    loadProfile.mockResolvedValue({ data: TEST_PROFILE, updatedAt: "2026-08-11T09:00:00Z" });
  });

  it("streams the text, banks it whole, and records the usage the vendor reported", async () => {
    const wire = fixture("anthropic-chat.sse");
    callChatStream.mockResolvedValueOnce(opusRung(wireStream(wire)));
    const raw = await readAll(await handler(req("POST", { message: "90 secondes de repos ?" })));
    expect(shown(raw).text).toBe(textOf(wire));
    expect(persistedReply()).toBe(textOf(wire));
    expect(persistedReply()).not.toContain(TRUNCATION_NOTE);
    const fin = wire.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((e) => e.type === "message_delta").usage;
    expect(coachDb.recordUsage.mock.calls[0][0]).toMatchObject({
      model: "claude-opus-5-5",
      finishReason: "stop",
      promptTokens: fin.input_tokens + fin.cache_read_input_tokens + fin.cache_creation_input_tokens,
      cachedTokens: fin.cache_read_input_tokens,
      completionTokens: fin.output_tokens,
    });
  });

  // Review finding (2026-10-12): fallbacks:"default" lets another model
  // answer inside the call; the usage row must name the model that answered.
  it("records the model a server-side fallback switched to", async () => {
    const line = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
    const wire = [
      line({ type: "message_start", message: { model: "claude-sonnet-5-5", usage: { input_tokens: 10 } } }),
      line({ type: "content_block_start", index: 0, content_block: { type: "fallback", from: { model: "claude-sonnet-5-5" }, to: { model: "claude-opus-4-8" } } }),
      line({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      line({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Oui, 90 secondes suffisent." } }),
      line({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } }),
    ].join("");
    callChatStream.mockResolvedValueOnce({ ...opusRung(wireStream(wire)), model: "claude-sonnet-5-5" });
    await readAll(await handler(req("POST", { message: "90 secondes ?" })));
    expect(coachDb.recordUsage.mock.calls[0][0]).toMatchObject({ model: "claude-opus-4-8" });
  });

  it("never sends thinking text to her", async () => {
    callChatStream.mockResolvedValueOnce(opusRung(wireStream(fixture("anthropic-thinking.sse"))));
    const raw = await readAll(await handler(req("POST", { message: "90 secondes de repos ?" })));
    expect(raw).not.toContain("SECRET-THINKING");
    expect(persistedReply()).not.toContain("SECRET-THINKING");
  });

  it("marks a reply cut by a mid-stream overload as incomplete", async () => {
    const wire = fixture("anthropic-error-mid.sse");
    callChatStream.mockResolvedValueOnce(opusRung(wireStream(wire)));
    await readAll(await handler(req("POST", { message: "90 secondes de repos ?" })));
    expect(persistedReply()).toContain(textOf(wire));
    expect(persistedReply()).toContain(TRUNCATION_NOTE);
    expect(coachDb.recordUsage.mock.calls[0][0]).toMatchObject({ finishReason: "error: overloaded_error" });
  });

  it("buffers an Anthropic plan emit and sends it without the notebook field", async () => {
    callChatStream.mockResolvedValueOnce(opusRung(wireStream(fixture("anthropic-emit.sse")), {
      nextRung: 1, firstTextTimeoutMs: 40_000, payloadTimeoutMs: 240_000,
    }));
    const raw = await readAll(await handler(req("POST", { message: "ma semaine", mode: "plan-emit" })));
    const { text } = shown(raw);
    const payload = JSON.parse(text);
    expect(isPlanPayload(payload)).toBe(true);
    expect(payload).not.toHaveProperty("notebook");
    expect(coachDb.recordUsage.mock.calls[0][0]).toMatchObject({ model: "claude-opus-5-5", mode: "plan-emit", finishReason: "stop" });
  });
});
