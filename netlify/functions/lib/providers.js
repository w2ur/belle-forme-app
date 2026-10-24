import { env } from "./env.js";
import { buildAnthropicRequest, createAnthropicSSEParser } from "./anthropic.js";
import { createSSEParser } from "./sse.js";

// Mistral's OpenAI-compatible endpoint. Base URL ENDS WITH a slash so we can
// append "chat/completions" directly. Models are PINNED (no "latest" aliases).
const MISTRAL_BASE = "https://api.mistral.ai/v1/";

/**
 * The fallback ladder — MODELS across TWO VENDORS since 2026-10-12, best-first.
 * The history behind every rung (Gemini → Mistral, Large 3, GLM 5.2/5.3,
 * Large 4, the five-case evals and the replays) is in the belle-forme-coach
 * skill; this comment states only what still decides the order.
 *
 * RUNG 1 IS CLAUDE SONNET 5.5, EFFORT "medium" (see WIDENED FOR MEDIUM EFFORT
 * below). OWNER RULING 2026-10-12: Anthropic
 * is accepted for the user's data (US company, inference_geo global, no training on
 * API data), paid from the plan's weekly API credits, so cost is not the
 * variable; judgement and latency are. On replays of that day's four failures
 * (a constraint dropped twice, a confabulated « je me suis arrêté en cours de
 * route », a prose programme instead of the « Plan » route, a false « tu ne
 * m'as pas posé cette question ») both Claude models answered right and Large 4
 * none did not. Sonnet then took rung 1 over Opus on the harness with a real
 * history (same day): asked about next week, Opus rewrote the programme as
 * prose — that day's production failure — where Sonnet pointed at « Plan »;
 * Sonnet's first text came at 1.2-4.7 s against Opus's ~7.5 s, its emits in
 * 24-31 s against 60 s, both importing with 0 errors, and its replies were
 * shorter, which is her standing complaint. Thinking cannot be turned off on
 * either; the effort level is the control. The thinking text never reaches us (display
 * omitted) and the parser would withhold it anyway (anthropic.js).
 *
 * RUNG 2 IS OPUS 5.5, ALSO "low" — a stronger model, never a weaker one (the
 * rung-2 rule: a fallback that answers worse is a way to fail twice), on a
 * separate capacity pool. Both Claude rungs share one key, so a bad key is two
 * instant 401s and the ladder lands on Mistral without spending a header budget.
 *
 * RUNGS 3-4 ARE MISTRAL, so the coach survives an Anthropic outage. Large 4 is
 * sent "none" explicitly (its only other setting, "high", measured 38 s to
 * first text and 270-426 s per emit); Medium 3.5 is the floor (never timed out
 * on chat — a timeout only helps when there is somewhere better to go). GLM
 * 5.3 LEFT on 2026-10-12: CJK leaked into French replies and 2 of 7 emits
 * imported.
 *
 * THE HEADER TIMEOUT DOES NOT COVER A THINKING RUNG — FIRST_TEXT_TIMEOUT_MS
 * DOES. A rung that returns headers and then thinks past its first-text budget
 * is abandoned by coach-chat.js and the ladder resumes at the next one
 * (`startAt`/`nextRung` below); nothing has been sent or banked at that point.
 *
 * PARSER COMPATIBILITY IS CHECKED BEFORE A RUNG IS ADDED: a content shape the
 * parser does not know produces an EMPTY REPLY rather than an error. Each rung
 * names its `provider`, and createParserFor picks the parser; the Anthropic
 * shapes are pinned by recorded fixtures (scripts/anthropic-probe.mjs).
 *
 * IDS ARE PINNED, NEVER ALIASED (`-latest` silently changes the model under a
 * prompt tuned for another one). Deprecation is checked on the API AND in the
 * docs — each has been wrong alone.
 */
export const MODEL_LADDER = [
  // MEDIUM, not low: owner ruling 2026-10-12, the user trades waiting for accuracy.
  // Measured on her history: Sonnet's median first text 1.2-4.7 s -> 5.7 s.
  { provider: "anthropic", model: "claude-sonnet-5-5", reasoningEffort: "medium" },
  { provider: "anthropic", model: "claude-opus-5-5", reasoningEffort: "medium" },
  // Undated while in public preview — re-pin once Mistral issues a dated id
  // (GA weights were announced for 2026-10-27).
  { provider: "mistral", model: "mistral-large-4", reasoningEffort: "none" },
  // No reasoning_effort: Medium is not asked to think.
  { provider: "mistral", model: "mistral-medium-2604" },
];

