/**
 * The wire contract between the coach function and the client, in one place
 * because both ends have to agree on it byte for byte.
 *
 * The problem it solves: a streamed reply can stop for three different reasons,
 * and two of them used to look identical on screen.
 *
 *  1. The model finished.
 *  2. The model was cut off (max_tokens) or the upstream connection died. The
 *     function is still alive, notices, and appends TRUNCATION_NOTE itself.
 *  3. The PLATFORM killed the invocation mid-stream. Netlify caps a streamed
 *     response at 10 s of execution — "if the limit is reached, the response
 *     stops streaming" — and nothing in the function runs after that. No note,
 *     no persistence, no log line. From the client, this is indistinguishable
 *     from case 1: the text simply stops, and the user reads half an answer as the
 *     coach's final word.
 *
 * Hence the marker. The function emits it once it has finished its own work, so
 * its ABSENCE is the only reliable evidence of case 3 — the client cannot infer
 * it from anything else. A control character is used rather than a word so that
 * it can never collide with something the model wrote, and so that a leak into
 * the UI is invisible rather than embarrassing.
 */
export const STREAM_END_MARKER = "\u0004"; // ASCII END OF TRANSMISSION

/**
 * Emitted when no model on the ladder accepted the request at all.
 *
 * It exists because the Response is now returned BEFORE the model is called.
 * The handler used to await `callChatStream` first, which held our own response
 * headers for the 17-28 s the model spends on prefill and hidden reasoning,
 * against an edge limit of 40 s for headers. One prod run on 2026-08-02 never
 * got model headers within 30 s at all, and would have blown that limit.
 *
 * The cost of returning early is that an HTTP status can no longer describe the
 * outcome: by the time the ladder is known to have failed, the headers are gone
 * and the status is already 200. The old 502 was what told the client to take
 * her question back off screen and return the text to the composer, so that
 * signal has to travel in-band instead.
 *
 * Deliberately distinct from STREAM_END_MARKER, because the two mean opposite
 * things to her: the end marker says "this exchange is banked, reload to see
 * it", this one says "nothing happened, your text is back, try again".
 */
export const STREAM_ERROR_MARKER = "\u0015"; // ASCII NEGATIVE ACKNOWLEDGE

/**
 * A byte that means nothing — sent by the server while the plan-emit payload
 * is being BUFFERED, so the connection is never idle for the whole generation.
 * Since 2026-10-06 rung 1 writes at 20-70 tokens/s, so a 2-4k-token payload is
 * 40-185 s during which the client would otherwise receive nothing; whether
 * Netlify's edge, its CDN or iOS Safari close an idle stream before that has
 * never been measured, and this removes the question instead of answering it.
 * Protocol, never text: the client strips every occurrence before anything is
 * rendered or judged (stripKeepalive, below), it never travels through the
 * server's send() — so it stamps no ttft and banks nothing — and it is never
 * persisted. Only the plan-emit path sends it; a chat reply streams its own
 * bytes. ASCII SYNCHRONOUS IDLE, which is exactly what it is for.
 */
export const STREAM_KEEPALIVE_MARKER = "\u0016"; // ASCII SYNCHRONOUS IDLE

/** Drops every keepalive byte; the only legitimate reader of the raw stream besides finalizeStream. */
export function stripKeepalive(text) {
  return typeof text === "string" ? text.replaceAll(STREAM_KEEPALIVE_MARKER, "") : "";
}

/**
 * Appended when a reply stopped before the model was done. Written from the
 * server when the server can tell, and from the client when only the absence of
 * the marker reveals it — the wording is identical either way, because to the user
 * it is the same event.
 */
export const TRUNCATION_NOTE =
  "\n\n_(Réponse coupée avant la fin — demande-moi la suite.)_";

/**
 * A trailing line announcing the private notebook, and the rule above it.
 *
 * Start-anchored on the announcement itself, which is the whole guard: « Je
 * garde ça dans mon carnet » is something the coach may legitimately say to
 * her, and only a line that OPENS on the label is scaffolding. The optional
 * `**`/`#` markers cover every form production has produced.
 */
