/** Why an assistant reply stopped, when it did not stop cleanly. */
export const INCOMPLETE_STREAM_CUT = "stream cut";
export const INCOMPLETE_MAX_TOKENS = "max_tokens";
export const INCOMPLETE_NO_FINISH_REASON = "no finish_reason";

/**
 * Returns the reason a reply is incomplete, or null if it genuinely finished.
 *
 * ONLY "stop" MEANS FINISHED. Everything else — including the upstream saying
 * nothing at all — is treated as a reply that stopped early, and that default is
 * the whole point of this function.
 *
 * Measured on prod 2026-08-03, five requests in nine minutes: gemini-3.5-flash
 * returned response headers after 59 s and 99 s, emitted 43 and 48 completion
 * tokens, and closed the stream with `finish_reason: null`. Both fragments stop
 * mid-word ("j'ai manqué de", "**La"). The old test was
 * `interrupted || finishReason === "length"`, so neither matched: the reader
 * loop ended normally, the usage chunk arrived, and a 155-character fragment was
 * persisted as a complete answer with no note on it.
 *
 * That is not a cosmetic miss. The fragment at turn 40 read "the user, tu as tout à
 * fait raison de me poser ces questions et de me recadrer. Je me suis emmêlé les
 * pinceaux dans mes explications précédentes, j'ai manqué de" — the opening of
 * an apology. The user resent the same question two minutes later; the model read its
 * own severed apology as a position it had taken, escalated, and rewrote her
 * entire programme. She had asked whether an exercise was useful. Marking the
 * fragment is what stops a dropped stream from teaching the coach that it was
 * wrong about something nobody challenged.
 *
 * The asymmetry decides the default. A complete reply wrongly marked costs the user
 * one confusing line; a truncated reply passing as complete corrupts every turn
 * that follows it. So an unknown or absent finish reason is incomplete.
 */
export function incompleteReason({ interrupted = false, finishReason = null } = {}) {
  if (interrupted) return INCOMPLETE_STREAM_CUT;
  if (finishReason === "stop") return null;
  if (finishReason === "length") return INCOMPLETE_MAX_TOKENS;
  // A reason we have no name for is still not "stop" — report it verbatim so the
  // function log names it rather than flattening it into the absent case.
  if (typeof finishReason === "string" && finishReason.trim()) return finishReason;
  return INCOMPLETE_NO_FINISH_REASON;
}

/**
 * Flattens a provider usage block into the three numbers worth keeping.
 *
 * ABSENT AND ZERO ARE DIFFERENT, and conflating them is the trap this function
 * exists to avoid. `cachedTokens: 0` means the provider told us nothing was
 * served from cache — evidence the prompt layout is not paying off.
 * `cachedTokens: null` means the provider never reported the field at all, which
 * says nothing either way. Defaulting the missing case to 0 would manufacture
 * exactly the finding we are instrumenting to test, and it would look like data.
 *
 * The cached-token field is the least standardised part of the payload, so all
 * three known spellings are accepted.
 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return { promptTokens: null, cachedTokens: null, completionTokens: null };
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const details = raw.prompt_tokens_details ?? raw.promptTokensDetails ?? null;
  return {
    promptTokens: num(raw.prompt_tokens ?? raw.promptTokens),
    cachedTokens: num(details?.cached_tokens ?? details?.cachedTokens ?? raw.cached_content_token_count),
    completionTokens: num(raw.completion_tokens ?? raw.completionTokens),
  };
}

/**
 * The visible text of one `content` value — a streamed `delta.content` or a
 * non-streamed `message.content` — and how much reasoning it carried.
 *
 * TWO SHAPES, AND A STREAM MIXES THEM. A plain model sends a string. A model
 * that reasons sends an ARRAY of typed blocks:
 *
 *   [{type: "thinking", thinking: [{type: "text", text: "…"}], closed: true},
 *    {type: "text", text: "…"}]
 *
 * Probed live 2026-10-01 on `zai-glm-5-3` (which cannot turn reasoning off —
 * `reasoning_effort` accepts only low/high/max, and "none" is a 400): the
 * first chunks carry `content: ""`, then one-fragment thinking arrays, then a
 * chunk holding BOTH the last thinking fragment and the first text block, then
 * plain STRINGS for the rest of the answer. So the shape is decided per chunk,
 * never once per stream.
 *
 * ONLY `type: "text"` IS VISIBLE. Thinking is the model reasoning about the user's
 * health data; it is withheld whole — from her screen, from the transcript,
 * from `coach_messages` — and only its length is kept. Any other block type,
 * and any bare string inside an array, is dropped too: forwarding an unknown
 * shape is how a private channel leaks the day a vendor adds one.
 *
 * Before 2026-10-01 the parser kept strings only, so a block-shaped reply was a
 * silently EMPTY one rather than an error. That is the trap this closes.
 */