/**
 * THE « PLAN » BUTTON WALKS ITS OWN LADDER, because what makes a rung weak can
 * differ by path (on 2026-10-06 GLM tied Large 4 on chat and broke 4 of 9
 * strict-schema emits). Today both paths walk the same order; the mechanism
 * stays so an emit-specific reorder is one line. Same entries as MODEL_LADDER
 * by identity, found by model FAMILY, so a re-pin to a dated id and a reorder
 * of MODEL_LADDER both leave this order intact. A family that has left
 * MODEL_LADDER is skipped here rather than thrown at module load (which would
 * take the CHAT path down with it), and a test pins the two ladders as
 * permutations of each other.
 */
export const PLAN_EMIT_FAMILIES = [/^claude-sonnet-/, /^claude-opus-/, /^mistral-large-/, /^mistral-medium-/];
// A test pins that this is a PERMUTATION of MODEL_LADDER (round 7): a rung added
// to the chat ladder that no family here names would otherwise never reach the
// « Plan » path, silently, and a family that left would silently shorten it.
export const PLAN_EMIT_LADDER = PLAN_EMIT_FAMILIES.map((re) => MODEL_LADDER.find((e) => re.test(e.model))).filter(Boolean);

/** The rungs a request of this MODE walks, best-first. Anything not exactly `plan-emit` is chat. */
export function ladderFor(mode) {
  return mode === "plan-emit" ? PLAN_EMIT_LADDER : MODEL_LADDER;
}

/**
 * How long a rung may take to return RESPONSE HEADERS before we give up on it.
 *
 * There was no timeout at all, and it cost the user minutes. On 2026-08-03
 * gemini-3.5-flash held the request for 99 309 ms and then 59 297 ms before
 * dying with a fragment, while the rung below answered the very next request in
 * 1 853 ms. Nothing in the code could tell the difference between a rung that is
 * slow and a rung that is gone, so it waited for both.
 *
 * DELIBERATELY NOT RE-TUNED DOWN for Mistral. Measured headers came back in
 * 0.84-6.9 s across 8 calls, which would argue for something nearer 7 s — but
 * five or eight samples is not a distribution, and the same session saw a 33.6k
 * -token prompt take 47 s to return headers. Prefill scales hard and the tail is
 * real; 15 s stays until coach_usage says otherwise over a week.
 *
 * IT DOES NOT BOUND A THINKING RUNG. A rung that thinks (the Claude rungs; GLM
 * 5.3 before them) sends headers within about a second and then reasons before
 * its first visible character; FIRST_TEXT_TIMEOUT_MS below
 * is what bounds that.
 *
 * This covers the headers ONLY. The body is deliberately left unbounded: a
 * healthy reply streams for 18-25 s after headers arrive, and aborting mid-answer
 * is the exact failure this whole file exists to stop.
 */
export const RUNG_HEADER_TIMEOUT_MS = 15_000;

