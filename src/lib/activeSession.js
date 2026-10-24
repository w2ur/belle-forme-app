/**
 * The séance state machine — a running workout.
 *
 * Pure by design: this repo does not unit-test components, so anything worth
 * testing lives in `src/lib/`. Every function returns a NEW state and never
 * mutates its input, which is also what makes the property test's arbitrary
 * interleavings meaningful.
 *
 * The state IS the localStorage payload: iPad Safari kills backgrounded tabs,
 * and losing a séance mid-workout is not recoverable from memory.
 */

import { today } from "./helpers.js";

const VERSION = 1;

/** Status of an exercise once it has been left. */
function statusFor(exercise) {
  const done = exercise.sets.filter((s) => s.done).length;
  if (done === 0) return "skipped";
  return done === exercise.sets.length ? "complete" : "partial";
}

export function createFromPlanned(planned, { id, date, startedAt, weekStart = null }) {
  const checklist = (items) =>
    (items ?? []).map((i) => ({ name: i.name, detail: i.detail ?? "", done: false }));

  return {
    version: VERSION,
    id,
    date,
    name: planned.name,
    startedAt,
    weekStart,
    cursor: { exercise: 0, set: 0 },
    warmup: checklist(planned.warmup),
    cooldown: checklist(planned.cooldown),
    exercises: (planned.exercises ?? []).map((ex) => ({
      name: ex.name,
      weightType: ex.weightType || "total",
      // Travels with the exercise rather than being looked up from the
      // catalog at read time, exactly as `weightType` does: `computePRs` and
      // `generateExport` take no catalog, and a later catalog edit must not
      // retroactively reinterpret what a recorded set meant. Absent = reps.
      ...(ex.metric === "seconds" ? { metric: "seconds" } : {}),
      restSeconds: ex.restSeconds || 60,
      progressionNote: ex.progressionNote || "",
      plannedReps: ex.reps ?? "",
      plannedWeight: ex.weight ?? 0,
      status: "pending",
      sets: Array.from({ length: ex.setsCount || 1 }, () => ({ reps: "", weight: "", done: false })),
    })),
    general_notes: "",
  };
}

/**
 * The cursor, landed on an exercise: on the first set she has NOT validated.
 *
 * Every arrival goes through here rather than assuming `set: 0`. `SetRow`
 * renders a validated set as the read-only completed row and every
 * non-current set as `—`, so a cursor parked on a set that is already done
 * shows NO ✓ button at all — she cannot record the sets she has left, and the
 * only ways out are « Suivant › » (recording `partial`) or « Passer ».
 *
 * `set: 0` was safe while the cursor only ever advanced into an untouched
 * exercise. `moveExercise` made "I did a set, the bar is taken, I'll come back
 * to it" the headline flow, which lands on a half-done exercise by design.
 *
 * Everything done means there is nothing to land on; the last row is then the
 * honest place to be, exactly as `back` has always done.
 */
function cursorOnto(exercises, index) {
  const ex = exercises[index];
  if (!ex) return { exercise: index, set: 0 };
  const firstUndone = ex.sets.findIndex((s) => !s.done);
  return {
    exercise: index,
    set: firstUndone === -1 ? Math.max(0, ex.sets.length - 1) : firstUndone,
  };
}

export function currentExercise(state) {
  return state.exercises[state.cursor.exercise] ?? null;
}

/** Records what actually happened at the cursor, then advances. */
export function validateSet(state, { reps, weight }) {
  const ex = currentExercise(state);
  if (!ex) return state;

  const sets = ex.sets.map((s, i) =>
    i === state.cursor.set ? { reps: String(reps ?? ""), weight: String(weight ?? ""), done: true } : s
  );
  const wasLastSet = state.cursor.set >= ex.sets.length - 1;
  const updated = { ...ex, sets, status: wasLastSet ? statusFor({ ...ex, sets }) : ex.status };

  const exercises = state.exercises.map((e, i) => (i === state.cursor.exercise ? updated : e));
  const cursor = wasLastSet
    ? cursorOnto(exercises, state.cursor.exercise + 1)
    : { exercise: state.cursor.exercise, set: state.cursor.set + 1 };

  return { ...state, exercises, cursor };
}

/**
 * Ends the current exercise now and moves on. The three-way status is the
 * whole point: `skipped` and `partial` are what let the coach tell a session
 * that never happened from one that happened badly (issue #4, T5.3/T5.4).
 */
export function leaveExercise(state) {
  const ex = currentExercise(state);
  if (!ex) return state;
  const exercises = state.exercises.map((e, i) =>
    i === state.cursor.exercise ? { ...e, status: statusFor(e) } : e
  );
  return { ...state, exercises, cursor: cursorOnto(exercises, state.cursor.exercise + 1) };
}