export function contentText(content) {
  if (typeof content === "string") return { text: content, thinkingChars: 0 };
  if (!Array.isArray(content)) return { text: "", thinkingChars: 0 };
  let text = "";
  let thinkingChars = 0;
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") text += block.text;
    else if (block?.type === "thinking") thinkingChars += thinkingLength(block.thinking);
  }
  return { text, thinkingChars };
}

function thinkingLength(t) {
  if (typeof t === "string") return t.length;
  if (!Array.isArray(t)) return 0;
  return t.reduce((n, x) => n + (typeof x === "string" ? x.length : typeof x?.text === "string" ? x.text.length : 0), 0);
}

/**
 * Stateful parser for OpenAI-compatible Server-Sent Events. Feed it raw
 * decoded text chunks; `push` returns the newly-available assistant text.
 * Partial trailing lines are buffered until completed by a later chunk.
 *
 * It also records `finish_reason`, which the parser used to discard. That
 * discard is why a reply cut off by the token budget was indistinguishable
 * from a finished one: the text simply stopped, the stream closed cleanly, and
 * The user read a truncated answer as though the coach had said everything it meant
 * to. The value is only ever available here — nothing downstream can recover it.
 */
export function createSSEParser() {
  let buffer = "";
  let finishReason = null;
  let usage = null;
  let thinkingChars = 0;

  /** Processes one raw SSE line; returns the visible text it carried. */
  function handleLine(raw) {
    let out = "";
    const line = raw.trim();
    if (!line.startsWith("data:")) return "";
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") return "";
    try {
      const json = JSON.parse(payload);
      const choice = json?.choices?.[0];
      const delta = choice?.delta?.content;
      // A string OR an array of typed blocks — see contentText. Thinking
      // is counted, never forwarded: it reaches neither the user, the notebook
      // splitter, the plan-emit buffer nor coach_messages, because nothing
      // downstream of this line ever sees it.
      const part = contentText(delta);
      out = part.text;
      thinkingChars += part.thinkingChars;
      // Sent on the final chunk of a choice; "stop" is a normal ending,
      // "length" means the model hit max_tokens mid-sentence.
      if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
      // WHERE the usage block arrives is vendor-specific, which is exactly
      // why it is read out here and not inside the choice branch above.
      // Gemini sent it on a trailing chunk of its OWN, after finish_reason,
      // with `choices` as an empty array. Mistral (verified by live call,
      // 2026-08-03) puts it on the SAME chunk as the final choice, next to
      // finish_reason. Reading it off the choice would lose the first shape;
      // skipping chunks that carry a choice would lose the second. Both
      // require stream_options.include_usage on the request.
      if (json?.usage && typeof json.usage === "object") usage = json.usage;
    } catch {
      // Incomplete/unparseable JSON on a "data:" line — skip it.
    }
    return out;
  }

  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep the (possibly partial) last line
      let out = "";
      for (const raw of lines) out += handleLine(raw);
      return out;
    },

    /**
     * Call once when the stream reports done. The last line may have no
     * trailing newline, and that last line is where Mistral puts finish_reason
     * and usage; left in the buffer it is dropped and every reply reads as "no
     * finish_reason". It goes through the same line handler as push, so a
     * final typed-block chunk is split by contentText like any other: its text
     * is returned, its thinking only counted.
     */
    end() {
      const rest = buffer;
      buffer = "";
      return handleLine(rest);
    },

    /** null until the upstream reports one. "length" means the reply was cut off. */
    finishReason() {
      return finishReason;
    },

    /**
     * The raw usage block, or null if the upstream never sent one. Shapes differ
     * across OpenAI-compatible providers and the cached-token field is the least
     * standard part of it, so this returns the payload untouched and lets the
     * caller normalise — guessing a shape here would silently record zeros.
     */
    usage() {
      return usage;
    },

    /**
     * Characters of reasoning the model produced and this parser withheld. A
     * LENGTH, never the text: it is what tells "the model thought for the whole
     * budget and said nothing" from "the model said nothing" in the function
     * log, and the content itself must never leave the parser.
     */
    thinkingChars() {
      return thinkingChars;
    },
  };
}