/**
 * How long a NON-FINAL rung may take, after its headers, to produce its first
 * text — the bound on a reasoning rung that thinks instead of answering. Once
 * text arrives the clock stops for good: a reply is never cut for being slow.
 * The last rung gets none, for the same reason it gets no header timeout.
 *
 * From the 2026-10-01 eval at GLM 5.3 low effort, a real history and prompt
 * (scripts/coach-eval.mjs), worst first visible text measured:
 *
 *   chat (discussion, plan)   2.1 s    -> 15 s
 *   plan-emit                 14.9 s   -> 40 s
 *
 * Chat: ~7x the worst sample, and the same 15 s a rung already gets for
 * headers. The chat fallback's first text is ~1-4 s (GLM low; Medium ~4 s
 * behind it), so a fallthrough still puts text on screen by ~20 s, inside the
 * 17-28 s she sat through under Gemini. Two samples per mode are not a
 * distribution, so the budget is wide: a rung slow to speak is not the failure,
 * a rung that never speaks is.
 *
 * Plan-emit needs its own: its first text is the opening of a JSON payload
 * written after the thinking for a whole week, 5.2 s and 14.9 s in the two
 * low-effort GLM runs, so 15 s would abandon a healthy thinking emit. 40 s is
 * ~2.7x the worst. At default effort GLM thought for 144 s and emitted
 * nothing, which is the case this exists to cut short.
 *
 * RE-CHECKED FOR THE CLAUDE RUNGS, 2026-10-12 (same harness, a real history,
 * two runs): worst first visible text on chat 4.7 s for Sonnet 5.5 low and
 * 8.6 s for Opus 5.5 low — inside 15 s, Opus at ~1.7x; worst first payload
 * character on emit 12.4 s (Sonnet) and 14.7 s (Opus) — 40 s is ~2.7x. Both
 * THINK on every request (it cannot be turned off), so unlike Large 4 this
 * budget is in play on every healthy request: watch `models_skipped` for
 * abandons on rungs 1-2 before trusting these margins.
 *
 * WIDENED FOR MEDIUM EFFORT, 2026-10-12 (owner ruling: accuracy over latency).
 * At medium, worst first text on chat was 9.3 s (Sonnet) and 17.1 s (Opus),
 * and production had already seen 12.7 s from Sonnet LOW on a « Mon
 * programme » turn; worst first payload character on emit 17.8 s (Sonnet) and
 * 24.6 s (Opus). At 15 s the chat budget would throw away a reply that was
 * thinking fine and start over on a weaker rung — slower AND less accurate.
 * Chat 45 s is ~2.6x Opus's worst and stays under the 53 s of idle connection
 * production has survived (chat carries no keepalive, see EMIT_KEEPALIVE_MS);
 * emit 90 s is ~3.7x Opus's worst and the keepalive covers it. The header
 * budget stays 15 s, so a dead Anthropic still reaches Mistral fast.
 *
 * Worst cases on the ladder in force since 2026-10-12 (derived, not measured
 * end to end; the same four rungs on both paths). An Anthropic that holds
 * headers costs ONE RUNG_HEADER_TIMEOUT_MS (15 s): its second rung is then
 * skipped (callChatStream), and Large 4 answers. On emit, a rung that writes
 * `{` and then stalls or loops runs to PLAN_EMIT_PAYLOAD_TIMEOUT_MS (240 s),
 * and the floor (Medium) gets no first-text budget but DOES get a header budget
 * (PLAN_EMIT_FLOOR_HEADER_TIMEOUT_MS, 60 s) and the payload budget: about
 * (15 + 240) × 3 + (60 + 240) ≈ 1 065 s before PLAN_ERROR if all four fail the
 * same way on one press — never observed, and bounded where the keepalive had
 * made it unbounded. MODEL_LADDER (chat): a Sonnet that answers headers and
 * never speaks costs 45 s, then Opus.
 */
export const FIRST_TEXT_TIMEOUT_MS = 45_000;
export const PLAN_EMIT_FIRST_TEXT_TIMEOUT_MS = 90_000;

/**
 * How long a NON-FINAL emit rung gets to deliver a payload that PARSES, from
 * its headers. The emit path sends nothing and banks nothing until the payload
 * parses (the keepalive byte is protocol), so a rung can be abandoned at any
 * point before that with nothing to undo — exactly like a silent rung — and
 * the ladder resumes at the next one. Before this (2026-10-06, review round 2
 * of the Large 4 swap) a rung that committed on its first `{` and then looped
 * (« 13.0,13.0,… », measured) or stopped at finish=length ran to the end of
 * its token budget and ended on PLAN_ERROR with no fallthrough: with the
 * keepalive holding the connection and Large 4 at 20 tok/s, 16 384 tokens is
 * ~13 minutes of waiting line.
 *
 * THE BUDGET MUST NOT CUT A HEALTHY EMIT THAT IS MERELY SLOW (round 3). The
 * longest healthy emits MEASURED are 84 s (Large 4, launch-day throughput)
 * and 55 s (GLM low); the longest one EXTRAPOLATED from the same day is ~185 s
 * (the largest payload seen, 3.7k tokens, at the slowest rate seen, 20 tok/s).
 * 240 s sits ABOVE that extreme (round 5: 180 s sat just under it), because
 * the cost of the two errors is not symmetric: a loop cut 60 s later costs
 * The user a minute, a healthy plan cut costs her rung 1's plan AND the tokens it
 * had billed (cancelled before the usage chunk, so uncounted too). Two bounds
 * cover a loop and whichever is reached first cuts it: PLAN_EMIT_MAX_TOKENS
 * below at full speed (8 192 tokens at GLM's ~250 tok/s is ~33 s), this
 * budget at launch-day speed (8 192 at 20 tok/s would be ~410 s, so 240 s
 * fires first). A stall is cut by this budget alone. And
 * when it fires, coach-chat.js first checks whether the buffer ALREADY parses
 * — an object closed at 239 s whose final usage chunk is still in flight is a
 * finished plan, not a failure.
 *
 * THE EMIT FLOOR GETS THIS BUDGET TOO, the one exception to "the last rung is
 * never timed out" (round 4). That rule exists because for chat a slow answer
 * beats no answer. On emit nothing reaches her until the payload parses, the
 * keepalive now holds the connection open indefinitely, and the client has no
 * timeout of its own — so a floor that writes `{` and loops is a waiting line
 * with no end. A floor over budget ends the request on PLAN_ERROR: her press
 * comes back to her, which is what a 10-minute wait would also have ended on.
 * Worst case for one press is therefore bounded, at roughly
 * (15 + 240) × 3 + (60 + 240) s ≈ 1 065 s if all four rungs fail the same
 * way, headers then payload each (see FIRST_TEXT_TIMEOUT_MS); the floor's row then says
 * finish_reason = 'payload_budget', never null.
 */
