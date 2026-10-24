import { useLayoutEffect, useRef, useState } from "react";
import { Icons } from "./icons.jsx";
import { formatLoadWithUnit, formatRepsWithUnit, formatSetsWithUnit } from "../lib/stats.js";
import { describeExercise } from "../lib/catalog.js";
import { formatDateShort } from "../lib/helpers.js";

/**
 * `catalog` is a `buildCatalogViews` result, or null before the first pull —
 * threaded down to `PlannedSessionCard` for the per-exercise description in
 * the expanded detail view. A display consumer: with no catalog the
 * description line is simply absent, never a throw or a guess.
 */
export default function WeeklyPlan({ plan, sessions, onStartSession, onNoteSession, onTimer, catalog }) {
  if (!plan) return null;

  const weekLabel = plan.weekStart && plan.weekEnd
    ? `${formatDateShort(plan.weekStart)} → ${formatDateShort(plan.weekEnd)}`
    : "Semaine en cours";

  return (
    <div className="mb-5">
      <div className="mb-3">
        <h3 className="text-gray-800 text-base font-semibold m-0 font-serif">Programme</h3>
        <p className="text-muted text-sm mt-0.5">{weekLabel}</p>
      </div>

      {plan.coachNotes && <CoachNotes text={plan.coachNotes} />}

      <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
        {plan.sessions.map((planned, i) => {
          const matched = getMatchedSession(planned, sessions, plan);
          return (
            <PlannedSessionCard
              key={i}
              session={planned}
              index={i}
              matched={matched}
              onStart={() => onStartSession(planned)}
              onNote={() => onNoteSession(planned)}
              onTimer={onTimer}
              catalog={catalog}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * The week's coach notes, clamped to three lines. Unclamped they ran to a screen
 * and a half on the phone layout and pushed « Commencer » three screens down.
 * Whether to offer « Lire la suite » is MEASURED, not guessed from length: three
 * lines hold very different amounts of text at 500px and at 1440px, and a toggle
 * that expands nothing reads as broken.
 */
function CoachNotes({ text }) {
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  const ref = useRef(null);

  // Re-measured on two more events than a text change, or a first measure could
  // leave the notes cut with no button: a width change (iPad rotation, resize),
  // caught by a ResizeObserver; and the Jost webfont arriving, which reflows the
  // text inside a box whose clamped height does NOT change, so the observer
  // never sees it. `fonts.ready` covers a load already in flight at mount, and
  // `loadingdone` one that starts later (a weight first needed after mount).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    let live = true;
    const measure = () => { if (live) setClamped(el.scrollHeight > el.clientHeight + 1); };
    measure();
    const fonts = document.fonts;
    fonts?.ready.then(measure);
    fonts?.addEventListener?.("loadingdone", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      live = false;
      observer?.disconnect();
      fonts?.removeEventListener?.("loadingdone", measure);
    };
  }, [text, open]);

  return (
    <div className="bg-accent/10 border border-accent/20 rounded-xl p-3 mb-3">
      <div className="text-accent text-xs font-semibold mb-1 font-serif">Notes du coach</div>
      <div ref={ref} className={`text-gray-600 text-sm whitespace-pre-wrap max-w-[75ch] ${open ? "" : "line-clamp-3"}`}>
        {text}
      </div>
      {(clamped || open) && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="mt-1 min-h-[44px] bg-transparent border-none p-0 text-accent text-sm font-semibold cursor-pointer"
        >
          {open ? "Réduire" : "Lire la suite"}
        </button>
      )}
    </div>
  );
}

function PlannedSessionCard({ session, index, matched, onStart, onNote, onTimer, catalog }) {
  const [expanded, setExpanded] = useState(false);
  const isDone = !!matched;

  return (
    <div className={`rounded-[14px] p-3.5 border elev-card ${isDone ? "bg-surface border-border" : "bg-card border-border"}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          {isDone
            ? <span className="text-accent"><Icons.Check /></span>
            : <span className="text-accent font-bold text-sm">#{index + 1}</span>
          }
          <span className={`text-base font-semibold truncate ${isDone ? "text-muted" : "text-gray-800"}`}>
            {session.name}
          </span>
        </div>
        {isDone ? (
          <span className="text-xs text-muted shrink-0">
            Faite le {formatDateShort(matched.date)}
          </span>
        ) : (
          <div className="flex gap-1.5 shrink-0">
            <button
              onClick={onStart}
              className="flex min-h-[44px] items-center gap-1 rounded-lg border-none bg-accent px-3 py-1.5
                         text-sm font-semibold text-white cursor-pointer elev-raised"
            >
              <Icons.Play /> Commencer
            </button>
            <button
              onClick={onNote}
              className="flex items-center gap-1 px-2.5 py-1.5 min-h-[44px] rounded-lg border border-border-light bg-transparent text-accent text-sm font-semibold cursor-pointer"
            >
              <Icons.Edit /> Noter
            </button>
          </div>
        )}
      </div>

      <div className="space-y-0.5 mb-1.5">
        {session.exercises.map((ex, j) => (
          <div key={j} className="flex items-center justify-between">
            <span className={`text-sm flex-1 ${isDone ? "text-muted" : "text-gray-600"}`}>{ex.name}</span>
            <span className="text-muted text-sm font-mono mx-2">{formatSetsWithUnit(ex.sets, ex.metric)}</span>
            <span className="text-accent text-sm font-bold font-mono min-w-[50px] text-right">
              {ex.weight > 0 ? formatLoadWithUnit(ex.weight, ex.weightType) : "—"}
            </span>
          </div>
        ))}
      </div>

      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-center gap-1 py-1.5 text-xs text-muted font-semibold cursor-pointer bg-transparent border-none min-h-[44px]"
      >
        {expanded ? "Masquer" : "Détail"}
        {expanded ? <Icons.ChevronUp /> : <Icons.ChevronDown />}
      </button>

      {expanded && (
        <div className="mt-1.5 border-t border-border pt-2 space-y-1">
          {unfoldSession(session).map((step, k) => {
            if (step.type === "section-header") {
              return (
                <div key={k} className="pt-2 pb-1">
                  <span className="text-xs font-semibold text-gold-text uppercase tracking-wide font-serif">
                    {step.label}
                  </span>
                </div>
              );
            }
            if (step.type === "warmup" || step.type === "cooldown") {
              return (
                <div key={k} className="flex items-center justify-between py-1 pl-2">
                  <span className="text-gray-600 text-sm">{step.name}</span>
                  {step.detail && <span className="text-muted text-sm font-mono">{step.detail}</span>}
                </div>
              );
            }
            if (step.type === "exercise") {
              const desc = describeExercise(step.name, catalog)?.description;
              return (
                <div key={k} className="py-1">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-800 text-sm font-medium">{step.name}</span>
                    <span className="text-accent text-sm font-bold font-mono">
                      {formatRepsWithUnit(step.reps, step.metric)}{step.weight > 0 ? ` @ ${formatLoadWithUnit(step.weight, step.weightType)}` : ""}
                    </span>
                  </div>
                  {desc && <p className="text-muted text-xs mt-0.5">{desc}</p>}
                  {step.progressionNote && (
                    <p className="text-muted text-xs mt-0.5">↳ {step.progressionNote}</p>
                  )}
                </div>
              );
            }
            return (
              <button
                key={k}
                onClick={() => onTimer?.(step.seconds)}
                className="w-full flex items-center gap-2 py-1 px-3 rounded-lg bg-surface text-muted text-xs cursor-pointer border-none min-h-[44px]"
              >
                <Icons.Clock />
                <span>Repos — {formatDuration(step.seconds)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function getMatchedSession(plannedSession, sessions, plan) {
  if (!plan.weekStart) return null;
  const start = new Date(plan.weekStart);
  start.setHours(0, 0, 0, 0);

  return sessions.find(s => {
    const d = new Date(s.date);
    return s.name === plannedSession.name && d >= start;
  }) || null;
}

function unfoldSession(session) {
  const steps = [];
  if (session.warmup?.length > 0) {
    steps.push({ type: "section-header", label: "Échauffement" });
    session.warmup.forEach(item => steps.push({ type: "warmup", name: item.name, detail: item.detail }));
  }
  session.exercises.forEach((ex, i) => {
    const rest = ex.restSeconds || 60;
    const isLast = i === session.exercises.length - 1;
    for (let s = 0; s < ex.setsCount; s++) {
      // `metric` travels with the step or the expanded view renders a bare
      // "25" while the collapsed line above it correctly reads "3×25 s".
      steps.push({ type: "exercise", name: ex.name, reps: ex.reps, weight: ex.weight, weightType: ex.weightType, metric: ex.metric, progressionNote: ex.progressionNote });
      if (s < ex.setsCount - 1) {
        steps.push({ type: "rest", seconds: rest, isTransition: false });
      } else if (!isLast) {
        const nextRest = session.exercises[i + 1]?.restSeconds || 60;
        steps.push({ type: "rest", seconds: Math.max(Math.round(nextRest * 1.5), 60), isTransition: true });
      }
    }
  });
  if (session.cooldown?.length > 0) {
    steps.push({ type: "section-header", label: "Retour au calme" });
    session.cooldown.forEach(item => steps.push({ type: "cooldown", name: item.name, detail: item.detail }));
  }
  return steps;
}

function formatDuration(seconds) {
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}min${s.toString().padStart(2, "0")}` : `${m}min`;
  }
  return `${seconds}s`;
}
