import { useRef, useState } from "react";
import CoachConversation from "./CoachConversation.jsx";
import CoachModeToggle from "./CoachModeToggle.jsx";
import { evaluatePlanImport, noticeForVerdict } from "../lib/planValidation.js";
import { PLAN_BUTTON_LABEL } from "../lib/planButtonLabel.js";
import DemoCoachChips from "../demo/DemoCoachChips.jsx";

/**
 * `chat` is owned by App.jsx, not created here: this component unmounts every
 * time the user switches tabs, and creating the conversation inside it meant a reply
 * still streaming was abandoned the moment she looked at something else.
 *
 * `catalog` is a `buildCatalogViews` result, or null until the first pull lands
 * on a device that has never synced. Null disables the import (the validators
 * take a catalog and there is no fallback, by design).
 */
export default function CoachTab({ chat, onPlanImport, catalog }) {
  const [notice, setNotice] = useState(null); // {tone, title, items}

  // A notice with items stays until dismissed — a list of problems she has to
  // relay to the coach can't vanish after 2.5s. A bare confirmation still does.
  //
  // The auto-dismiss is tied to the notice it was scheduled for: an earlier
  // confirmation's timer must neither survive a newer call nor close the
  // rejection that replaced it.
  const noticeTimer = useRef(null);
  const noticeToken = useRef(0);
  const showNotice = (tone, title, items = [], canRequestCorrection = false, payload = null) => {
    clearTimeout(noticeTimer.current);
    const token = ++noticeToken.current;
    setNotice({ tone, title, items, canRequestCorrection, payload });
    if (!items.length) {
      noticeTimer.current = setTimeout(() => {
        if (noticeToken.current === token) setNotice(null);
      }, 2500);
    }
  };

  // Thin caller: read → validate → accept/reject lives in `evaluatePlanImport`,
  // and the verdict → notice mapping in `noticeForVerdict`. Both pure, both
  // tested. This only wires them to state.
  //
  // `payload` is the coach's schema-generated JSON, handed over verbatim by the
  // bubble that rendered it. It used to be the `=== FITTRACK PLAN ===` text
  // `detectPlanBlock` had carved out of a prose reply; there is no text format
  // and no parser left, so nothing between the model and here can misread it.
  //
  // Guarded rather than trusted: the button below is disabled without a
  // catalog, but a validator handed one it cannot read is the failure mode this
  // whole migration is careful about, so the caller checks too.
  function importPlan(payload) {
    if (!catalog) return;
    const verdict = evaluatePlanImport(payload, catalog);
    const result = noticeForVerdict(verdict);
    if (result.shouldImport) onPlanImport(verdict.plan);
    // The PAYLOAD is kept, not just the errors: `verdict.plan` is null on a
    // rejection, and the coach cannot see the plan it is being asked to fix
    // (history collapses it, the export carries the previous week). This is the
    // only place that still holds it.
    showNotice(result.tone, result.title, result.items, result.canRequestCorrection, payload);
  }

  /**
   * One tap, one request. The notice is dismissed first: the answer arrives in
   * the conversation, and leaving the rejection pinned over it would describe
   * a plan that is already being replaced.
   *
   * The errors come from the notice itself rather than a second copy in state —
   * `items` on an error notice IS the blocking-error list, so there is nothing
   * that can go out of step with what she is reading.
   */
  function requestCorrection() {
    const errors = notice?.items ?? [];
    const payload = notice?.payload ?? null;
    setNotice(null);
    chat.requestPlanCorrection(errors, payload);
  }

  if (!chat.hasClient) {
    return (
      <div className="rounded-xl border border-accent/20 bg-accent/10 p-4 text-sm text-gray-700">
        Connecte-toi pour discuter avec ton coach.
      </div>
    );
  }

  return (
    // Fills the viewport minus the shell chrome, instead of the old
    // calc(100vh-220px) — a phone assumption that left ~700px dead on an iPad.
    // The demo banner (2.5rem below lg, 3.5rem at lg) sits above the shell, so the demo subtracts it too.
    <div className={import.meta.env.VITE_DEMO
      ? "flex h-[calc(100dvh-15.5rem)] flex-col lg:h-[calc(100dvh-9.5rem)]"
      : "flex h-[calc(100dvh-13rem)] flex-col lg:h-[calc(100dvh-6rem)]"}>
      {/* The toggle replaces the old single-tap "Mon programme de la semaine"
          chip: that chip fired a ~20s schema request with no confirmation and
          nothing to undo, and it was tapped by accident in production
          (2026-08-10). Discussion and Mon programme both send ordinary
          messages — neither can produce a plan by itself, only the explicit
          « Plan » button can (rendered only in Mon programme). */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <CoachModeToggle mode={chat.mode} setMode={chat.setMode} />

        {/* The only path to a plan-emit request, beside the mode it belongs to
            and only in Mon programme mode. It used to sit on its own row below
            the composer, which cost the phone layout a full row of transcript.
            Sized to its label, never a full-width bar: as a bar it read as the
            primary action of the whole tab, which is the composer. The coach
            prompt names this position (`buildConversationFocusSection`), so
            moving the button means moving that sentence too. */}
        {chat.mode === "plan" && (
          <button
            onClick={chat.requestPlanUpdate}
            disabled={chat.busy}
            className="flex min-h-[44px] items-center gap-2 rounded-xl border border-accent/30 bg-accent/10 px-4 py-2 text-sm font-semibold text-accent disabled:opacity-50"
          >
            <CalendarIcon />
            {PLAN_BUTTON_LABEL}
          </button>
        )}
      </div>

      {import.meta.env.VITE_DEMO && <DemoCoachChips onAsk={chat.ask} busy={chat.busy} />}

      <CoachConversation
        messages={chat.messages}
        streaming={chat.streaming}
        streamingMode={chat.streamingMode}
        busy={chat.busy}
        draft={chat.draft}
        setDraft={chat.setDraft}
        onSend={chat.send}
        onImport={importPlan}
        canImport={!!catalog}
        catalog={catalog}
        error={chat.error}
        onDismissError={chat.dismissError}
        onReload={chat.reload}
      />

      {notice && (
        <Notice
          notice={notice}
          busy={chat.busy}
          onDismiss={() => setNotice(null)}
          onRequestCorrection={requestCorrection}
        />
      )}
    </div>
  );
}

/**
 * The plan button's glyph. Inline rather than from a library: the app ships no
 * icon dependency and one 16px calendar does not justify adding one.
 *
 * `aria-hidden` and no title — the label « Plan » sits right beside it, so an
 * accessible name here would only make a screen reader say the same thing
 * twice. `currentColor` so it inherits the button's accent, including the
 * disabled opacity.
 */
function CalendarIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <rect x="2" y="3.5" width="12" height="10.5" rx="1.75" />
      <path d="M2 6.75h12M5.25 2v3M10.75 2v3" />
    </svg>
  );
}

