import { formatDateShort, getWeekStart, today } from "./helpers.js";
import {
  computeStreak,
  computePRs,
  computeWeeklyVolume,
  computeLoadStreaks,
  formatLoadWithUnit,
  formatRepsWithUnit,
} from "./stats.js";
import { generateEquipmentLines } from "../constants/equipment.js";
import { skipReasonLabel } from "./activeSession.js";
import { CLEAN_SESSIONS_BEFORE_LOAD_INCREASE } from "../constants/index.js";
import { filledProfileFields } from "./profileForm.js";
import { resolvePersona } from "./persona.js";

/**
 * Generates a structured export text from recent session data.
 * Sent as context to the in-app coach (coach-chat) so it can reason about
 * The user's recent sessions, records, trends, and per-session notes.
 *
 * `activeSession` is the running séance, when there is one (the séance panel
 * mounts the same coach). Without it, a question asked mid-workout is answered
 * from last week's data.
 */
/**
 * One prescription line — "3×8 à 12kg/main", "3×25 s au poids du corps".
 *
 * Shared by the plan block and the mid-séance block so the number the coach
 * reads is written the same way in both, and a load always carries its
 * per-hand/total marker for the reason `formatLoadWithUnit` exists: a bare
 * 12 kg is ambiguous by a factor of two.
 */
function describePrescription(reps, weight, weightType, metric, setsCount) {
  const volume = metric === "seconds" ? formatRepsWithUnit(String(reps ?? ""), "seconds") : String(reps ?? "?");
  const sets = setsCount ? `${setsCount}×` : "";
  const load = Number(weight) > 0
    ? ` à ${formatLoadWithUnit(Number(weight), weightType)}`
    : " au poids du corps";
  return `${sets}${volume}${load}`;
}

