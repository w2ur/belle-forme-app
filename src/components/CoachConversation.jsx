import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isPlanPayload } from "../lib/planFromJson.js";
import PlanCard from "./PlanCard.jsx";
import { coachWaitMessage, PLAN_WAIT_TEXT } from "../lib/coachWait.js";

/** How tall the composer may grow before it starts scrolling instead. */
const MAX_COMPOSER_ROWS = 5;

/**
 * The coach conversation: message list + composer. Presentational — all state
 * comes from `useCoachChat`. Mounted twice: the Coach destination (full) and,
 * in Plan 2, the séance panel (`compact`).
 *
 * `compact` drops the 65ch measure cap so the conversation fills its
 * container instead. That is the whole difference for now: nothing consumes
 * `compact` yet, and the séance panel that will (Plan 2) doesn't exist —
 * inventing spacing values ahead of a layout nobody has seen would be a
 * guess, not a design. A docked ~380px panel has no use for a 65ch cap, which
 * is why that part is real today.
 *
 * The composer is a separate element from `onSend` on purpose: voice input is
 * a deferred phase, and keeping them decoupled makes it an addition rather
 * than a rewrite.
 */
export default function CoachConversation({
  messages,
  streaming,
  streamingMode = null,
  busy,
  draft,
  setDraft,
  onSend,
  // Null by default, and read as a capability rather than a callback: a surface
  // that omits it gets the plan card WITHOUT the import button. Never give this
  // a no-op default — that is exactly the shape that put a dead button on the
  // séance panel.
  onImport = null,
  // Read ONLY to render the right unit on a plan card; the import decision
  // still runs in `CoachTab` against the same document.
  catalog = null,
  // Whether that capability is currently USABLE. Separate from `onImport`
  // because the two answer different questions: a surface with no handler must
  // show no button at all (the séance panel), while a surface that simply has
  // no catalog yet must show the button DISABLED — the plan is real and will be
  // importable in a moment, and a control that vanishes and reappears is worse
  // than one that is visibly waiting.
  canImport = true,
  error,
  onDismissError,
  onReload,
  compact = false,
}) {
  const scrollRef = useRef(null);
  const composerRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages, streaming]);

  // The composer grows with its content up to MAX_COMPOSER_ROWS, then scrolls.
  // Measured from the element's own computed style rather than a hardcoded
  // pixel cap, so it follows the font and padding the classes actually apply.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    const style = getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    const frame =
      parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) +
      parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const maxHeight = lineHeight * MAX_COMPOSER_ROWS + frame;
    // scrollHeight includes padding but not borders (border-box), hence the sum.
    const contentHeight =
      el.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    el.style.height = `${Math.min(contentHeight, maxHeight)}px`;
    el.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
  }, [draft]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        className={`min-h-0 flex-1 space-y-3 overflow-y-auto pb-3 ${
          compact ? "" : "mx-auto w-full max-w-[65ch]"
        }`}
      >
        {/* A fade, not a hard edge, where bubbles scroll out under the row above
            (the mode toggle, the demo's question chips). Zero net height: the
            negative margin cancels it, so the first bubble does not move. */}
        {!compact && (
          <div aria-hidden="true" className="pointer-events-none sticky top-0 z-10 -mb-4 h-4 bg-gradient-to-b from-primary to-transparent" />
        )}
        {messages.map((m, i) => (
          <Bubble key={i} role={m.role} content={m.content} onImport={onImport} canImport={canImport} catalog={catalog} />
        ))}
        {streaming !== null && <Bubble role="assistant" content={streaming} catalog={catalog} streaming streamingMode={streamingMode} />}
      </div>

      {/* Beside the conversation, never in place of it: a failed refresh used
          to replace every message with a single error bubble. */}
      {error && (
        <div
          className={`mb-2 flex items-center gap-2 rounded-lg bg-surface px-3 py-2 text-xs text-muted-darker ${
            compact ? "" : "mx-auto w-full max-w-[65ch]"
          }`}
          role="status"
        >
          <span className="flex-1">{error}</span>
          {onReload && (
            <button onClick={onReload} className="shrink-0 font-semibold text-accent underline">
              Réessayer
            </button>
          )}
          <button
            onClick={onDismissError}
            aria-label="Masquer ce message"
            className="shrink-0 px-1 font-semibold text-muted-darker"
          >
            ✕
          </button>
        </div>
      )}

      <div
        className={`flex items-end gap-2 border-t border-border pt-2 ${
          compact ? "" : "mx-auto w-full max-w-[65ch]"
        }`}
      >
        <textarea
          ref={composerRef}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          // Enter sends, Shift+Enter inserts a line break. `isComposing` guards
          // the Enter that validates an input-method candidate, which must not
          // send the message.
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder="Parle à ton coach…"
          className="flex-1 resize-none rounded-xl border border-border-light bg-card px-3 py-2 text-base"
          disabled={busy}
        />
        <button
          // Wrapped, not passed directly: `send` takes a mode, and handing it the
          // click event would serialise a DOM event into the request body.
          onClick={() => onSend()}
          disabled={busy || !draft.trim()}
          className="min-h-[44px] rounded-xl border-none bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Envoyer
        </button>
      </div>
    </div>
  );
}