/**
 * Import verdict panel. Same fixed-toast idiom as before, but it lists EVERY
 * blocking error (the validation layer reports all of them, and showing only
 * the first turned "fix this" into a four-round loop) and the warnings after a
 * successful import (they were persisted to Neon and rendered nowhere).
 *
 * On a rejection it also offers « Demander une correction », which sends those
 * same errors back to the coach as one plan-emit request. It is a BUTTON and
 * not an automatic retry, per the ruling that retired the single-tap plan chip:
 * a ~20 s schema request must never fire without a deliberate gesture. The
 * dismiss button is `min-h-[44px]` alongside it — the two now sit together, and
 * the destructive-adjacent one should not be the easier target.
 */
function Notice({ notice, busy, onDismiss, onRequestCorrection }) {
  const { tone, title, items, canRequestCorrection } = notice;
  return (
    <div className={`fixed top-20 left-1/2 -translate-x-1/2 w-[90%] max-w-[420px] px-5 py-3 rounded-xl text-sm elev-overlay z-50 text-white ${tone === "error" ? "bg-danger" : "bg-accent"}`}>
      <p className="font-semibold">{title}</p>
      {items.length > 0 && (
        <>
          <ul className="mt-2 max-h-48 overflow-y-auto space-y-1.5 list-disc pl-4 text-xs">
            {items.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
          {canRequestCorrection && (
            <button
              onClick={onRequestCorrection}
              disabled={busy}
              className="mt-3 w-full min-h-[44px] rounded-lg border border-white/40 bg-white/15 text-white text-xs font-semibold disabled:opacity-50"
            >
              Demander une correction
            </button>
          )}
          <button
            onClick={onDismiss}
            className="mt-2 w-full min-h-[44px] rounded-lg border border-white/40 bg-transparent text-white text-xs font-semibold"
          >
            Compris
          </button>
        </>
      )}
    </div>
  );
}
