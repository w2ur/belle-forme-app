import { DEMO_QUESTIONS, DEMO_COACH_LABEL } from "./coach.js";

/** The demo coach's suggested questions, and the label that says it is scripted. */
export default function DemoCoachChips({ onAsk, busy }) {
  return (
    // The transcript's own column (CoachConversation: mx-auto, max-w-[65ch]),
    // so at lg the chips line up with the bubbles instead of the page edge.
    <div className="mx-auto mb-2 w-full max-w-[65ch]">
      <p className="m-0 mb-1.5 text-xs font-semibold text-muted">{DEMO_COACH_LABEL}</p>
      {/* One scrolling row: wrapped, four chips took a third of a phone screen from the transcript. */}
      <div className="-mx-5 flex scroll-px-5 gap-2 overflow-x-auto px-5 py-1 [scrollbar-width:none] lg:mx-0 lg:flex-wrap lg:px-1">
        {DEMO_QUESTIONS.map(({ question }) => (
          <button
            key={question}
            onClick={() => onAsk(question)}
            disabled={busy}
            className="min-h-[44px] shrink-0 cursor-pointer whitespace-nowrap rounded-xl border border-border-light bg-card px-3 py-1.5 text-sm text-muted disabled:opacity-50"
          >
            {question}
          </button>
        ))}
        {/* A scroller drops its trailing padding: this keeps the last chip, and
            its focus ring, clear of the edge. py-1 above leaves the ring room. */}
        <span aria-hidden="true" className="w-3 shrink-0 lg:hidden" />
      </div>
    </div>
  );
}
