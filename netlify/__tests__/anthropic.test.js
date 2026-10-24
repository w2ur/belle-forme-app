import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  toAnthropicMessages, buildAnthropicRequest, createAnthropicSSEParser,
  ANTHROPIC_VERSION, FALLBACK_BETA, WINDOW_START_NOTE, EMPTY_TURN_NOTE,
} from "../functions/lib/anthropic.js";
import { incompleteReason } from "../functions/lib/sse.js";
import { jsonSchemaResponseFormat } from "../functions/lib/providers.js";

const fixture = (name) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const events = (sse) => sse.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
const textOf = (sse) => events(sse).filter((e) => e.delta?.type === "text_delta").map((e) => e.delta.text).join("");

/** Feeds `wire` through a fresh parser in `size`-byte slices, as a socket would. */
function drain(wire, size = 7) {
  const p = createAnthropicSSEParser();
  let out = "";
  for (let i = 0; i < wire.length; i += size) out += p.push(wire.slice(i, i + size));
  out += p.end();
  return { out, p };
}

const OPUS = { provider: "anthropic", model: "claude-opus-5-5", reasoningEffort: "low" };

describe("toAnthropicMessages", () => {
  it("splits the system message off and keeps every turn in order", () => {
    const { system, turns } = toAnthropicMessages([
      { role: "system", content: "S" }, { role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" },
    ]);
    expect(system).toBe("S");
    expect(turns).toEqual([{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }]);
  });

  it("prepends a fixed user turn when the window opens on an assistant turn, dropping nothing", () => {
    const { turns } = toAnthropicMessages([{ role: "system", content: "S" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }]);
    expect(turns).toEqual([{ role: "user", content: WINDOW_START_NOTE }, { role: "assistant", content: "b" }, { role: "user", content: "c" }]);
  });

  // Probe 6, 2026-10-12: an empty user turn is a 400 « non-empty content ».
  it("keeps an empty turn with a placeholder instead of sending an empty text block", () => {
    const { turns } = toAnthropicMessages([{ role: "user", content: "" }, { role: "assistant", content: "  " }, { role: "user", content: "c" }]);
    expect(turns.map((t) => t.content)).toEqual([EMPTY_TURN_NOTE, EMPTY_TURN_NOTE, "c"]);
  });
});

describe("buildAnthropicRequest", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "ak";
  });
  const messages = [
    { role: "system", content: "SYS" }, { role: "user", content: "q1" }, { role: "assistant", content: "r1" }, { role: "user", content: "volatile" },
  ];

  it("targets the Messages API with our key, version and the fallback beta", () => {
    const req = buildAnthropicRequest(OPUS, messages, { maxTokens: 100 });
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req.headers).toMatchObject({ "x-api-key": "ak", "anthropic-version": ANTHROPIC_VERSION, "anthropic-beta": FALLBACK_BETA });
  });

  it("streams with the entry's effort, server-side fallback and 1 h breakpoints on system and the last history turn", () => {
    const body = JSON.parse(buildAnthropicRequest(OPUS, messages, { maxTokens: 100 }).body);
    expect(body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 100, stream: true, fallbacks: "default", output_config: { effort: "low" } });
    const cc = { type: "ephemeral", ttl: "1h" };
    expect(body.system).toEqual([{ type: "text", text: "SYS", cache_control: cc }]);
    expect(body.messages[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "r1", cache_control: cc }] });
    expect(body.messages[0]).toEqual({ role: "user", content: "q1" });
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "volatile" });
    for (const key of ["prompt_cache_key", "reasoning_effort", "stream_options", "thinking", "response_format"]) expect(body).not.toHaveProperty(key);
    expect(body.output_config).not.toHaveProperty("format");
  });

  it("constrains the emit to the plan schema through output_config.format", () => {
    const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };
    const body = JSON.parse(buildAnthropicRequest(OPUS, messages, { maxTokens: 100, responseFormat: jsonSchemaResponseFormat("plan", schema) }).body);
    expect(body.output_config).toEqual({ effort: "low", format: { type: "json_schema", schema } });
  });

  it("ignores Mistral's prompt cache key", () => {
    const body = JSON.parse(buildAnthropicRequest(OPUS, messages, { maxTokens: 100, promptCacheKey: "k" }).body);
    expect(body).not.toHaveProperty("prompt_cache_key");
  });
});