/**
 * The line shown before the coach's first character arrives.
 *
 * It ticks because the wait is 17-28 s and a single frozen line over that long
 * reads as a hung app. All the copy and every threshold live in
 * `coachWaitMessage` — pure and tested — so what stays here is the timer.
 *
 * Mounted only while the placeholder is on screen, so the interval dies with the
 * first character rather than needing to be cancelled by anything else.
 */
function WaitingLine({ mode }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    // Twice a second: fast enough that a stage change never looks late, slow
    // enough to be free. Measured off a wall clock rather than accumulated, so
    // a backgrounded iPad tab that throttles timers still shows the right stage
    // when she comes back.
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 500);
    return () => clearInterval(id);
  }, []);

  return (
    <span className="animate-pulse italic text-muted">{coachWaitMessage(elapsed, mode)}</span>
  );
}

/**
 * A `=== FITTRACK PLAN ===` block still sitting in her scrollback.
 *
 * The model has not been able to author this format since 2026-08-10 — it emits
 * a schema-backed payload instead — but months of transcript still carry it, and
 * `coach_messages` is never rewritten. Matched only so those replies still look
 * like the replies they were; never so one can be imported. The old text parser
 * is deleted, so there is nothing left that could read it back into a plan.
 */
const LEGACY_PLAN_RE = /===\s*FITTRACK PLAN\s*===[\s\S]*/;

/** The collapsed chip a legacy block sits behind. Says it is old, not broken. */
const LEGACY_PLAN_SUMMARY = "Ancien programme · afficher";

/** Shown for a plan-emit reply that arrived as a fragment. See the `cutPlan` branch. */
const CUT_PLAN_NOTE = "Programme interrompu — il n'est pas arrivé en entier. Redemande-le.";

/**
 * Shown beside a disabled import button. Names the cause and the fix, because
 * a greyed-out button with no explanation reads as the app being broken — and
 * the cause here is always transient (the catalog has not been pulled yet).
 */
const CATALOG_UNAVAILABLE_NOTE = "Catalogue en cours de chargement — réessaie dans un instant.";

