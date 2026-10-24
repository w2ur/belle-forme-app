import { describe, it, expect } from "vitest";
import {
  createSSEParser,
  contentText,
  normalizeUsage,
  incompleteReason,
  INCOMPLETE_STREAM_CUT,
  INCOMPLETE_MAX_TOKENS,
  INCOMPLETE_NO_FINISH_REASON,
} from "../functions/lib/sse.js";

const evt = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

describe("createSSEParser", () => {
  it("extracts content from complete events", () => {
    const p = createSSEParser();
    expect(p.push(evt("Bon"))).toBe("Bon");
    expect(p.push(evt("jour"))).toBe("jour");
  });

  it("buffers a line split across chunks", () => {
    const p = createSSEParser();
    const full = evt("Bonjour");
    const mid = Math.floor(full.length / 2);
    expect(p.push(full.slice(0, mid))).toBe(""); // partial, nothing yet
    expect(p.push(full.slice(mid))).toBe("Bonjour");
  });

  it("ignores [DONE] and non-data lines", () => {
    const p = createSSEParser();
    expect(p.push(": keep-alive\n\n")).toBe("");
    expect(p.push("data: [DONE]\n\n")).toBe("");
  });

  it("skips events with no content delta (e.g. role-only)", () => {
    const p = createSSEParser();
    expect(p.push(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`)).toBe("");
  });

  // Regression: user feedback 2026-08-01 — "some answers are not complete". The
  // parser read only delta.content and dropped finish_reason on the floor, so
  // a reply the model had to cut short at max_tokens was indistinguishable
  // from a finished one: the text just stopped and the stream closed cleanly.
  // This is the only place the distinction exists.
  it("records finish_reason", () => {
    const p = createSSEParser();
    expect(p.finishReason()).toBeNull();
    p.push(evt("Séance 1"));
    expect(p.finishReason()).toBeNull();
    p.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`);
    expect(p.finishReason()).toBe("length");
  });

  it("distinguishes a normal ending from a truncation", () => {
    const p = createSSEParser();
    p.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "Voilà." }, finish_reason: "stop" }] })}\n\n`);
    expect(p.finishReason()).toBe("stop");
  });
});

describe("normalizeUsage", () => {
  it("reads the OpenAI-compatible shape", () => {
    expect(normalizeUsage({
      prompt_tokens: 12000,
      completion_tokens: 1500,
      prompt_tokens_details: { cached_tokens: 8000 },
    })).toEqual({ promptTokens: 12000, cachedTokens: 8000, completionTokens: 1500 });
  });

  // The distinction the whole instrumentation rests on. A missing field means
  // "the provider said nothing"; 0 means "the provider said no cache hit". If
  // these collapse, the caching change can never be shown to work or fail —
  // every request would look like a cache miss and it would look like data.
  it("keeps absent and zero apart on cached tokens", () => {
    expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 2 }).cachedTokens).toBeNull();
    expect(normalizeUsage({
      prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 },
    }).cachedTokens).toBe(0);
  });

  it("accepts the other spellings providers use for the cache figure", () => {
    expect(normalizeUsage({ cached_content_token_count: 4096 }).cachedTokens).toBe(4096);
    expect(normalizeUsage({ promptTokensDetails: { cachedTokens: 512 } }).cachedTokens).toBe(512);
  });

  it("returns nulls rather than throwing when there is no usage at all", () => {
    for (const bad of [null, undefined, "nope", 42]) {
      expect(normalizeUsage(bad)).toEqual({ promptTokens: null, cachedTokens: null, completionTokens: null });
    }
  });
});

// The two shapes this parser has to survive, pinned as a pair. Providers do not
// agree on where the usage block goes, and the difference is invisible until the
// coach_usage table quietly fills with nulls — which reads as a provider quirk
// rather than as a parser that looked in the wrong place.
describe("createSSEParser — usage capture", () => {
  // The Gemini shape: usage arrives on its own trailing chunk whose `choices`
  // array is EMPTY. Reading it off the choice would miss it entirely.
  it("captures usage from a trailing chunk that carries no choices", () => {
    const p = createSSEParser();
    p.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "Voilà." }, finish_reason: "stop" }] })}\n\n`);
    expect(p.usage()).toBeNull();
    p.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 80 } })}\n\n`);
    expect(normalizeUsage(p.usage())).toMatchObject({ promptTokens: 900, completionTokens: 80 });
    expect(p.finishReason()).toBe("stop");
  });

  // The Mistral shape, verified by live call on 2026-08-03: finish_reason AND
  // usage on the SAME chunk, with `choices` non-empty. This is the shape the
  // coach actually runs against now, and it is the one that breaks the moment
  // the `json?.usage` read is moved inside the choice-handling branch — which is
  // where a tidy-up would naturally put it, since that branch already has the
  // chunk in hand.
  it("captures usage from a final chunk that also carries the choice", () => {
    const p = createSSEParser();
    expect(
      p.push(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "Voilà." }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 14183,
            completion_tokens: 830,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        })}\n\n`
      )
    ).toBe("Voilà.");
    expect(p.finishReason()).toBe("stop");
    expect(normalizeUsage(p.usage())).toEqual({
      promptTokens: 14183,
      // Reported as 0 rather than omitted — a stated cache miss, not silence.
      cachedTokens: 0,
      completionTokens: 830,
    });
  });

  it("survives a usage chunk split across two reads", () => {
    const p = createSSEParser();
    const line = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })}\n\n`;
    p.push(line.slice(0, 20));
    p.push(line.slice(20));
    expect(normalizeUsage(p.usage()).promptTokens).toBe(7);
  });
});

// Regression: user feedback 2026-08-03 — "il corrige tout le programme quand je
// pose une question". Measured on prod that morning: gemini-3.5-flash returned
// headers after 59 s and 99 s, emitted 43 and 48 completion tokens, and closed
// the stream with finish_reason null. The old test was
// `interrupted || finishReason === "length"`, so a 155-character fragment
// stopping mid-word was persisted as a finished answer with no note on it.
//
// The fragment happened to be the opening of an apology. The user resent the same
// question; the next model read that severed apology as a position the coach had
// taken, escalated, and rewrote her whole programme. Marking the fragment is what
// breaks that chain.
describe("incompleteReason", () => {
  it("treats a stream that closed without a finish reason as incomplete", () => {
    expect(incompleteReason({ finishReason: null })).toBe(INCOMPLETE_NO_FINISH_REASON);
    expect(incompleteReason({ finishReason: undefined })).toBe(INCOMPLETE_NO_FINISH_REASON);
    expect(incompleteReason({})).toBe(INCOMPLETE_NO_FINISH_REASON);
  });

  // The false-positive guard. A correct reply wrongly marked costs one confusing
  // line; the opposite corrupts every turn after it — but "mark everything" is
  // still not the answer, and this is what stops it drifting there.
  it("leaves a genuinely finished reply alone", () => {
    expect(incompleteReason({ finishReason: "stop" })).toBeNull();
    expect(incompleteReason({ interrupted: false, finishReason: "stop" })).toBeNull();
  });

  it("still catches the two failures it always caught", () => {
    expect(incompleteReason({ interrupted: true, finishReason: "stop" })).toBe(INCOMPLETE_STREAM_CUT);
    expect(incompleteReason({ finishReason: "length" })).toBe(INCOMPLETE_MAX_TOKENS);
  });

  // A reason we have no name for is not "stop", so it is not finished — and it
  // reaches the log verbatim instead of being flattened into the absent case.
  it("reports an unknown finish reason by name", () => {
    expect(incompleteReason({ finishReason: "content_filter" })).toBe("content_filter");
  });
});

// The typed-block shape, recorded live from zai-glm-5-3 on 2026-10-01
// (`reasoning_effort: "low"`, « Réponds en une phrase : bonjour »). Trimmed to
// the deltas, in arrival order, ids and logprobs dropped. GLM 5.3 cannot turn
// reasoning off, so this IS what rung 1 sends on every request: empty strings,
// then thinking arrays, then ONE chunk carrying the last thinking fragment AND
// the first text block, then plain strings to the end.
const GLM53_DELTAS = [
  "",
  "",
  [{ type: "thinking", thinking: [{ type: "text", text: "Bonjour" }], closed: true }],
  [{ type: "thinking", thinking: [{ type: "text", text: " in" }], closed: true }],
  [{ type: "thinking", thinking: [{ type: "text", text: " one" }], closed: true }],
  [
    { type: "thinking", thinking: [{ type: "text", text: " sentence." }], closed: true },
    { type: "text", text: "Bonjour," },
  ],
  " comment puis-",
  "je vous aider aujourd",
  "'hui ?",
  "",
];

describe("contentText", () => {
  it("returns a string unchanged", () => {
    expect(contentText("Bonjour")).toEqual({ text: "Bonjour", thinkingChars: 0 });
    expect(contentText("")).toEqual({ text: "", thinkingChars: 0 });
  });

  it("keeps text blocks in order and only counts thinking", () => {
    expect(
      contentText([
        { type: "thinking", thinking: [{ type: "text", text: "hmm, " }, { type: "text", text: "ok" }], closed: true },
        { type: "text", text: "Bonjour " },
        { type: "text", text: "!" },
      ])
    ).toEqual({ text: "Bonjour !", thinkingChars: 7 });
  });

  it("counts thinking given as a plain string too", () => {
    expect(contentText([{ type: "thinking", thinking: "abc" }])).toEqual({ text: "", thinkingChars: 3 });
  });

  // Forwarding a shape it does not know is how a private channel leaks the day
  // a vendor adds one, so the allow-list is exactly `type: "text"`.
  it("drops unknown block types and bare strings inside an array", () => {
    expect(contentText([{ type: "reasoning", text: "secret" }, "loose", { text: "untyped" }]).text).toBe("");
  });

  it("returns nothing for null, numbers and objects", () => {
    for (const bad of [null, undefined, 42, { type: "text", text: "x" }]) {
      expect(contentText(bad)).toEqual({ text: "", thinkingChars: 0 });
    }
  });
});

// Regression: 2026-10-01 — zai-glm-5-3 returns `content` as typed blocks and
// cannot turn reasoning off. The parser kept strings only, so rung 1 would have
// answered every request with a silently EMPTY reply.
describe("createSSEParser — typed blocks (zai-glm-5-3)", () => {
  it("forwards the visible text of the recorded GLM 5.3 stream and nothing of its thinking", () => {
    const p = createSSEParser();
    let out = "";
    for (const d of GLM53_DELTAS) out += p.push(evt(d));
    p.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "" }, finish_reason: "stop" }] })}\n\n`);
    expect(out).toBe("Bonjour, comment puis-je vous aider aujourd'hui ?");
    expect(out).not.toMatch(/sentence|in one/);
    expect(p.thinkingChars()).toBe("Bonjour in one sentence.".length);
    expect(p.finishReason()).toBe("stop");
  });

  it("keeps a plain string stream's output and counts no thinking", () => {
    const p = createSSEParser();
    expect(p.push(evt("Bon") + evt("jour"))).toBe("Bonjour");
    expect(p.thinkingChars()).toBe(0);
  });

  // The failure that must stay LOUD: a model that spends the whole budget
  // thinking ends with no visible text and finish_reason "length". The parser
  // returns "" — and incompleteReason, fed the same parser, still names it, so
  // coach-chat takes the truncation path rather than banking an empty answer.
  it("reports a thinking-only stream as empty AND as cut by the budget", () => {
    const p = createSSEParser();
    let out = "";
    for (const d of GLM53_DELTAS.slice(0, 5)) out += p.push(evt(d));
    p.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "" }, finish_reason: "length" }] })}\n\n`);
    expect(out).toBe("");
    expect(p.thinkingChars()).toBeGreaterThan(0);
    expect(incompleteReason({ finishReason: p.finishReason() })).toBe(INCOMPLETE_MAX_TOKENS);
  });
});

describe("createSSEParser.end", () => {
  // Regression: 7cf40bb — a final `data:` line with no trailing newline stayed in the buffer and was dropped, taking finish_reason and usage with it
  it("flushes a last data line that has no trailing newline", () => {
    const p = createSSEParser();
    const last = `data: ${JSON.stringify({
      choices: [{ delta: { content: "fin" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })}`;
    expect(p.push(last)).toBe("");
    expect(p.finishReason()).toBeNull();
    expect(p.end()).toBe("fin");
    expect(p.finishReason()).toBe("stop");
    expect(p.usage()).not.toBeNull();
  });

  // The flush runs through the same block-aware handler as push: a final
  // unterminated typed-block chunk returns its text and only COUNTS its thinking.
  it("flushes a final typed-block line through contentText, withholding thinking", () => {
    const p = createSSEParser();
    const last = `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            content: [
              { type: "thinking", thinking: [{ type: "text", text: "secret" }], closed: true },
              { type: "text", text: "fin" },
            ],
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })}`;
    expect(p.push(last)).toBe("");
    const out = p.end();
    expect(out).toBe("fin");
    expect(out).not.toMatch(/secret/);
    expect(p.thinkingChars()).toBe("secret".length);
    expect(p.finishReason()).toBe("stop");
    expect(p.usage()).not.toBeNull();
  });

  it("flushes a final thinking-only line as no text, with its length counted", () => {
    const p = createSSEParser();
    p.push(`data: ${JSON.stringify({ choices: [{ delta: { content: [{ type: "thinking", thinking: "abcd" }] }, finish_reason: "length" }] })}`);
    expect(p.end()).toBe("");
    expect(p.thinkingChars()).toBe(4);
    expect(incompleteReason({ finishReason: p.finishReason() })).toBe(INCOMPLETE_MAX_TOKENS);
  });

  it("is a no-op on an empty buffer and idempotent", () => {
    const p = createSSEParser();
    p.push(evt("a"));
    expect(p.end()).toBe("");
    expect(p.end()).toBe("");
  });
});