const NOTEBOOK_ANNOUNCEMENT =
  /\n[ \t]*(?:(?:-{3,}|\*{3,}|_{3,})[ \t]*\n\s*)?(?:#{1,6}[ \t]*)?(?:\*\*|__)?\s*(?:carnet|mise\s+à\s+jour\s+du\s+carnet|màj\s+(?:du\s+)?carnet)\b[^\n]{0,80}$/i;

/**
 * Removes the notebook label the model writes just before the sentinel.
 *
 * The private notes themselves never leak — `createNotebookSplitter` captures
 * everything from `<<<NOTEBOOK>>>` onwards, and the notebook row is written
 * correctly. What leaks is the announcement in front of it, which is ordinary
 * visible text at the moment it streams and is already on the wire by the time
 * the sentinel arrives, so the splitter cannot hold it back. Measured on the
 * live transcript 2026-08-16: every reply from 2026-08-14 ends on a dangling
 * `---` + « **Carnet mis à jour** : » with nothing after it, and 13 replies
 * carry some form of it. The splitter's markdown fallback matches `#` headings
 * only, and 0 of 67 assistant replies have ever written one.
 *
 * The prompt now forbids the announcement outright; this is the half that does
 * not depend on the model complying. It is applied to what is PERSISTED and to
 * what the settled bubble shows, so both agree — the live stream still shows
 * the label for the second before the reply settles, which is the one thing no
 * pure function on this side can fix.
 *
 * Deliberately narrow, because this text is shown to the user: only a trailing line
 * that OPENS on the label goes, never one that merely mentions the carnet.
 */
export function stripNotebookAnnouncement(text) {
  if (typeof text !== "string" || !text) return "";
  // Trimmed at both ends, because this replaces a bare `.trim()` on the two
  // paths that persist the reply — a subtler strip that left leading whitespace
  // behind would change what is stored for reasons unrelated to the notebook.
  return text.trim().replace(NOTEBOOK_ANNOUNCEMENT, "").trim();
}

/**
 * Turns the raw bytes of a completed read loop into what should be displayed.
 *
 * Pure, and separated from the hook for that reason: "did this reply arrive
 * whole" is the kind of decision that has to keep being true, and a component
 * is not where it can be tested.
 */
export function finalizeStream(raw) {
  // Keepalive bytes first: they can sit anywhere before the payload, including
  // directly before the end or error marker, so every check below runs on the
  // stream without them.
  const text = stripKeepalive(raw);
  // Checked FIRST, and by inclusion rather than suffix: the failure marker is
  // the only thing the server sends on that path, but reading it as ordinary
  // text would render a control character and then decorate it with a
  // truncation note — a bubble describing a reply that never existed.
  if (text.includes(STREAM_ERROR_MARKER)) {
    return { text: "", interrupted: false, failed: true };
  }
  if (text.endsWith(STREAM_END_MARKER)) {
    // The function reached the end of its own work. Whatever it decided about
    // truncation is already inside the text; do not second-guess it here.
    // The notebook label and an echoed annotation line are the two exceptions,
    // and neither is a decision the server made — see cleanVisibleReply.
    return {
      text: cleanVisibleReply(text.slice(0, -STREAM_END_MARKER.length)),
      interrupted: false,
    };
  }
  const trimmed = cleanVisibleReply(text);
  if (!trimmed) return { text: "", interrupted: true };
  // Never stack a second note on top of one the server already wrote: a reply
  // can be truncated AND lose its marker (killed while persisting).
  if (trimmed.endsWith(TRUNCATION_NOTE.trim())) return { text: trimmed, interrupted: true };
  return { text: trimmed + TRUNCATION_NOTE, interrupted: true };
}

/**
 * One annotation line, exactly as `annotateHistory` writes it — a date stamp
 * (`[dim. 30 août, 17:15]`) or a session break (`[— nouvelle conversation, 3
 * jours plus tard —]`), alone on its line.
 *
 * Deliberately the same shape as `ANNOTATION_LINE` in `coachPrompt.js`, which
 * cannot be imported here: that module is the edge bundle and imports nothing
 * from `src/`, by design. The duplication is therefore forced, and it is
 * covered the way `PLAN_BUTTON_LABEL` is — a parity test asserting both
 * regexes agree on the same specimens. Two wordings of one rule are exactly
 * what drifts.
 */
export const ECHOED_ANNOTATION =
  /^[ \t]*\[(?:—[^\n]*—|[^\n[\]]*\d{1,2}:\d{2})\][ \t]*(?:\r?\n|$)/;

/**
 * The opening of what MIGHT become an annotation line, still streaming: an
 * unclosed `[` on the first line and nothing yet to judge it by. Bounded at 60
 * characters so an ordinary sentence that happens to open on a bracket is
 * released as soon as it is clearly not a stamp.
 */
const PARTIAL_ANNOTATION = /^[ \t]*\[[^\n[\]]{0,60}$/;

/**
 * Removes annotation lines the MODEL copied into its own reply.
 *
 * `annotateHistory` stamps the coach's own turns, which fixed
 * a real bug (the coach quoting its own undated « le rendez-vous de demain »
 * days later). It also put twelve verbatim examples of a reply that OPENS
 * on a bracketed date line into every request — and this repo has already lost
 * this fight once: `collapsePlan` exists because the coach re-learned a retired
 * plan format from its own transcript while the prompt said otherwise. It
 * learned this one the same way. Measured on the live transcript 2026-08-30:
 * **25 of the 46 assistant replies since the change open on an echoed stamp**,
 * and the time in it is wrong — the model copies the PRECEDING turn's stamp, so
 * reply #380 (17:27) is labelled 20:10 and #332 (18:49) is labelled 18:47.
 *
 * Unlike `stripReplyScaffolding`, this text IS shown to the user, so the guard is
 * narrow in the same way `stripNotebookAnnouncement` is: only a LEADING line
 * that matches the annotation shape whole goes. A reply mentioning a date, or a
 * bracket, or a time inside a sentence never reaches the match.
 *
 * `partial` is for the live stream, and it is why the flash can be fixed here
 * when the notebook label's could not: an echoed stamp is the FIRST thing on
 * the wire, so holding a bracket-opening first line until its newline arrives
 * removes it before it is ever painted. The hold is bounded by
 * PARTIAL_ANNOTATION and can never swallow more than one short line.
 */
export function stripEchoedAnnotation(text, { partial = false } = {}) {
  if (typeof text !== "string" || !text) return typeof text === "string" ? text : "";
  let out = text;
  // Several, because a session break and a stamp arrive as two lines and the
  // model copies whatever it saw.
  for (;;) {
    const next = out.replace(ECHOED_ANNOTATION, "");
    if (next === out) break;
    out = next;
  }
  if (partial && PARTIAL_ANNOTATION.test(out)) return "";
  return out;
}

/**
 * Everything that has to come off a reply before it is shown or stored: the
 * notebook label the model writes in front of the sentinel, and the annotation
 * lines it copies from its own history. Composed in one place so the persisted
 * transcript and the settled bubble cannot disagree about either.
 */
export function cleanVisibleReply(text) {
  return stripNotebookAnnouncement(stripEchoedAnnotation(text));
}