function Bubble({ role, content, onImport, canImport = true, catalog = null, streaming, streamingMode = null }) {
  const isUser = role === "user";
  const text = typeof content === "string" ? content : "";

  // On the plan-emit path the visible reply IS the JSON payload — `coachNotes`,
  // every session, AND the private `notebook` field. So the FIRST question asked
  // of an assistant turn is "is this JSON-shaped", before anything can reach
  // ReactMarkdown: rendering the raw payload would put the coach's private notes
  // on the user's screen, which is precisely the leak this format was meant to close.
  // Deliberately true while streaming too — a half-written payload is still a
  // payload, and the notebook is the last field the model writes.
  const jsonShaped = !isUser && text.trimStart().startsWith("{");
  const payload = !isUser && !streaming && isPlanPayload(text) ? text : null;
  // A reply that began as a plan and stopped mid-object. `isPlanPayload` is
  // false because it does not parse — correct, and exactly why it must not fall
  // through to the prose branch. There is no partial plan to import, ever, so
  // this branch carries no import button.
  //
  // It also catches the narrower case of JSON that parses but carries no
  // `sessions` array, and that is on purpose rather than an accident of the
  // condition: such an object can still carry a `notebook` field, so sending it
  // to ReactMarkdown would print the coach's private notes. `historyView`'s
  // `looksLikeTruncatedPlanFragment` deliberately excludes that case because it
  // is choosing what the MODEL reads; here the reader is the user, and the safe
  // default runs the other way.
  const cutPlan = !isUser && !streaming && !payload && jsonShaped;
  const legacy = !isUser && !streaming && !jsonShaped
    ? (text.match(LEGACY_PLAN_RE) || [])[0]?.trim() || null
    : null;
  const prose = legacy ? text.slice(0, text.indexOf(legacy)).trimEnd() : text;
  // While streaming, append a cursor to the text so it trails the last line
  // inline (a sibling span would drop below react-markdown's block <p>).
  const proseWithCursor = streaming && prose ? `${prose} ▌` : prose;

  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
          isUser
            ? "bg-accent whitespace-pre-wrap text-white"
            : "border border-border bg-card text-gray-800"
        }`}
      >
        {isUser ? (
          content
        ) : (
          <>
            {streaming && !text && <WaitingLine mode={streamingMode} />}

            {streaming && jsonShaped && (
              <span className="animate-pulse italic text-muted">{PLAN_WAIT_TEXT}</span>
            )}

            {/* The CARD renders wherever a payload appears; the BUTTON needs a
                handler to exist. A surface that cannot import (the séance
                panel) passes no `onImport`, so the programme stays readable
                mid-workout without offering a control that does nothing —
                which is what a no-op handler used to produce, since a function
                is truthy however empty it is. */}
            {payload && (
              <>
                <PlanCard payload={payload} catalog={catalog} />
                {onImport && (
                  <>
                    <button
                      onClick={() => onImport(payload)}
                      disabled={!canImport}
                      className="mt-2 block min-h-[44px] w-full rounded-lg border border-accent bg-transparent py-2 text-xs font-semibold text-accent disabled:opacity-50"
                    >
                      Importer ce programme
                    </button>
                    {!canImport && (
                      <p className="mt-1 text-[11px] italic text-muted">{CATALOG_UNAVAILABLE_NOTE}</p>
                    )}
                  </>
                )}
              </>
            )}

            {/* Same treatment as a cut prose reply (`TRUNCATION_NOTE`): italic,
                muted, and stating plainly that nothing usable arrived. The
                fragment itself is never shown — it is raw schema syntax. */}
            {cutPlan && <p className="italic text-muted">{CUT_PLAN_NOTE}</p>}

            {!jsonShaped && prose && (
              <div className="coach-md">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{proseWithCursor}</ReactMarkdown>
              </div>
            )}

            {/* Read-only, and no import button: her history should still look
                like a history, but nothing can read this format any more.

                Collapsed by default. Months of superseded plans rendered as
                full monospace walls is most of what makes her scrollback
                unreadable, and every one of them is dead — unimportable, and
                superseded by the plan `generateExport` ships on every request.
                A <details> rather than deleting the rows: she keeps what she
                read, one tap away, and nothing is destroyed to tidy a view.

                `list-none` plus the webkit rule because Safari draws its own
                disclosure triangle from a pseudo-element the standard property
                does not reach — and Safari is the only browser here. */}
            {legacy && (
              <details className="mt-2">
                <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-semibold text-muted [&::-webkit-details-marker]:hidden">
                  {LEGACY_PLAN_SUMMARY}
                </summary>
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg border border-border bg-surface p-2 font-mono text-[11px]">
                  {legacy}
                </pre>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