export const PLAN_EMIT_PAYLOAD_TIMEOUT_MS = 240_000;

/**
 * The emit FLOOR's budget to return HEADERS (round 7, its own number since
 * round 8 — it reused the payload budget, so tuning one silently moved the
 * other). The payload budget starts at headers, so without this a floor that
 * accepted the connection and never answered held a keepalive-fed « Plan »
 * wait open with no end. Derivation: the longest header wait ever measured
 * here is ~51 s (a Gemini-era floor on 2026-08-03) and 47 s on a 33.6k-token
 * prompt; today's floors answer in 0.6-5.4 s. 60 s is above every measured
 * tail and a quarter of the payload budget it precedes. Chat floors stay
 * unbounded, as the rule above says.
 */
export const PLAN_EMIT_FLOOR_HEADER_TIMEOUT_MS = 60_000;

/**
 * max_tokens for the emit path on a rung that does NOT think. A whole-week
 * payload is 2.3-3.7k tokens on Large 4 and Medium; 8 192 is over 2x that and
 * halves the ceiling a degenerate emit can run to. A THINKING rung keeps
 * DEFAULT_MAX_TOKENS on emit (maxTokensFor): its reasoning shares the budget
 * (the Claude rungs think on every request; their emits measured 4.0-4.9k
 * completion tokens, thinking included, on 2026-10-12), and a cap that
 * truncated a plan would waste the rung where 16 384 produced one. Chat keeps
 * DEFAULT_MAX_TOKENS everywhere: a long explanation is legitimate there.
 */
export const PLAN_EMIT_MAX_TOKENS = 8192;

/** Whether a ladder entry is sent a reasoning effort that makes it think ("none" does not). */
export const thinks = (entry) => !!entry?.reasoningEffort && entry.reasoningEffort !== "none";

/**
 * The token ceiling production sends for `entry` in `mode` — one function for
 * callChatStream and the eval harness, so they cannot drift on the one number
 * that decides whether a payload is cut off.
 */
export function maxTokensFor(entry, mode) {
  return mode === "plan-emit" && !thinks(entry) ? PLAN_EMIT_MAX_TOKENS : DEFAULT_MAX_TOKENS;
}

// Headroom for a full weekly plan payload (warmup + cooldown per session) plus
// the notebook block the model appends last, plus hidden reasoning tokens. The
// old 8192 was shared with reasoning and truncated real answers; truncation is
// now also DETECTED (see the finish_reason handling in coach-chat.js) rather
// than silently passed off as a complete reply.
export const DEFAULT_MAX_TOKENS = 16384;

/**
 * The strict `json_schema` response_format of a plan-emit request. One builder
 * for production (coach-chat.js) and the eval harness, so the two cannot drift
 * on the one request whose shape decides whether a plan imports.
 */
export const jsonSchemaResponseFormat = (name, schema) => ({
  type: "json_schema",
  json_schema: { name, schema, strict: true },
});

/** The rung's request, built for its vendor. Same { url, headers, body } shape either way. */
export function requestFor(entry, messages, opts) {
  // The default lives here so both vendors get it: Anthropic REQUIRES the
  // field (a 400 without it), and buildRequest only defaults its own.
  const withMax = { ...opts, maxTokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS };
  return entry.provider === "anthropic" ? buildAnthropicRequest(entry, messages, withMax) : buildRequest(entry, messages, withMax);
}

/** The stream parser for a rung's vendor. Absent means Mistral, the only vendor before 2026-10-12. */
export function createParserFor(provider) {
  return provider === "anthropic" ? createAnthropicSSEParser() : createSSEParser();
}

