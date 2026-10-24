import { describe, it, expect, beforeEach, vi } from "vitest";
import seed from "../../src/data/catalogSeed.json";
import { buildCatalogViews } from "../../src/lib/catalogTestkit.js";
import { buildPromptInputs } from "../functions/lib/coachPromptInputs.js";
import { buildSystemPrompt } from "../functions/lib/coachPrompt.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  requestFor, createParserFor,
  MODEL_LADDER, PLAN_EMIT_LADDER, PLAN_EMIT_FAMILIES, ladderFor, DEFAULT_MAX_TOKENS, PLAN_EMIT_MAX_TOKENS, PLAN_EMIT_PAYLOAD_TIMEOUT_MS, PLAN_EMIT_FLOOR_HEADER_TIMEOUT_MS, maxTokensFor, thinks, jsonSchemaResponseFormat, buildRequest, callChatStream, redactErrorBody, requestShingles, FIRST_TEXT_TIMEOUT_MS, PLAN_EMIT_FIRST_TEXT_TIMEOUT_MS,
} from "../functions/lib/providers.js";

// Shared by every "rung goes quiet" fixture below: hangs until the abort fires,
// which is what a rung that has stopped responding looks like from here.
const hangs = (signal) =>
  new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));

const messages = [{ role: "user", content: "hi" }];
const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";

