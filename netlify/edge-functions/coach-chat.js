// netlify/edge-functions/coach-chat.js — the coach conversation.
//
// WHY THIS IS AN EDGE FUNCTION AND NOT A REGULAR ONE.
//
// THE NUMBERS IN THIS SECTION ARE FROM THE GEMINI ERA (July-August 2026) and are
// kept because they are what the decision was made on, not because they still
// describe a request. The coach moved to Mistral on 2026-08-03; the current
// figures are at the bottom of this block. THE DECISION ITSELF STANDS — the
// margin it bought is smaller now, but it is the reason a bad day degrades into
// a slow answer instead of a lost one.
//
// Long replies were dying on the regular function, and short ones were not.
// Measured on 2026-08-02 (`coach_usage`, prod, one hour of the user's use): EIGHT
// questions, TWO replies persisted, TWO usage rows. Six exchanges she had read
// on screen reached neither. Both writes live in the same `finally`, so the run
// ended before it — no truncation note, no reply, no usage row, no log line.
// It read to her as "the connection is unstable".
//
// The function logs named it exactly: **the limit enforced is 30 s of total
// execution, not the 10 s Netlify documents for streamed responses.** Six
// invocations that hour report `Duration: 30000 ms` on the nose and stop there;
// the two survivors report 27771 ms and 25052 ms. That is the whole split — two
// requests came in a few seconds under the wall, six hit it.
//
// And the wall was reached almost entirely BEFORE a single token was streamed.
// `answered by` was then logged the moment the model returned response headers
// (since 2026-10-01 the line is `committed to`, logged when a rung commits
// to its first text, because a thinking rung returns headers and may never
// speak), and it landed 17 to 28 SECONDS into every run: 22-27k prompt
// tokens to ingest, plus the hidden reasoning tokens. The streaming itself
// took about 8 s. Shortening the reply was never going to fix that; the time was spent before the reply
// existed. (The prompt breakdown is measured: history is the largest block at
// ~51%, not the export context — see budgetHistory in coachPrompt.js.)
//
// On this edge function a 3588-token reply completed in 18.4 s of streaming,
// persisted and accounted for.
//
// WHERE MISTRAL LEAVES THIS. Measured 2026-08-03 against a real ~14.2k-token
// French prompt, 8 calls: headers in 0.84-6.9 s, no 503s — against Gemini's
// 1.9-99.3 s on prod. Most of the pre-token wall is simply gone, so a regular
// function would probably survive a typical request today. That is not a reason
// to move back. The wall it would reintroduce is a 30 s TOTAL execution budget,
// and prefill still scales hard with prompt size: a 33.6k-token prompt took 47 s
// to return headers in the same session. A ladder that falls through to rung 2
// spends its budget twice. Going back would trade a failure mode that costs the user
// a slow answer for one that silently eats the answer entirely.
//
// CAUTION for whoever touches the shape of this handler: `callChatStream` is
// awaited INSIDE the stream, after the Response has gone out. It used to be
// awaited before, which held our own response headers for as long as the model
// took to return its own — 17-28 s under Gemini — against an edge limit of 40 s,
// and one prod run never got model headers within 30 s at all. The cost of the
// move is that no HTTP status can describe the outcome any more, which is what
// STREAM_ERROR_MARKER carries instead. Do not move it back: it costs nothing on
// a fast vendor and it is the only thing standing between a slow day and a
// platform timeout.
//
// Measured 2026-08-03, and the reason callChatStream now bounds each rung: a
// model can hold the request for 99 s and then die with a 43-token fragment.
//
// Edge functions are metered on CPU (50 ms per request) rather than wall clock,
// with no documented cap on how long a response may stream. Proxying an SSE
// stream is almost entirely I/O, which is why this moved rather than being
// shortened: no amount of prompt tuning makes a weekly programme short.
// The checkpointing below is the part that does not depend on any of this being
// diagnosed correctly — it makes a lost reply impossible whatever killed the run.
//
// The CPU budget is why the system prompts are built once per CATALOG, below,
// rather than once per request.
import { authorizeToken, getDb } from "../functions/lib/db.js";
import { callChatStream, createParserFor, jsonSchemaResponseFormat } from "../functions/lib/providers.js";
import { createSSEParser, normalizeUsage, incompleteReason } from "../functions/lib/sse.js";
import { createNotebookSplitter } from "../functions/lib/notebookStream.js";
import {
  applyNotebookOps,
  parseNotebookOps,
  renderNotebookForPrompt,
} from "../functions/lib/notebookDoc.js";
import { splitPlanPayload } from "../functions/lib/planEmit.js";
import {
  buildSystemPrompt,
  buildMessages,
  offeredExerciseNames,
  alignHistoryWindow,
  HISTORY_BLOCK,
} from "../functions/lib/coachPrompt.js";
import { annotateHistory } from "../functions/lib/historyView.js";
import { buildPromptInputs } from "../functions/lib/coachPromptInputs.js";
import { loadCatalog } from "../functions/lib/catalogDb.js";
import { loadProfile } from "../functions/lib/profileDb.js";
import { buildCatalogViews } from "../../src/lib/catalog.js";
import {
  loadNotebook,
  saveNotebook,
  loadRecentMessages,
  loadAllMessages,
  appendMessage,
  updateMessage,
  deleteMessages,
  recordUsage,
} from "../functions/lib/coachDb.js";
import {
  STREAM_END_MARKER,
  STREAM_ERROR_MARKER,
  STREAM_KEEPALIVE_MARKER,
  TRUNCATION_NOTE,
  cleanVisibleReply,
  stripEchoedAnnotation,
  stripNotebookAnnouncement,
} from "../../src/lib/coachStream.js";
import { PLAN_SCHEMA_NAME, buildPlanJsonSchema } from "../../src/lib/planSchema.js";

// Declared here rather than in netlify.toml so the route travels with the file.
// It shadows the /api/* redirect for this one path; every other endpoint still
// resolves to a regular function.
export const config = { path: "/api/coach-chat" };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

/**
 * How many past messages the MODEL sees. The client renders far more (see
 * loadAllMessages) — this is the coach's working memory, and at 15 it was about
 * seven exchanges, after which the coach genuinely lost the thread and the user had
 * to re-explain herself. Everything older still has to survive in the notebook.
 *
 * It is a FLOOR now, not a size: the window drops rows in whole HISTORY_BLOCKs
 * (alignHistoryWindow, coachPrompt.js) so the prompt prefix stays byte-identical
 * and Mistral's prefix cache can hit, which makes it 40..49 rows long. The
 * loader therefore reads HISTORY_WINDOW + HISTORY_BLOCK - 1 rows.
 */
export const HISTORY_WINDOW = 40;

/**
 * How often the reply in progress is written back to the transcript.
 *
 * This is the bound on what an interruption can cost her: at worst the last
 * couple of seconds of an answer she had already read. Lower would mean more
 * Neon round trips inside the read loop, each one delaying a token she is
 * waiting for.
 */
export const CHECKPOINT_MS = 2000;

/**
 * How often the BUFFERED plan-emit path puts a byte on the wire while the
 * payload is still being generated (STREAM_KEEPALIVE_MARKER, coachStream.js).
 * Large 4 (rung 1 from 2026-10-06 to 10-12, rung 3 since) writes at 20-70
 * tokens/s, so a 2-4k-token payload is 40-185 s of a connection that would
 * otherwise carry nothing (the Claude rungs emit in ~25-60 s); production
 * had survived 53 s of that, and whether the edge, the CDN or iOS Safari close
 * an idle stream somewhere past it has never been measured. Ten seconds is
 * well under any plausible idle timeout and costs one byte and one microtask
 * each — the edge meters CPU, not bytes. Never sent on a chat reply, which
 * streams its own text, and never through send(): a keepalive is not a commit.
 */
