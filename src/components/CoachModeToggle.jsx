/**
 * The two-mode segmented control that replaced the accidental-fire chips.
 * Discussion never carries a schema and can never produce a plan; Mon
 * programme only changes what the coach is ALLOWED to talk about — producing
 * one still needs the explicit « Plan » button, in the mode row (`CoachTab`).
 *
 * `role="radiogroup"` / `role="radio"` + `aria-checked`, not `tablist`/`tab`:
 * the tabs pattern implies a single tab stop with arrow-key roving tabindex,
 * which this control does not implement (both options are ordinary
 * independently-focusable buttons) — declaring a role assistive tech expects
 * to be able to navigate a way it can't is worse than declaring none.
 * `radiogroup` fits (one control choosing between two mutually exclusive
 * states) and needs no roving tabindex to be a correct implementation.
 *
 * Active option: `bg-card` + `elev-card` (the three-step elevation scale —
 * never a bespoke shadow). Inactive: `surface` + `muted`. Deliberately no
 * `gold` anywhere here — gold means *earned*, and a mode is not an
 * achievement.
 */
export default function CoachModeToggle({ mode, setMode }) {
  // The visible « Mode » label is what tells her this is a send mode and not a
  // pair of view tabs: switching changes nothing in the transcript. It sits
  // outside the radiogroup, which keeps its own aria-label. Hidden below `sm`:
  // at 390px its 34px is what pushed « Plan » onto a row of its own (measured:
  // 367px of controls in a 346px row), and that row is the one the move saved.
  return (
    <div className="inline-flex items-center gap-2">
      <span className="hidden text-muted text-sm sm:inline">Mode</span>
      <div role="radiogroup" aria-label="Mode du coach" className="inline-flex gap-1 rounded-xl bg-surface p-1">
        <ModeOption label="Discussion" selected={mode === "discussion"} onSelect={() => setMode("discussion")} />
        <ModeOption label="Mon programme" selected={mode === "plan"} onSelect={() => setMode("plan")} />
      </div>
    </div>
  );
}

function ModeOption({ label, selected, onSelect }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`min-h-[44px] rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
        selected ? "bg-card text-accent elev-card" : "bg-transparent text-muted"
      }`}
    >
      {label}
    </button>
  );
}