describe("providers", () => {
  beforeEach(() => {
    process.env.MISTRAL_API_KEY = "mk";
    process.env.ANTHROPIC_API_KEY = "ak";
  });

  it("buildRequest targets the OpenAI-compatible chat/completions path", () => {
    const req = buildRequest(MODEL_LADDER[0], messages, { maxTokens: 100 });
    expect(req.url).toBe(MISTRAL_URL);
    expect(req.headers.Authorization).toBe("Bearer mk");
    const body = JSON.parse(req.body);
    expect(body.model).toBe(MODEL_LADDER[0].model);
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(100);
    expect(body.messages).toEqual(messages);
  });

  // Without this opt-in a streaming response carries no usage block at all, and
  // the coach_usage table fills with nulls that look like a provider quirk
  // rather than a missing request field.
  it("opts in to usage reporting on every rung, or there is nothing to measure", () => {
    for (const entry of MODEL_LADDER) {
      const body = JSON.parse(buildRequest(entry, messages).body);
      expect(body.stream_options).toEqual({ include_usage: true });
    }
  });

  // Mistral matches prompt_cache_key on prefix and bills cached input at 10% of
  // list (docs read 2026-09-30). Absent, the request is still served — so a key
  // that silently stopped reaching the body would show only as a cost, a month later.
  it("carries prompt_cache_key when one is given, and omits the field otherwise", () => {
    for (const entry of MODEL_LADDER) {
      expect(JSON.parse(buildRequest(entry, messages, { promptCacheKey: "k" }).body).prompt_cache_key).toBe("k");
      expect(JSON.parse(buildRequest(entry, messages).body)).not.toHaveProperty("prompt_cache_key");
    }
  });

  // The key is Mistral's prefix cache; the Claude rungs cache through
  // cache_control breakpoints instead (anthropic.js) and must not carry it.
  it("threads the cache key from callChatStream to every Mistral rung it tries, and to no Claude rung", async () => {
    const keys = [];
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      keys.push(body.prompt_cache_key);
      return body.model === "mistral-medium-2604" ? { ok: true, body: {} } : { ok: false, status: 503, body: null };
    };
    await callChatStream(messages, { promptCacheKey: "belle-forme:discussion:v1" }, fetchImpl);
    expect(keys).toEqual([undefined, undefined, "belle-forme:discussion:v1", "belle-forme:discussion:v1"]);
  });

  it("defaults to a max_tokens that leaves room for a full plan AND the notebook", () => {
    const body = JSON.parse(buildRequest(MODEL_LADDER.find((e) => e.provider === "mistral"), messages).body);
    expect(body.max_tokens).toBeGreaterThan(8192);
  });

  // Rung 1, mistral-large-4, is sent "none" EXPLICITLY although no thinking is
  // already its default: its only other setting is "high" (no "low"/"medium"
  // exist on it — 400), which measured 38 s median to first text on chat and
  // 270-426 s on an emit with two emits of four producing nothing (2026-10-06),
  // so a default flipped at GA must not be able to turn this rung into that
  // one silently. zai-glm-5-3 cannot turn reasoning off ("none" is a 400), so
  // rung 2 names "low": same score as the default in the 2026-10-01 eval at
  // 0.7-0.9 s to first visible text instead of 31 s, and at the default the
  // plan request thought through all 16 384 tokens and emitted nothing. Medium
  // is not asked to think. The Claude rungs think at MEDIUM: owner ruling
  // 2026-10-12, the user trades waiting for accuracy (a few seconds on Sonnet).
  it("asks the Claude rungs for medium effort, Large 4 for no reasoning, and the floor for nothing", () => {
    const efforts = MODEL_LADDER.map((e) => {
      const body = JSON.parse(requestFor(e, messages, { maxTokens: 100 }).body);
      return e.provider === "anthropic" ? body.output_config.effort : body.reasoning_effort;
    });
    expect(efforts).toEqual(["medium", "medium", "none", undefined]);
  });

  // Regression: 8d51361 — 2026-10-06, Large 4 at "high" spent 56-57k chars
  // thinking on the replayed production request #913 and emitted nothing,
  // twice, after 330 s and 426 s. The ladder entry must never carry it.
  it("never asks Large 4 to think", () => {
    // By family, not by the preview id: this must keep holding once the id is re-pinned.
    const large4 = MODEL_LADDER.find((e) => /^mistral-large-/.test(e.model));
    expect(large4).toBeDefined();
    expect(large4.reasoningEffort).toBe("none");
    expect(JSON.parse(buildRequest(large4, messages).body).reasoning_effort).toBe("none");
  });

  it("sends reasoning_effort only for an entry that names one", () => {
    expect(JSON.parse(buildRequest({ model: "zai-glm-5-3", reasoningEffort: "low" }, messages).body).reasoning_effort).toBe("low");
    expect(JSON.parse(buildRequest({ model: "mistral-medium-2604" }, messages).body)).not.toHaveProperty("reasoning_effort");
  });

  // One vendor, one key, one data-processing posture to keep true. That was the
  // argument against the old Gemini → Groq shape (Groq's 12k tokens/minute cap
  // 429'd against a ~6-9k prompt, so it was a second way to fail rather than a
  // fallback), and it is the argument against OpenRouter, whose free models are
  // logged and trainable. It holds under Mistral for a stronger reason than it
  // did under Google: Paris HQ and no US CLOUD Act exposure, with no France/EEA
  // account carve-out needed to get there. Residency unverified (Mistral terms
  // not checked).
  it("keeps every rung on the same key and endpoint", () => {
    expect(MODEL_LADDER.length).toBeGreaterThan(1);
    for (const entry of MODEL_LADDER) {
      const req = buildRequest(entry, messages);
      expect(req.url).toBe(MISTRAL_URL);
      expect(req.headers.Authorization).toBe("Bearer mk");
    }
    const models = MODEL_LADDER.map((e) => e.model);
    expect(new Set(models).size).toBe(models.length);
  });

  // Pinned because nothing else would catch a silent flip: every order produces
  // a working coach, just a worse one. Ids are pinned exactly — no "-latest"
  // aliases, so a vendor-side model swap cannot arrive unannounced. Both traps
  // found while picking these are worth remembering: mistral-medium-3505 is
  // listed on the docs overview but 400s with `invalid_model` on a real key, and
  // magistral-medium is not available on this account at all.
  it("puts the strongest model first so a healthy request gets the best answer", () => {
    // Sonnet 5.5 first since 2026-10-12 (Anthropic accepted for
    // the user's data). On a real history Sonnet pointed at « Plan » where Opus wrote
    // the programme as prose — that day's production failure — and answered
    // ~3x faster (first text 1.2-4.7 s vs ~7.5 s; emit 24-31 s vs 60 s, both
    // imported). Opus 5.5 is rung 2: a stronger model, never a weaker one.
    // Mistral holds the coach through an Anthropic outage; GLM 5.3 left.
    expect(MODEL_LADDER.map((e) => e.model)).toEqual([
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "mistral-large-4",
      "mistral-medium-2604",
    ]);
    expect(MODEL_LADDER.map((e) => e.provider)).toEqual(["anthropic", "anthropic", "mistral", "mistral"]);
    for (const e of MODEL_LADDER.slice(0, 2)) expect(e.reasoningEffort).toBe("medium");
    expect(MODEL_LADDER.some((e) => /^zai-glm-/.test(e.model))).toBe(false);
    // Regression: zai-glm-5-2 retires 2026-10-31 (docs.mistral.ai models page,
    // read 2026-09-30); the API deprecation field still said null that day.
    expect(MODEL_LADDER.some((e) => e.model === "zai-glm-5-2")).toBe(false);
    for (const entry of MODEL_LADDER) expect(entry.model).not.toMatch(/latest/);
  });

  // `mistral-large-4` is the one undated id on the ladder, because the model is
  // in public preview and Mistral has issued no dated id for it yet (2026-10-06:
  // `mistral-large-4` and `mistral-large-4-0` alias each other, nothing else).
  // An undated id is what the pinning rule exists to forbid — Mistral can move
  // it to a different checkpoint at GA (weights announced for 2026-10-27) under
  // a prompt and an eval tuned on the preview, and the /latest/ check above
  // cannot see it. Nothing here turns red on that day; a regression to Large 3
  // (`mistral-large-2512`, 2/5) is caught by the exact-id order test above,
  // not by the loose family pattern below.
  // NOT a calendar trigger (rounds 2 and 6 disagreed; round 6 wins): a suite
  // that goes red on a date fails every unrelated PR from that day and trains
  // everyone to ignore red runs. The reminder lives in the ladder entry's
  // comment and in the session memory (re-pin once a dated id exists; GA
  // weights were announced for 2026-10-27). This test only pins that the
  // preview id is the one in use ON PURPOSE, so a re-pin is a deliberate edit
  // here, never a drift.
  it("runs Large 4 on its undated preview id, by design, until a dated id exists", () => {
    const large4 = MODEL_LADDER.find((e) => /^mistral-large-/.test(e.model));
    expect(large4).toBeDefined();
    expect(["mistral-large-4", "mistral-large-4-0"].includes(large4.model) || /^mistral-large-\d{4}$/.test(large4.model)).toBe(true);
  });

  // Regression: c5d24a2 — code review of the Large 4 swap, 2026-10-06. One
  // ladder for every mode put GLM 5.3 low on rung 2 of the « Plan » path, the
  // model that broke 4 of 9 emits that day, with Medium 3.5 (3/3 imports)
  // behind it and reachable only if GLM produced no text at all — a broken but
  // complete payload never falls through. Rung 2 was weaker than rung 3 on
  // that path.
  describe("ladderFor", () => {
    it("walks Sonnet → Opus → Large 4 → Medium on plan-emit, and MODEL_LADDER on anything else", () => {
      expect(PLAN_EMIT_LADDER.map((e) => e.model)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5", "mistral-large-4", "mistral-medium-2604"]);
      expect(ladderFor("plan-emit")).toBe(PLAN_EMIT_LADDER);
      for (const mode of ["discussion", "plan", undefined, "anything-else"]) expect(ladderFor(mode)).toBe(MODEL_LADDER);
    });

    it("reuses MODEL_LADDER's entries by identity, so a model id or an effort is changed in one place", () => {
      for (const entry of PLAN_EMIT_LADDER) expect(MODEL_LADDER).toContain(entry);
      expect(new Set(PLAN_EMIT_LADDER).size).toBe(MODEL_LADDER.length);
    });

    it("sends a plan-emit request down its own ladder when rung 1 refuses", async () => {
      const calls = [];
      const fetchImpl = async (_url, { body }) => {
        const model = JSON.parse(body).model;
        calls.push(model);
        return model === PLAN_EMIT_LADDER[0].model
          ? new Response("", { status: 503 })
          : new Response(new ReadableStream(), { status: 200 });
      };
      const { model } = await callChatStream(messages, { mode: "plan-emit" }, fetchImpl);
      expect(model).toBe("claude-opus-5-5");
      expect(calls).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
    });
  });

  // Regression: user feedback 2026-08-03 — "il corrige tout le programme quand je
  // pose une question". Root cause was what sat on the FALLBACK rung, not the
  // prompt. gemini-3.5-flash 503'd three times in nine minutes, so every fallback
  // landed on gemini-3.1-flash-lite, the one rung that could not reason. Asked
  // whether an exercise was useful, it read the question as a reproach, rewrote
  // the whole programme and deleted the exercise — with all four consistency
  // rules sitting in its prompt.
  //
  // This requirement is vendor-independent, which is why it survived the
  // migration: rung 1 failing is ordinary, and rung 2 is what she actually gets
  // on a bad day, so rung 2 has to be able to follow a conditional instruction.
  //
  // What this pins is the MODEL, not a reasoning flag. The claim being protected
  // is "the fallback is not a strictly weaker class of model", which is what
  // gemini-3.1-flash-lite was, and what mistral-small-2603 turned out to be.
  // Cheapness is not why a rung is here; if the cheapest option ever stops being
  // a capable one, capability wins.
  it("falls back to a capable model, not to a cheaper weaker one", () => {
    // Opus 5.5 low: imported both emits with 0 errors on 2026-10-12 — a
    // stronger model than rung 1, never a weaker one.
    expect(MODEL_LADDER[1].model).toBe("claude-opus-5-5");
    // Stated as the CLAIM rather than as one id, because the id is what drifted:
    // this test asserted `mistral-small-2603` for a month while its own comment
    // said the fallback must not be a weaker class of model. It has since left
    // the ladder entirely; if it ever returns it may only be the floor.
    const cheapest = MODEL_LADDER.findIndex((e) => e.model === "mistral-small-2603");
    if (cheapest !== -1) expect(cheapest).toBe(MODEL_LADDER.length - 1);
  });

  it("uses the first model when it responds ok", async () => {
    const calls = [];
    const fetchImpl = async (_url, init) => { calls.push(JSON.parse(init.body).model); return { ok: true, body: {} }; };
    const { res, model, attempts, rungRetries } = await callChatStream(messages, {}, fetchImpl);
    expect(model).toBe(MODEL_LADDER[0].model);
    expect(res).toBeTruthy();
    expect(calls).toEqual([MODEL_LADDER[0].model]);
    expect(attempts).toEqual([]);
    expect(rungRetries).toBe(0);
  });

  // Kept as a 429 because that is the cheapest status to write, but note the
  // rationale changed with the vendor: Mistral's limits are ACCOUNT-level, so a
  // real 429 hits both rungs and the ladder cannot save it. What the ladder
  // survives now is one model being overloaded — a 503, or a rung that never
  // returns headers (below). Both are per-model, and both are what the user actually
  // hit on 2026-08-03.
  it("walks down the ladder past a model that rejects the request", async () => {
    const calls = [];
    const fetchImpl = async (_url, init) => {
      const model = JSON.parse(init.body).model;
      calls.push(model);
      return model === MODEL_LADDER[0].model
        ? { ok: false, status: 429, body: null }
        : { ok: true, body: {} };
    };
    const { model, attempts, rungRetries } = await callChatStream(messages, {}, fetchImpl);
    expect(model).toBe(MODEL_LADDER[1].model);
    expect(calls).toHaveLength(2);
    expect(attempts).toEqual([{ model: MODEL_LADDER[0].model, status: 429, detail: "" }]);
    expect(rungRetries).toBe(0);
  });

  it("treats an ok response with no body as a failure and moves on", async () => {
    const fetchImpl = async (_url, init) =>
      JSON.parse(init.body).model === MODEL_LADDER[0].model
        ? { ok: true, body: null }
        : { ok: true, body: {} };
    const { model } = await callChatStream(messages, {}, fetchImpl);
    expect(model).toBe(MODEL_LADDER[1].model);
  });

  // Regression: user feedback 2026-08-03 — "connexion instable". There was no
  // timeout at all. gemini-3.5-flash held two requests for 99 309 ms and
  // 59 297 ms before dying with a fragment, while the rung below answered the
  // very next request in 1 853 ms. Nothing could tell a slow rung from a dead
  // one, so it waited for both.
  //
  // This is now the ladder's PRIMARY job rather than a late addition to it: a
  // rung that goes quiet is per-model, whereas an account-level 429 would take
  // both rungs down together.
  describe("a rung that never answers", () => {
    // Distinct from a rung that returns an error status — that path never
    // throws, so it can never look like a header timeout.
    it("gives up on a rung that returns no headers and goes straight to the next one — no retry (regression: 25/09 ~30 s replies)", async () => {
      const calls = [];
      const fetchImpl = async (_url, init) => {
        const m = JSON.parse(init.body).model;
        calls.push(m);
        return m === MODEL_LADDER[0].model ? hangs(init.signal) : { ok: true, body: {} };
      };
      const t0 = Date.now();
      const { model, attempts, rungRetries } = await callChatStream(messages, { headerTimeoutMs: 20 }, fetchImpl);
      // The next rung of ANOTHER vendor: rung 2 shares rung 1's vendor and is
      // skipped once that vendor has held headers (see "skips the vendor's…").
      const nextVendorRung = MODEL_LADDER.find((e) => e.provider !== MODEL_LADDER[0].provider);
      expect(model).toBe(nextVendorRung.model);
      expect(rungRetries).toBe(0);
      expect(calls.filter((m) => m === MODEL_LADDER[0].model)).toHaveLength(1);
      expect(attempts).toHaveLength(2);
      expect(attempts[1].error).toMatch(/^skipped:/);
      expect(attempts[0].model).toBe(MODEL_LADDER[0].model);
      expect(attempts[0].error).toMatch(/^no response headers within 20 ms$/);
      expect(Date.now() - t0).toBeLessThan(500);
    });

    // THE POINT OF THE WHOLE DESIGN. A naive AbortSignal.timeout keeps firing
    // after the response resolves, so it would kill a healthy reply partway
    // through a 25 s stream — turning a latency fix into the exact data loss
    // this file exists to prevent. Remove the clearTimeout and this fails.
    it("stops the clock once headers land, so it can never abort the reply", async () => {
      let signal = null;
      const fetchImpl = async (_url, init) => { signal = init.signal; return { ok: true, body: {} }; };
      const { res } = await callChatStream(messages, { headerTimeoutMs: 10 }, fetchImpl);
      expect(res).toBeTruthy();
      await new Promise((r) => setTimeout(r, 40)); // well past the timeout
      expect(signal.aborted).toBe(false);
    });

    // A timeout is only ever an improvement when there is somewhere better to
    // go. On the floor it would convert a slow answer into no answer, which is
    // the one outcome worse than waiting — measured on the Gemini ladder: a
    // floor request took 50 832 ms to return headers on 2026-08-03 and then
    // answered normally.
    it("never times out the last rung", async () => {
      const last = MODEL_LADDER[MODEL_LADDER.length - 1].model;
      const fetchImpl = async (_url, init) => {
        if (JSON.parse(init.body).model !== last) return { ok: false, status: 503, body: null };
        expect(init.signal).toBeUndefined();
        await new Promise((r) => setTimeout(r, 40)); // slower than the timeout
        return { ok: true, body: {} };
      };
      const { model, res } = await callChatStream(messages, { headerTimeoutMs: 20 }, fetchImpl);
      expect(model).toBe(last);
      expect(res).toBeTruthy();
    });
  });

  // The rung-1 retry was deleted 2026-09-30. A 4xx and a generic network error
  // never retried either; this one stays as documentation of that.
  it("does not retry rung 1 on a 4xx", async () => {
    const calls = [];
    const fetchImpl = async (_url, init) => {
      const model = JSON.parse(init.body).model;
      calls.push(model);
      return model === MODEL_LADDER[0].model
        ? { ok: false, status: 400, body: null }
        : { ok: true, body: {} };
    };
    const { model, attempts } = await callChatStream(messages, { headerTimeoutMs: 20 }, fetchImpl);
    expect(model).toBe(MODEL_LADDER[1].model);
    expect(calls.filter((m) => m === MODEL_LADDER[0].model)).toHaveLength(1);
    expect(attempts).toEqual([{ model: MODEL_LADDER[0].model, status: 400, detail: "" }]);
  });

  it("a refused rung records the first 300 chars of the error body", async () => {
    // Regression: 25/09 — a 400 "Expected last role User", a 400 on a rejected schema
    // and a 422 were indistinguishable in the function log (attempts held status only).
    const body = JSON.stringify({ message: "Expected last role User or Tool", pad: "x".repeat(800) });
    const fetchImpl = async () => new Response(body, { status: 400 });
    const { attempts } = await callChatStream([{ role: "user", content: "x" }], { headerTimeoutMs: 50 }, fetchImpl);
    expect(attempts[0]).toMatchObject({ status: 400 });
    expect(attempts[0].detail).toContain("Expected last role User");
    expect(attempts[0].detail.length).toBeLessThanOrEqual(300);
  });

  // Regression: e662ce2 — the header timeout stops at headers, and the
  // error body was then read with an unbounded `res.text()`. A rung that
  // answered 503 and stalled its body held the whole ladder: Medium was never
  // tried and nothing reached the log.
  it("bounds the error-body read, cancels the stalled body and moves on", async () => {
    let cancelled = false;
    const stalled = () =>
      new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } }), { status: 503 });
    const fetchImpl = async (_url, init) =>
      JSON.parse(init.body).model === MODEL_LADDER[0].model ? stalled() : { ok: true, body: {} };
    const t0 = Date.now();
    const { model, attempts } = await callChatStream(messages, { errorBodyTimeoutMs: 20 }, fetchImpl);
    expect(model).toBe(MODEL_LADDER[1].model);
    expect(attempts[0]).toMatchObject({ status: 503, detail: "(error body not read within 20 ms)" });
    expect(cancelled).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  // `attempts` goes to the function log, and a FastAPI-style 422 echoes the
  // request's `input` — on this path, her messages and her export.
  // Regression: c8b5a20 — the eval harness copied the 16384 budget and the
  // plan-emit response_format instead of importing them, so a change in
  // production would have left the harness scoring a request nobody sends.
  it("exports the budget and the plan-emit response_format the eval shares", () => {
    expect(jsonSchemaResponseFormat("plan", { type: "object" })).toEqual({
      type: "json_schema",
      json_schema: { name: "plan", schema: { type: "object" }, strict: true },
    });
    const body = JSON.parse(buildRequest(MODEL_LADDER[0], [{ role: "user", content: "x" }]).body);
    expect(body.max_tokens).toBe(DEFAULT_MAX_TOKENS);
  });

  describe("redacting the error body", () => {
    const SECRET = "Camille: douleur genou droit";
    const fastapi422 = JSON.stringify({
      detail: [{ type: "string_type", loc: ["body", "messages", 0, "content"], msg: "Input should be a valid string", input: { content: SECRET }, ctx: { v: SECRET } }],
    });

    it("keeps what names the error and drops the echoed input", async () => {
      const fetchImpl = async () => new Response(fastapi422, { status: 422 });
      const { attempts } = await callChatStream(messages, {}, fetchImpl);
      expect(attempts[0].status).toBe(422);
      expect(attempts[0].detail).toContain("Input should be a valid string");
      expect(attempts[0].detail).toContain("string_type");
      expect(attempts[0].detail).not.toContain(SECRET);
    });

    it("redacts a validator body nested in Mistral's envelope, as an object or as a string", () => {
      const asObject = JSON.stringify({ object: "error", message: JSON.parse(fastapi422), type: "invalid_request_message_error", code: null });
      const asString = JSON.stringify({ object: "error", message: fastapi422, type: "invalid_request_message_error" });
      for (const body of [asObject, asString]) {
        const out = redactErrorBody(body);
        expect(out).toContain("invalid_request_message_error");
        expect(out).toContain("Input should be a valid string");
        expect(out).not.toContain(SECRET);
      }
    });

    it("keeps Mistral's plain error message whole", () => {
      const out = redactErrorBody('{"object":"error","message":"Expected last role User or Tool","type":"invalid_request_error","param":null,"code":"3230"}');
      expect(JSON.parse(out)).toEqual({ object: "error", message: "Expected last role User or Tool", type: "invalid_request_error", param: null, code: "3230" });
    });

    // Regression: 6efa685 — a body capped at 8 KB fails JSON.parse and the
    // raw 200-char prefix was returned unredacted, echoing her message.
    it("returns no prefix of a capped body or of JSON that does not parse", async () => {
      const big = new TextEncoder().encode(JSON.stringify({
        object: "error",
        message: { detail: [{ type: "value_error", msg: "bad", input: { role: "user", content: "SECRET_HEALTH_DATA ".repeat(1000) } }] },
        type: "invalid_request_message_error",
      }));
      const body = new ReadableStream({ start(c) { for (let i = 0; i < big.length; i += 4096) c.enqueue(big.slice(i, i + 4096)); c.close(); } });
      const { attempts } = await callChatStream(messages, { startAt: 2 }, async () => new Response(body, { status: 422 }));
      expect(attempts[0].detail).not.toContain("SECRET");
      expect(attempts[0].detail).toContain("unparsed");
      expect(redactErrorBody('{"a": "SECRET", truncated')).not.toContain("SECRET");
      expect(redactErrorBody(JSON.stringify({ message: '{"input":"SECRET", bad' }))).not.toContain("SECRET");
    });

    // Regression: 23f5eae — the allowlist filtered KEYS, never values,
    // so an allowlisted string could carry her text anyway: a pydantic repr
    // inside `message`, JSON embedded mid-string, a `detail`/`error`/`param`
    // echo, a `loc` entry, a top-level string or array, or a short HTML page
    // quoting the input. Redaction now goes by CONTENT: any detail string that
    // shares a 12-character run with an outgoing message is replaced, and an
    // allowlisted string is cut at its first `input`.
    describe("by content, not only by key", () => {
      const S = "SECRET genou droit, douleur depuis lundi";
      const outgoing = [
        { role: "system", content: "Tu es le coach de Camille." },
        { role: "user", content: `Bonjour. ${S}. Que faire ?` },
      ];
      const detailFor = async (body) => {
        const { attempts } = await callChatStream(outgoing, { startAt: 2 }, async () => new Response(body, { status: 422 }));
        return attempts[0].detail;
      };
      const shapes = {
        pydanticRepr: JSON.stringify({ object: "error", message: `1 validation error for ChatCompletionRequest\nmessages.1.content\n  Input should be a valid string [type=string_type, input_value={'role': 'user', 'content': '${S}'}, input_type=dict]`, type: "invalid_request_error" }),
        embeddedJsonMidString: JSON.stringify({ message: `Validation failed: {"input": "${S}"}` }),
        detailString: JSON.stringify({ detail: `Unprocessable: ${S}` }),
        errorString: JSON.stringify({ error: S }),
        paramEcho: JSON.stringify({ error: { message: "bad", input: S, param: S } }),
        loc: JSON.stringify({ detail: [{ loc: ["body", S], msg: "x" }] }),
        topLevelString: JSON.stringify(`echo ${S}`),
        topLevelArray: JSON.stringify([S]),
        shortHtml: `<html><body>Bad request for ${S}</body></html>`,
        plainText: `Bad request: ${S}`,
      };
      for (const [name, body] of Object.entries(shapes)) {
        it(`does not log her text through ${name}`, async () => {
          const detail = await detailFor(body);
          expect(detail).not.toContain("SECRET");
          expect(detail).not.toContain("genou droit");
        });
      }

      it("still keeps what names the error", async () => {
        const repr = await detailFor(shapes.pydanticRepr);
        expect(repr).toContain("Input should be a valid string");
        expect(repr).toContain("invalid_request_error");
        const env = await detailFor('{"object":"error","message":"Expected last role User or Tool","type":"invalid_request_error","param":null,"code":"3230"}');
        expect(JSON.parse(env).message).toBe("Expected last role User or Tool");
        expect(await detailFor("<html>502 Bad Gateway</html>")).toBe("<html>502 Bad Gateway</html>");
      });

      // Regression: eda62ff — the system message was skipped as "no
      // personal data", but its catalog section renders her free-text
      // inactiveReason, a free-text field the user writes.
      describe("against the real system prompts", () => {
        const views = buildCatalogViews(seed);
        const { equipment, structure, coaching } = buildPromptInputs(views);
        const prompts = ["discussion", "plan", "plan-emit"].map((mode) => [
          mode,
          [
            { role: "system", content: buildSystemPrompt(views.muscleGroups, equipment, views.blacklist, structure, coaching, mode) },
            { role: "user", content: "Bonjour." },
          ],
        ]);
        const detailAgainst = async (outgoingMessages, body) =>
          (await callChatStream(outgoingMessages, { startAt: 2 }, async () => new Response(body, { status: 400 }))).attempts[0].detail;

        it("redacts an echo of a deactivation reason the user wrote", async () => {
          const reason = views.blacklist.map((b) => b.reason).find((r) => r.length >= 12);
          expect(reason).toBeTruthy();
          for (const [, outgoing] of prompts) {
            expect(outgoing[0].content).toContain(reason);
            const detail = await detailAgainst(outgoing, JSON.stringify({ message: `bad content: ${reason}` }));
            expect(detail).not.toContain(reason);
          }
        });

        // Real Mistral envelopes, as returned by the API.
        for (const message of [
          "Requests rate limit exceeded",
          "Unauthorized",
          "Internal server error",
          "Expected last role User or Tool",
          "Response format json_schema is not supported",
        ]) {
          it(`keeps « ${message} » in every mode`, async () => {
            for (const [, outgoing] of prompts) {
              const detail = await detailAgainst(outgoing, JSON.stringify({ object: "error", message, type: "invalid_request_error" }));
              expect(JSON.parse(detail).message).toBe(message);
            }
          });
        }
      });

      it("cuts an allowlisted string at an input-value marker even with no request to compare", () => {
        for (const message of [
          "bad value, input_value='quelque chose de privé'",
          "bad value {'input': 'quelque chose de privé'}",
          'bad value {"input": "quelque chose de privé"}',
          "bad value, input='quelque chose de privé'",
        ]) {
          const out = redactErrorBody(JSON.stringify({ message }));
          expect(out).toContain("bad value");
          expect(out).not.toContain("privé");
        }
      });

      // Regression: 4295fc8 — a validator writing `input = …` or `input: …`
      // (spaced sign) matched no marker, so the value after it reached the
      // log whole. Round 6 narrowed the branch to a VALUE-looking token after
      // the sign (quote, `{`, `[`) so a diagnosis survives (next test).
      it("cuts at `input` followed by a colon or an equals sign and a quoted or structured value", () => {
        for (const message of [
          "value_error input = 'quelque chose de privé'",
          "input: 'quelque chose de privé'",
          "input={'content': 'quelque chose de privé'}",
          "input: [quelque chose de privé]",
        ]) {
          expect(redactErrorBody(JSON.stringify({ message }))).not.toContain("privé");
        }
        expect(JSON.parse(redactErrorBody(JSON.stringify({ message: "value_error input = 'x privé'" }))).message)
          .toBe("value_error …");
      });

      // Regression: ce5f573 — « Invalid input: expected array, received
      // string » was cut at its colon, throwing the diagnosis away.
      it("keeps « Invalid input: expected array, received string »", () => {
        const message = "Invalid input: expected array, received string";
        expect(JSON.parse(redactErrorBody(JSON.stringify({ message }))).message).toBe(message);
      });

      // An UNQUOTED value is no longer cut by the marker; the 12-char echo
      // check is the guard, and it catches the value whenever it repeats the
      // request. Without an echo there is nothing of hers to protect.
      it("still redacts an unquoted `input: …` value that echoes the request", () => {
        const echoed = `input: ${S} and more`;
        const out = redactErrorBody(JSON.stringify({ message: echoed }), { echoes: requestShingles(outgoing) });
        expect(out).not.toContain("SECRET");
      });

      // Regression: 73ce420 — the cut was at the first `input` WORD, which
      // is also the diagnosis in these.
      it("keeps a diagnosis that merely names inputs", () => {
        for (const message of [
          "Extra inputs are not permitted",
          "Prompt exceeds max_input_tokens (131072)",
          "Invalid input for messages[3].content",
        ]) {
          expect(JSON.parse(redactErrorBody(JSON.stringify({ message }), { echoes: requestShingles(outgoing) })).message).toBe(message);
        }
      });

      // Regression: e24c052 — the echo set (~100k entries on a real
      // request) was built for every refused rung whose body was read, even
      // when no string long enough to echo anything was ever checked.
      it("builds the echo set only when a detail string is actually checked", () => {
        const thunk = vi.fn(() => requestShingles(outgoing));
        redactErrorBody("", { echoes: thunk });
        redactErrorBody(JSON.stringify({ code: 503, message: "short" }), { echoes: thunk });
        expect(thunk).not.toHaveBeenCalled();
        const out = redactErrorBody(JSON.stringify({ message: `Bad: ${S}` }), { echoes: thunk });
        expect(thunk).toHaveBeenCalledTimes(1);
        expect(out).not.toContain("SECRET");
      });

      // Regression: 73ce420 — the echo check ran on the whole string and the
      // 200-char cut came after, so an echo that would never be logged
      // redacted the diagnosis in front of it.
      it("checks only what will be logged", () => {
        const diagnosis = "x".repeat(250);
        const out = JSON.parse(redactErrorBody(JSON.stringify({ message: `${diagnosis} ${S}` }), { echoes: requestShingles(outgoing) }));
        expect(out.message).toBe(diagnosis.slice(0, 200));
        // An echo inside the logged prefix is still redacted.
        const early = JSON.parse(redactErrorBody(JSON.stringify({ message: `Bad: ${S} ${diagnosis}` }), { echoes: requestShingles(outgoing) }));
        expect(early.message).toMatch(/^\(redacted/);
      });
    });

    // Regression: 23f5eae — ERROR_BODY_MAX_BYTES was compared against
    // decoded CHARACTERS, so a multibyte body could buffer twice the cap and
    // still be read "in full", prefix and all.
    it("caps the error body by encoded bytes, not characters", async () => {
      const bytes = new TextEncoder().encode("é".repeat(6000)); // 12 000 bytes, 6 000 chars
      const body = new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 1024) c.enqueue(bytes.slice(i, i + 1024)); c.close(); } });
      const { attempts } = await callChatStream(messages, { startAt: 2 }, async () => new Response(body, { status: 500 }));
      expect(attempts[0].detail).toMatch(/^\(unparsed error body, \d+ chars\)$/);
    });

    it("keeps only a short prefix of a body that is not JSON", () => {
      const out = redactErrorBody("<html>502 Bad Gateway</html>" + "x".repeat(1000));
      expect(out.startsWith("<html>502 Bad Gateway")).toBe(true);
      expect(out.length).toBeLessThanOrEqual(200);
    });
  });

  // coach-chat.js abandons a non-final rung that produced no text and resumes
  // here; these are the three things it relies on.
  describe("resuming the ladder after a silent rung", () => {
    const okFetch = (calls) => async (_url, init) => { calls.push(JSON.parse(init.body).model); return { ok: true, body: {} }; };

    it("starts at `startAt` and never touches the rungs above it", async () => {
      const calls = [];
      const { model, nextRung } = await callChatStream(messages, { startAt: 1 }, okFetch(calls));
      expect(calls).toEqual([MODEL_LADDER[1].model]);
      expect(model).toBe(MODEL_LADDER[1].model);
      expect(nextRung).toBe(2);
    });

    it("gives a non-final rung a first-text budget chosen by mode, and the last rung none", async () => {
      const chat = await callChatStream(messages, { mode: "discussion" }, okFetch([]));
      expect(chat).toMatchObject({ nextRung: 1, firstTextTimeoutMs: FIRST_TEXT_TIMEOUT_MS });
      const plan = await callChatStream(messages, { mode: "plan" }, okFetch([]));
      expect(plan.firstTextTimeoutMs).toBe(FIRST_TEXT_TIMEOUT_MS);
      const emit = await callChatStream(messages, { mode: "plan-emit" }, okFetch([]));
      expect(emit.firstTextTimeoutMs).toBe(PLAN_EMIT_FIRST_TEXT_TIMEOUT_MS);
      // Measured worst first text at medium effort (2026-10-12, her history):
      // chat 17.1 s (Opus), plan-emit 24.6 s (Opus). A budget under that
      // throws away a reply that was thinking fine.
      expect(FIRST_TEXT_TIMEOUT_MS).toBeGreaterThan(17_100 * 2);
      expect(PLAN_EMIT_FIRST_TEXT_TIMEOUT_MS).toBeGreaterThan(24_600 * 2);
      // Chat sends no keepalive, so its silent wait stays under the 53 s of
      // idle connection production has survived (EMIT_KEEPALIVE_MS).
      expect(FIRST_TEXT_TIMEOUT_MS).toBeLessThan(53_000);

      const last = await callChatStream(messages, { startAt: MODEL_LADDER.length - 1 }, okFetch([]));
      expect(last).toMatchObject({ nextRung: null, firstTextTimeoutMs: null });
    });

    it("has nowhere to go past the last rung", async () => {
      const calls = [];
      const { res, nextRung } = await callChatStream(messages, { startAt: MODEL_LADDER.length }, okFetch(calls));
      expect(calls).toEqual([]);
      expect(res).toBeNull();
      expect(nextRung).toBeNull();
    });
  });

  it("returns null res when every model fails, and reports why", async () => {
    const fetchImpl = async () => { throw new Error("network"); };
    const { res, model, attempts } = await callChatStream(messages, {}, fetchImpl);
    expect(res).toBeNull();
    expect(model).toBeNull();
    // The diagnostic matters: without it, every distinct failure mode reaches
    // The user as the same generic error and the function log says nothing.
    expect(attempts).toHaveLength(MODEL_LADDER.length);
    for (const a of attempts) expect(a.error).toMatch(/network/);
  });
});

