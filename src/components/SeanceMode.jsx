import { lazy, Suspense, useEffect, useState } from "react";
import { currentExercise, SKIP_REASONS } from "../lib/activeSession.js";
import { formatDateShort } from "../lib/helpers.js";
import { formatLoadWithUnit, formatRepsWithUnit } from "../lib/stats.js";
import HeroPhoto from "./HeroPhoto.jsx";
import SetRow from "./SetRow.jsx";
import RestTimer from "./RestTimer.jsx";
import ChecklistPanel from "./ChecklistPanel.jsx";
import ExerciseInfo from "./ExerciseInfo.jsx";
/**
 * Lazy on purpose: `SeanceSummary` pulls in dnd-kit, ~54 kB of the bundle for
 * a panel that starts closed and that most séances never open. Eagerly
 * imported it pushed the entry chunk from 484 kB to 538 kB and tripped Vite's
 * 500 kB warning, which this repo does not tolerate. The chunk is precached by
 * the service worker like every other build output, so opening the sommaire
 * offline still works.
 */
const SeanceSummary = lazy(() => import("./SeanceSummary.jsx"));
import { canonicalExerciseName, describeExercise } from "../lib/catalog.js";
import { Icons } from "./icons.jsx";

/**
 * The running workout: one exercise at a time, its records in context, and the
 * set rows that record what actually happened.
 *
 * Same viewport arithmetic as CoachTab — the shell's chrome differs above and
 * below `lg`, and a séance that scrolls the whole page is unusable mid-set.
 */