export const EMIT_KEEPALIVE_MS = 10_000;

// Re-exported: the note is part of the client/server contract and now lives in
// src/lib/coachStream.js, where the client can reach it too.
export { TRUNCATION_NOTE };

/**
 * The three system prompts, rebuilt only when the catalog document changes.
 *
 * They used to be three module-level constants, built once per isolate, and the
 * CPU budget that made this an edge function (50 ms/request) is why. A catalog
 * that lives in Neon cannot be read at module scope, so the property is kept by
 * caching on the document's updated_at instead: an isolate serving an unchanged
 * catalog does no prompt-building work at all. It is also what keeps the
 * byte-identical prefix any prompt cache needs a structural property rather
 * than a coincidence.
 *
 * Three variants rather than one: neither conversational mode is ever told that
 * it produces a programme, so the coach cannot emit one there — capability
 * removed rather than refrained from. Three stable prefixes are still stable
 * prefixes.
 *
 * Exported for its test — it is a closure, not a singleton, so the test can
 * build its own without reaching into module state.
 */
export function buildPromptCache(build) {
  let key = null;
  let value = null;
  return {
    get(doc, updatedAt) {
      const nextKey = catalogVersionKey(updatedAt);
      // An undatable document rebuilds, every time: `nextKey === null` is
      // checked FIRST and separately, because the initial `key` is also null
      // and a plain inequality would read the two as a hit.
      if (nextKey === null || key !== nextKey || value === null) {
        value = build(doc);
        key = nextKey;
      }
      return value;
    },
  };
}

/**
 * One catalog document version, as a comparable string.
 *
 * ISO-8601 rather than `String(updatedAt)`, and that is a correctness fix
 * rather than a tidy-up. The Neon driver returns a `Date` for a `timestamptz`,
 * and `String(date)` renders to the SECOND — `2026-08-14T08:10:54.805Z` becomes
 * `Fri Aug 14 2026 10:10:54 GMT+0200`. Two catalog writes 800 ms apart in the
 * same second would therefore share a key, and every warm isolate would go on
 * serving the older prompts indefinitely while reading the newer document. The
 * failure is silent in both directions: nothing errors, and the coach simply
 * describes a catalog that is no longer there.
 *
 * Null for anything that is not a usable instant — a null column, a value the
 * driver could not parse. That forces a rebuild rather than throwing:
 * `new Date(undefined).toISOString()` raises a RangeError, and this runs on the
 * one path that must stay debuggable rather than 500. Rebuilding costs CPU;
 * serving a prompt we cannot date is the exact bug this key exists to prevent,
 * so the cheap answer is the wrong one here.
 */
function catalogVersionKey(updatedAt) {
  // Several documents feed one prompt (the catalog and the profile), so a list
  // of timestamps is one key: every part must be datable, or none is.
  if (Array.isArray(updatedAt)) {
    const keys = updatedAt.map(catalogVersionKey);
    return keys.includes(null) ? null : keys.join("|");
  }
  if (updatedAt === null || updatedAt === undefined) return null;
  const ms = new Date(updatedAt).getTime();
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

const promptCache = buildPromptCache(({ doc, profile }) => {
  // The inventory comes from the profile, so the catalog views are built with
  // it: every validator handed these views is handed the same equipment the
  // prompt describes.
  const catalog = buildCatalogViews(doc, profile?.inventory);
  const { equipment, structure, coaching } = buildPromptInputs(catalog, profile);
  const buildFor = (mode) =>
    buildSystemPrompt(catalog.muscleGroups, equipment, catalog.blacklist, structure, coaching, mode);
  // The three prompts and nothing else. The views object stays local: keeping it
  // on the cached value would be state nothing reads, held for the lifetime of
  // an isolate, on a function metered by CPU. Whatever needs it later can take
  // it then — and will then be responsible for reading the same version the
  // prompts were built from.
  return {
    discussion: buildFor("discussion"),
    plan: buildFor("plan"),
    planEmit: buildFor("plan-emit"),
    // Cached with the prompts, on the same two versions: the headings
    // `buildMessages` writes around the user's data carry the name.
    persona: coaching.persona,
    // Cached beside the prompts and keyed on the same catalog version, so the
    // enum the API enforces and the catalog the model was shown are the same
    // document BY CONSTRUCTION rather than by two calls happening to agree.
    // Building it per request would also cost CPU on a function metered at
    // 50 ms — the same reason the prompts are cached at all.
    planSchema: buildPlanJsonSchema(
      offeredExerciseNames(structure.exerciseAvailability, catalog.blacklist)
    ),
  };
});

/**
 * Anything that is not exactly "plan" or "plan-emit" is discussion. The mode
 * decides whether the model is even CAPABLE of emitting an importable
 * programme, so it is never taken on trust from the client.
 *
 * Written as a chain rather than a lookup object on purpose: a plain object
 * would answer `PROMPTS["constructor"]` with something truthy, and a client
 * string is exactly the sort of value that reaches a key lookup.
 */
const systemPromptFor = (prompts, mode) =>
  mode === "plan-emit" ? prompts.planEmit : mode === "plan" ? prompts.plan : prompts.discussion;

/**
 * The same three-way decision, as a value rather than as a prompt — for the
 * usage row, which must record which prompt actually served the request and
 * NOT what the client asked for. A body carrying `mode: "brief"` is answered in
 * discussion mode, so recording "brief" would describe a request that never
 * happened and split the distribution the column exists to keep readable.
 */
const normalizeMode = (mode) =>
  mode === "plan-emit" ? "plan-emit" : mode === "plan" ? "plan" : "discussion";

/**
 * The `prompt_cache_key` for one request: the served mode and the catalog
 * version, or undefined for an undatable catalog (served uncached rather than
 * under a wrong key). Exported so scripts/coach-eval.mjs sends exactly what
 * production sends.
 */
export function promptCacheKeyFor(mode, catalogUpdatedAt, profileUpdatedAt) {
  // The profile is part of the prompt (persona, inventory, notes), so a profile
  // edit moves the key exactly as a catalog edit does. Omitted: catalog only.
  const version = catalogVersionKey(
    profileUpdatedAt === undefined ? catalogUpdatedAt : [catalogUpdatedAt, profileUpdatedAt]
  );
  return version ? `belle-forme:${normalizeMode(mode)}:${version}` : undefined;
}

/**
 * The in-band failure the client already knows how to read: her question comes
 * back to the composer, nothing is banked, nothing is accounted for.
 *
 * Used when the catalog read fails, which is the one memory read that is NOT
 * caught. A Neon outage costs the coach its notebook and its transcript, not
 * its voice — but a coach with no exercise list invents movements the user cannot
 * do, and this app's whole guardrail layer exists because a wrong plan reads to
 * her as a coaching decision rather than as a bug. A loud failure is
 * debuggable; a silent empty catalog is not.
 *
 * A 200 with a marker rather than a status code, for the same reason the
 * in-stream path uses one: this is the shape the client parses.
 */
const streamFailure = () =>
  new Response(STREAM_ERROR_MARKER, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });

/**
 * The schema rides on the emit request ONLY, so a conversational reply is never
 * constrained to JSON. Probed live 2026-08-10 on both rungs: strict
 * `json_schema` produced a valid plan first try, `json_object` failed on both.
 */
const responseFormatFor = (mode, schema) =>
  mode === "plan-emit"
    ? jsonSchemaResponseFormat(PLAN_SCHEMA_NAME, schema)
    : undefined;

export default async (req) => {
  // Everything recorded in coach_usage is measured from here, so the numbers
  // include our own overhead (the three Neon reads) rather than quietly
  // excluding it. The user's clock starts when the request lands, not when we get
  // around to calling the model.
  const t0 = Date.now();

  if (!authorizeToken(req.headers.get("authorization"))) return json({ error: "Unauthorized" }, 401);

  if (req.method === "GET") {
    const messages = await loadAllMessages();
    return json({ messages });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid body" }, 400); }
  const { message, exportContext, mode } = body || {};
  if (typeof message !== "string" || !message.trim()) return json({ error: "Message required" }, 400);

  // THREE reads, ONE round trip's worth of latency. Every serial Neon call
  // lands directly in `headers_ms`, which is the written go-paid trigger for
  // this project — a third sequential read would corrupt the one metric the
  // vendor decision rests on.
  //
  // The catalog is the odd one out, deliberately. A database that is down
  // should cost the coach its MEMORY, not its voice: the notebook/history pair
  // has its own catch (they used to be un-caught, so a Neon hiccup turned every
  // message into a 500 — one of the "connection problems" as the user experienced
  // them). The catalog read is not caught, so it takes the whole request down
  // the failure path — see `streamFailure`.
  //
  // Declared without defaults: the memory read has its own fallback below, and
  // the catalog read RETURNS rather than falling through, so there is no path
  // that reaches `buildMessages` with either of these unassigned.
  let notebook;
  let history;
  let prompts;
  let catalogUpdatedAt;
  let profileUpdatedAt;
  try {
    const [catalog, profile, memory] = await Promise.all([
      loadCatalog(getDb()),
      loadProfile(getDb()),
      Promise.all([loadNotebook(), loadRecentMessages(HISTORY_WINDOW + HISTORY_BLOCK - 1)]).catch((e) => {
        console.error("coach-chat: memory unavailable, answering without it:", e);
        return ["", []];
      }),
    ]);
    [notebook, history] = memory;
    // Inside the try for the same reason the read is: a document that cannot
    // produce a prompt is as unusable as one that never arrived, and both fail
    // the same way rather than half-building a catalog the coach then invents
    // around.
    prompts = promptCache.get(
      { doc: catalog.doc, profile: profile.data },
      [catalog.updatedAt, profile.updatedAt]
    );
    catalogUpdatedAt = catalog.updatedAt;
    profileUpdatedAt = profile.updatedAt;
  } catch (e) {
    console.error("coach-chat: no usable catalog, refusing to answer:", e);
    return streamFailure();
  }

  // Mistral's prefix cache is routed by this key and matched on bytes. One key
  // per system prompt: the three modes differ in bytes, so a shared key would let
  // a plan turn evict the discussion prefix. The catalog version uses the same
  // ISO key as buildPromptCache, never String(date). An undatable catalog sends
  // no key — the request is served all the same, only uncached.
  const promptCacheKey = promptCacheKeyFor(mode, catalogUpdatedAt, profileUpdatedAt);

  const messages = buildMessages({
    systemPrompt: systemPromptFor(prompts, mode),
    persona: prompts.persona,
    // NUMBERED, because the numbers are the addresses a `- n` operation refers
    // to. Rendered here rather than inside `buildMessages` so `coachPrompt.js`
    // keeps importing nothing at all — every fact it states is injected.
    notebook: renderNotebookForPrompt(notebook),
    exportContext,
    // Annotated BEFORE budgeting, which happens inside buildMessages: a session
    // break prefixed to an assistant turn has to survive the 600-char abridging,
    // and it does because it sits at the front of the string.
    //
    // Aligned BEFORE annotating: the window's first row is fixed for a whole
    // block, and so is its stamp, which annotateHistory computes against an
    // absent predecessor. `total` is the whole table (loadRecentMessages), not
    // the tail — see alignHistoryWindow for why the tail length cannot be used.
    history: annotateHistory(
      alignHistoryWindow(history, { window: HISTORY_WINDOW, total: Number(history[0]?.total ?? history.length) })
    ),
    historyWindow: HISTORY_WINDOW,
    userMessage: message,
    now: new Date(t0),
    // NORMALIZED, never the client's own word — same reason coach_usage.mode is.
    // The reminder decides what the reply may look like, so it has to agree with
    // the prompt that decides what the reply may DO: a body carrying an unknown
    // mode is answered in discussion mode, and must be shaped that way too.
    mode: normalizeMode(mode),
  });

  // Assigned inside the stream, once a model has actually answered. They are
  // declared out here because `finish` and the accounting block below close over
  // them, and both run in the stream's `finally`.
  let model = null;
  let attempts = [];
  let rungRetries = 0;
  let headersMs = null;

  /**
   * The emit path is BUFFERED, and it is the only one that is.
   *
   * Its reply is a single JSON object carrying a `notebook` field the schema
   * itself calls « JAMAIS montré à l'utilisateur ». Streaming it incrementally put those
   * private notes on the wire, into `coach_messages`, back down on every history
   * GET, and into `localStorage` under `fittrack_coach_transcript`. Nothing ever
   * RENDERED them — a JSON-shaped assistant turn never reaches ReactMarkdown —
   * but for content defined by her not reading it, "one devtools panel away" is
   * not a meaningful distinction.
   *
   * Buffering costs her nothing visible: during an emit stream the client shows
   * a placeholder (`PLAN_WAIT_TEXT`) and never the payload as it arrives,
   * so there is no incremental output to lose. What it does cost is
   * checkpointing — see the `finally` block, where that trade is spelled out.
   */
  const emitting = mode === "plan-emit";
  // The keepalive byte is OPT-IN per client (review round 4): the PWA updates
  // only when the user accepts the prompt, so an old bundle can be on her iPad for
  // days after a deploy, and that bundle does not strip the byte — it would
  // see `\u0016\u0016{…}` and render the plan as text. A client that strips it
  // says so (sync.js); anyone else gets the pre-keepalive stream.
  const clientAcceptsKeepalive = /\bkeepalive\b/i.test(req.headers.get("x-coach-stream") ?? "");

  let parser = createSSEParser();
  // Tokens the abandoned rungs consumed before the ladder fell past them: the
  // parser is replaced per rung, and an abandoned thinking rung is the
  // expensive one (up to its whole budget), so dropping it would under-count.
  const abandonedUsage = { promptTokens: null, cachedTokens: null, completionTokens: null, thinkingChars: 0 };
  // How many rungs were abandoned for silence. Non-zero is what makes a total
  // failure worth a usage row: those rungs were billed.
  let abandonedRungs = 0;
  // One per rung, replaced with the parser: an abandoned rung's held tail and
  // any notebook block it closed are thrown away with it, so a notebook written
  // by a rung that never answered can never be committed.
  let splitter = createNotebookSplitter();
  let decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let visible = "";
  // The raw emit payload as it accumulates. Never forwarded, never persisted:
  // only what `splitPlanPayload` re-serialises out of it ever leaves here.
  let buffered = "";

  // The row this reply is written into, created by the first checkpoint that
  // finds text and rewritten from then on. Null until then, so a request that
  // never commits leaves no empty assistant bubble behind — and one that
  // commits and cleans to nothing has it rolled back by `finish`.
  let replyId = null;
  let persisted = "";
  let lastCheckpoint = 0;
  let checkpointsOff = false;
  // Her question's row, once banked at the commit: what `finish` rolls back if
  // the reply turns out to have nothing in it after all.
  let userBanked = false;
  let userRowId = null;

  // Stamped at the commit; null if the rung never committed, or if `finish`
  // rolls the reply back. That is a real outcome, not a zero — see the schema
  // comment on ttft_ms.
  let ttftMs = null;

  /**
   * Writes what exists so far, explicitly as an UNFINISHED reply.
   *
   * The provisional truncation note is the point. A checkpoint is by definition
   * a reply that has not finished, and the run may end without another line of
   * ours ever executing — that is precisely the case this exists for. Storing it
   * unmarked would leave a half-answer in the transcript reading as the coach's
   * final word. `finish` rewrites it clean if the reply does complete.
   */
  async function checkpoint() {
    if (checkpointsOff) return;
    // Stamped BEFORE the clean pass, whatever it finds: cleanVisibleReply is
    // O(length of the reply), so it must run at most once per CHECKPOINT_MS and
    // never once per delta — a reply that cleans to nothing (an echoed stamp so
    // far) or to what is already stored would otherwise re-run it on every
    // token, which is O(n²) on a function metered at 50 ms of CPU.
    lastCheckpoint = Date.now();
    // PARTIAL-aware, here and nowhere else: a stamp or an announcement cut
    // mid-way ("[dim. 30 ") is not yet recognisable as one, and writing it as
    // a row shows her a fragment of an annotation. The final `finish` pass
    // judges the whole reply with the strict form.
    const text = stripNotebookAnnouncement(stripEchoedAnnotation(visible, { partial: true }));
    // Nothing visible yet (an echoed date stamp, still alone) is no row.
    if (!text || text === persisted) return;
    try {
      const marked = text + TRUNCATION_NOTE;
      if (replyId === null) {
        const id = await appendMessage("assistant", marked);
        // A write that gives back no id cannot be rewritten, and checkpointing
        // on would insert a fresh row every two seconds — one reply arriving as
        // a dozen bubbles. Stand down; `finish` still writes the real version.
        if (id === null || id === undefined) return void (checkpointsOff = true);
        replyId = id;
      } else {
        await updateMessage(replyId, marked);
      }
      persisted = text;
    } catch (e) {
      console.error("coach-chat: checkpoint failed:", e);
    }
  }

  // Saves whatever exists, however the stream ended. A partial reply is
  // something she actually read, so it belongs in the transcript; dropping it
  // left her scrolling back to an answer that was no longer there.
  async function finish({ truncated = false, notebook: fromPayload = null } = {}) {
    // `visible` already carries TRUNCATION_NOTE when the reply was cut, so this
    // writes exactly what is on her screen — and clears the provisional note
    // from the last checkpoint when it turns out the reply did finish.
    //
    // Two things are removed: the notebook label the model writes just before
    // the sentinel, and any annotation line it copied out of its own stamped
    // history. `finalizeStream` removes the same two on her side, so the stored
    // transcript and the settled bubble stay identical.
    //
    // The ONE place the whole reply is judged — once, at the end. While it
    // streams, a rung commits on the first non-whitespace character the
    // notebook splitter forwards, and nothing re-judges the accumulated text
    // per delta: that re-judging was non-monotonic (a line could count as
    // visible, then invisible) and O(n²).
    const text = cleanVisibleReply(visible);
    if (!text) {
      // A committed reply that cleans to nothing — today, an echoed date stamp
      // and nothing else. Her question was banked at the commit and a
      // checkpoint may have written a row, yet the client settles on the same
      // empty text and hands her question back to the composer, so a row left
      // here would be banked a second time on resend: the 2026-08-05 orphan.
      // ROLLBACK IS THE DESIGNED PATH, not a guard: this request's own rows
      // and nothing else, in one statement.
      const ids = [userRowId, replyId].filter((id) => id !== null);
      if (ids.length) {
        console.warn("coach-chat: committed reply left nothing visible; rolling back its rows");
        // Retried once: a rollback that fails leaves her question banked
        // while the client hands it back for a resend — the 2026-08-05 orphan.
        try {
          await deleteMessages(ids);
        } catch (e) {
          console.error("coach-chat: rollback failed, retrying once:", e);
          try {
            await deleteMessages(ids);
          } catch (e2) {
            console.error("coach-chat: rollback failed:", e2);
          }
        }
      }
      // No reply, so no time-to-first-token: what was sent was held off her
      // screen by the client, and 0-or-something would average a failure in
      // as an answer.
      ttftMs = null;
      // The notebook is NOT skipped here, whatever the rollback did. A closed
      // block from the answering rung is durable memory on its own — the
      // rule an existing test pins for a reply that was entirely a notebook
      // block (« banks nothing when a model accepted but never said anything
      // visible »), and nothing in the notebook rules ties a note to a
      // visible reply: they refuse only a block that did not close, and a
      // heading capture from a cut reply. What IS discarded is an ABANDONED
      // rung's notebook, with its splitter, because that rung did not answer.
      // The client hands her question back; a resend that writes the same
      // note again is de-duplicated by applyNotebookOps.
    } else if (replyId === null) {
      await appendMessage("assistant", text);
    } else {
      await updateMessage(replyId, text);
    }

    // On the emit path the notebook is a SCHEMA FIELD, taken out of a payload
    // that parsed whole — which is proof enough of completeness on its own.
    if (fromPayload) return void (await commitNotebook(fromPayload));

    // Otherwise: null unless a notebook actually closed. A fragment carries
    // half-written operations, and a half-written `- 12` is a removal nobody
    // asked for.
    //
    // The two capture routes do NOT prove the same thing. `<<<END>>>` is a
    // terminator: a block carrying one finished, whatever happened to the rest
    // of the reply. A markdown `### Carnet` heading has no terminator at all, so
    // a reply cut inside one looks exactly like a reply that finished — and the
    // splitter cannot tell. This is the only place that knows the finish reason,
    // so this is where a heading capture from a cut reply is refused.
    const nb = splitter.notebook();
    if (!nb) return;
    if (splitter.notebookSource() === "heading" && truncated) {
      console.warn("coach-chat: dropping a heading-sourced notebook from a cut reply");
      return;
    }
    await commitNotebook(nb);
  }

  /**
   * Applies one turn's operations to the notebook that was loaded at the top of
   * this request.
   *
   * The write used to be `saveNotebook(whateverTheModelEmitted)` — a wholesale
   * replace — and that is what destroyed weeks of memory on 2026-08-30, when
   * every request fell to rung 2 and a three-line reply became the whole
   * notebook. `applyNotebookOps` inverts it: silence preserves, and only an
   * explicit `- n` removes. See `notebookDoc.js` for the full account.
   *
   * `notebook` is the value read at the start of THIS request, which is the
   * same document the model was shown numbered — so the indices it returns
   * address the lines it actually saw. Anything written in between (there is no
   * such path today, one request writes it once) would be clobbered, which is
   * the one reason this stays a single read and a single write per turn.
   *
   * A no-op turn writes NOTHING: skipping the round trip keeps `updated_at`
   * meaning "the notebook changed", and every Neon round trip on this path
   * lands in the numbers the vendor decision rests on. The one exception is a
   * notebook still carrying the old `- ` bullets, which normalises on its first
   * write and matches cleanly from then on.
   */
  async function commitNotebook(block) {
    const ops = parseNotebookOps(block);
    const { content, warnings } = applyNotebookOps(notebook, ops);
    for (const w of warnings) console.warn("coach-chat: notebook —", w);
    if (content === notebook) return;
    await saveNotebook(content);
  }

  /**
   * Writes one usage row and mirrors it to the log — the log so a Neon outage
   * still leaves a trace and the numbers are visible during a deploy without
   * opening the database. Swallows its own failure: an analytics row is never
   * worth costing the user an answer she has already read. The one helper for both
   * the answered and the ladder-exhausted row, so the two cannot drift.
   *
   * `logOnly` rides on the log line and never on the row: fields with no
   * column. Today that is `finish`, the RAW upstream finish reason, which the
   * row's `finishReason` overwrites with "stream_cut" when the stream broke —
   * and a stream that broke after the vendor said "length" is a different
   * failure from one that broke before saying anything.
   */
  async function account(row, logOnly = {}) {
    try {
      await recordUsage(row);
    } catch (e) {
      console.error("coach-chat: could not record usage:", e);
    }
    console.log("coach-chat: usage", JSON.stringify({ ...row, ...logOnly }));
  }

  const stream = new ReadableStream({
    async start(controller) {
      // The buffered emit path sends nothing until the whole payload has
      // parsed, so it ticks a protocol byte on the connection instead (see
      // EMIT_KEEPALIVE_MS). Enqueued directly — never through send(), which
      // stamps ttftMs and banks her question — and stopped the moment the
      // payload goes out or the request ends on either marker. Only for a
      // client that announced it can strip the byte (clientAcceptsKeepalive).
      const KEEPALIVE_BYTES = encoder.encode(STREAM_KEEPALIVE_MARKER); // once, not per tick
      let keepalive = emitting && clientAcceptsKeepalive
        ? setInterval(() => {
            try {
              controller.enqueue(KEEPALIVE_BYTES);
            } catch {
              // The stream is closed or errored — including by an exception
              // that escaped start(), which no explicit stop below can see.
              // One failed tick ends the ticking, so nothing keeps the isolate
              // alive for a request that is already over.
              clearInterval(keepalive);
              keepalive = null;
            }
          }, EMIT_KEEPALIVE_MS)
        : null;
      const stopKeepalive = () => {
        if (keepalive) clearInterval(keepalive);
        keepalive = null;
      };
      // THE MODEL IS CALLED HERE, not before the Response is built.
      //
      // Awaiting it up there held our own response headers for exactly as long
      // as the model took to return its own — 17-28 s on prod — against an edge
      // limit of 40 s for headers. One run on 2026-08-02 never got model headers
      // within 30 s at all. Nothing about the user's wait changes by moving the call;
      // what changes is that the platform can no longer time us out before we
      // have said anything, and that a slower day cannot silently start failing.
      //
      // Her message is banked when a rung COMMITS (see readRung), not when a
      // model accepts. Both edges matter, and the earlier boundary got one of
      // them wrong. Banking before the stream is consumed protected a PARTIAL
      // reply — which this still does, because a partial reply has committed.
      // But it also banked her question when a model accepted and then said
      // nothing at all (killed early, or a reply that was entirely a notebook
      // block), leaving an unanswered question in coach_messages forever. The
      // model read those back as open questions and answered them (the user,
      // 2026-08-05). A reply that commits and then cleans to nothing (an
      // echoed date stamp alone) is rolled back by `finish`.
      //
      // Total ladder failure still banks nothing: no commit, no row. The
      // client keeps her draft instead. That is also what makes a rung that
      // thought and said nothing safe to abandon for the next one: until the
      // commit, nothing has been sent and nothing has been banked.
      const bankQuestion = async () => {
        if (userBanked) return;
        userBanked = true;
        try {
          userRowId = (await appendMessage("user", message)) ?? null;
        } catch (e) {
          console.error("coach-chat: could not persist the user message:", e);
        }
      };

      // Banks the text first, forwards second. If the user's client has gone away
      // the enqueue throws, and that must not cost us the transcript — the
      // whole point is that she finds the answer again when she comes back.
      // ONLY EVER CALLED ONCE THE RUNG HAS COMMITTED, and the first call carries
      // the commit's first non-whitespace character — so it stamps ttftMs and
      // banks her question unconditionally, in O(1). Nothing here judges the
      // accumulated text: the reply as a whole is judged once, in finish(), and
      // a committed reply that turns out empty is rolled back there.
      const send = async (text) => {
        // The moment the user stops looking at "Je regarde tes données…" — give or
        // take an echoed date stamp, which the client holds off screen and
        // which, alone, ends in finish()'s rollback (where ttftMs is nulled).
        visible += text;
        if (ttftMs === null) ttftMs = Date.now() - t0;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // Client disconnected; keep reading and banking.
        }
        // Awaited AFTER the enqueue so a Neon round trip never delays her first
        // token, and awaited at all so her row takes a lower id than the reply's
        // first checkpoint. `lastCheckpoint` starts at 0, so that checkpoint
        // fires immediately after this returns. Idempotent.
        await bankQuestion();
      };

      /**
       * Consumes one rung's stream. Returns whether the rung COMMITTED, whether
       * the first-text budget ran out, and whether the stream broke.
       *
       * ONE MONOTONIC EVENT. A rung commits at the first non-whitespace
       * character the notebook splitter forwards (discussion and plan), or the
       * first non-whitespace character of the raw payload (plan-emit, which
       * is buffered and never meets the splitter). At that instant, and not
       * before, it is logged as the answerer, its first-text budget stops,
       * and — through send() — ttftMs is stamped and her question is banked.
       * Once committed it stays committed: nothing re-judges the accumulated
       * text while it streams, so per-delta work is O(delta). Whether the
       * reply had anything in it is decided ONCE, in finish(), and a committed
       * reply that cleans to nothing is rolled back there.
       *
       * Before the commit, raw deltas still go through this rung's splitter,
       * so a notebook block is consumed rather than counted as text; what it
       * forwards is held in a local `pending` while it is whitespace alone.
       * Nothing is sent, banked or checkpointed. An abandoned rung's `pending`
       * and splitter are dropped with it, notebook included.
       *
       * The splitter holds back up to 13 characters (a sentinel split across
       * chunks), so a short reply forwards nothing until the stream ends —
       * which is why a stream that ENDS (done or broken) flushes the splitter
       * here and may commit on that tail. A rung abandoned on its budget is
       * not flushed: it was cancelled, and is not the one answering.
       *
       * Accepted trade-off, decided 2026-10-01: an echoed date stamp is
       * non-whitespace, so a non-final rung that writes ONLY a stamp now
       * commits and ends in rollback instead of falling through. The
       * alternative was the partial-visibility predicate this replaced, which
       * could count a line visible and then not, committing and then undoing
       * a rung, and cost O(n²) CPU on a long reply.
       *
       * The budget only runs until the commit: once a rung has started
       * writing it is committed to, exactly as the header timeout stops the
       * instant headers land. A reply is never cut for being slow.
       */
      const readRung = async (body, firstTextTimeoutMs, payloadTimeoutMs) => {
        const reader = body.getReader();
        let sawText = false;
        let timedOut = false;
        // On emit, the ONE parse of the buffer, taken after the loop and
        // carried to the ladder loop, which derives every budget verdict from it.
        let split = null;
        let broke = false;
        let pending = "";
        let inFlight = null;
        let timer;
        let payloadTimer;
        // Set by the payload timer and read after every chunk. The timer
        // CANCELS the reader instead of being raced against each read (round
        // 5): a Promise.race per chunk retained one reaction per read for the
        // whole stream on a function metered on CPU, while cancelling resolves
        // the pending read with `done` and costs nothing per chunk.
        let payloadBudgetFired = false;
        const TIMED_OUT = Symbol("first text timeout");
        let deadline = firstTextTimeoutMs
          ? new Promise((resolve) => {
              timer = setTimeout(() => resolve(TIMED_OUT), firstTextTimeoutMs);
            })
          : null;
        // Emit only, EVERY emit rung including the floor (round 4; see
        // PLAN_EMIT_PAYLOAD_TIMEOUT_MS): runs from headers to a payload that
        // parses, and keeps running AFTER the commit, because on this path the
        // commit sends and banks nothing — a rung that wrote `{` and then
        // looped or stalled can still be abandoned with nothing to undo.
        if (emitting && payloadTimeoutMs) {
          payloadTimer = setTimeout(() => {
            payloadBudgetFired = true;
            reader.cancel().catch(() => {});
          }, payloadTimeoutMs);
        }
        const NON_WHITESPACE = /\S/;

        // Feeds text that is ready to leave (splitter output, or a raw emit
        // delta) through the commit gate. Returns what may be forwarded now:
        // "" while uncommitted and still whitespace, everything held so far
        // the moment it commits, the text itself afterwards.
        const gate = (text) => {
          if (sawText) return text;
          pending += text;
          if (!NON_WHITESPACE.test(text)) return "";
          sawText = true;
          clearTimeout(timer);
          // The ladder's verdict, logged when it is reached: this rung spoke,
          // so it is the one answering. Not at headers — a thinking rung that
          // never speaks would have been named as the answerer.
          // On the emit path the first byte is not the answer: the rung can
          // still be abandoned for a payload that does not parse, so the
          // "committed to" line is logged by the ladder loop when it does.
          if (emitting) console.log("coach-chat: payload opened by", model, "headers", headersMs, "ms, first byte", Date.now() - t0, "ms");
          else console.log("coach-chat: committed to", model, "headers", headersMs, "ms, first text", Date.now() - t0, "ms");
          const out = pending;
          pending = "";
          return out;
        };

        try {
          for (;;) {
            // The read that lost a race to the deadline is still in flight and
            // will resolve with a chunk: it is kept, never re-issued, or that
            // chunk would be skipped.
            inFlight ??= reader.read();
            const step = deadline && !sawText ? await Promise.race([inFlight, deadline]) : await inFlight;
            if (step !== TIMED_OUT) inFlight = null;
            if (step === TIMED_OUT) {
              // The rung HAS spoken if the splitter is still holding visible
              // text (a short reply under its look-ahead, a `#` line awaiting
              // its newline): that text is not forwarded yet, so `sawText` is
              // false, but abandoning the rung would throw away an answer
              // already on its way. Stop racing the deadline and keep
              // reading; the commit still happens only when text is forwarded.
              if (!emitting && splitter.heldVisible()) {
                deadline = null;
                continue;
              }
              timedOut = true;
              // Cancelling the body cancels the upstream request, so the
              // abandoned rung stops generating (and billing) its thoughts.
              reader.cancel().catch(() => {});
              break;
            }
            const { done, value } = step;
            // At done, flush the decoder and the parser: the last SSE line
            // may have no trailing newline, and it is where Mistral puts
            // finish_reason and usage. The flush goes through the same
            // block-aware line handler, so it returns visible text only, and
            // it is this rung's parser, before the splitter's tail below.
            const delta = done
              ? parser.push(decoder.decode()) + parser.end()
              : parser.push(decoder.decode(value, { stream: true }));
            // Held back until the object is closed and the notebook is out of it.
            // Nothing is forwarded and nothing is checkpointed on this path.
            if (emitting) {
              // The chunk is buffered BEFORE the budget flag is read (round 6):
              // a read that resolved in the same tick the timer fired carries
              // real bytes — possibly the closing `}` of a finished plan — and
              // checking the flag first dropped them. The verdict on what the
              // buffer holds is taken once, after the loop.
              if (delta) buffered += gate(delta);
              if (payloadBudgetFired || done) break;
              continue;
            }
            if (!delta) {
              if (done) break;
              continue;
            }
            const fwd = gate(splitter.push(delta));
            if (fwd) await send(fwd);
            if (sawText && Date.now() - lastCheckpoint >= CHECKPOINT_MS) await checkpoint();
            if (done) break;
          }
        } catch (e) {
          // Our own payload-budget cancel is not a broken stream (round 9): the
          // Streams spec resolves the pending read as `done`, but a runtime
          // that rejects it instead must not turn a budget verdict into a
          // vendor fault (`stream_cut`, « stream ended early »).
          if (!payloadBudgetFired) {
            broke = true;
            console.error("coach-chat: stream ended early:", e);
          }
        } finally {
          clearTimeout(timer);
          clearTimeout(payloadTimer);
        }
        // The stream is over (finished or broken), so the splitter's held
        // tail is released — on BOTH paths, or every interrupted reply loses
        // its last characters. It can be the commit itself: a short reply
        // forwards nothing until here.
        if (!timedOut && !emitting) {
          const tail = gate(splitter.end());
          if (tail) await send(tail);
        }
        // ONE parse per rung, here, whatever ended the read — stream end, a
        // break, or the payload timer cancelling the reader. The two budget
        // flags are derived from that single parse, so they cannot disagree
        // with it: an object that already parses when the budget fires is a
        // finished plan whose final chunk (usage, finish reason) was late, and
        // is kept; a buffer that does not parse at the budget is abandoned.
        if (emitting) split = splitPlanPayload(buffered);
        // The budget ENDED the read only if the stream had not already finished
        // (round 7): a timer that fires while the trailing `done` read is
        // pending, after the finish chunk was processed, is a normal end with
        // its finish reason and usage intact, not a kept or an abandoned rung.
        // Both verdicts come from HERE, from the one parse (round 8): kept =
        // the budget ended a buffer that parses (a finished plan whose last
        // chunk was late); timed out = it ended one that does not.
        const budgetEnded = emitting && payloadBudgetFired && !parser.finishReason();
        return {
          sawText,
          timedOut,
          interrupted: broke,
          split,
          payloadKept: budgetEnded && !!split?.payload,
          payloadTimedOut: budgetEnded && !split?.payload,
        };
      };

      /**
       * Why a non-final rung is being abandoned — the text that goes into
       * `attempts`, the only place a failure mode can be told apart from the
       * outside. Emit cases first and grouped: only on the emit path can a
       * rung have SEEN text and still be abandoned (round 8 replaced a
       * six-level ternary that hid exactly that).
       */
      const abandonReason = ({ rung, call, emitFailed, finish, bufferedChars }) => {
        if (emitting) {
          if (rung.payloadTimedOut) return `no complete payload within ${call.payloadTimeoutMs} ms`;
          // A broken stream before a payload that did not parse: the two look
          // alike in the buffer and need different fixes — a vendor cut
          // against a model that ignored the schema.
          if (rung.sawText && rung.interrupted) return `stream broke mid-payload (${bufferedChars} chars)`;
          if (rung.sawText && emitFailed) return `payload did not parse (finish ${finish ?? "none"}, ${bufferedChars} chars)`;
        }
        if (rung.timedOut) return `no visible text within ${call.firstTextTimeoutMs} ms`;
        if (rung.interrupted) return "stream broke before any visible text";
        return "no visible text";
      };

      // A RUNG THAT THINKS AND SAYS NOTHING IS A FAILED RUNG. A thinking rung
      // (the Claude rungs since 2026-10-12; zai-glm-5-3 before them) returns
      // headers in ~1 s and reasons AFTER them, so the header timeout
      // has already committed to it by the time it can spend its whole budget
      // thinking (measured once in the 2026-10-01 eval: finish=length, nothing
      // visible) or think for minutes. Either used to end on the empty-reply
      // path with Medium never tried. Now a non-final rung that produced no
      // text — stream finished, broke, or ran out its first-text budget — is
      // abandoned and the ladder resumes at the NEXT rung: each rung at most
      // once, so it cannot loop, and the last rung gets no budget and no
      // fallthrough (a timeout only helps when there is somewhere to go).
      // Nothing was sent and nothing was banked, so there is nothing to undo.
      let call;
      // The answering rung's read result, and on emit its parsed payload, set
      // by the ladder loop (see emitFailed); both read after the loop.
      let rung;
      let startAt = 0;
      let interrupted = false;
      // Set when the last rung's silence is already logged, so the empty-reply
      // path below does not log the same request a second time.
      let lastRungSilentLogged = false;
      for (;;) {
        call = await callChatStream(messages, {
          responseFormat: responseFormatFor(mode, prompts.planSchema),
          promptCacheKey,
          mode: normalizeMode(mode),
          startAt,
        });
        attempts.push(...(call.attempts ?? []));
        // Always 0 since the rung-1 retry was deleted (2026-09-30); the column is kept for history.
        rungRetries = call.rungRetries ?? 0;
        if (!call.res) break;
        model = call.model;
        // Everything the model does before it will talk to us — ingesting a
        // ~14-20k prompt. NOT its thinking: a thinking rung (the Claude rungs
        // since 2026-10-12) sends headers and reasons AFTER them, while Large 4
        // (thinking off) writes within ~0.1 s of its headers — so the wait the user
        // feels is ttftMs (first visible character) on every rung, not this. After a
        // fallthrough it is the ANSWERING rung's headers, so it includes the
        // abandoned rung's silence.
        headersMs = Date.now() - t0;

        // The answering rung's vendor decides how its body reads: an Anthropic
        // stream read by the Mistral parser is an empty reply, not an error.
        parser = createParserFor(call.provider);
        splitter = createNotebookSplitter();
        decoder = new TextDecoder();
        rung = await readRung(call.res.body, call.firstTextTimeoutMs ?? null, call.payloadTimeoutMs ?? null);
        interrupted = rung.interrupted;
        // A server-side refusal fallback (Anthropic fallbacks:"default") hands
        // the turn to another model inside the call: name the one that answered.
        model = parser.servedModel?.() ?? model;
        // ON THE EMIT PATH A RUNG ANSWERS ONLY WITH A PAYLOAD THAT PARSES.
        // Nothing has been sent or banked before that, so a non-final rung
        // whose stream ended without one — cut at finish=length, looped to
        // its token ceiling, broken, or past PLAN_EMIT_PAYLOAD_TIMEOUT_MS — is
        // abandoned like a silent rung and the next one gets the request.
        // Before 2026-10-06 such a rung ended the request on PLAN_ERROR with
        // Medium never tried: it had "committed" on its first `{`.
        // Parsed ONCE, by readRung, and reused below when it succeeds: the
        // payload is multi-kB JSON and the edge meters CPU. The parse is the
        // single verdict; `rung.split` is null off the emit path.
        const emitFailed = emitting && !rung.split.payload;
        if (rung.sawText && !emitFailed) {
          // The emit path's commit: the payload parsed, so this rung answered.
          if (emitting) console.log("coach-chat: committed to", model, "payload parsed", Date.now() - t0, "ms");
          break;
        }
        if (call.nextRung === null || call.nextRung === undefined) {
          // The last rung has nowhere to fall to, so the request ends on the
          // empty-reply path below (or, on emit, on the no-usable-payload
          // path, which logs itself). Said as such: "answered by" here named
          // a model as having answered a request nobody answered.
          if (!rung.sawText) {
            console.warn("coach-chat: last rung silent:", model, {
              timedOut: rung.timedOut,
              interrupted: rung.interrupted,
              finish: parser.finishReason(),
              thinkingChars: parser.thinkingChars(),
              // The emit floor stopped by its payload budget before writing a
              // byte lands here, not on the no-usable-payload line (round 6):
              // a budget kill must never read as a vendor fault. Added only
              // when it applies, so a chat rung's line is unchanged.
              ...(rung.payloadTimedOut ? { payloadBudget: `no complete payload within ${call.payloadTimeoutMs} ms` } : {}),
            });
            lastRungSilentLogged = true;
          }
          break;
        }

        // Recorded like any rung that did not answer, so models_skipped counts
        // it and the log says which of the silences — or which emit failure —
        // it was.
        const silent = {
          model,
          error: abandonReason({ rung, call, emitFailed, finish: parser.finishReason(), bufferedChars: buffered.length }),
          finish: parser.finishReason(),
          thinkingChars: parser.thinkingChars(),
        };
        // The abandoned rung's half-payload must not leak into the next rung's.
        buffered = "";
        attempts.push(silent);
        // Only a rung whose stream ENDED (finish=stop/length, or a break after
        // a usage chunk) reports what it cost. One abandoned on its first-text
        // budget, or on its payload budget (up to PLAN_EMIT_PAYLOAD_TIMEOUT_MS
        // of billed generation, the most expensive failure on this path), was
        // cancelled mid-stream and never sent a usage chunk, so its tokens are
        // absent from the row — an under-count, and the reason a per-rung cost
        // reading counts only finish=stop/length abandons. The usage chunk is
        // the only source of counts; nothing here estimates from `buffered`.
        abandonedRungs += 1;
        const spent = normalizeUsage(parser.usage());
        for (const k of ["promptTokens", "cachedTokens", "completionTokens"]) {
          if (spent[k] !== null) abandonedUsage[k] = (abandonedUsage[k] ?? 0) + spent[k];
        }
        abandonedUsage.thinkingChars += parser.thinkingChars();
        console.warn("coach-chat: falling to the next rung:", JSON.stringify(silent));
        model = null;
        headersMs = null;
        interrupted = false;
        startAt = call.nextRung;
      }
      // Distinct rungs that never answered: every model named in `attempts` other than the winner.
      const modelsSkipped = new Set(attempts.map((a) => a.model).filter((m) => m !== model)).size;
      // One entry per rung that did not answer (callChatStream records nothing
      // for the rung that answers, and has no retry since 2026-09-30), so this
      // line fires exactly when the ladder fell past at least one rung.
      if (attempts.length) console.warn("coach-chat: extra attempts before answering:", JSON.stringify(attempts));

      if (!call.res) {
        // No status code is available any more — the headers went out with the
        // Response, long before we knew. The marker is the whole signal: the
        // client takes her question back off screen and returns the text to the
        // composer, which is what the 502 used to buy.
        console.error("coach-chat: no model answered:", JSON.stringify(attempts));
        stopKeepalive();
        try {
          controller.enqueue(encoder.encode(STREAM_ERROR_MARKER));
        } catch {
          // Client already gone; nothing was banked, so there is nothing to
          // reconcile.
        }
        // A ladder that refused outright spent nothing, and a row would be a
        // request that never happened. One that fell past a silent rung first
        // DID spend — the abandoned thinking is the expensive part — so the row
        // is written, with model NULL (nobody answered) and a finish reason
        // of its own so it never reads as a reply.
        if (abandonedRungs > 0) {
          const row = {
            model: null,
            modelsSkipped,
            rungRetries,
            promptTokens: abandonedUsage.promptTokens,
            cachedTokens: abandonedUsage.cachedTokens,
            completionTokens: abandonedUsage.completionTokens,
            thinkingChars: abandonedUsage.thinkingChars,
            finishReason: "ladder_exhausted",
            headersMs: null,
            ttftMs: null,
            totalMs: Date.now() - t0,
            mode: normalizeMode(mode),
          };
          await account(row);
        }
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
        return;
      }

      // An answer that stopped early is told as such, whichever way it
      // stopped: hitting max_tokens, losing the connection, and an upstream
      // that closes without ever declaring a finish reason all look identical
      // on screen, and all three used to pass for a finished reply. That last
      // case is not hypothetical — it is what gemini-3.5-flash did twice on
      // 2026-08-03, and the unmarked fragment then poisoned the thread. See
      // incompleteReason() for the full account.
      // A plan kept at the payload deadline is complete by the only test that
      // matters on that path — it parsed — and its finish reason simply never
      // arrived; it is not truncated. Its tokens are unknown for the same
      // reason, and the usage row says so (payload_kept_at_deadline, below).
      const payloadKept = !!rung?.payloadKept;
      const stoppedBecause = payloadKept ? null : incompleteReason({ interrupted, finishReason: parser.finishReason() });
      if (stoppedBecause) console.warn("coach-chat: incomplete reply from", model, `(${stoppedBecause})`);
      if (payloadKept) console.log("coach-chat: payload kept at the deadline from", model, "— finish chunk never arrived");

      let notebookFromPayload = null;
      if (emitting) {
        // ALL OR NOTHING, and the raw buffer never leaves this scope. What is
        // sent is re-serialised from a PARSED object with `notebook` deleted,
        // so no prose the model wrapped around it and no fragment of the field
        // can travel — that structural property is what closes the leak, not
        // careful string handling.
        // readRung already parsed the answering rung's buffer (every path
        // that reaches here with a response went through it); a last rung
        // that failed left `rung.split` with no payload, same verdict.
        const { payload, notebook: nb } = rung.split;
        if (payload) {
          // Deliberately NOT decorated with TRUNCATION_NOTE even when
          // `stoppedBecause` is set. A payload that parses whole is closed by
          // definition; balanced braces are stronger evidence than a header,
          // and appending prose to it is what made a COMPLETE plan fail
          // JSON.parse on the client and read as « Programme interrompu ».
          stopKeepalive();
          await send(payload);
          notebookFromPayload = nb;
        } else {
          // A partial payload is not a plan and never becomes one: there is no
          // half-week to import, and the fragment may carry the notebook
          // field. So nothing goes out, nothing is banked, and the client
          // returns her question to the composer — which beats stranding a
          // « Programme interrompu » bubble in the transcript forever. Losing
          // the checkpoint protection here costs nothing she could have read.
          //
          // `buffered.length` and never its content: this is the only place
          // the three failures are distinguishable, and they need different
          // fixes. 0 = the model said nothing; small + `stoppedBecause` = the
          // stream died mid-object; large + no `stoppedBecause` = a complete
          // reply that is not a plan, i.e. the model ignored the schema.
          // Not for a silent last rung, which the loop already logged: one
          // request, one warning.
          if (!lastRungSilentLogged) {
            // `payloadBudget` names the one case the floor can be stopped by
            // (round 4/5): a budget kill must never read as a vendor fault.
            console.warn("coach-chat: plan-emit produced no usable payload", {
              stoppedBecause,
              bufferedChars: buffered.length,
              payloadBudget: rung?.payloadTimedOut ? `no complete payload within ${call.payloadTimeoutMs} ms` : null,
            });
          }
        }
      } else if (!lastRungSilentLogged) {
        // The rung committed; its splitter tail was already flushed by
        // readRung. The reply is judged here for the second and last time
        // (finish() is the other), once per request and never per delta.
        if (cleanVisibleReply(visible)) {
          if (stoppedBecause) await send(TRUNCATION_NOTE);
        } else {
          // Committed and left nothing visible — an echoed date stamp alone.
          // finish() rolls back what the commit wrote; this line says why.
          // (A silent last rung, thinking only or a notebook only, never
          // committed and was logged in the loop.)
          console.warn("coach-chat: no visible text from", model, {
            stoppedBecause,
            thinkingChars: parser.thinkingChars(),
          });
        }
      }

      try {
        await finish({ truncated: !!stoppedBecause, notebook: notebookFromPayload });
      } catch (e) {
        console.error("coach-chat: could not persist the reply:", e);
      }

      // Sent only once the transcript is settled, and never through send() —
      // it is protocol, not text, and has no business being persisted. Its
      // ABSENCE is how the client detects an invocation killed mid-stream:
      // that path runs none of this, so nothing else can carry the signal.
      stopKeepalive();
      try {
        controller.enqueue(encoder.encode(STREAM_END_MARKER));
      } catch {
        // Client already gone; it reconciles from the transcript instead.
      }

      // Accounting, deliberately last and deliberately swallowing its own
      // failure: an analytics row is never worth costing the user an answer she
      // has already read. Recorded even when the stream was cut, because an
      // interrupted request still consumed tokens and a sample that quietly
      // drops the expensive cases is worse than no sample.
      const answering = normalizeUsage(parser.usage());
      // Abandoned rungs' tokens included; null stays null only if nobody reported.
      const usage = Object.fromEntries(
        ["promptTokens", "cachedTokens", "completionTokens"].map((k) => [
          k,
          answering[k] === null && abandonedUsage[k] === null ? null : (answering[k] ?? 0) + (abandonedUsage[k] ?? 0),
        ])
      );
      const thinkingChars = parser.thinkingChars() + abandonedUsage.thinkingChars;
      await account({
        model,
        modelsSkipped,
        rungRetries,
        promptTokens: usage.promptTokens,
        cachedTokens: usage.cachedTokens,
        completionTokens: usage.completionTokens,
        // Withheld reasoning, in characters: completionTokens includes it on a
        // thinking rung, and this is what tells a long think from a long answer.
        // A length only; the thinking itself never leaves the parser.
        thinkingChars,
        // `payload_budget` is the floor stopped by its payload budget (the one
        // way the last rung is ever timed out, on emit only); distinct from an
        // upstream that closed without a finish reason, which stays null.
        finishReason: interrupted
          ? "stream_cut"
          : payloadKept
            ? "payload_kept_at_deadline"
            : rung?.payloadTimedOut
              ? "payload_budget"
              : parser.finishReason(),
        headersMs,
        ttftMs,
        totalMs: Date.now() - t0,
        mode: normalizeMode(mode),
      }, { finish: parser.finishReason() });
      try {
        controller.close();
      } catch {
        // Already closed or errored by the runtime; nothing left to do.
      }
    },
  });

  return new Response(stream, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