/** DD/MM, with the year when the draft is not from the current year (06/01 is ambiguous a year later). */
function formatDraftDate(date) {
  const d = new Date(date);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("fr-FR", sameYear
    ? { day: "2-digit", month: "2-digit" }
    : { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function generateExport(sessions, profile, currentPlan, activeSession = null) {
  const sorted = [...sessions].sort((a, b) => new Date(b.date) - new Date(a.date));
  const recent = sorted.slice(0, 10);
  const now = new Date();

  // Date range for the export
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const periodStart = formatDateShort(weekAgo);
  const periodEnd = formatDateShort(now);

  const lines = [];
  lines.push("=== FITTRACK EXPORT ===");
  lines.push(`Période : ${periodStart} → ${periodEnd}`);
  lines.push("");

  // A séance in progress. Without this, "comment je me débrouille ?" asked
  // mid-workout is answered from last week's data.
  if (activeSession) {
    const total = activeSession.exercises.length;
    // A draft never expires, so one quit on Monday is still here on Thursday.
    // Labelled « EN COURS » it would be presented as today's workout; a draft
    // she is not doing now says so, and no longer matches the prompt's
    // mid-séance brevity rule (which keys on « SÉANCE EN COURS » alone).
    // `current` is decided by `sessionForCoach` (screen open, or last worked on today and not quit with the X).
    // Without it — a direct caller — fall back to the date alone.
    const current = activeSession.current ?? (!activeSession.date || activeSession.date === today());
    const heading = current
      ? "SÉANCE EN COURS"
      : `SÉANCE COMMENCÉE LE ${formatDraftDate(activeSession.date)}, NON TERMINÉE`;
    lines.push(`${heading} : ${activeSession.name} — exercice ${Math.min(activeSession.cursor.exercise + 1, total)}/${total}`);
    activeSession.exercises.forEach((ex) => {
      const done = ex.sets.filter((s) => s.done);
      if (ex.status === "skipped") {
        const why = skipReasonLabel(ex.skipReason);
        lines.push(`- ${ex.name} : passé (non réalisé)${why ? ` — ${why.toLowerCase()}` : ""}`);
      } else if (done.length) {
        const detail = done
          .map((s) =>
            ex.metric === "seconds"
              ? formatRepsWithUnit(s.reps, "seconds")
              : `${s.reps} × ${formatLoadWithUnit(Number(s.weight) || 0, ex.weightType)}`
          )
          .join(", ");
        lines.push(`- ${ex.name} : ${detail}`);
      } else {
        // `à venir` used to be the whole line. The prescription was sitting in
        // `plannedWeight`/`plannedReps` and was thrown away — so when the user asked
        // « je fais quoi ? » mid-séance, the coach had no load for the exercise
        // in front of her and answered from the streak block instead. That is
        // the whole of a 12 kg / 14 kg contradiction.
        lines.push(`- ${ex.name} : à venir — prévu ${describePrescription(ex.plannedReps, ex.plannedWeight, ex.weightType, ex.metric)}`);
      }
    });
    lines.push("");
  }

  // Where the plan's week sits relative to today, computed once for both the
  // prescription block and the adherence block: a plan imported ahead of its
  // week is not « en cours », and one whose week is over is the previous plan.
  // A stored plan without dates is treated as current (planFromJson accepts a
  // null weekStart).
  const planHasRange = Boolean(currentPlan?.weekStart && currentPlan?.weekEnd);
  const todayISO = today();
  const phase = !planHasRange ? "current"
    : todayISO < currentPlan.weekStart ? "upcoming"
    : todayISO > currentPlan.weekEnd ? "previous"
    : "current";
  const planRange = planHasRange
    ? ` (${formatDateShort(currentPlan.weekStart)} → ${formatDateShort(currentPlan.weekEnd)})`
    : "";

  // THE PLAN ITSELF. Until 2026-08-23 this block did not exist: the export
  // carried history, records, streaks and adherence COUNTS, but never the
  // prescriptions — so the coach could not read the week it had written, and
  // `collapsePlan` had already removed it from the transcript on the stated
  // grounds that "generateExport ships the CURRENT plan on every request",
  // which was simply not true. Measured consequence: asked what load to use
  // mid-séance, the coach answered 14 kg from the streak block while the user was
  // looking at a plan that said 12 kg, and she read that as incoherence.
  //
  // Deliberately prose, never JSON: a JSON block here would re-teach the
  // payload format exactly as plan payloads in history once did.
  if (currentPlan && currentPlan.sessions?.length > 0) {
    // Only « EN COURS » is what the user does today. The other two keep the stable
    // prefix « PROGRAMME DE LA SEMAINE » (the prompt names the block by it) but
    // say so, or an upcoming or finished week reads as today's prescription.
    const who = resolvePersona(profile).name;
    const heading = phase === "upcoming"
      ? `PROGRAMME DE LA SEMAINE À VENIR (pas commencée)${planRange} — prévu pour plus tard, ce n'est PAS ce que ${who} fait aujourd'hui :`
      : phase === "previous"
        ? `PROGRAMME DE LA SEMAINE PRÉCÉDENTE (terminée)${planRange} — périmé, ce n'est plus une consigne :`
        : `PROGRAMME DE LA SEMAINE EN COURS${planRange} — c'est CE QUI EST PRESCRIT, et ce que ${who} a sous les yeux :`;
    lines.push(heading);
    currentPlan.sessions.forEach((planned, i) => {
      lines.push(`Séance ${i + 1} — ${planned.name}`);
      (planned.exercises ?? []).forEach((pex) => {
        const note = pex.progressionNote ? ` — ${pex.progressionNote}` : "";
        lines.push(`- ${pex.name} : ${describePrescription(pex.reps, pex.weight, pex.weightType, pex.metric, pex.setsCount)}${note}`);
      });
    });
    lines.push("");
  }

  // Recent sessions
  lines.push("SÉANCES RÉCENTES :");
  lines.push("");
  if (recent.length === 0) {
    lines.push("Aucune séance enregistrée.");
  } else {
    recent.forEach(s => {
      const duration = s.duration_minutes ? ` (${s.duration_minutes} min)` : "";
      lines.push(`📅 ${formatDateShort(s.date)} — ${s.name}${duration}`);
      s.exercises.forEach(ex => {
        // `status` was read for the ACTIVE séance only, so a skipped exercise
        // reached the coach here as `- Dead hang : 0×()` — an empty
        // parenthesis it had to guess at. The three-way status exists precisely
        // because "she skipped it" and "it never existed" are different facts,
        // and that distinction was being thrown away the moment the séance
        // finished.
        if (ex.status === "skipped") {
          const why = skipReasonLabel(ex.skipReason);
          lines.push(`- ${ex.name} : passé (non réalisé)${why ? ` — ${why.toLowerCase()}` : ""}`);
          return;
        }
        const wtSuffix = ex.weightType === "per_hand" ? "/main" : "";
        const setDetails = ex.sets
          .map(set => {
            const w = set.weight ? ` @ ${set.weight}kg${wtSuffix}` : "";
            // `45sreps` was reaching the coach as its own evidence about what
            // she did. The unit is a field now, so it is rendered from it.
            const volume = ex.metric === "seconds" ? formatRepsWithUnit(set.reps, "seconds") : `${set.reps}reps`;
            return `${volume}${w}`;
          })
          .join(", ");
        // A partial exercise is not a complete one, and the coach reading a
        // shorter line has no way to tell the difference on its own.
        const partial = ex.status === "partial" ? " — partiel" : "";
        lines.push(`- ${ex.name} : ${ex.sets.length}×(${setDetails})${partial}`);
      });
      if (s.general_notes) {
        lines.push(`Notes : ${s.general_notes}`);
      }
      lines.push("");
    });
  }

  // Personal records (top 10 by weight)
  const prs = computePRs(sessions);
  const topPrs = Object.entries(prs)
    .filter(([, pr]) => pr.weight > 0)
    .sort((a, b) => b[1].weight - a[1].weight)
    .slice(0, 10);

  if (topPrs.length > 0) {
    lines.push("RECORDS PERSONNELS (top 10) :");
    topPrs.forEach(([name, pr]) => {
      lines.push(`- ${name} : ${formatLoadWithUnit(pr.weight, pr.weightType)} (${formatDateShort(pr.date)})`);
    });
    lines.push("");
  }

  // Held exercises keep their OWN records block rather than being mixed into
  // the list above, which is sorted by kilograms and filtered on `weight > 0`.
  // A duration and a load are not comparable quantities, and sorting seconds
  // among kilograms would put a 45-second plank above a 15 kg squat.
  const holdPrs = Object.entries(prs)
    .filter(([, pr]) => pr.metric === "seconds" && pr.seconds > 0)
    .sort((a, b) => b[1].seconds - a[1].seconds)
    .slice(0, 10);

  if (holdPrs.length > 0) {
    lines.push("RECORDS DE MAINTIEN (top 10) :");
    holdPrs.forEach(([name, pr]) => {
      lines.push(`- ${name} : ${formatRepsWithUnit(String(pr.seconds), "seconds")} (${formatDateShort(pr.date)})`);
    });
    lines.push("");
  }

  // Progression evidence: how long each exercise has sat at its current load.
  // Supplied so the coach can apply the "N sessions before an increase" rule
  // as a JUDGEMENT rather than guessing — deliberately not enforced by any
  // validator, because whether a load is ready to move is contextual.
  const loadStreaks = computeLoadStreaks(sessions);
  const streakLines = Object.entries(loadStreaks)
    .filter(([, streak]) => streak.load > 0)
    .sort((a, b) => b[1].sessions - a[1].sessions || (a[0] < b[0] ? -1 : 1))
    .map(
      ([name, streak]) =>
        `- ${name} : ${formatLoadWithUnit(streak.load, streak.weightType)} depuis ${streak.sessions} séance` +
        `${streak.sessions > 1 ? "s" : ""} (depuis le ${formatDateShort(streak.since)})`
    );

  if (streakLines.length > 0) {
    lines.push(`SÉANCES PROPRES À LA CHARGE ACTUELLE (repère pour la règle des ${CLEAN_SESSIONS_BEFORE_LOAD_INCREASE} séances) :`);
    lines.push(...streakLines);
    lines.push("");
  }

  // Trends (calendar weeks, Sunday-aware — consistent with the progression charts)
  const thisMonday = getWeekStart(today()).toISOString().split("T")[0];
  const prevMondayDate = getWeekStart(today());
  prevMondayDate.setUTCDate(prevMondayDate.getUTCDate() - 7);
  const prevMonday = prevMondayDate.toISOString().split("T")[0];

  const weekOf = (s) => getWeekStart(s.date).toISOString().split("T")[0];
  const thisWeekSessions = sessions.filter(s => weekOf(s) === thisMonday);

  const weekly = computeWeeklyVolume(sessions);
  const thisVol = weekly.find(w => w.weekStart === thisMonday)?.volume || 0;
  const lastVol = weekly.find(w => w.weekStart === prevMonday)?.volume || 0;
  const volChange = lastVol > 0 ? Math.round(((thisVol - lastVol) / lastVol) * 100) : 0;

  // Streak (consecutive calendar weeks with activity)
  const streak = computeStreak(sessions);

  // Plateau detection: exercises where max weight hasn't increased in 3+ sessions
  // Use Object.create(null) so prototype-named exercises (e.g. "valueOf") don't
  // collide with inherited properties and cause a crash.
  const exerciseHistory = Object.create(null);
  sorted.forEach(s => {
    s.exercises.forEach(ex => {
      if (!Object.prototype.hasOwnProperty.call(exerciseHistory, ex.name)) exerciseHistory[ex.name] = [];
      const maxW = Math.max(...ex.sets.map(set => Number(set.weight) || 0));
      exerciseHistory[ex.name].push({ date: s.date, maxWeight: maxW });
    });
  });

  const plateaus = [];
  Object.entries(exerciseHistory).forEach(([name, history]) => {
    if (history.length >= 3) {
      const lastThree = history.slice(0, 3);
      const maxWeights = lastThree.map(h => h.maxWeight);
      if (maxWeights[0] === maxWeights[1] && maxWeights[1] === maxWeights[2] && maxWeights[0] > 0) {
        const weeks = Math.ceil(
          (new Date(lastThree[0].date) - new Date(lastThree[lastThree.length - 1].date)) / (7 * 86400000)
        );
        plateaus.push(`${name} (${maxWeights[0]}kg depuis ${Math.max(weeks, 2)} semaines)`);
      }
    }
  });

  lines.push("TENDANCES :");
  lines.push(`- Volume hebdo : ${thisVol.toLocaleString()} kg${volChange !== 0 ? ` (${volChange > 0 ? "+" : ""}${volChange}% vs semaine précédente)` : ""}`);
  lines.push(`- Séances cette semaine : ${thisWeekSessions.length}`);
  lines.push(`- Streak : ${streak} semaine${streak > 1 ? "s" : ""} consécutive${streak > 1 ? "s" : ""}`);
  if (plateaus.length > 0) {
    lines.push(`- Plateaux détectés : ${plateaus.join(", ")}`);
  }
  lines.push("");

  // Plan adherence (if there's a current plan)
  const planSessions = currentPlan?.sessions ?? [];
  if (planSessions.length > 0) {
    // Scored against the PLAN's own week, never the calendar week: a plan
    // imported on Sunday for next week read as « 0/4 » against a week that
    // had not started. A stored plan without dates falls back to the calendar
    // week (planFromJson accepts a null weekStart).
    const planWeekSessions = planHasRange
      ? sessions.filter(s => s.date >= currentPlan.weekStart && s.date <= currentPlan.weekEnd)
      : thisWeekSessions;
    const plannedCount = planSessions.length;
    const doneCount = planWeekSessions.length;

    // `phase` (computed above) says where the plan's week sits relative to
    // today. A plan imported ahead of its week is not "en cours" and has no
    // score to report; one whose week is over is the previous plan, scored as such.
    if (phase === "upcoming") {
      lines.push(`ADHÉRENCE AU PROGRAMME À VENIR (pas commencée)${planRange} :`);
      lines.push(`- ${plannedCount} séances prévues, aucune à scorer pour l'instant`);
      lines.push("");
    } else {
      lines.push(`ADHÉRENCE AU PROGRAMME DE LA SEMAINE ${phase === "previous" ? "PRÉCÉDENTE" : "EN COURS"}${planRange} :`);
      lines.push(`- ${Math.min(doneCount, plannedCount)}/${plannedCount} séances réalisées`);

      // Check target weights vs actual
      const hits = [];
      const misses = [];
      planSessions.forEach(planned => {
        (planned.exercises ?? []).forEach(pex => {
          // Find matching actual exercise in the plan's week
          for (const s of planWeekSessions) {
            const actual = (s.exercises ?? []).find(e => e.name === pex.name);
            if (actual) {
              // A held exercise is scored on TIME, not on kilograms: both loads
              // are 0, so `0 >= 0` reported a 5-second plank against a planned
              // 45 s as a target met.
              if (pex.metric === "seconds" || actual.metric === "seconds") {
                const plannedS = Number(pex.reps) || 0;
                const actualS = Math.max(0, ...actual.sets.map(set => Number(String(set.reps).replace(",", ".")) || 0));
                if (actualS >= plannedS) hits.push(pex.name);
                else misses.push(`${pex.name} (cible ${plannedS} s, fait ${actualS} s)`);
                break;
              }
              // `Math.max()` of nothing is -Infinity, and a skipped exercise
              // stores `sets: []` — which reported « fait -Infinitykg » to the
              // coach. The seed makes it 0, which is what "she lifted nothing"
              // actually means.
              const actualMax = Math.max(0, ...actual.sets.map(set => Number(set.weight) || 0));
              if (actualMax >= pex.weight) {
                hits.push(pex.name);
              } else {
                misses.push(`${pex.name} (cible ${pex.weight}kg, fait ${actualMax}kg)`);
              }
              break;
            }
          }
        });
      });

      const total = hits.length + misses.length;
      if (total > 0) {
        lines.push(`- Cibles atteintes : ${hits.length}/${total} exercices`);
        if (misses.length > 0) {
          lines.push(`- Cibles manquées : ${misses.join(", ")}`);
        }
      }
      lines.push("");
    }
  }

  // Profile summary
  lines.push("PROFIL :");
  // A field she cleared or left blank is left out — never « nullkg », « - , »
  // or a dangling « fréquence : ». A line with nothing left in it is dropped.
  const line = (parts) => { if (parts.length) lines.push(`- ${parts.join(", ")}`); };
  line(filledProfileFields(profile, {
    name: (v) => `${v}`, age: (v) => `${v} ans`, height: (v) => `${v}cm`, weight: (v) => `${v}kg`,
  }));
  line(filledProfileFields(profile, {
    experience: (v) => `Expérience : ${v}`, frequency: (v) => `fréquence : ${v}`,
  }));
  lines.push(`- Équipement : ${generateEquipmentLines(profile?.inventory).join(", ")}`);
  line(filledProfileFields(profile, { goals: (v) => `Objectifs : ${v}` }));
  line(filledProfileFields(profile, { priorities: (v) => `Priorités : ${v}` }));

  return lines.join("\n");
}
