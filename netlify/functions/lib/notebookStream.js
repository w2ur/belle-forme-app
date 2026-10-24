const START = "<<<NOTEBOOK>>>";
const END = "<<<END>>>";

/**
 * The heading the model actually wrote instead of the sentinel, for weeks.
 *
 * Anchored to the start of a LINE and tested one line at a time, which is what
 * makes it narrow: the word "carnet" in the middle of a sentence — which the
 * coach says often, since the notebook is something it talks about — can never
 * reach it. `\**` covers the bold form observed in production,
 * `### **Carnet mis à jour (privé)**`, and the trailing text is deliberately
 * unconstrained because every reply worded it differently.
 */
const CARNET_HEADING = /^#{1,6}\s*\**\s*Carnet\b/i;

/**
 * Splits a streamed coach reply into (a) visible text forwarded to the client
 * and (b) a private notebook block. The block must never reach the client.
 *
 * TWO CAPTURE ROUTES, and the second one is a rescue rather than a design.
 *
 * The sentinel (`<<<NOTEBOOK>>>` … `<<<END>>>`) is what the prompt asks for. The
 * FALLBACK is a trailing markdown section whose heading matches
 * CARNET_HEADING, and it exists because the model ignored the sentinel in
 * production for weeks: every recent reply ended on a visible
 * `### **Carnet mis à jour (privé)**` section, so this splitter never entered
 * its notebook phase, `saveNotebook` was never called — the coach had no
 * long-term memory at all — and the user read the notes written about her.
 *
 * Properties this module exists to guarantee, all learned the hard way:
 *
 * 1. **The block is an interruption, not a terminator.** The prompt asks for it
 *    "à la TOUTE FIN", but a model that closes the block and keeps talking is
 *    not a bug on its side. The splitter used to latch into the notebook phase
 *    forever on the first sentinel, so everything after `<<<END>>>` — sometimes
 *    the whole answer, when the model emitted the block early — was silently
 *    dropped. On screen that is indistinguishable from a truncated reply.
 *
 * 2. **An unterminated block is not a notebook.** `notebook()` returns a body
 *    only for a block that actually closed. The saved notebook is overwritten
 *    wholesale by its caller, so reporting a half-streamed block would destroy
 *    real accumulated memory using the fragment of a reply that got cut off —
 *    and truncation is exactly when that happens.
 *
 * 3. **The fallback has no terminator, so it cannot prove the same thing.** A
 *    heading-sourced capture from a reply that was cut looks exactly like one
 *    from a reply that finished. `notebookSource()` reports which route the
 *    capture came from so the CALLER — which knows the finish reason — can
 *    refuse a heading capture on a truncated reply and keep invariant 2 intact.
 *
 * 4. **Suppression must not be guessed mid-stream.** A `Carnet` heading is only
 *    a notebook if nothing but its own section follows, and that is unknowable
 *    until either the next heading arrives or the stream ends. So the section
 *    is HELD from the heading onwards and released the moment a new heading
 *    proves it was ordinary text. The cost is that a reply containing a Carnet
 *    heading mid-answer arrives in one burst at the end instead of streaming;
 *    the alternative is suppressing text she was meant to read, which is worse
 *    and irreversible once it is off the wire.
 */