/**
 * Abandons the current exercise DELIBERATELY, with a reason, and moves on.
 *
 * Distinct from `leaveExercise`, which merely advances and lets `statusFor`
 * infer what happened from the sets. Both used to be wired to the same two
 * buttons — « Passer » and « Suivant › » called one function — so the UI
 * offered a choice that did not exist, and the three-way status was never a
 * statement of intent, only a description of what she happened to type.
 *
 * The reason is why this exists at all. In one session the user spent five messages
 * and twenty minutes re-narrating a séance to the coach: a piece of equipment
 * that would not set up, a substitute exercise done instead, the equipment
 * finally ready at the end. The coach was looking straight at a SÉANCE EN COURS
 * block that could not express any of it. Her reason was équipement — one tap,
 * had there been anything to tap.
 *
 * The status is still DERIVED, and the reason is what this adds. An early
 * draft forced `skipped` on the grounds that her intent outranks the numbers,
 * and that was wrong in a way that reached the coach: `finalize` keeps every
 * validated set, so an exercise she half-did and then abandoned was stored as
 * `skipped` WITH two real sets — breaking the documented invariant that a
 * skipped exercise carries `sets: []`, and making `generateExport` report
 * « passé (non réalisé) » for a session `computePRs` was simultaneously
 * crediting with a new record. Two contradictory facts about one exercise.
 *
 * So the status is `statusFor`, identically to `leaveExercise`: nothing done
 * is `skipped`, some sets is `partial`, all of them is `complete`. **The
 * difference between the two buttons is the REASON, not a different verdict
 * about what she did** — which is the thing that was actually missing, and a
 * button cannot make a set she validated stop existing. « Suivant › » moves
 * on; « Passer » moves on and says why.
 */
export function skipExercise(state, { reason = "" } = {}) {
  const ex = currentExercise(state);
  if (!ex) return state;
  const exercises = state.exercises.map((e, i) =>
    i === state.cursor.exercise ? { ...e, status: statusFor(e), skipReason: reason } : e
  );
  return { ...state, exercises, cursor: cursorOnto(exercises, state.cursor.exercise + 1) };
}

/** Back to the previous exercise, reopened so it can be continued. */
export function back(state) {
  const target = state.cursor.exercise - 1;
  if (target < 0) return state;
  // Reopening clears the skip AND its reason: continuing an exercise she said
  // she was abandoning would otherwise leave « matériel » attached to a set
  // she went on to do, and that reason travels to the coach.
  const exercises = state.exercises.map((e, i) =>
    i === target ? { ...e, status: "pending", skipReason: "" } : e
  );
  return { ...state, exercises, cursor: cursorOnto(exercises, target) };
}

/**
 * Reorders the séance while it runs.
 *
 * Two rules that dnd-kit's `arrayMove` knows nothing about, which is why the
 * arithmetic lives here rather than in the component:
 *
 * **The cursor is the floor.** An exercise already behind the cursor is frozen
 * — it has been left, its `status` is a statement about what happened and its
 * `skipReason` travels to the coach. Reordering the past would rewrite that
 * record. Only the CURRENT exercise and the ones still ahead can move.
 *
 * **The current exercise moves too, and that is the point.** « La barre est
 * prise, je le fais plus tard » has no other expression: leaving it would
 * record it as `skipped` with a reason she does not mean. Moving it down keeps
 * `cursor.exercise` where it is, so whatever now sits there becomes current
 * and the displaced exercise is simply still to come.
 *
 * `cursor.set` is therefore recomputed rather than carried: it indexes the
 * exercise AT the cursor, and after a move that may be a different exercise.
 * A cursor left at set 2 of a half-done exercise would otherwise point at an
 * already-validated row of the one that replaced it.
 */
export function moveExercise(state, from, to) {
  const n = state.exercises.length;
  const floor = state.cursor.exercise;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return state;
  if (from < floor || to < floor) return state;
  if (from >= n || to >= n) return state;
  if (from === to) return state;

  const exercises = state.exercises.slice();
  const [moved] = exercises.splice(from, 1);
  exercises.splice(to, 0, moved);

  return { ...state, exercises, cursor: cursorOnto(exercises, floor) };
}

export function toggleChecklistItem(state, section, index) {
  const items = state[section];
  if (!Array.isArray(items) || index < 0 || index >= items.length) return state;
  return {
    ...state,
    [section]: items.map((it, i) => (i === index ? { ...it, done: !it.done } : it)),
  };
}