export function buildRequest(entry, messages, { maxTokens = DEFAULT_MAX_TOKENS, responseFormat, promptCacheKey } = {}) {
  const body = {
    model: entry.model,
    messages,
    stream: true,
    max_tokens: maxTokens,
    // Without this, a STREAMING OpenAI-compatible response carries no usage
    // block at all — token counts are simply absent, and there is nothing to
    // reconstruct them from downstream. It costs one extra final chunk.
    stream_options: { include_usage: true },
  };
  // Attached ONLY on the plan-emit path, and omitted entirely otherwise so a
  // conversational reply is never constrained to JSON. Probed live 2026-08-10
  // on both rungs: strict `json_schema` produced a valid plan first try, while
  // `json_object` failed on both — so this is the difference between a plan
  // that imports and one that does not, not a nicety.
  if (responseFormat) body.response_format = responseFormat;
  // Mistral prefix cache (docs read 2026-09-30): matched on prefix, cached input
  // billed at 10% of list, a hit is not guaranteed. One key per system prompt
  // version: the three mode prompts share the catalog but differ in bytes, so
  // the key carries the mode too, or a plan turn would evict the discussion
  // prefix. coach-chat.js builds it; the history half of the prefix is held
  // still by alignHistoryWindow (coachPrompt.js).
  if (promptCacheKey) body.prompt_cache_key = promptCacheKey;
  // Per-rung, and absent unless the entry names one: a model that does not
  // reason may 400 on the field, and Medium is not configured through it.
  // Large 4 carries "none" ON PURPOSE (see MODEL_LADDER) — do not "tidy" the
  // entry by dropping its effort.
  if (entry.reasoningEffort) body.reasoning_effort = entry.reasoningEffort;
  return {
    url: MISTRAL_BASE + "chat/completions",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env("MISTRAL_API_KEY")}`,
    },
    body: JSON.stringify(body),
  };
}

/**
 * Streams a chat completion, walking the ladder until one model answers.
 * Returns the raw fetch Response (whose body is a ReadableStream), the model
 * that answered, `attempts` — one entry per rung tried — and `rungRetries`,
 * which is always 0: the rung-1 retry was deleted 2026-09-30 (it doubled the
 * wait on a dead rung: 15 s timeout + 15 s retry + Medium). The field is still
 * returned so `coach-chat.js` and `recordUsage` keep their signature; the
 * `coach_usage.rung_retries` column stays for historical rows.
 *
 * `attempts` is not decoration. Every failure mode here (quota exhaustion, a
 * rejected parameter, an outage, a header timeout) reaches the user as the same
 * generic error bubble, so the function log is the ONLY place the difference
 * is visible.
 */
export async function callChatStream(messages, opts = {}, fetchImpl = fetch) {
  const {
    headerTimeoutMs = RUNG_HEADER_TIMEOUT_MS,
    errorBodyTimeoutMs = ERROR_BODY_TIMEOUT_MS,
    mode,
    startAt = 0,
  } = opts;
  const isEmit = mode === "plan-emit";
  const firstTextBudget = isEmit ? PLAN_EMIT_FIRST_TEXT_TIMEOUT_MS : FIRST_TEXT_TIMEOUT_MS;
  const attempts = [];
  // Built the first time a refused rung's detail string is actually checked,
  // then shared: the happy path, an empty body and a numbers-only envelope
  // never pay for it. See requestShingles.
  let echoes;
  const echoesOf = () => (echoes ??= requestShingles(messages));
  // Chat and plan-emit walk different ladders (see PLAN_EMIT_LADDER); `startAt`
  // and the returned `nextRung` index the SAME ladder because coach-chat.js
  // passes the same normalized mode on every call of one request.
  const ladder = ladderFor(mode);
  // A vendor that held headers past the timeout once is not asked again in the
  // same request: rungs 1 and 2 share Anthropic, and waiting the same timeout
  // twice only doubles her wait before Mistral. A fast refusal (4xx/5xx) does
  // not mark it — another model of the same vendor may well answer.
  const stalledVendors = new Set();
  for (let i = Math.max(0, startAt); i < ladder.length; i++) {
    const entry = ladder[i];
    const vendor = entry.provider ?? "mistral";
    if (stalledVendors.has(vendor)) {
      attempts.push({ model: entry.model, error: `skipped: ${vendor} held headers past the timeout on an earlier rung` });
      continue;
    }
    const isLastRung = i === ladder.length - 1;
    // THE LAST RUNG WAITS AS LONG AS IT TAKES. A timeout is only ever an
    // improvement when there is somewhere better to go; applying it to the floor
    // would convert a slow answer into no answer, which is the one outcome worse
    // than waiting. Measured on the Gemini ladder: a floor request took 50 832 ms
    // to return headers on 2026-08-03 and then answered normally.
    // …except on EMIT, where the floor gets a header budget of its own
    // (round 7; its own constant since round 8): the payload budget only
    // starts once headers land, so a floor that accepted the connection and
    // never sent headers held a keepalive-fed « Plan » wait open with no end.
    const timeoutMs = isLastRung ? (isEmit ? PLAN_EMIT_FLOOR_HEADER_TIMEOUT_MS : null) : headerTimeoutMs;
    try {
      // The emit path has its own, lower token ceiling on a rung that does not
      // think (maxTokensFor); an explicit maxTokens from the caller still wins.
      const req = requestFor(entry, messages, { ...opts, maxTokens: opts.maxTokens ?? maxTokensFor(entry, mode) });
      const res = await fetchHeaders(req, timeoutMs, fetchImpl);
      if (res && res.ok && res.body) {
        // `nextRung` is where coach-chat.js resumes if this rung then produces
        // no text — or, on plan-emit, no payload that parses within its budget;
        // null on the last rung, which gets no first-text budget and no next
        // rung. On emit the last rung DOES carry the payload budget (round 4):
        // over it, the request ends on PLAN_ERROR rather than waiting forever.
        // Each call starts strictly lower, so it cannot loop.
        return {
          res,
          model: entry.model,
          attempts,
          rungRetries: 0,
          // Which parser reads this body (createParserFor).
          provider: entry.provider ?? "mistral",
          nextRung: isLastRung ? null : i + 1,
          firstTextTimeoutMs: isLastRung ? null : firstTextBudget,
          // Every emit rung, the floor included — see PLAN_EMIT_PAYLOAD_TIMEOUT_MS.
          payloadTimeoutMs: isEmit ? PLAN_EMIT_PAYLOAD_TIMEOUT_MS : null,
        };
      }
      // Read the body: it is what tells a 400 "Expected last role User" from a
      // rejected schema or a 422, and an unread body stays open in Deno until GC.
      // Bounded and redacted — see readErrorDetail.
      const detail = await readErrorDetail(res, errorBodyTimeoutMs, echoesOf);
      attempts.push({ model: entry.model, status: res?.status ?? 0, detail });
    } catch (e) {
      if (e?.headerTimeout) stalledVendors.add(vendor);
      attempts.push({ model: entry.model, error: String(e?.message ?? e) });
    }
  }
  return { res: null, model: null, provider: null, attempts, rungRetries: 0, nextRung: null, firstTextTimeoutMs: null, payloadTimeoutMs: null };
}

/**
 * How long a refused rung's ERROR BODY may take to arrive. The header timeout
 * stops at headers by design, so without this a rung that answered 4xx/5xx and
 * then stalled its body would hold the whole ladder — Medium never tried —
 * with nothing in the log to say why. Two seconds is generous for a few hundred
 * bytes of JSON and small against the 15 s a rung already gets for headers.
 */
export const ERROR_BODY_TIMEOUT_MS = 2_000;

// More than any real error envelope, and a cap on what a misbehaving upstream
// can make us buffer. Counted in ENCODED BYTES as they arrive: compared against
// decoded characters, a multibyte body buffered up to twice the cap and was
// still treated as read in full.
const ERROR_BODY_MAX_BYTES = 8_192;
// The run length that counts as an echo of the request. Long enough that an
// error vocabulary word ("invalid_request", "Expected last") does not collide
// with a French prompt by chance; short enough that a clipped or re-quoted
// fragment of her message is still caught.
const ECHO_WINDOW = 12;

/**
 * Every ECHO_WINDOW-character run of the outgoing message contents, as a Set.
 * Linear in the request (~100 KB → ~100k entries, built once per call and only
 * when a rung refuses). A detail string sharing any run with it is quoting the
 * request — her message, her export, her notebook, the history — whatever key
 * it sits under. Exported for its test.
 *
 * The SYSTEM message is included. It used to be skipped as "instructions +
 * catalog, no personal data", which was false: the catalog section renders each
 * deactivated exercise's free-text `inactiveReason`, which the user writes
 * and which can carry health information. The worry that justified the
 * skip — vendor errors redacted on API vocabulary — was measured against
 * docs/claude-project/instructions.md, which is never sent; against the three
 * real system prompts, none of Mistral's envelopes shares a run (pinned in
 * providers.test.js). If one ever does, exempt that MESSAGE by a fixed allowlist
 * rather than exempting her data.
 */
export function requestShingles(messages) {
  const set = new Set();
  for (const m of messages ?? []) {
    const c = typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
    for (let i = 0; i + ECHO_WINDOW <= c.length; i++) set.add(c.slice(i, i + ECHO_WINDOW));
  }
  return set;
}

/**
 * `echoes` is the shingle Set or a thunk returning it; the thunk is called only
 * here, once a string long enough to echo anything is actually checked — the
 * set is ~100k entries over a ~100 KB request.
 */
function echoesRequest(str, echoes) {
  if (!echoes || str.length < ECHO_WINDOW) return false;
  if (typeof echoes === "function") echoes = echoes();
  if (!echoes) return false;
  for (let i = 0; i + ECHO_WINDOW <= str.length; i++) {
    if (echoes.has(str.slice(i, i + ECHO_WINDOW))) return true;
  }
  return false;
}

/**
 * Where a validator starts quoting the input VALUE: a pydantic repr
 * (`input_value=…`), a dict or JSON key (`'input': …`, `"input": …`), a
 * keyword or label with a quoted or structured value (`input='…'`,
 * `input = "…"`, `input={…}`, `input: [...]`). The WORD alone is
 * not a marker — « Extra inputs are not permitted », `max_input_tokens`,
 * « Invalid input for messages[3].content » are the diagnosis, and cutting at
 * the first `input` used to throw them away. `\binput\s*[:=]` cannot match
 * `inputs` or `max_input_tokens`: the sign must follow the word itself. The
 * sign must also be followed by a VALUE-looking token (a quote, `{` or `[`):
 * « Invalid input: expected array, received string » is a diagnosis and used
 * to be cut at its colon. An UNQUOTED value (`input: some words`) is therefore
 * not cut here; the echo check in `safeDetailString` is the guard for it, and
 * it catches any value that repeats the request.
 */
const INPUT_VALUE_MARKER = /input_value=|['"]input['"]\s*:|\binput\s*[:=]\s*['"{[]/;

/**
 * One string bound for the log, made safe by CONTENT. The key allowlist cannot
 * do this alone: an allowlisted value can carry the input too (a pydantic repr
 * in `message`, JSON embedded mid-string, a `detail` or `param` echo, a
 * `loc` entry). Three steps, in this order: cut at the first input-value
 * marker, keep the ERROR_PREFIX_CHARS that will actually be logged, then
 * replace the whole string if THAT still shares a run with the request — an
 * echo past the cut-off never reaches the log, so it must not cost the
 * diagnosis in front of it. Accented text re-encoded as HTML entities or
 * escapes would slip the last step; the cut and the key allowlist still apply.
 */
function safeDetailString(str, echoes) {
  const m = INPUT_VALUE_MARKER.exec(str);
  const kept = (m ? str.slice(0, m.index) + "…" : str).slice(0, ERROR_PREFIX_CHARS);
  if (echoesRequest(kept, echoes)) return `(redacted: echoes the request, ${str.length} chars)`;
  return kept;
}
const ERROR_DETAIL_CHARS = 300;
const ERROR_PREFIX_CHARS = 200;

/**
 * The refused rung's error body, as one log-safe line for `attempts`.
 *
 * BOUNDED: read through our own reader, so on a timeout we hold the lock and
 * can cancel the body. `res.text()` would lock it and leave nothing to cancel
 * with — `res.body.cancel()` rejects on a locked stream.
 *
 * REDACTED: `attempts` goes to the function log, and a FastAPI-style 422
 * echoes the offending `input`, which on this path is her messages, her export
 * and her notebook. JSON keeps only the fields that NAME the error
 * (redactErrorJson); anything else keeps a short prefix, which is enough to
 * tell an HTML gateway page from a plain-text refusal.
 */
async function readErrorDetail(res, timeoutMs, echoesOf = () => undefined) {
  const reader = res?.body?.getReader?.();
  if (!reader) {
    // Not a stream (the test doubles, or a body-less error): nothing to bound.
    const raw = await Promise.resolve()
      .then(() => res?.text?.())
      .catch(() => "");
    return redactErrorBody(String(raw ?? ""), { echoes: echoesOf });
  }
  let capped = false;
  let bytes = 0;
  const decoder = new TextDecoder();
  let raw = "";
  let timer;
  const TIMED_OUT = Symbol("timed out");
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    for (;;) {
      const step = await Promise.race([reader.read(), deadline]);
      if (step === TIMED_OUT) {
        reader.cancel().catch(() => {});
        return `(error body not read within ${timeoutMs} ms)`;
      }
      if (step.done) break;
      bytes += step.value.byteLength;
      raw += decoder.decode(step.value, { stream: true });
      if (bytes >= ERROR_BODY_MAX_BYTES) {
        capped = true;
        reader.cancel().catch(() => {});
        break;
      }
    }
    raw += decoder.decode();
  } catch {
    // A body that errors mid-read still tells us something with what arrived.
  } finally {
    clearTimeout(timer);
  }
  return redactErrorBody(raw, { capped, echoes: echoesOf });
}

/**
 * Exported for its test. `capped` says the read stopped at the byte cap, so the
 * text is a truncated prefix: a truncated JSON body does not parse, and a raw
 * prefix of it is exactly where an echoed `input` would sit. A prefix is only
 * ever returned for a fully-read body that does not look like JSON.
 *
 * `echoes` is `requestShingles(outgoing messages)`, or a thunk returning it
 * (built lazily, see echoesRequest): every string that reaches
 * the output — leaf values, a top-level JSON string, the plain-text prefix —
 * goes through safeDetailString against it.
 *
 * PRIVACY OVER DIAGNOSIS, on purpose: a capped body, or any text that starts
 * with `{`/`[` and does not parse, logs ONLY its length. A truncated 422 is
 * exactly where an echoed `input` sits, so even its harmless first bytes are
 * not worth the risk; the status code and the length are what is left to go on.
 */
export function redactErrorBody(raw, { capped = false, echoes } = {}) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      return JSON.stringify(redactErrorJson(parsed, echoes)).slice(0, ERROR_DETAIL_CHARS);
    }
    // A bare JSON string is text, and was returned as a raw prefix.
    if (typeof parsed === "string") return JSON.stringify(redactErrorJson(parsed, echoes)).slice(0, ERROR_DETAIL_CHARS);
  } catch {
    // Not parseable: handled below.
  }
  if (capped || /^[[{]/.test(text)) return `(unparsed error body, ${text.length} chars)`;
  return safeDetailString(text, echoes);
}

// The keys that DESCRIBE an error, across Mistral's envelope
// ({object, message, type, param, code}) and FastAPI's validation list
// ({detail: [{type, loc, msg, input, ctx}]}). An allowlist, not a denylist:
// `input` is the echo we know about, `ctx` can carry values too, and the next
// echoing field will not announce itself.
const ERROR_KEYS = new Set(["object", "type", "code", "message", "msg", "loc", "param", "detail", "error"]);

function redactErrorJson(value, echoes, depth = 0) {
  if (depth > 5) return "…";
  if (Array.isArray(value)) return value.slice(0, 5).map((v) => redactErrorJson(v, echoes, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (ERROR_KEYS.has(k)) out[k] = redactErrorJson(v, echoes, depth + 1);
    }
    return out;
  }
  // A validator's JSON nested inside `message` as a STRING (not observed, but
  // nothing rules it out) would otherwise smuggle `input` past the allowlist.
  if (typeof value === "string" && /^\s*[[{]/.test(value)) {
    try {
      return redactErrorJson(JSON.parse(value), echoes, depth + 1);
    } catch {
      return `(unparsed nested error, ${value.length} chars)`;
    }
  }
  return typeof value === "string" ? safeDetailString(value, echoes) : value;
}

/**
 * Fetch with an abort that is cancelled the instant headers land, so the timer
 * can never reach the streaming body. `AbortSignal.timeout` would have been
 * shorter and wrong: it keeps firing after the response resolves and would kill
 * a healthy reply 15 s into a 25 s stream.
 */
async function fetchHeaders(req, timeoutMs, fetchImpl) {
  const init = { method: "POST", headers: req.headers, body: req.body };
  if (!timeoutMs) return fetchImpl(req.url, init);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetchImpl(req.url, { ...init, signal: controller.signal });
  } catch (e) {
    // Named explicitly, because `attempts` is the only place a failure mode is
    // visible from the outside — "aborted" alone would not say by whom or why.
    // The abort is kept as `cause`: `attempts` only carries `.message`, so
    // without it the underlying error is gone by the time anyone reads the log.
    if (timedOut) throw Object.assign(new Error(`no response headers within ${timeoutMs} ms`, { cause: e }), { headerTimeout: true });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
