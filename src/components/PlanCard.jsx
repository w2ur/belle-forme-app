import { planFromJson } from "../lib/planFromJson.js";
import { describeExercise } from "../lib/catalog.js";
import { formatLoadWithUnit, formatSetsWithUnit } from "../lib/stats.js";

/**
 * The coach's proposed week, rendered from the schema-backed payload.
 *
 * It exists because the payload IS the reply on the plan-emit path: there is no
 * prose wrapper any more, so whatever this component does not render is what
 * The user never sees — and whatever it renders blindly is what she sees raw. The
 * bubble used to show the `=== FITTRACK PLAN ===` text in a <pre>, which was
 * readable because the model wrote it for a human. JSON is not.
 *
 * IT MUST NEVER RENDER `plan.notebook`. That field is the coach's private
 * notes, described in the schema as « JAMAIS montré à l'utilisateur », and it travels
 * inside the same payload as everything below. This has already happened to her
 * once by another route — for weeks the model wrote its notebook as a visible
 * `### Carnet mis à jour (privé)` heading — so the field is deliberately not
 * destructured, not mapped, and not passed anywhere from here.
 *
 * The server strips the field before the payload is ever streamed
 * (`splitPlanPayload`), so a reply never carries it on the wire. This whole
 * JSON payload format is new on this branch, which has never deployed, and
 * the strip landed before the branch did — so there is no persisted payload
 * anywhere, on this device or in `coach_messages`, that still has the field
 * in it. Even so this rule does not become redundant: it is defense in
 * depth, not a response to observed data, and a future change to the emit
 * path must not come to rely on `PlanCard` to catch a field the server
 * failed to strip.
 *
 * Every string below is model-authored and clamped at the render site. React
 * escapes it, so there is no injection risk; the risk is layout — one 400-
 * character exercise name pushes the sets and the weight off a 380px docked
 * panel. Clamping here rather than in `planFromJson` is deliberate: the plan
 * object is also what gets IMPORTED, and a truncated name would then be
 * rejected by the catalog lookup (or worse, stored).
 */

const MAX_NAME = 70;
const MAX_DETAIL = 90;
// A real progression note is one sentence — the prompt's own worked example
// ("on descend à 15 kg pour que la préhension ne soit plus le facteur limitant")
// is 72 characters. 200 leaves room without letting one note own the card.
const MAX_NOTE = 200;
const MAX_COACH_NOTES = 1200;

function clamp(value, max) {
  const text = typeof value === "string" ? value : "";
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** "2026-08-11" -> "11/08". Tolerates anything else by returning "". */
function formatShort(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(typeof iso === "string" ? iso : "");
  return match ? `${match[3]}/${match[2]}` : "";
}

/** Through `formatLoadWithUnit` — a bare number is ambiguous by 2×. */
function formatWeight(exercise) {
  if (!(exercise.weight > 0)) return "—";
  return formatLoadWithUnit(exercise.weight, exercise.weightType);
}

export default function PlanCard({ payload, catalog = null }) {
  const { plan } = planFromJson(payload);
  if (!plan) return null;

  // The payload is the RAW model reply, and `planFromJson` deliberately does
  // not carry `metric` — only `validatePlanDomain` stamps it, which happens on
  // import, after this card has already been read. So the unit is resolved
  // from the catalog here, or a 25-second dead hang renders "3×25" on the very
  // first surface the user sees, which is the ambiguity this whole change removes.
  // No catalog yet (transient, before the first pull) → no unit rather than a
  // wrong one.
  const metricOf = (name) => describeExercise(name, catalog)?.metric;

  const from = formatShort(plan.weekStart);
  const to = formatShort(plan.weekEnd);
  const weekLabel = from && to ? `${from} → ${to}` : "Semaine à venir";

  return (
    <div className="font-sans">
      <div className="mb-2">
        <p className="font-serif text-sm font-semibold text-gray-800">Programme proposé</p>
        <p className="text-xs text-muted">{weekLabel}</p>
      </div>

      {plan.coachNotes && (
        <div className="mb-2 rounded-xl border border-accent/20 bg-accent/10 p-2.5">
          <p className="mb-1 font-serif text-[11px] font-semibold text-accent">Notes du coach</p>
          <p className="whitespace-pre-wrap text-xs text-gray-800">
            {clamp(plan.coachNotes, MAX_COACH_NOTES)}
          </p>
        </div>
      )}

      <div className="space-y-2">
        {plan.sessions.map((session, i) => (
          <div key={i} className="rounded-xl border border-border bg-surface p-2.5">
            <p className="mb-1.5 text-sm font-semibold text-gray-800">
              {clamp(session.name, MAX_NAME) || `Séance ${i + 1}`}
            </p>

            <MovementList label="Échauffement" items={session.warmup} />

            <div className="space-y-1 py-1">
              {session.exercises.map((exercise, j) => (
                <div key={j}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 flex-1 break-words text-xs text-gray-800">
                      {clamp(exercise.name, MAX_NAME)}
                    </span>
                    {/* Capped and shrinkable for the same reason as the
                        movement detail below: `sets` is built from `reps`,
                        which the model authors freely, so it can be long
                        enough to starve the name column in the coach panel. */}
                    <span className="min-w-0 max-w-[40%] break-words font-mono text-xs text-muted">
                      {formatSetsWithUnit(exercise.sets, metricOf(exercise.name))}
                    </span>
                    <span className="shrink-0 text-right font-mono text-xs font-bold text-accent">
                      {formatWeight(exercise)}
                    </span>
                  </div>
                  {exercise.progressionNote && (
                    <p className="mt-0.5 break-words text-[11px] text-muted">
                      ↳ {clamp(exercise.progressionNote, MAX_NOTE)}
                    </p>
                  )}
                </div>
              ))}
            </div>

            <MovementList label="Retour au calme" items={session.cooldown} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A warmup or cooldown block. `gold-text` on the heading is the established
 * semantic use — the same "earned" role it carries in `WeeklyPlan.jsx:111` —
 * and never plain `gold`, which is 2.20:1 and cannot carry text.
 */
function MovementList({ label, items }) {
  if (!items?.length) return null;
  return (
    <div className="py-0.5">
      <p className="font-serif text-[10px] font-semibold uppercase tracking-wide text-gold-text">
        {label}
      </p>
      {items.map((item, i) => (
        <div key={i} className="flex items-baseline justify-between gap-2 pl-2">
          <span className="min-w-0 flex-1 break-words text-[11px] text-muted-darker">
            {clamp(item.name, MAX_NAME)}
          </span>
          {/* The detail is capped and shrinkable, never `shrink-0` — that was
              the alignment bug of 06/09/2026. `clamp` bounds a detail to
              MAX_DETAIL CHARACTERS, but nothing bounded the SHARE OF THE ROW
              it took, so a 52-character cooldown detail refused to shrink
              inside the ~400px coach panel and starved the name, whose
              `flex-1 min-w-0 break-words` then wrapped it one character per
              line down the card. Measured at 400px: the name went from 40px
              over 4 lines to 188px on one. Short details ("5min") measure
              identically before and after — they fit, so they never shrink. */}
          {item.detail && (
            <span className="min-w-0 max-w-[50%] break-words font-mono text-[11px] text-muted">
              {clamp(item.detail, MAX_DETAIL)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
