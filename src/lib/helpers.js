import { canonicalExerciseName, isUsableCatalog } from "./catalog.js";

/**
 * Rewrites retired exercise names to their current ones as data comes in.
 *
 * Applied on READ rather than as a one-off migration for two reasons: the cloud
 * copy is not ours to rewrite in place, and a device that has been offline for a
 * month still holds the old names. Because every write goes through state that
 * has already been normalised, it self-migrates on the next save.
 *
 * Load-bearing rather than cosmetic: `computePRs` and `computeLoadStreaks` key
 * their maps on `ex.name`, so an un-normalised rename splits one exercise's
 * history into two and resets its clean-session count to zero.
 *
 * **A missing or empty catalog passes the data through untouched, and that is
 * NOT the runtime fallback the owner ruled out.** That ruling is about the
 * VALIDATORS: one running without a catalog would approve or reject a plan on
 * no evidence — a confident wrong answer. Alias normalisation without a catalog
 * is a NO-OP, not a wrong answer: the names stay as they were written, nothing
 * is lost, and the pass corrects itself the moment the catalog arrives (see the
 * re-normalisation in `useSessionData`'s pull). Turning this into a throw would
 * make the app unusable at first mount on a device that has never synced.
 *
 * @param {unknown} sessions
 * @param {object} catalog - a `buildCatalogViews` result, or null.
 */
export function normalizeSessionNames(sessions, catalog) {
  if (!Array.isArray(sessions)) return sessions;
  if (!isUsableCatalog(catalog)) return sessions;
  return sessions.map((s) =>
    s && Array.isArray(s.exercises)
      ? {
          ...s,
          exercises: s.exercises.map((e) => ({ ...e, name: canonicalExerciseName(e?.name, catalog) })),
        }
      : s
  );
}

/** Same, for the stored plan's sessions — including the pass-through above. */
export function normalizePlanNames(plan, catalog) {
  if (!plan || !Array.isArray(plan.sessions)) return plan;
  if (!isUsableCatalog(catalog)) return plan;
  return {
    ...plan,
    sessions: plan.sessions.map((s) =>
      Array.isArray(s?.exercises)
        ? {
            ...s,
            exercises: s.exercises.map((e) => ({ ...e, name: canonicalExerciseName(e?.name, catalog) })),
          }
        : s
    ),
  };
}

export const generateId = () =>
  `s_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

export const formatDate = (d) =>
  new Date(d).toLocaleDateString("fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

export const formatDateShort = (d) =>
  new Date(d).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });

// Europe/Paris is hardcoded on purpose: one user, in Paris. UTC dated a séance
// logged between 00:00 and 01:59 local time to the previous day.
const PARIS_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" });
export const today = () => PARIS_DATE.format(new Date());

/**
 * Returns the Monday that starts the calendar week containing `date`.
 *
 * Sunday-aware: a Sunday belongs to the week that started the *previous*
 * Monday, not the upcoming one. The naive `getDate() - getDay() + 1` form
 * maps Sunday (getDay() === 0) to the next Monday, which corrupts streaks,
 * weekly-volume buckets and the coach export. Computation is done entirely
 * in UTC so the result is independent of the runtime timezone.
 *
 * @param {string | number | Date} date
 * @returns {Date} UTC-midnight Date of the week's Monday
 */
export function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getUTCDay(); // 0 = Sunday, 1 = Monday, ...
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * The muscle group a name belongs to, read from the catalog document rather
 * than a build-time constant.
 *
 * A DISPLAY consumer, not a validator: `ExerciseInput`'s picker uses this to
 * label its suggestions, and a wrong or invented label there costs nothing
 * beyond a badge — unlike a validator, which would give a confident wrong
 * answer. So a missing/empty catalog returns "" (no badge) rather than
 * "Autre" — "Autre" is a real classification ("this name is in the catalog
 * but in none of its groups") and must not be reused to mean "no catalog to
 * check against yet", which is a different fact and would read as a guess.
 *
 * @param {unknown} name
 * @param {object} catalog - a `buildCatalogViews` result, or null.
 * @returns {string}
 */
export function getExerciseGroup(name, catalog) {
  if (!isUsableCatalog(catalog)) return "";
  for (const [group, exercises] of Object.entries(catalog.muscleGroups)) {
    if (exercises.includes(name)) return group;
  }
  return "Autre";
}