/**
 * Active séance → the storable session shape.
 *
 * Only validated sets survive. An exercise that was left with none is kept
 * with an empty `sets` array and `status: "skipped"` — recorded, not dropped,
 * because "she skipped it" and "it never existed" are different facts.
 */
export function finalize(state, { durationMinutes }) {
  return {
    id: state.id,
    date: state.date,
    name: state.name,
    exercises: state.exercises.map((ex) => ({
      name: ex.name,
      weightType: ex.weightType,
      ...(ex.metric === "seconds" ? { metric: "seconds" } : {}),
      status: ex.status === "pending" ? statusFor(ex) : ex.status,
      ...(ex.skipReason ? { skipReason: ex.skipReason } : {}),
      sets: ex.sets.filter((s) => s.done).map((s) => ({ reps: s.reps, weight: s.weight, notes: "" })),
    })),
    duration_minutes: durationMinutes,
    general_notes: state.general_notes ?? "",
  };
}

/** localStorage payload → state, or null if it is not one we can trust. */
export function restore(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.version !== VERSION) return null;
  if (!Array.isArray(raw.exercises) || !Array.isArray(raw.warmup) || !Array.isArray(raw.cooldown)) return null;
  if (!raw.cursor || typeof raw.cursor.exercise !== "number" || typeof raw.cursor.set !== "number") return null;
  if (typeof raw.id !== "string" || typeof raw.date !== "string") return null;
  return raw;
}

/**
 * The reasons an exercise gets abandoned, as a CLOSED list.
 *
 * Closed rather than free text for two reasons. It has to be one tap: she is
 * mid-workout, standing up, and a textarea there is a textarea nobody fills.
 * And the reason is read by the coach through `generateExport`, so a stable
 * vocabulary means the model sees the same five words rather than a different
 * phrasing each time.
 *
 * `""` is a real answer — « Sans raison » — and stores no reason at all, which
 * is why `finalize` omits the key rather than writing an empty string.
 */
export const SKIP_REASONS = [
  { id: "fatigue", label: "Fatigue" },
  { id: "douleur", label: "Douleur" },
  { id: "temps", label: "Manque de temps" },
  { id: "materiel", label: "Matériel" },
  { id: "", label: "Sans raison" },
];

/** The French label for a stored skip reason, or `null` if there is none. */
export function skipReasonLabel(id) {
  return SKIP_REASONS.find((r) => r.id === id && r.id !== "")?.label ?? null;
}

/**
 * Which séance the coach is shown: the draft whenever one exists, not only while
 * its screen is up (navigating to the Coach tab closes the screen below xl, and
 * the coach must still see the workout she is in the middle of). Anything that
 * is not a usable draft yields null, so `generateExport` never reads a cursor
 * off a half-formed state.
 *
 * The result carries `current`: is she training NOW? True while the séance
 * screen is open (a draft resumed on a later day, or a séance that crossed
 * midnight, is being done at this moment whatever its date says), or when she
 * last touched the draft TODAY — `activeOn`, stamped by every write-through
 * mutation and by resuming (`stampActive`) — and its screen was closed by
 * NAVIGATION: she is mid-workout, looking at the coach. The stamp, not the
 * start date, is what carries a séance past midnight. A draft she QUIT with the
 * X (`markQuit`) is not current until she resumes it, even today: hours later
 * she is not between two sets, and « en cours » would hold her to the 1-3
 * sentence mid-séance rule. A draft written before the stamp existed falls back
 * to its start date. It is a flag on the returned copy, decided here, so
 * `generateExport` does not re-derive it from the date alone.
 */
export function sessionForCoach(state, seanceOpen = false) {
  if (!state || !Array.isArray(state.exercises) || !state.cursor) return null;
  const lastDay = state.activeOn ?? state.date;
  const current = Boolean(seanceOpen) || (!state.quit && (!lastDay || lastDay === today()));
  return { ...state, current };
}

/** The draft, stamped with the day she last worked on it. Read by `sessionForCoach`. */
export function stampActive(state, day = today()) {
  return state.activeOn === day ? state : { ...state, activeOn: day };
}

/**
 * How the séance screen was closed, kept ON the persisted draft because it must
 * survive the tab being killed. The X (« Quitter la séance ») marks the draft;
 * navigating away does not, since she is still mid-workout and only looking at
 * another tab. Resuming clears the mark and stamps the day (`stampActive`), so
 * a draft from an earlier day that she took up again today stays current when
 * she then navigates away. Read by `sessionForCoach`.
 */
export function markQuit(state) {
  return state.quit ? state : { ...state, quit: true };
}

export function markResumed(state, day = today()) {
  const next = { ...state, activeOn: day };
  delete next.quit;
  return next;
}
