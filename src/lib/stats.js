import { getWeekStart } from "./helpers.js";

/**
 * Shared session statistics.
 *
 * These helpers were previously duplicated (~45 lines) between the
 * progression tab (removed) and `planExport.js`, each with its own copy of
 * the buggy Sunday week-bucketing. Centralising them here keeps the coach
 * export on calendar weeks.
 */

/** ISO date (YYYY-MM-DD) of the Monday that starts the week containing `date`. */
function weekKey(date) {
  return getWeekStart(date).toISOString().split("T")[0];
}

/**
 * Total training volume (Σ reps × weight over every set) for one session.
 *
 * Holds (`metric: "seconds"`) are skipped: seconds × kg is not a tonnage.
 * A `per_hand` weight counts twice, since both hands carry it.
 */
export function sessionVolume(session) {
  return session.exercises.reduce((sum, ex) => {
    if (ex.metric === "seconds") return sum;
    const factor = ex.weightType === "per_hand" ? 2 : 1;
    return (
      sum +
      ex.sets.reduce(
        (ss, set) =>
          ss + (Number(set.reps) || 0) * (Number(set.weight) || 0) * factor,
        0
      )
    );
  }, 0);
}

/**
 * Buckets sessions into calendar weeks and sums their volume.
 * @returns {{ weekStart: string, volume: number }[]} chronological order
 */
export function computeWeeklyVolume(sessions) {
  const buckets = new Map();
  sessions.forEach((s) => {
    const key = weekKey(s.date);
    buckets.set(key, (buckets.get(key) || 0) + sessionVolume(s));
  });
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([weekStart, volume]) => ({ weekStart, volume }));
}

/**
 * Number of consecutive calendar weeks (up to and including the most recent
 * one with activity) that contain at least one session.
 */
export function computeStreak(sessions) {
  const weekSet = new Set();
  sessions.forEach((s) => weekSet.add(weekKey(s.date)));

  const sortedWeeks = [...weekSet].sort().reverse();
  let streak = 0;
  for (let i = 0; i < sortedWeeks.length; i++) {
    if (i === 0) {
      streak = 1;
      continue;
    }
    const prev = new Date(sortedWeeks[i - 1]);
    const curr = new Date(sortedWeeks[i]);
    if ((prev - curr) / 86400000 <= 8) streak++;
    else break;
  }
  return streak;
}

/**
 * How long each exercise has been sitting at its CURRENT load: walking back
 * from the most recent session, the number of consecutive sessions that used
 * the same top weight, and the date that run started.
 *
 * Exists so the coach can apply the progression rule ("N sessions at a load
 * before increasing it", `CLEAN_SESSIONS_BEFORE_LOAD_INCREASE`) instead of
 * guessing. Without this number the model could not distinguish a deliberate
 * consolidation from a plateau, so it defaulted to "on consolide par
 * précaution" — which reads as stagnation.
 *
 * Counts CLEAN sessions since mode séance: an exercise that was skipped or
 * left part-way carries `status: "skipped"`/`"partial"` and breaks the run
 * instead of counting toward it (issue #4 T5.2). It is still not a statement
 * about execution quality inside a completed exercise — a set she barely
 * finished is recorded like any other — so the prompt still tells the coach to
 * ask rather than assume when that matters.
 *
 * Sessions recorded BEFORE mode séance carry no `status` at all and count as
 * clean. The alternative resets every counter to zero on the day this ships,
 * and the coach concludes she has been stuck at every weight from the start.
 *
 * The run breaks on ANY change of top weight, up or down — a drop then a
 * return to the old load restarts the count rather than resuming it.
 *
 * @returns {Object<string, { load: number, weightType: "per_hand"|"total", sessions: number, since: string }>}
 */
export function computeLoadStreaks(sessions) {
  const sorted = [...(Array.isArray(sessions) ? sessions : [])]
    .filter((s) => s && Array.isArray(s.exercises))
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  // Object.create(null): an exercise named "valueOf" or "toString" would
  // otherwise read back Object.prototype's method instead of the entry.
  const streaks = Object.create(null);
  const broken = new Set();

  sorted.forEach((session) => {
    session.exercises.forEach((ex) => {
      if (!ex || typeof ex.name !== "string") return;
      const sets = Array.isArray(ex.sets) ? ex.sets : [];
      if (sets.length === 0) return; // no sets recorded -> no evidence of a load

      // A run of clean sessions is the input to the "N sessions before an
      // increase" rule. `status` arrived with mode séance; sessions recorded
      // before it have none, and must count — otherwise every existing
      // counter silently resets to zero.
      if (ex.status === "skipped" || ex.status === "partial") {
        broken.add(ex.name);
        return;
      }

      const load = sets.reduce((max, set) => Math.max(max, Number(set.weight) || 0), 0);
      const existing = Object.prototype.hasOwnProperty.call(streaks, ex.name) ? streaks[ex.name] : null;

      if (!existing) {
        streaks[ex.name] = {
          load,
          weightType: ex.weightType === "per_hand" ? "per_hand" : "total",
          sessions: 1,
          since: session.date,
        };
        return;
      }

      if (broken.has(ex.name)) return;
      if (Math.abs(existing.load - load) > 1e-6) {
        broken.add(ex.name);
        return;
      }

      existing.sessions += 1;
      existing.since = session.date; // the run's oldest session so far
    });
  });

  return streaks;
}

/**
 * Best (heaviest) recorded set per exercise.
 *
 * `weightType` is carried through from the exercise entry that SET the record,
 * not inferred from the catalog. The coach export renders records as load
 * evidence, and a bare "17kg" is ambiguous by a factor of two — 17 kg in each
 * hand and 17 kg in total are both plausible readings of the same record, and
 * the wrong one propagates straight into the next prescribed load.
 *
 * @returns {Object<string, { weight: number, weightType: "per_hand"|"total", date: string }>}
 */