export function createNotebookSplitter() {
  let phase = "visible"; // "visible" | "notebook"
  let hold = "";         // visible tail buffer (for split-sentinel detection)
  let pending = "";      // block text accumulated since START
  let banked = null;     // body of the last block that CLOSED
  let source = null;     // "sentinel" | "heading" | null

  // The fallback stage, applied to text the sentinel pass already cleared.
  let stage = "text";    // "text" | "heading" | "carnet"
  let atLineStart = true;
  let lineBuf = "";      // a heading line, buffered until it can be judged
  let carnetBuf = "";    // the speculatively-held trailing section

  function feed(text) {
    if (phase === "notebook") {
      pending += text;
      const endIdx = pending.indexOf(END);
      if (endIdx === -1) return ""; // still inside the block
      banked = pending.slice(0, endIdx).trim();
      source = "sentinel";
      const after = pending.slice(endIdx + END.length);
      pending = "";
      phase = "visible";
      return after ? feed(after) : "";
    }

    hold += text;
    const idx = hold.indexOf(START);
    if (idx !== -1) {
      const out = hold.slice(0, idx);
      const rest = hold.slice(idx + START.length);
      hold = "";
      phase = "notebook";
      // Whatever trailed the sentinel in this same chunk belongs to the block,
      // and may already carry its END — so it goes back through feed().
      return out + feed(rest);
    }

    // Hold back the last (START.length - 1) chars: they might be the start of
    // a sentinel that completes in the next chunk.
    const keep = START.length - 1;
    if (hold.length > keep) {
      const out = hold.slice(0, hold.length - keep);
      hold = hold.slice(hold.length - keep);
      return out;
    }
    return "";
  }

  /**
   * The fallback stage. Runs on text the sentinel pass has already cleared, so
   * a notebook block and a Carnet heading can coexist without either confusing
   * the other.
   *
   * Streaming granularity is preserved everywhere it can be: only a line that
   * actually STARTS with `#` is buffered, and only until its newline arrives.
   * Everything else goes straight out, character by character as it lands.
   */
  function route(text) {
    let out = "";
    let i = 0;
    while (i < text.length) {
      if (stage === "heading") {
        const nl = text.indexOf("\n", i);
        const stop = nl === -1 ? text.length : nl + 1;
        lineBuf += text.slice(i, stop);
        i = stop;
        if (nl === -1) break; // the line has not finished; judge it later
        if (CARNET_HEADING.test(lineBuf)) {
          stage = "carnet";
          carnetBuf = lineBuf;
        } else {
          out += lineBuf;
          stage = "text";
        }
        lineBuf = "";
        atLineStart = true;
        continue;
      }

      if (atLineStart && text[i] === "#") {
        if (stage === "carnet") {
          // A new section opens, so the Carnet heading was not trailing after
          // all: every held character is ordinary text and goes back on the
          // wire, late but whole.
          out += carnetBuf;
          carnetBuf = "";
        }
        stage = "heading";
        lineBuf = "";
        continue;
      }

      const nl = text.indexOf("\n", i);
      const stop = nl === -1 ? text.length : nl + 1;
      const slice = text.slice(i, stop);
      if (stage === "carnet") carnetBuf += slice;
      else out += slice;
      atLineStart = nl !== -1;
      i = stop;
    }
    return out;
  }

  /**
   * Decides what happens to a section still being held when the stream ends.
   *
   * `mayBank` is false when the stream died inside a sentinel block: nothing
   * about that reply can be trusted to be complete, so a Carnet section is
   * hidden (it is notebook-shaped, and showing it is the leak this exists to
   * close) but never written down.
   */
  function flushStage(mayBank) {
    if (stage === "heading") {
      const line = lineBuf;
      lineBuf = "";
      stage = "text";
      // Only a Carnet heading is withheld. Every other unfinished heading line
      // is ordinary text — an unterminated block must not eat the paragraph
      // the fallback happened to be holding.
      return CARNET_HEADING.test(line) ? "" : line;
    }
    if (stage !== "carnet") return "";

    const held = carnetBuf;
    carnetBuf = "";
    stage = "text";

    // A held Carnet section is NEVER returned as visible text, whatever else is
    // true — including when a sentinel block already closed in the same reply.
    // That case used to release it, on the reasoning that a model which used the
    // sentinel knows the protocol so its heading must be a real section for her.
    // The reasoning was wrong in the one direction that matters. The transcript
    // now holds weeks of heading-form replies, and this repo's own `collapsePlan`
    // lesson is that history teaches format more strongly than the prompt does —
    // so a model emitting BOTH is plausible, and that branch would have printed
    // the private notes on her screen. The asymmetry is one-sided: hiding a
    // section costs her something she is by definition not meant to read;
    // showing it reproduces the incident this module exists to close.
    //
    // The sentinel still WINS THE CAPTURE — `banked` is not overwritten — because
    // a block that closed proved itself and a heading cannot.
    if (banked === null && mayBank) {
      const body = held.slice(held.indexOf("\n") + 1).trim();
      if (body) {
        banked = body;
        source = "heading";
      }
    }
    return "";
  }

  return {
    push: (text) => route(feed(text)),

    /** Flushes the held-back visible tail once the upstream stream is done. */
    end() {
      // Cut off mid-block: that text was never visible, and is not a notebook.
      const tail = phase === "visible" ? hold : "";
      hold = "";
      return (tail ? route(tail) : "") + flushStage(phase === "visible");
    },

    /**
     * True when text the reply HAS written is still held back, waiting for
     * more input to be judged: a short visible tail (the sentinel look-ahead)
     * or a `#` line awaiting its newline. A caller racing a first-text
     * deadline must not abandon a rung while this is true — the rung has
     * spoken, the splitter just has not released it yet. A held Carnet
     * section is hidden by design and does not count.
     */
    heldVisible() {
      // In a held Carnet section even the look-ahead tail is bound for the
      // hidden buffer, so nothing she would read is waiting.
      if (phase !== "visible" || stage === "carnet") return false;
      return /\S/.test(hold) || (stage === "heading" && /\S/.test(lineBuf));
    },

    /** The last COMPLETE block body, or null — never a partial one. */
    notebook() {
      return banked;
    },

    /**
     * Where `notebook()` came from: `"sentinel"` for a block that closed,
     * `"heading"` for the markdown fallback, `null` for nothing captured.
     * The caller needs the difference — see property 3 above.
     */
    notebookSource() {
      return source;
    },
  };
}