export default function SeanceMode({
  state, prs, onValidate, onLeave, onSkip, onBack, onMove, onFinish, onQuit, onToggleItem, coachPanel, catalog,
}) {
  const ex = currentExercise(state);
  const total = state.exercises.length;
  const position = Math.min(state.cursor.exercise + 1, total);
  const doneCount = state.exercises.filter((e) => e.status !== "pending").length;

  // The rest countdown belongs to the last validated set, not to the séance:
  // a new validation replaces it rather than queueing behind it.
  const [rest, setRest] = useState(null); // { seconds, nonce }

  // « Passer » asks WHY, in one tap. Before this, « Passer » and « Suivant › »
  // called the same function: the UI offered a choice that did not exist, and
  // nothing ever recorded why an exercise did not happen.
  const [asking, setAsking] = useState(false);

  // The sommaire answers « je fais quoi après ? » in full; the « ensuite »
  // line below answers it in one glance. Closed by default: séance mode shows
  // one thing at a time, and the whole point of the line is that she should
  // not have to open anything for the common case.
  const [summaryOpen, setSummaryOpen] = useState(false);

  // What comes after the current exercise, or null on the last one.
  const next = state.exercises[state.cursor.exercise + 1] ?? null;

  // Closed whenever the current exercise changes. Left open across a
  // « Suivant › » or a « ‹ Précédent », the panel still reads "Pourquoi tu
  // passes cet exercice ?" and the next tap marks a DIFFERENT exercise with a
  // reason she chose for the previous one.
  //
  // Keyed on the NAME as well as the index, because `moveExercise` changes
  // which exercise is current while deliberately holding `cursor.exercise`
  // fixed — an index-only dependency is blind to exactly the move this
  // feature exists to make, which is the hazard this effect claims to prevent.
  useEffect(() => { setAsking(false); }, [state.cursor.exercise, ex?.name]);

  const handleValidate = (values) => {
    onValidate(values);
    setRest({ seconds: ex?.restSeconds || 60, nonce: Date.now() });
  };

  return (
    <div className="flex h-[calc(100dvh-13rem)] gap-6 lg:h-[calc(100dvh-6rem)]">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="mb-4">
          <div className="flex items-center justify-between">
            <h2 className="seance-title m-0 text-gray-800">{state.name}</h2>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setSummaryOpen((o) => !o)}
                aria-expanded={summaryOpen}
                aria-controls="seance-sommaire"
                // Spelled out rather than left to the visible « Exo 2/4 »,
                // which alone does not say the button opens anything — and
                // rather than a bare "Sommaire de la séance", which would drop
                // the position the previous `<span>` announced.
                aria-label={`Sommaire de la séance — exercice ${position} sur ${total}`}
                className="flex min-h-[44px] cursor-pointer items-center gap-1 rounded-lg border-none
                           bg-transparent px-1 seance-control text-muted"
              >
                Exo {position}/{total}
                {summaryOpen ? <Icons.ChevronUp /> : <Icons.ChevronDown />}
              </button>
              <button
                onClick={onQuit}
                aria-label="Quitter la séance"
                className="flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center
                           rounded-lg border border-border-light bg-card text-muted"
              >
                <Icons.X />
              </button>
            </div>
          </div>
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-border">
            <div className="h-full bg-accent transition-[width] duration-300"
                 style={{ width: `${total ? (doneCount / total) * 100 : 0}%` }} />
          </div>
        </header>

        {ex ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* Inside the scrollable container, not wrapped around it: dnd-kit
                auto-scrolls the nearest scrollable ancestor of the droppable,
                and a droppable mounted outside it does not scroll at all
                (my-tsundoku 1507350). */}
            {summaryOpen && (
              <Suspense
                fallback={<p className="mb-4 seance-control text-muted">Sommaire…</p>}
              >
                <SeanceSummary state={state} onMove={onMove} />
              </Suspense>
            )}
            {/* The warmup belongs before the first exercise, not behind a
                toggle on another screen. It disappears once she has moved on. */}
            {state.cursor.exercise === 0 && (
              <ChecklistPanel
                title="Échauffement"
                items={state.warmup}
                onToggle={(i) => onToggleItem("warmup", i)}
              />
            )}
            {/* The PR map is keyed on CANONICAL names — `computePRs` reads
                `sessions`, which `useSessionData` runs through
                `normalizeSessionNames`. The active draft is NOT normalised:
                `useActiveSession` restores it straight from localStorage. So a
                séance started before a rename and resumed after it looked the
                name up raw and silently lost its « record » row, which reads as
                "you have no record here" rather than as a bug. */}
            <ExerciseContext
              exercise={ex}
              pr={prs[catalog ? canonicalExerciseName(ex.name, catalog) : ex.name]}
              catalog={catalog}
            />
            <div className="mt-4 space-y-2">
              {ex.sets.map((set, i) => (
                <SetRow
                  // Keyed by exercise too: without it the row instance is reused
                  // across exercises, carrying the previous one's typed values
                  // and its validation animation into the next. The NAME is
                  // part of the key for the same reason the effect above
                  // depends on it — a move swaps the current exercise without
                  // moving `cursor.exercise`, so an index-only key reuses the
                  // instance and carries her typed values onto a different
                  // exercise whenever the planned numbers happen to match.
                  key={`${state.cursor.exercise}-${ex.name}-${i}`}
                  index={i}
                  planned={{ reps: ex.plannedReps, weight: ex.plannedWeight }}
                  recorded={set}
                  isCurrent={i === state.cursor.set}
                  metric={ex.metric}
                  onValidate={handleValidate}
                />
              ))}
            </div>
            {next && (
              <p className="mt-4 border-t border-border pt-3 seance-control text-muted">
                ensuite · <span className="text-gray-800">{next.name}</span>
                {" — "}
                <span className="font-mono tabular-nums">
                  {formatRepsWithUnit(next.plannedReps, next.metric)}
                  {next.plannedWeight > 0
                    ? ` × ${formatLoadWithUnit(next.plannedWeight, next.weightType)}`
                    : " au poids du corps"}
                </span>
              </p>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex flex-col items-center text-center">
              <HeroPhoto name="victory" className="mb-4" />
              <p className="seance-title text-gray-800">Rideau, darling.</p>
              <p className="mb-6 seance-control text-muted">Tout est passé. Termine quand tu veux.</p>
            </div>
            <ChecklistPanel
              title="Retour au calme"
              items={state.cooldown}
              onToggle={(i) => onToggleItem("cooldown", i)}
            />
          </div>
        )}

        {rest && (
          <div className="mt-3">
            {/* The key is what makes a new validation restart the countdown
                rather than letting the previous one run on. */}
            <RestTimer key={rest.nonce} seconds={rest.seconds} onDismiss={() => setRest(null)} />
          </div>
        )}

        {asking && ex && (
          <div className="mt-3 rounded-xl border border-border-light bg-surface p-3">
            <p className="m-0 mb-2 seance-control text-muted">Pourquoi tu passes cet exercice ?</p>
            <div className="flex flex-wrap gap-2">
              {SKIP_REASONS.map((r) => (
                <button
                  key={r.id || "none"}
                  onClick={() => { setAsking(false); onSkip(r.id); }}
                  className="min-h-[44px] cursor-pointer rounded-lg border border-border-light bg-card px-3
                             seance-control text-gray-800"
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <footer className="mt-4 flex items-center gap-3 border-t border-border pt-4">
          <button
            onClick={onBack}
            disabled={state.cursor.exercise === 0}
            className="min-h-[44px] cursor-pointer rounded-xl border border-border-light bg-transparent px-4
                       seance-control text-muted disabled:opacity-40"
          >
            ‹ Précédent
          </button>
          {ex && (
            <button
              onClick={() => setAsking((a) => !a)}
              aria-expanded={asking}
              className="min-h-[44px] cursor-pointer rounded-xl border border-border-light bg-transparent px-4
                         seance-control text-muted"
            >
              Passer
            </button>
          )}
          <button
            onClick={ex ? onLeave : onFinish}
            className="ml-auto min-h-[44px] cursor-pointer rounded-xl border-none bg-accent px-6
                       seance-control font-semibold text-white elev-raised"
          >
            {ex ? "Suivant ›" : "Terminer la séance"}
          </button>
        </footer>
      </div>

      {coachPanel}
    </div>
  );
}

function ExerciseContext({ exercise, pr, catalog }) {
  return (
    <div>
      <h3 className="seance-title m-0 text-gray-800">{exercise.name}</h3>
      {/* Below the heading rather than inside it: the description is a `<p>`
          now that it is shown by default, and a `<p>` is invalid content for an
          `<h3>` — it would also inherit the serif 28px weight-700. */}
      {/* Keyed by exercise, for the same reason `SetRow` below is: without it
          the instance is reused across exercises and its open panel stays open
          over the NEXT exercise's set rows — floated, so it covers the ✓
          button rather than pushing it down. */}
      <ExerciseInfo key={exercise.name} info={describeExercise(exercise.name, catalog)} />
      <dl className="mt-2 space-y-1 seance-control">
        <div className="flex gap-2">
          <dt className="w-24 text-muted">prévu</dt>
          <dd className="m-0 font-mono tabular-nums text-gray-800">
            {formatRepsWithUnit(exercise.plannedReps, exercise.metric)}
            {exercise.plannedWeight > 0
              ? ` × ${formatLoadWithUnit(exercise.plannedWeight, exercise.weightType)}`
              : " — poids du corps"}
          </dd>
        </div>
        {/* A bodyweight movement has a 0 kg "record", which is not a record —
            but a HOLD has a record in seconds, and this gate used to hide it.
            That was the one progression the user is actually chasing. */}
        {pr && (pr.weight > 0 || pr.seconds > 0) && (
          <div className="flex gap-2">
            <dt className="w-24 text-muted">record</dt>
            <dd className="m-0 font-mono tabular-nums text-gold-text">
              {pr.metric === "seconds"
                ? formatRepsWithUnit(String(pr.seconds), "seconds")
                : formatLoadWithUnit(pr.weight, pr.weightType)} · {formatDateShort(pr.date)}
            </dd>
          </div>
        )}
        {exercise.progressionNote && (
          <div className="flex gap-2">
            <dt className="w-24 text-muted">note</dt>
            <dd className="m-0 text-gray-600">{exercise.progressionNote}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
