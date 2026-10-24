/**
 * Turns a planned session from the coach's programme into an editable draft.
 *
 * The planned numbers are a STARTING POINT for inputs, never a record of what
 * happened. The old `Fait` button saved this shape straight to history, so the
 * coach's next recommendation was built on numbers the user never confirmed.
 */
export function draftFromPlanned(planned, { id, date }) {
  return {
    id,
    date,
    name: planned.name,
    exercises: (planned.exercises ?? []).map((ex) => ({
      name: ex.name,
      weightType: ex.weightType || "total",
      ...(ex.metric === "seconds" ? { metric: "seconds" } : {}),
      sets: Array.from({ length: ex.setsCount || 1 }, () => ({
        reps: ex.reps ?? "",
        // A bodyweight movement plans as 0; an empty input is honest, a "0" is
        // a claim she lifted nothing.
        weight: ex.weight > 0 ? String(ex.weight) : "",
        notes: "",
      })),
    })),
    duration_minutes: "",
    general_notes: "",
  };
}
