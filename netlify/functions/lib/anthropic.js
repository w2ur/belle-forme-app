// Anthropic Messages API: request builder and stream parser for the coach's
// Claude rungs (rung 1 and 2 since 2026-10-12, owner ruling).
//
// RAW HTTP, NOT @anthropic-ai/sdk — deliberately. Every rung's timeouts
// (fetchHeaders' abort, cleared at headers), its bounded and redacted error
// body and the edge function's single stream reader all operate on a raw fetch
// Response, for every vendor on the ladder. The SDK would put a second stream
// reader with its own retry and timeout behaviour in front of that one, and a
// new npm dependency in the Deno edge bundle. The wire shapes are pinned by the
// recorded fixtures in netlify/__tests__/fixtures/ (scripts/anthropic-probe.mjs).
//
// The parser exposes createSSEParser's interface (sse.js) and speaks its
// dialect — OpenAI finish reasons and an OpenAI-shaped usage block — so nothing
// downstream (notebook splitter, emit buffer, normalizeUsage, incompleteReason,
// coach_usage) knows which vendor answered.
import { env } from "./env.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
// Server-side refusal fallback: a policy decline is re-run on another model
// inside the same call instead of ending the request.
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
// Anthropic rejects a list whose first message is not from the user, and the
// history window can open on an assistant turn. A fixed string keeps the cached
// prefix byte-stable.
export const WINDOW_START_NOTE = "[— début de l'historique conservé —]";
// Anthropic rejects an empty text block. A turn is never dropped (count, order
// and roles are preserved — see buildMessages), so it gets a placeholder.
export const EMPTY_TURN_NOTE = "[message vide]";
// One hour, not the five-minute default: her turns land minutes apart within a
// session, often more than five.
const CACHE_1H = { type: "ephemeral", ttl: "1h" };

/** Splits the system message off and makes the list one Anthropic accepts, dropping nothing. */
export function toAnthropicMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const hasSystem = list[0]?.role === "system";
  const system = hasSystem ? list[0].content : null;
  const turns = (hasSystem ? list.slice(1) : list).map((m) => ({
    role: m.role,
    content: typeof m.content === "string" && m.content.trim() ? m.content : EMPTY_TURN_NOTE,
  }));
  if (turns.length && turns[0].role !== "user") turns.unshift({ role: "user", content: WINDOW_START_NOTE });
  return { system, turns };
}

/** Same return shape as buildRequest (providers.js): { url, headers, body }. */
export function buildAnthropicRequest(entry, messages, { maxTokens, responseFormat } = {}) {
  const { system, turns } = toAnthropicMessages(messages);
  // Breakpoint on the last HISTORY turn: everything before her volatile block
  // (notebook + export + message, always the last turn) is reused, and the
  // next request finds this write by looking back from its own breakpoint.
  const withBreakpoint = turns.map((t, i) =>
    i === turns.length - 2 ? { role: t.role, content: [{ type: "text", text: t.content, cache_control: CACHE_1H }] } : t
  );
  const outputConfig = { effort: entry.reasoningEffort ?? "low" };
  if (responseFormat) outputConfig.format = { type: "json_schema", schema: responseFormat.json_schema.schema };
  const body = {
    model: entry.model,
    max_tokens: maxTokens,
    stream: true,
    messages: withBreakpoint,
    output_config: outputConfig,
    fallbacks: "default",
  };
  if (system) body.system = [{ type: "text", text: system, cache_control: CACHE_1H }];
  return {
    url: ANTHROPIC_URL,
    headers: {
      "content-type": "application/json",
      "x-api-key": env("ANTHROPIC_API_KEY") ?? "",
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": FALLBACK_BETA,
    },
    body: JSON.stringify(body),
  };
}

const STOP_REASONS = { end_turn: "stop", stop_sequence: "stop", max_tokens: "length" };

/**
 * Stateful parser for the Messages API event stream, with createSSEParser's
 * interface. Only `text` blocks are forwarded; thinking is counted, never
 * returned — it is the model reasoning about her health data. A refusal and a
 * mid-stream `error` event become finish reasons that are not "stop", so the
 * reply is marked incomplete rather than banked as finished.
 */
export function createAnthropicSSEParser() {
  let buffer = "";
  let finishReason = null;
  let start = null;
  let outputTokens = null;
  let thinkingChars = 0;
  let servedModel = null;
  const blockTypes = new Map();

  function handleLine(raw) {
    const line = raw.trim();
    if (!line.startsWith("data:")) return "";
    let ev;
    try {
      ev = JSON.parse(line.slice(5).trim());
    } catch {
      return "";
    }
    switch (ev?.type) {
      case "message_start":
        // NOT its output_tokens: a placeholder at that point (5 in the recorded
        // fixture). A rung cancelled before message_delta has an UNKNOWN
        // completion count, which is null, never a small made-up number.
        start = ev.message?.usage ?? null;
        return "";
      case "content_block_start":
        blockTypes.set(ev.index, ev.content_block?.type);
        // fallbacks:"default" can hand the turn to another model inside the
        // call; the block names it, and coach_usage must too.
        if (ev.content_block?.type === "fallback" && typeof ev.content_block.to?.model === "string") servedModel = ev.content_block.to.model;
        return "";
      case "content_block_delta": {
        const d = ev.delta;
        if (d?.type === "thinking_delta" && typeof d.thinking === "string") thinkingChars += d.thinking.length;
        if (d?.type === "text_delta" && blockTypes.get(ev.index) === "text" && typeof d.text === "string") return d.text;
        return "";
      }
      case "message_delta":
        if (typeof ev.delta?.stop_reason === "string") finishReason = STOP_REASONS[ev.delta.stop_reason] ?? ev.delta.stop_reason;
        if (typeof ev.usage?.output_tokens === "number") outputTokens = ev.usage.output_tokens;
        // The final counts: message_delta repeats the input side, with any
        // server-side fallback's iterations folded in.
        for (const k of ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
          if (typeof ev.usage?.[k] === "number") start = { ...start, [k]: ev.usage[k] };
        }
        return "";
      case "error":
        finishReason = `error: ${ev.error?.type ?? "unknown"}`;
        return "";
      default:
        return "";
    }
  }

  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      let out = "";
      for (const l of lines) out += handleLine(l);
      return out;
    },
    /** The last line may have no trailing newline. */
    end() {
      const rest = buffer;
      buffer = "";
      return handleLine(rest);
    },
    finishReason: () => finishReason,
    /** The model a server-side fallback switched to, or null if the requested model answered. */
    servedModel: () => servedModel,
    thinkingChars: () => thinkingChars,
    /** OpenAI-shaped, for normalizeUsage. cached_tokens is absent, not 0, when the vendor sent no cache read. */
    usage() {
      if (!start) return null;
      const n = (v) => (typeof v === "number" ? v : 0);
      const usage = {
        prompt_tokens: n(start.input_tokens) + n(start.cache_read_input_tokens) + n(start.cache_creation_input_tokens),
        completion_tokens: outputTokens,
      };
      if (typeof start.cache_read_input_tokens === "number") usage.prompt_tokens_details = { cached_tokens: start.cache_read_input_tokens };
      return usage;
    },
  };
}
