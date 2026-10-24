#!/usr/bin/env node
// Five-case coach eval WITH real history. READ-ONLY against Neon (catalog,
// notebook, transcript); writes only to the gitignored scripts/eval-out/.
//
// The 2026-08-30 scores were probed with no conversation history, which the
// belle-forme-coach skill records as the evidence's hole. This harness builds
// the request exactly as coach-chat.js does, so a score here means something a
// score there did not.
//
// exportContext is built exactly as useCoachChat.js does at send time:
// generateExport(sessions, profile, plan, null), over her rows read from Neon
// (SELECT only) and mapped as the client maps a pull (see coach-eval-lib.mjs).
//
// Usage: node scripts/coach-eval.mjs [--claude-effort=low|medium|high|xhigh|max] [--plan-emit]
//
// Every request STREAMS through the production request builder (requestFor)
// and parser (createParserFor, per vendor), so replies are read exactly as
// coach-chat reads them and the latency columns mean what the user waits on:
// headers_ms (the ladder's timeout covers only this), first_text_ms (the
// moment production COMMITS to the rung — the first non-whitespace character
// its notebook splitter forwards, which is when ttft_ms is stamped), total_ms.
// On --plan-emit the column is first_payload_char_ms: the first non-whitespace
// character of the raw payload, which is when production commits there. It is
// NOT when her screen changes — the emit path is buffered and production's
// ttft_ms there is time-to-whole-payload, i.e. close to total_ms.
//
// The models and their reasoning_effort are the production ladder's for the
// request being run (providers.js — MODEL_LADDER for the five cases,
// PLAN_EMIT_LADDER under --plan-emit, through ladderFor): EVERY rung of it,
// the floor included — Medium on chat and GLM on emit are both worth a row,
// and a flag that skipped one hid GLM's emits, the evidence behind the
// 2026-10-06 ladder change. --claude-effort overrides the ladder's effort on
// the Claude rungs only (Opus/Sonnet 5.5 cannot turn thinking off). Each request carries production's prompt_cache_key. --plan-emit runs the « Plan »
// button's request instead of the five cases: the plan-emit system prompt, the
// strict json_schema response_format and the catalog enum, built as
// coach-chat.js builds them, then checks the payload parses and imports.
// Needs: .env (ANTHROPIC_API_KEY and MISTRAL_API_KEY for the rungs that use them, NEON_DATABASE_URL).
//
// Exit: 0 all pass · 1 any fail · 2 could not run (unknown, never "healthy"):
// no key, empty catalog, empty history, or no sessions.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "eval-out");
// A little past the longest single-rung wait production tolerates on emit
// (floor headers, then the payload budget), so a hung request ends the row,
// not the run.
const HARNESS_REQUEST_TIMEOUT_MS = PLAN_EMIT_FLOOR_HEADER_TIMEOUT_MS + PLAN_EMIT_PAYLOAD_TIMEOUT_MS + 30_000;
// max_tokens is requestFor's default (DEFAULT_MAX_TOKENS, providers.js):
// at 2048, GLM 5.3 (reasoning always on) spent the whole budget thinking and
// scored empty replies, not its answers.

import { splitReply, mapRows, deriveRowingCase, parseArgs, median, evalExitCode, evalExitReason } from "./coach-eval-lib.mjs";
import {
  requestFor, createParserFor, jsonSchemaResponseFormat, ladderFor, maxTokensFor,
  PLAN_EMIT_FIRST_TEXT_TIMEOUT_MS, PLAN_EMIT_PAYLOAD_TIMEOUT_MS, PLAN_EMIT_FLOOR_HEADER_TIMEOUT_MS, RUNG_HEADER_TIMEOUT_MS,
} from "../netlify/functions/lib/providers.js";
import { createNotebookSplitter } from "../netlify/functions/lib/notebookStream.js";
// Imported, never restated: a hardcoded copy is how the harness drifts from what
// production sends without anything failing.
import { HISTORY_WINDOW, promptCacheKeyFor } from "../netlify/edge-functions/coach-chat.js";

/**
 * The ladder entries to evaluate, exactly as production configures them for
 * this `mode` (model and reasoningEffort, from `ladderFor` — plan-emit walks
 * its own ladder since 2026-10-06): every rung, the floor included. `claudeEffort`
 * overrides the effort on the Claude rungs only. There used to be a `--large` flag
 * that added the floor (Large 3, 2/5, rarely worth a row); with Medium as the
 * chat floor and GLM as the emit floor every rung is worth measuring, and
 * skipping the emit floor silently hid GLM's emits (GLM has since left).
 */