export function computePRs(sessions) {
  // Use Object.create(null) so prototype-named exercises (e.g. "valueOf") don't
  // collide with inherited properties and produce incorrect or missing PRs.
  const prs = Object.create(null);
  sessions.forEach((s) => {
    s.exercises.forEach((ex) => {
      // A skipped exercise carries no sets (mode séance records those
      // explicitly), and Math.max() of an empty array is -Infinity. Without
      // this guard an exercise that was only ever skipped sits in the map as a
      // record of -Infinity, which JSON.stringify turns into null and every
      // reader — export, sync, UI — takes for a real entry.
      if (!Array.isArray(ex.sets) || ex.sets.length === 0) return;

      const existing = Object.prototype.hasOwnProperty.call(prs, ex.name) ? prs[ex.name] : null;

      // A held exercise progresses in TIME, and its weight is 0 forever — so
      // reading `weight` for it records no progress at all. That was the state
      // of things until 2026-08-23: the user's stated objective is a pull-up and
      // the coach's whole progression for it is « Dead Hang 20s → 25s → 30s »,
      // none of which the app could see or credit.
      if (ex.metric === "seconds") {
        const maxS = Math.max(...ex.sets.map((set) => Number(String(set.reps).replace(",", ".")) || 0));
        // A weight record that carries a real number is left alone: it is
        // information, and this one is not. A 0 kg "record" is explicitly not a
        // record anywhere in this codebase, so a duration replaces it — that is
        // what an exercise logged before the migration looks like.
        const beats = !existing || (existing.metric === "seconds" ? maxS > existing.seconds : !(existing.weight > 0));
        if (beats) prs[ex.name] = { metric: "seconds", seconds: maxS, date: s.date };
        return;
      }

      const maxW = Math.max(...ex.sets.map((set) => Number(set.weight) || 0));
      // Deliberately compared against `existing.weight`, which is `undefined`
      // on a duration entry — so `maxW > undefined` is false and a real
      // duration record is never clobbered by a 0 kg reading of the same
      // exercise from a session recorded before the migration.
      if (!existing || maxW > existing.weight) {
        prs[ex.name] = {
          weight: maxW,
          weightType: ex.weightType === "per_hand" ? "per_hand" : "total",
          date: s.date,
        };
      }
    });
  });
  return prs;
}

/**
 * Renders a load with an EXPLICIT per-hand/total marker.
 *
 * The plan format treats a bare weight as "total" by convention, which is fine
 * on an exercise line the coach itself wrote. It is not fine in the export,
 * where the same bare number is the coach's evidence about what the user can
 * actually lift: "Squat : 17kg" reads as either 17 kg total or 17 kg in each
 * hand, and only one of those is a load she has ever handled. Always suffixed
 * here, never left to convention.
 */
export function formatLoadWithUnit(weightKg, weightType) {
  return `${weightKg}kg${weightType === "per_hand" ? "/main" : " total"}`;
}

/**
 * A session's volume for display. Pinned to fr-FR, since a bare toLocaleString()
 * follows the device locale. The unit takes the same narrow no-break space
 * (U+202F) as the thousands separator: in the mono face an ordinary space is
 * twice as wide, so « 2 816 kg » read with a gap before the unit twice the
 * separator's.
 */
export function formatVolume(kg) {
  return `${kg.toLocaleString("fr-FR")}\u202Fkg`;
}

/**
 * A RECORDED set's load for display, or "" when there is nothing to show.
 *
 * Sets are stored with `weight: ""` at bodyweight, and sessions recorded before
 * `weightType` existed carry none: `formatLoadWithUnit` would print « kg total »
 * or « 0kg total » for the first and invent a « total » convention for the
 * second. A legacy set gets the bare number, since its convention is unknown.
 */
export function formatRecordedLoad(weight, weightType) {
  const w = Number(weight);
  if (!(w > 0)) return "";
  if (weightType !== "per_hand" && weightType !== "total") return `${w}kg`;
  return formatLoadWithUnit(w, weightType);
}

/**
 * A prescribed or recorded volume, with the unit `metric` says it carries.
 *
 * The unit stopped living inside the value on 2026-08-23 — a hold is stored as
 * `"45"` with `metric: "seconds"` beside it — so every surface that renders a
 * count has to put it back, or a 45-second dead hang reads as 45 repetitions.
 * One function so `WeeklyPlan`, `PlanCard`, `SessionDetail` and the coach's
 * own export cannot drift apart on it, exactly as `formatLoadWithUnit` keeps
 * the weight convention in one place.
 *
 * A value that is not a bare number is passed through untouched: `"30-40min"`
 * carries its own unit already, and appending another would read `30-40min s`.
 */
export function formatRepsWithUnit(reps, metric) {
  const raw = String(reps ?? "");
  if (metric !== "seconds") return raw;
  return /^\s*\d+([.,]\d+)?\s*$/.test(raw) ? `${raw.trim()} s` : raw;
}

/**
 * The `"3×45"` display string with its unit — `"3×45 s"`. Splits on the ×
 * rather than re-deriving, because `sets` is already the one derived string
 * (`formatSets`, `planFromJson.js`) and building a second one here would be
 * the two-sources-for-one-fact problem this project keeps paying for.
 */
export function formatSetsWithUnit(sets, metric) {
  const raw = String(sets ?? "");
  if (metric !== "seconds") return raw;
  const [count, ...rest] = raw.split("×");
  if (rest.length === 0) return raw;
  return `${count}×${formatRepsWithUnit(rest.join("×"), metric)}`;
}
