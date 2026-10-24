import { useEffect, useState } from "react";
import {
  DndContext, DragOverlay, closestCenter,
  KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors,
} from "@dnd-kit/core";
import {
  SortableContext, useSortable, sortableKeyboardCoordinates, verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { skipReasonLabel } from "../lib/activeSession.js";
import { formatLoadWithUnit, formatSetsWithUnit } from "../lib/stats.js";

/**
 * The whole séance at a glance, and the only place its order can change.
 *
 * Two complaints, one surface: the user could not see what was coming (only the
 * current exercise is ever on screen), and could not reorder when the room
 * disagreed with the plan.
 *
 * **The gesture is a long press on the row, not a drag handle.** That is not a
 * taste call — `my-tsundoku` built the handle (18cbba0) and removed it eight
 * days later (a42cb87). The activation constraints below are what actually
 * resolve the scroll-versus-drag conflict: under 200 ms it is a scroll, and so
 * is any press that drifts more than 5 px before the delay elapses.
 *
 * The same project also proved `@hello-pangea/dnd` unusable on iOS Safari and
 * migrated to dnd-kit (9a16bdb) — which is why this is a dependency rather
 * than a hand-rolled pointer implementation on the one browser that matters
 * here.
 *
 * **The drag does not work in `npm run dev`, and that is not a bug in this
 * file.** React 19's `StrictMode` double-invokes effects, which leaves
 * dnd-kit v6 with a drag that activates — the row dims, the overlay mounts —
 * but never receives a move, so the pointer travels and nothing follows it.
 * Measured 2026-09-06 both ways: identical code reorders correctly in
 * `npm run build && npm run preview`, and correctly in `npm run dev` with
 * `StrictMode` removed from `main.jsx`. `StrictMode` stays, because losing it
 * for the whole app to make one panel debuggable is the wrong trade — verify
 * this panel against the production preview.
 */
export default function SeanceSummary({ state, onMove }) {
  const [activeId, setActiveId] = useState(null);
  const reducedMotion = usePrefersReducedMotion();

  const floor = state.cursor.exercise;
  const past = state.exercises.slice(0, floor);
  const movable = state.exercises.slice(floor);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = ({ active, over }) => {
    setActiveId(null);
    if (!over || active.id === over.id) return;
    onMove(Number(active.id), Number(over.id));
  };

  const dragged = activeId !== null ? state.exercises[Number(activeId)] : null;

  return (
    <section
      id="seance-sommaire"
      aria-label="Sommaire de la séance"
      className="mb-4 rounded-xl border border-border-light bg-surface p-3"
    >
      {/* Past exercises are rendered OUTSIDE the sortable context, not merely
          disabled inside it. Everything behind the cursor has been left: its
          status is a statement about what happened and its skip reason travels
          to the coach, so a drop must not be able to land there at all.
          `moveExercise` refuses it too — belt and suspenders, as elsewhere. */}
      {past.length > 0 && (
        <ul className="m-0 mb-1 list-none space-y-1 p-0">
          {past.map((ex, i) => (
            <li key={`past-${i}`}>
              <SummaryRow exercise={ex} position="past" />
            </li>
          ))}
        </ul>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={({ active }) => setActiveId(active.id)}
        onDragEnd={handleDragEnd}
        // Without this a cancelled drag leaves the source row at opacity 0.4
        // and the overlay mounted (my-tsundoku c1142c7).
        onDragCancel={() => setActiveId(null)}
      >
        <SortableContext
          items={movable.map((_, i) => String(floor + i))}
          strategy={verticalListSortingStrategy}
        >
          <ul className="m-0 list-none space-y-1 p-0">
            {movable.map((ex, i) => (
              <SortableRow
                key={`${floor + i}-${ex.name}`}
                id={String(floor + i)}
                exercise={ex}
                position={i === 0 ? "current" : "upcoming"}
                reducedMotion={reducedMotion}
              />
            ))}
          </ul>
        </SortableContext>

        {/* `dropAnimation={null}`: the default animation flies the row back to
            its origin before the state update lands, which reads as a flash
            (my-tsundoku b76238b). */}
        <DragOverlay dropAnimation={null}>
          {dragged ? (
            <div className="rounded-lg bg-card elev-overlay">
              <SummaryRow exercise={dragged} position="upcoming" />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <p className="m-0 mt-2 text-xs text-muted-darker">
        Appui long sur un exercice pour le déplacer.
      </p>
    </section>
  );
}

function SortableRow({ id, exercise, position, reducedMotion }) {
  // dnd-kit animates the rows that shift out of the way with its own inline
  // transition, which no CSS media query can reach. `null` disables it, so the
  // panel honours the same `prefers-reduced-motion` contract as
  // `.motion-validate` in `index.css`.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, transition: reducedMotion ? null : undefined });

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
        // iOS opens its own preview/callout on a long press otherwise, which
        // is exactly the gesture this uses (my-tsundoku a42cb87).
        WebkitTouchCallout: "none",
        userSelect: "none",
        touchAction: "manipulation",
      }}
      {...attributes}
      {...listeners}
    >
      <SummaryRow exercise={exercise} position={position} />
    </li>
  );
}

/**
 * One line, shared by the list and the drag overlay so the row being dragged
 * cannot drift from the row it came from.
 */
function SummaryRow({ exercise, position }) {
  const why = position === "past" ? skipReasonLabel(exercise.skipReason) : null;
  const tone =
    position === "current" ? "text-gray-800 font-semibold"
      : position === "past" ? "text-muted"
        : "text-gray-600";

  return (
    <div className="flex min-h-[44px] items-center gap-2 rounded-lg px-2 py-1">
      <span aria-hidden className="w-5 shrink-0 text-center text-muted">
        {position === "current" ? "▶" : position === "past" ? statusMark(exercise.status) : "·"}
      </span>
      <span className={`min-w-0 flex-1 truncate text-sm ${tone}`}>
        {exercise.name}
        {why && <span className="text-muted-darker"> — {why.toLowerCase()}</span>}
      </span>
      <span className="mx-2 shrink-0 font-mono text-sm text-muted">
        {formatSetsWithUnit(`${exercise.sets.length}×${exercise.plannedReps}`, exercise.metric)}
      </span>
      <span className="min-w-[84px] shrink-0 text-right font-mono text-sm font-bold text-accent">
        {exercise.plannedWeight > 0
          ? formatLoadWithUnit(exercise.plannedWeight, exercise.weightType)
          : "—"}
      </span>
    </div>
  );
}

/** `prefers-reduced-motion`, live — the setting can change mid-séance. */
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  );
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function statusMark(status) {
  if (status === "complete") return "✓";
  if (status === "partial") return "~";
  return "×";
}
