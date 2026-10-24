import { useState } from "react";

/**
 * The lexique, delivered where it is needed. The description sits inline under
 * the exercise name in séance mode; the form cues are one tap away, instead of
 * sending her to a list on another screen mid-set.
 *
 * **The description used to be behind the tap too, and that is the fix.** It
 * was a magnifier icon in the heading, collapsed by default — an affordance
 * that reads as "search", on a screen where she is holding two dumbbells. A
 * description is one sentence (138 characters at the longest in the catalog),
 * so it costs two lines to simply show it, and it is STATIC rather than
 * toggled, which is what keeps the set rows from moving: mid-set, the ✓ button
 * must not shift under her thumb. The cues panel is still floated and
 * absolutely positioned for the same reason.
 *
 * `catalog` is a `buildCatalogViews` result, or null before the first pull.
 * `describeExercise` resolves the alias and tolerates the missing catalog — the
 * raw `catalog.descriptions[name]` this used to do returned `undefined` for
 * every retired name and rendered nothing at all, with no way to tell that
 * apart from an exercise that genuinely has no description.
 */
export default function ExerciseInfo({ info }) {
  const [open, setOpen] = useState(false);
  if (!info) return null;
  const { description, formCues, perSide } = info;
  if (!description && !formCues && !perSide) return null;

  return (
    <div className="mt-1">
      {description && <p className="m-0 seance-control text-gray-800">{description}</p>}
      {/* Inline rather than inside the panel, and the button is gated on the
          cues ALONE. An exercise can carry `perSide` with no `formCues` — the
          lexique's `blankExercise()` defaults them empty and neither validator
          demands them — which produced a « Comment faire » button opening onto
          nothing but this one line, then offering to hide "points de forme"
          that did not exist. It is also the half she needs without tapping:
          whether 10 reps means 10 or 20. */}
      {perSide && <p className="m-0 mt-1 text-sm text-muted">Répétitions comptées par côté.</p>}
      {formCues && (
        <span className="relative inline-block">
          <button
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="inline-flex min-h-[44px] cursor-pointer items-center py-0 text-sm text-accent underline
                       underline-offset-4"
          >
            {open ? "Masquer les points de forme" : "Comment faire"}
          </button>
          {open && (
            <span
              className="absolute left-0 top-full z-30 block w-[min(30rem,75vw)] rounded-xl border border-border
                         bg-card p-4 font-sans font-normal elev-overlay"
            >
              <span className="block seance-control text-accent">{formCues}</span>
            </span>
          )}
        </span>
      )}
    </div>
  );
}