// Regression: 92ce052 — review round 2 of the Large 4 swap, 2026-10-06. The
// keepalive held a buffered emit open for as long as the model kept writing,
// and a rung that committed on `{` then looped or hit finish=length ran to
// DEFAULT_MAX_TOKENS with no fallthrough: ~13 minutes at Large 4's 20 tok/s.
// Two bounds, both emit-only: a lower token ceiling and a payload budget that
// non-final rungs carry so coach-chat.js can abandon them and fall through.
describe("the emit path's own bounds", () => {
  const messages = [{ role: "user", content: "Prépare-moi mon programme de la semaine." }];

  it("caps plan-emit at PLAN_EMIT_MAX_TOKENS on a rung that does not think, and leaves chat at DEFAULT_MAX_TOKENS", async () => {
    const seen = [];
    const fetchImpl = async (_url, { body }) => {
      seen.push(JSON.parse(body).max_tokens);
      return new Response(new ReadableStream(), { status: 200 });
    };
    // Large 4, thinking off: the Claude rungs are refused so it answers.
    const claudeDown = async (url, init) => (url.includes("anthropic") ? new Response("", { status: 503 }) : fetchImpl(url, init));
    await callChatStream(messages, { mode: "plan-emit" }, claudeDown);
    await callChatStream(messages, { mode: "discussion" }, fetchImpl);
    await callChatStream(messages, { mode: "plan-emit", maxTokens: 4096 }, fetchImpl);
    expect(seen).toEqual([PLAN_EMIT_MAX_TOKENS, DEFAULT_MAX_TOKENS, 4096]);
    expect(PLAN_EMIT_MAX_TOKENS).toBeLessThan(DEFAULT_MAX_TOKENS);
  });

  // Round 3: GLM low THINKS inside max_tokens and is the emit floor with no
  // fallthrough — one emit already spent 5.5k with ~4k of it thinking, so a
  // ceiling that truncated its plan would end the request on PLAN_ERROR
  // where 16 384 produced a plan. The ceiling is per rung, by whether it thinks.
  it("keeps DEFAULT_MAX_TOKENS on a thinking rung even on plan-emit", () => {
    // Opus 5.5 cannot turn thinking off; it thinks inside max_tokens like GLM did.
    const glm = MODEL_LADDER.find((e) => /^claude-opus-/.test(e.model));
    const large4 = MODEL_LADDER.find((e) => /^mistral-large-/.test(e.model));
    const medium = MODEL_LADDER.find((e) => /^mistral-medium-/.test(e.model));
    expect(thinks(glm)).toBe(true);
    expect(thinks(large4)).toBe(false); // "none" is not thinking
    expect(thinks(medium)).toBe(false);
    expect(maxTokensFor(glm, "plan-emit")).toBe(DEFAULT_MAX_TOKENS);
    expect(maxTokensFor(large4, "plan-emit")).toBe(PLAN_EMIT_MAX_TOKENS);
    expect(maxTokensFor(medium, "plan-emit")).toBe(PLAN_EMIT_MAX_TOKENS);
    for (const e of MODEL_LADDER) expect(maxTokensFor(e, "discussion")).toBe(DEFAULT_MAX_TOKENS);
  });

  // Round 3: built by position, a reorder of MODEL_LADDER silently reordered
  // the emit ladder too; by id string, a re-pin left a hole. By family, both
  // leave the emit order intact.
  // Round 5: a missing family used to throw at module load, which fails the
  // import of coach-chat.js and takes the CHAT path down with the emit ladder.
  // It is skipped at runtime instead, and THIS is where its absence fails.
  it("is a permutation of MODEL_LADDER: every chat rung is an emit rung and vice versa", () => {
    // Round 7: a rung added to MODEL_LADDER that no family names would never
    // reach the « Plan » path, and a family that left would shorten it — both
    // silently at runtime, both loudly here.
    for (const re of PLAN_EMIT_FAMILIES) expect(MODEL_LADDER.some((e) => re.test(e.model)), String(re)).toBe(true);
    expect(new Set(PLAN_EMIT_LADDER)).toEqual(new Set(MODEL_LADDER));
    expect(PLAN_EMIT_LADDER).toHaveLength(MODEL_LADDER.length);
  });

  // Round 7: the payload budget starts at headers, so a floor that accepted the
  // connection and never sent headers held a keepalive-fed « Plan » wait open
  // with no end. On emit the floor's header wait is bounded by the same budget.
  it("bounds the emit floor's header wait with the payload budget, and leaves the chat floor unbounded", async () => {
    vi.useFakeTimers();
    try {
      const floor = PLAN_EMIT_LADDER.at(-1).model;
      // A connection that is accepted and never answers, but honours the abort
      // the header timer sends — as a real fetch does.
      const hangOnFloor = async (_url, { body, signal }) =>
        JSON.parse(body).model === floor
          ? new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
          : new Response("", { status: 503 });
      const pending = callChatStream(messages, { mode: "plan-emit" }, hangOnFloor);
      await vi.advanceTimersByTimeAsync(PLAN_EMIT_FLOOR_HEADER_TIMEOUT_MS + 1);
      const r = await pending;
      expect(r.res).toBeNull();
      expect(r.attempts.find((a) => a.model === floor)?.error).toMatch(/no response headers within/);
      // Its own number (round 8): shorter than the payload budget it precedes,
      // above every header tail measured (~51 s).
      expect(PLAN_EMIT_FLOOR_HEADER_TIMEOUT_MS).toBeLessThan(PLAN_EMIT_PAYLOAD_TIMEOUT_MS);
      expect(PLAN_EMIT_FLOOR_HEADER_TIMEOUT_MS).toBeGreaterThan(51_000);
      // And the CHAT floor stays unbounded (round 9 asked for the proof the
      // title promised): a floor that took 50 832 ms to return headers on
      // 2026-08-03 then answered normally, and a timeout only helps when
      // there is somewhere better to go.
      const chatFloor = MODEL_LADDER.at(-1).model;
      const hangOnChatFloor = async (_url, { body, signal }) =>
        JSON.parse(body).model === chatFloor
          ? new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
          : new Response("", { status: 503 });
      const chatPending = callChatStream(messages, { mode: "discussion" }, hangOnChatFloor);
      await vi.advanceTimersByTimeAsync(PLAN_EMIT_PAYLOAD_TIMEOUT_MS * 4);
      const STILL_WAITING = Symbol("still waiting");
      expect(await Promise.race([chatPending, Promise.resolve(STILL_WAITING)])).toBe(STILL_WAITING);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the emit order Sonnet → Opus → Large → Medium by model family, whatever MODEL_LADDER's order or ids", () => {
    expect(PLAN_EMIT_LADDER.map((e) => e.model)).toEqual([
      expect.stringMatching(/^claude-sonnet-/),
      expect.stringMatching(/^claude-opus-/),
      expect.stringMatching(/^mistral-large-/),
      expect.stringMatching(/^mistral-medium-/),
    ]);
  });

  describe("two vendors", () => {
    const fixture = (name) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
    const opus = MODEL_LADDER[0];
    const large4 = MODEL_LADDER.find((e) => e.model === "mistral-large-4");

    // Found by the first live harness run, 2026-10-12: a caller that passed no
    // maxTokens got a Mistral body with the default and an Anthropic body
    // without the field — a 400 (« max_tokens: Field required ») on both Claude rungs.
    it("gives an Anthropic rung the same default max_tokens a Mistral rung gets", () => {
      expect(JSON.parse(requestFor(opus, messages).body).max_tokens).toBe(DEFAULT_MAX_TOKENS);
      expect(JSON.parse(requestFor(large4, messages).body).max_tokens).toBe(DEFAULT_MAX_TOKENS);
    });

    it("builds each rung's request for its own vendor", () => {
      expect(requestFor(opus, messages, { maxTokens: 10 }).url).toBe("https://api.anthropic.com/v1/messages");
      expect(requestFor(large4, messages, { maxTokens: 10 }).url).toBe(MISTRAL_URL);
    });

    it("parses each vendor's stream with its own parser, Mistral by default", () => {
      const p = createParserFor("anthropic");
      const out = p.push(fixture("anthropic-chat.sse")) + p.end();
      expect(out.length).toBeGreaterThan(0);
      expect(p.finishReason()).toBe("stop");
      const m = createParserFor(undefined);
      expect(m.push('data: {"choices":[{"delta":{"content":"ok"}}]}\n')).toBe("ok");
    });

    it("returns the answering rung's provider", async () => {
      const ok = async () => new Response(new ReadableStream(), { status: 200 });
      expect((await callChatStream(messages, { mode: "discussion" }, ok)).provider).toBe("anthropic");
      const anthropicDown = async (url) => (url.includes("anthropic") ? new Response("", { status: 503 }) : new Response(new ReadableStream(), { status: 200 }));
      const r = await callChatStream(messages, { mode: "discussion" }, anthropicDown);
      expect(r).toMatchObject({ model: "mistral-large-4", provider: "mistral" });
    });

    // Review finding (2026-10-12): rungs 1 and 2 share a vendor. When that
    // vendor holds headers, waiting out the same timeout again on rung 2 only
    // doubles her wait before Mistral; a 5xx (fast) still tries rung 2.
    it("skips the vendor's remaining rungs after one header timeout", async () => {
      vi.useFakeTimers();
      try {
        const calls = [];
        const fetchImpl = async (url, { body, signal }) => {
          calls.push(JSON.parse(body).model);
          return url.includes("anthropic") ? hangs(signal) : new Response(new ReadableStream(), { status: 200 });
        };
        const pending = callChatStream(messages, { mode: "discussion" }, fetchImpl);
        await vi.advanceTimersByTimeAsync(15_001);
        const r = await pending;
        expect(calls).toEqual(["claude-sonnet-5-5", "mistral-large-4"]);
        expect(r.model).toBe("mistral-large-4");
        expect(r.attempts.map((a) => a.model)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
        expect(r.attempts[1].error).toMatch(/skipped/);
      } finally {
        vi.useRealTimers();
      }
    });

    // Review Focus 5: a missing or wrong ANTHROPIC_API_KEY in Netlify is a 401
    // on both Claude rungs at once. The ladder must reach Mistral without
    // spending any header budget, and the log must name the 401s.
    it("falls through two 401s to Mistral at once, without waiting on any timer", async () => {
      vi.useFakeTimers();
      try {
        const urls = [];
        const fetchImpl = async (url) => {
          urls.push(url);
          return url.includes("anthropic") ? new Response('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', { status: 401 }) : new Response(new ReadableStream(), { status: 200 });
        };
        const r = await callChatStream(messages, { mode: "discussion" }, fetchImpl);
        expect(urls).toHaveLength(3);
        expect(r).toMatchObject({ model: "mistral-large-4", provider: "mistral" });
        expect(r.attempts.map((a) => [a.model, a.status])).toEqual([["claude-sonnet-5-5", 401], ["claude-opus-5-5", 401]]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("hands a payload budget to every emit rung, the floor included — and to no chat rung", async () => {
    const okOnlyFor = (model) => async (_url, { body }) =>
      JSON.parse(body).model === model ? new Response(new ReadableStream(), { status: 200 }) : new Response("", { status: 503 });
    const emitFirst = await callChatStream(messages, { mode: "plan-emit" }, okOnlyFor(PLAN_EMIT_LADDER[0].model));
    expect(emitFirst.payloadTimeoutMs).toBe(PLAN_EMIT_PAYLOAD_TIMEOUT_MS);
    // Round 4: the floor too. The keepalive made an unbounded floor a waiting
    // line with no end; on emit nothing reaches her before the payload anyway.
    const emitFloor = await callChatStream(messages, { mode: "plan-emit" }, okOnlyFor(PLAN_EMIT_LADDER.at(-1).model));
    expect(emitFloor.payloadTimeoutMs).toBe(PLAN_EMIT_PAYLOAD_TIMEOUT_MS);
    expect(emitFloor.firstTextTimeoutMs).toBeNull(); // the floor's FIRST-TEXT budget stays off, as for chat
    const chatFirst = await callChatStream(messages, { mode: "discussion" }, okOnlyFor(MODEL_LADDER[0].model));
    expect(chatFirst.payloadTimeoutMs).toBeNull();
    // Longer than the first-text budget on the same path: it starts at headers and must outlast it.
    expect(PLAN_EMIT_PAYLOAD_TIMEOUT_MS).toBeGreaterThan(PLAN_EMIT_FIRST_TEXT_TIMEOUT_MS);
  });
});