describe("createAnthropicSSEParser", () => {
  it("returns exactly the text deltas of a recorded chat stream, in slices", () => {
    const wire = fixture("anthropic-chat.sse");
    const { out, p } = drain(wire);
    expect(out).toBe(textOf(wire));
    expect(out.length).toBeGreaterThan(0);
    expect(p.finishReason()).toBe("stop");
  });

  it("reports usage in the OpenAI shape normalizeUsage reads, from the final message_delta", () => {
    const wire = fixture("anthropic-chat.sse");
    const fin = events(wire).find((e) => e.type === "message_delta").usage;
    const { p } = drain(wire);
    expect(p.usage()).toEqual({
      prompt_tokens: fin.input_tokens + fin.cache_read_input_tokens + fin.cache_creation_input_tokens,
      completion_tokens: fin.output_tokens,
      prompt_tokens_details: { cached_tokens: fin.cache_read_input_tokens },
    });
  });

  // Regression guard on a privacy rule: thinking is her health data reasoned
  // about. The recorded fixture's thinking text is EMPTY (display omitted), so
  // this hand-written one carries sentinels a leak would expose.
  it("never forwards thinking text, and counts it", () => {
    const wire = fixture("anthropic-thinking.sse");
    const { out, p } = drain(wire);
    expect(out).not.toContain("SECRET-THINKING");
    expect(out).toBe(textOf(wire));
    expect(p.thinkingChars()).toBe("SECRET-THINKING-ALPHA".length + "SECRET-THINKING-BETA".length);
  });

  it("yields a payload that parses on a recorded emit stream", () => {
    const { out, p } = drain(fixture("anthropic-emit.sse"));
    expect(() => JSON.parse(out)).not.toThrow();
    expect(p.finishReason()).toBe("stop");
  });

  it("keeps the text before a mid-stream error and reports the error as an incomplete reason", () => {
    const wire = fixture("anthropic-error-mid.sse");
    const { out, p } = drain(wire);
    expect(out).toBe(textOf(wire));
    expect(p.finishReason()).toBe("error: overloaded_error");
    expect(incompleteReason({ finishReason: p.finishReason() })).toBe("error: overloaded_error");
  });

  const delta = (stop_reason) => `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason }, usage: { output_tokens: 1 } })}\n`;
  it.each([["end_turn", "stop"], ["stop_sequence", "stop"], ["max_tokens", "length"], ["refusal", "refusal"]])(
    "maps stop_reason %s to %s",
    (raw, mapped) => {
      const p = createAnthropicSSEParser();
      p.push(delta(raw));
      expect(p.finishReason()).toBe(mapped);
    }
  );

  it("forwards a text_delta only on a block that started as text", () => {
    const p = createAnthropicSSEParser();
    const line = (o) => `data: ${JSON.stringify(o)}\n`;
    const out =
      p.push(line({ type: "content_block_start", index: 0, content_block: { type: "fallback" } })) +
      p.push(line({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hidden" } })) +
      p.push(line({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })) +
      p.push(line({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "shown" } }));
    expect(out).toBe("shown");
  });

  it("reads a final line with no trailing newline at end()", () => {
    const p = createAnthropicSSEParser();
    p.push(`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}\n`);
    expect(p.push(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fin" } })}`)).toBe("");
    expect(p.end()).toBe("fin");
  });

  // message_delta repeats the input counts and is final (a server-side
  // fallback's iterations are folded in there, not in message_start).
  it("prefers the final message_delta's input and cache counts over message_start's", () => {
    const p = createAnthropicSSEParser();
    const line = (o) => `data: ${JSON.stringify(o)}\n`;
    p.push(line({ type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } }));
    p.push(line({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 30, cache_read_input_tokens: 7, cache_creation_input_tokens: 3, output_tokens: 9 } }));
    expect(p.usage()).toEqual({ prompt_tokens: 40, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 7 } });
  });

  // Review finding (2026-10-12): message_start's output_tokens is a placeholder
  // (5 in the recorded fixture). A rung cancelled at its budget before
  // message_delta must report an unknown completion count, not a made-up one.
  it("reports no completion count until message_delta says one", () => {
    const p = createAnthropicSSEParser();
    p.push(`data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 5 } } })}\n`);
    expect(p.usage().completion_tokens).toBeNull();
  });

  // Review finding (2026-10-12): with fallbacks:"default" another model can
  // answer inside the same call; coach_usage must name it.
  it("names the model a server-side fallback switched to, and nothing otherwise", () => {
    const line = (o) => `data: ${JSON.stringify(o)}\n`;
    const plain = createAnthropicSSEParser();
    plain.push(line({ type: "message_start", message: { model: "claude-sonnet-5-5", usage: { input_tokens: 1 } } }));
    expect(plain.servedModel()).toBeNull();
    const p = createAnthropicSSEParser();
    p.push(line({ type: "message_start", message: { model: "claude-sonnet-5-5", usage: { input_tokens: 1 } } }));
    p.push(line({ type: "content_block_start", index: 0, content_block: { type: "fallback", from: { model: "claude-sonnet-5-5" }, to: { model: "claude-opus-4-8" } } }));
    expect(p.servedModel()).toBe("claude-opus-4-8");
  });

  it("has no usage before message_start, and no cached_tokens when the vendor sent no cache read", () => {
    const p = createAnthropicSSEParser();
    expect(p.usage()).toBeNull();
    p.push(`data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } })}\n`);
    expect(p.usage()).toEqual({ prompt_tokens: 5, completion_tokens: null });
  });
});