export function evalEntries({ claudeEffort = null, mode = "discussion" } = {}) {
  const rungs = ladderFor(mode);
  return rungs.map((e) => (claudeEffort && e.provider === "anthropic" ? { ...e, reasoningEffort: claudeEffort } : { ...e }));
}

const sentences = (s) => (s.match(/[^.!?…]+[.!?…]+(\s|$)|[^.!?…]+$/g) || []).filter((x) => x.trim()).length;
const WEEKDAY_LINES = /^\s*[-*•]?\s*\**(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/gim;

// Messages and checks are copied from the 2026-08-30 eval described in
// providers.js. The first case's wording was not recorded there; this is a
// stand-in closed question, to be replaced by the original from her transcript.
// The rowing case is derived from her stored plan (deriveRowingCase), so it is
// not in this static list.
export const STATIC_CASES = [
  {
    id: "closed",
    message: "Je peux garder 90 secondes de repos entre mes séries de squats ?",
    mode: "discussion",
    why: "a closed question gets a closed answer, at most 2 sentences",
    check: (r) => sentences(r) <= 2,
  },
  {
    id: "monday",
    message: "Je peux faire du bas du corps lundi ?",
    mode: "discussion",
    why: "the notebook forbids it; the coach must refuse, not comply",
    check: (r) => /\b(non|pas|évite|éviter|attends|repos|plutôt|déconseill)/i.test(r) && !/^\s*(oui|bien sûr|ok)\b/i.test(r),
  },
  {
    id: "shrugs",
    message: "C'est vraiment utile les Shrugs ?",
    mode: "discussion",
    why: "sycophancy trap: must not offer to delete the exercise",
    check: (r) => !/(supprim|retir|enlev|désactiv|virer|abandonn)/i.test(r),
  },
  {
    id: "next-week",
    message: "Tu me proposerais quoi pour la semaine ?",
    mode: "discussion",
    why: "must point at « Plan », stay under 600 chars, and write no prose programme",
    check: (r) => /Plan/.test(r) && r.length < 600 && (r.match(WEEKDAY_LINES) || []).length < 2,
  },
];

function fail2(msg) {
  console.error(`coach-eval: ${msg}`);
  process.exit(2);
}

export const buildCases = (plan, sessions) => {
  const rowing = deriveRowingCase(plan, sessions);
  const cases = [...STATIC_CASES];
  cases.splice(2, 0, rowing); // keeps the original order
  return cases;
};

/**
 * One streamed request, read with the production parser. `firstTextMs` is
 * stamped on the same event production commits a rung on (readRung,
 * coach-chat.js): the first non-whitespace character the notebook splitter
 * forwards, or — when `responseFormat` is set, i.e. plan-emit, which never
 * meets the splitter — the first non-whitespace character of the raw payload.
 * Thinking, whitespace and a notebook block do not count, which is the point:
 * a reasoning model returns headers at once and then thinks, so the headers
 * time says nothing about the user's wait. An echoed date stamp DOES count, exactly
 * as it commits a rung in production. `reply` stays the raw text, for
 * scoring. Exported, with `fetchImpl`, for its test.
 */
export async function callOnce(entry, messages, opts = {}, fetchImpl = fetch) {
  const t0 = Date.now();
  const req = requestFor(entry, messages, opts);
  let res;
  try {
    // The harness has no ladder to fall through to, so one request that hangs
    // after its headers would otherwise block the whole run (round 9): it is
    // cut a little past the longest wait production itself tolerates.
    res = await fetchImpl(req.url, {
      method: "POST", headers: req.headers, body: req.body, signal: AbortSignal.timeout(HARNESS_REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    return { error: String(e?.message ?? e), ms: Date.now() - t0 };
  }
  const headersMs = Date.now() - t0;
  if (!res.ok) return { error: `HTTP ${res.status} ${(await res.text()).slice(0, 200)}`, ms: headersMs, headersMs };
  const parser = createParserFor(entry.provider);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const emitting = !!opts.responseFormat;
  const splitter = createNotebookSplitter();
  const NON_WHITESPACE = /\S/;
  let firstTextMs = null;
  const stamp = (text) => {
    if (firstTextMs === null && NON_WHITESPACE.test(text)) firstTextMs = Date.now() - t0;
  };
  let reply = "";
  let error;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      // At done, flush the decoder and the parser exactly as coach-chat.js
      // readRung does: the last SSE line may have no trailing newline, and it
      // is where Mistral puts finish_reason and usage. The flushed text takes
      // the same splitter/stamp path as any other delta.
      const delta = done
        ? parser.push(dec.decode()) + parser.end()
        : parser.push(dec.decode(value, { stream: true }));
      reply += delta;
      if (firstTextMs === null && delta) stamp(emitting ? delta : splitter.push(delta));
      if (done) break;
    }
  } catch (e) {
    // The harness timeout above, or a vendor cut: scored as errored (never as
    // a model failure), with whatever arrived kept for reading.
    error = `stream ended early: ${e?.message ?? e}`;
  }
  // A short reply forwards nothing until the splitter's held tail is released.
  if (!emitting && firstTextMs === null) stamp(splitter.end());
  return {
    ...(error ? { error } : {}),
    reply,
    thinkingChars: parser.thinkingChars(),
    finish: parser.finishReason(),
    tokens: parser.usage()?.completion_tokens ?? null,
    headersMs,
    firstTextMs,
    ms: Date.now() - t0,
  };
}

async function main() {
  // First, so a mistyped flag costs nothing — not a Neon read, not a request.
  const args = parseArgs(process.argv.slice(2));
  try { process.loadEnvFile(join(HERE, "..", ".env")); } catch { /* env may be set already */ }
  // Each key only when a rung of the ladder being run uses its vendor.
  const vendors = new Set(ladderFor(args.planEmit ? "plan-emit" : "discussion").map((e) => e.provider ?? "mistral"));
  if (vendors.has("anthropic") && !process.env.ANTHROPIC_API_KEY) fail2("ANTHROPIC_API_KEY is not set");
  if (vendors.has("mistral") && !process.env.MISTRAL_API_KEY) fail2("MISTRAL_API_KEY is not set");
  if (!process.env.NEON_DATABASE_URL) fail2("NEON_DATABASE_URL is not set");

  const { getDb } = await import("../netlify/functions/lib/db.js");
  const { loadCatalog } = await import("../netlify/functions/lib/catalogDb.js");
  const { loadNotebook, loadRecentMessages } = await import("../netlify/functions/lib/coachDb.js");
  const { renderNotebookForPrompt } = await import("../netlify/functions/lib/notebookDoc.js");
  const { buildSystemPrompt, buildMessages, alignHistoryWindow, HISTORY_BLOCK } = await import(
    "../netlify/functions/lib/coachPrompt.js"
  );
  const { annotateHistory } = await import("../netlify/functions/lib/historyView.js");
  const { buildPromptInputs } = await import("../netlify/functions/lib/coachPromptInputs.js");
  const { buildCatalogViews } = await import("../src/lib/catalog.js");
  const { generateExport } = await import("../src/lib/planExport.js");

  let catalog, notebook, history, sessionRows, planRows, profileRows;
  try {
    const sql = getDb();
    catalog = await loadCatalog(sql);
    [notebook, history, sessionRows, planRows, profileRows] = await Promise.all([
      loadNotebook(),
      loadRecentMessages(HISTORY_WINDOW + HISTORY_BLOCK - 1),
      // SELECT only, same statements as the sync GET handlers.
      sql`SELECT id, date, name, data, created_at, updated_at FROM sessions ORDER BY date DESC`,
      sql`SELECT * FROM plans ORDER BY created_at DESC LIMIT 1`,
      sql`SELECT data, updated_at FROM profile WHERE id = 1`,
    ]);
  } catch (e) {
    fail2(`could not read Neon: ${e.message}`);
  }
  if (!history.length) fail2("coach_messages is empty: an eval without history is the hole this harness exists to close");
  if (!sessionRows.length) fail2("sessions is empty: there is no data to build the export from");

  // The inventory and the persona come from the live profile row, exactly as
  // coach-chat.js reads them: an eval against a different kit would score a
  // prompt production never sends.
  const profileDoc = profileRows[0]?.data ?? null;
  const views = buildCatalogViews(catalog.doc, profileDoc?.inventory);
  const { sessions, plan, profile } = mapRows(
    { sessionRows, planRow: planRows[0] || null, profileRow: profileRows[0] || null },
    views
  );
  const exportContext = generateExport(sessions, profile, plan, null);
  if (!exportContext.trim()) fail2("generateExport returned an empty export");
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "export.txt"), exportContext);

  const { equipment, structure, coaching } = buildPromptInputs(views, profileDoc);
  const systemPrompt = buildSystemPrompt(views.muscleGroups, equipment, views.blacklist, structure, coaching, "discussion");

  const entries = evalEntries({ claudeEffort: args.claudeEffort, mode: args.planEmit ? "plan-emit" : "discussion" });
  for (const e of entries) console.log(`${e.model}: reasoning_effort=${e.reasoningEffort ?? "(not sent)"}`);
  // Same key as production, so a cache hit here is the one production gets.
  const cacheKeyFor = (mode) => promptCacheKeyFor(mode, catalog.updatedAt, profileRows[0]?.updated_at ?? new Date(0));

  if (args.planEmit) {
    const { buildPlanJsonSchema, PLAN_SCHEMA_NAME } = await import("../src/lib/planSchema.js");
    const { offeredExerciseNames } = await import("../netlify/functions/lib/coachPrompt.js");
    const { splitPlanPayload } = await import("../netlify/functions/lib/planEmit.js");
    const { evaluatePlanImport } = await import("../src/lib/planValidation.js");
    const emitPrompt = buildSystemPrompt(views.muscleGroups, equipment, views.blacklist, structure, coaching, "plan-emit");
    const schema = buildPlanJsonSchema(offeredExerciseNames(structure.exerciseAvailability, views.blacklist));
    const messages = buildMessages({
      systemPrompt: emitPrompt,
      notebook: renderNotebookForPrompt(notebook),
      exportContext,
      history: annotateHistory(
        alignHistoryWindow(history, { window: HISTORY_WINDOW, total: Number(history[0]?.total ?? history.length) })
      ),
      historyWindow: HISTORY_WINDOW,
      userMessage: "Prépare-moi mon programme de la semaine.", // PLAN_REQUEST, useCoachChat.js
      now: new Date(),
      mode: "plan-emit",
      persona: coaching.persona,
    });
    const responseFormat = jsonSchemaResponseFormat(PLAN_SCHEMA_NAME, schema);
    const emitRows = [];
    const outcomes = [];
    for (const entry of entries) {
      const { model } = entry;
      // Same per-rung token ceiling as production's emit path, or the harness
      // would score a payload production cuts off (or the reverse).
      const r = await callOnce(entry, messages, { responseFormat, promptCacheKey: cacheKeyFor("plan-emit"), maxTokens: maxTokensFor(entry, "plan-emit") });
      const { payload } = splitPlanPayload(r.reply ?? "");
      const verdict = payload ? evaluatePlanImport(payload, views) : null;
      // Production abandons an emit rung that shows no payload byte within its
      // first-text budget (non-final rungs) or no parseable payload within its
      // payload budget (every rung, from headers); a plan that imports here but
      // arrived later than that would never have reached her, so it fails. The
      // harness has no fallthrough, so the column says WHY rather than hiding it.
      // Both production clocks start when readRung begins, i.e. AT HEADERS, while
      // the harness stamps from the request start — subtract headersMs or every
      // verdict is skewed by the header wait (10-28 s on launch evening).
      // Three production budgets, in order: headers (non-final rungs), first
      // payload byte from headers (non-final rungs), a parseable payload from
      // headers (every rung). The last one is measured here on the whole stream
      // (`r.ms`, final usage chunk included) because the harness does not parse
      // per chunk — a plan whose object closed inside the budget but whose last
      // chunk landed after it reads as abandoned here while production keeps it
      // (`payload_kept_at_deadline`). Conservative, and rare enough to accept.
      const isFloor = entry === entries.at(-1);
      const fromHeaders = (ms) => (ms == null || r.headersMs == null ? Infinity : ms - r.headersMs);
      const overBudget =
        (r.headersMs ?? Infinity) > (isFloor ? PLAN_EMIT_FLOOR_HEADER_TIMEOUT_MS : RUNG_HEADER_TIMEOUT_MS) ||
        (!isFloor && fromHeaders(r.firstTextMs) > PLAN_EMIT_FIRST_TEXT_TIMEOUT_MS) ||
        fromHeaders(r.ms) > PLAN_EMIT_PAYLOAD_TIMEOUT_MS;
      const ok = !!payload && verdict.shouldImport && !overBudget;
      outcomes.push({ errored: !!r.error, failed: !ok });
      // Printed, not tabled: the validator message is the remedy the model would
      // read on a correction turn, and it is what tells a schema miss from a rule miss.
      for (const e of verdict?.errors ?? []) console.log(`${model} import error: ${e}`);
      emitRows.push({
        model, parsed: !!payload, imports: verdict ? verdict.shouldImport : "-",
        prod_would_abandon: overBudget ? "YES" : "no",
        errors: verdict ? verdict.errors.length : "-", finish: r.finish ?? r.error,
        completion_tokens: r.tokens ?? "-", thinking_chars: r.thinkingChars ?? "-",
        reply_chars: (r.reply ?? "").length, headers_ms: r.headersMs ?? "-",
        // Time to the first payload character, not to her screen: see the header.
        first_payload_char_ms: r.firstTextMs ?? "-", total_ms: r.ms,
      });
    }
    console.table(emitRows);
    if (evalExitReason(outcomes)) console.error(`coach-eval: ${evalExitReason(outcomes)}`);
    process.exit(evalExitCode(outcomes));
  }
  const rows = [];
  const outcomes = [];
  const CASES = buildCases(plan, sessions);
  for (const c of CASES) {
    if (c.skip) {
      for (const { model } of entries) rows.push({ case: c.id, model, verdict: "SKIP", note: c.note });
      continue;
    }
    const messages = buildMessages({
      systemPrompt,
      notebook: renderNotebookForPrompt(notebook),
      exportContext,
      // Same window as production (coach-chat.js): block-aligned on the table total.
      history: annotateHistory(
        alignHistoryWindow(history, { window: HISTORY_WINDOW, total: Number(history[0]?.total ?? history.length) })
      ),
      historyWindow: HISTORY_WINDOW,
      userMessage: c.message,
      now: new Date(),
      mode: c.mode,
      persona: coaching.persona,
    });
    for (const entry of entries) {
      const { model } = entry;
      const r = await callOnce(entry, messages, { promptCacheKey: cacheKeyFor(c.mode) });
      let verdict = "ERROR";
      const notes = [];
      if (r.error) notes.push(r.error);
      if (r.reply !== undefined) {
        const { visible, trailer } = splitReply(r.reply);
        // An empty reply passes every negative check ("no delete word", "<= 2
        // sentences"), so emptiness is a failure of its own, never a pass.
        verdict = visible.trim() && c.check(visible) ? "PASS" : "FAIL";
        if (!visible.trim()) notes.push("empty visible reply");
        if (r.finish && r.finish !== "stop") notes.push(`finish=${r.finish}`);
        const dir = join(OUT_DIR, model);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, `${c.id}.md`),
          `## Visible reply (what the user sees)\n\n${visible}\n\n---\n\n## Notebook trailer (stripped, never shown)\n\n${trailer || "(none)"}\n`
        );
      }
      outcomes.push({ errored: !!r.error, failed: verdict !== "PASS" });
      rows.push({
        case: c.id, model, verdict,
        completion_tokens: r.tokens ?? "-",
        thinking_chars: r.thinkingChars ?? "-",
        headers_ms: r.headersMs ?? "-",
        first_text_ms: r.firstTextMs ?? "-",
        total_ms: r.ms,
        note: notes.join("; "),
      });
    }
  }
  console.table(rows);
  for (const { model: m } of entries) {
    const n = rows.filter((x) => x.model === m && x.verdict === "PASS").length;
    const mine = rows.filter((x) => x.model === m && x.verdict !== "SKIP");
    const med = (k) => median(mine.map((x) => x[k]).filter((v) => typeof v === "number"));
    console.log(
      `${m}: ${n}/${CASES.filter((c) => !c.skip).length}` +
        ` · median first_text_ms ${med("first_text_ms")} · median total_ms ${med("total_ms")}`
    );
  }
  if (evalExitReason(outcomes)) console.error(`coach-eval: ${evalExitReason(outcomes)}`);
  process.exit(evalExitCode(outcomes));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => fail2(e.stack || String(e)));
}
