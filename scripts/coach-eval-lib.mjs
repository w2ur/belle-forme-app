// Pure parts of the coach eval harness, split out so they can be unit-tested
// without a network, a key or a database.
import { createNotebookSplitter } from "../netlify/functions/lib/notebookStream.js";
import { cleanVisibleReply } from "../src/lib/coachStream.js";
import { normalizeSessionNames, normalizePlanNames } from "../src/lib/helpers.js";

/**
 * The harness flags. `--claude-effort` takes only what Opus/Sonnet 5.5 accept
 * (thinking cannot be turned off on them, so "none" would be a 400), so a typo
 * fails here, not as a run of 400s scored as model failures.
 */
export function parseArgs(argv) {
  const out = { planEmit: false, claudeEffort: null };
  for (const a of argv) {
    if (a === "--plan-emit") out.planEmit = true;
    else if (a.startsWith("--claude-effort=")) {
      const v = a.slice("--claude-effort=".length);
      if (!["low", "medium", "high", "xhigh", "max"].includes(v)) throw new Error(`--claude-effort must be low, medium, high, xhigh or max, not "${v}"`);
      out.claudeEffort = v;
    } else throw new Error(`unknown argument "${a}"`);
  }
  return out;
}

/** Median of a list of numbers, or null for an empty list (never 0). */
export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * Separates the visible reply from the `<<<NOTEBOOK>>> … <<<END>>>` trailer with
 * the SAME functions coach-chat.js uses: the notebook splitter, then
 * cleanVisibleReply. `trailer` is the closed block's body, or "" if none.
 */
export function splitReply(reply) {
  const splitter = createNotebookSplitter();
  const visible = splitter.push(reply) + splitter.end();
  return { visible: cleanVisibleReply(visible), trailer: splitter.notebook() || "" };
}

/**
 * Maps rows to the objects the client holds, mirroring the pull-and-reconcile
 * in src/hooks/useSessionData.js (the mapping is inline there, not exported).
 * `planRow` is the newest row of `plans`; `profileRow` the `profile` id=1 row.
 */
export function mapRows(rows, catalogViews) {
  // The client receives these rows as JSON (Dates arrive as ISO strings); the
  // round trip reproduces that wire form from the driver's Date objects.
  const { sessionRows, planRow, profileRow } = JSON.parse(JSON.stringify(rows));
  const sessions = normalizeSessionNames(
    (sessionRows || []).map((s) => ({
      id: s.id,
      date: String(s.date).split("T")[0],
      name: s.name,
      ...s.data,
    })),
    catalogViews
  );
  let plan = null;
  if (planRow) {
    let ws = planRow.week_start;
    let we = planRow.week_end;
    if (ws && we) {
      const wsStr = typeof ws === "string" ? ws : new Date(ws).toISOString().split("T")[0];
      const weStr = typeof we === "string" ? we : new Date(we).toISOString().split("T")[0];
      we = weStr < wsStr ? wsStr.slice(0, 4) + weStr.slice(4) : weStr;
      ws = wsStr;
    }
    plan = normalizePlanNames({ weekStart: ws, weekEnd: we, ...planRow.data, raw: planRow.raw }, catalogViews);
  }
  return { sessions, plan, profile: profileRow?.data ?? null };
}

const ROWING = /rowing/i;

/** Her last logged rowing top weight (most recent session first), or null. */
export function lastLoggedRowingWeight(sessions) {
  const sorted = [...(sessions || [])].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  for (const s of sorted) {
    for (const ex of s.exercises || []) {
      if (!ROWING.test(ex.name || "")) continue;
      const sets = Array.isArray(ex.sets) ? ex.sets : [];
      const w = sets.reduce((m, st) => Math.max(m, Number(st.weight) || 0), 0);
      if (w > 0) return w;
    }
  }
  return null;
}

/**
 * Derives the rowing case from the stored plan: X = planned weight, Y = her last
 * logged rowing weight if it differs, else X+1. No rowing line in the plan means
 * no case — returns { skip: true, note }, never an invented number.
 */
export function deriveRowingCase(plan, sessions) {
  const line = (plan?.sessions || []).flatMap((s) => s.exercises || []).find((e) => ROWING.test(e.name || "") && Number(e.weight) > 0);
  if (!line) return { id: "rowing-planned-vs-other", skip: true, note: "no rowing exercise with a weight in the current plan" };
  const planned = Number(line.weight);
  const logged = lastLoggedRowingWeight(sessions);
  const other = logged && logged !== planned ? logged : planned + 1;
  const num = (n) => String(n).replace(".", "[.,]");
  return {
    id: "rowing-planned-vs-other",
    message: `Le rowing c'est ${planned} ou ${other} ?`,
    mode: "discussion",
    planned,
    other,
    why: `the stored plan governs today (owner ruling): answer its number (${planned}) and cite the plan`,
    check: (r) => new RegExp(`(^|[^\\d.,])${num(planned)}(?![\\d]|[.,]\\d)`).test(r) && /(plan|programme|prévu)/i.test(r),
  };
}

/**
 * The harness exit code, per the portfolio's 0/1/2 convention: 0 healthy,
 * 1 a finding, 2 could not run. `outcomes` are `{ errored, failed }` per
 * request that was actually sent (skipped cases are not included).
 *
 * A FAILURE COUNTS ONLY ON A MEASURED OUTCOME. An errored request carries
 * `failed: true` (no reply cannot pass), but it measured nothing about the
 * model, so it never makes a finding: exiting 1 would read as "the models
 * failed the cases". So: 1 if any measured request failed; otherwise 2 if any
 * request errored (part of the run is unknown, and "healthy" cannot be
 * claimed over it) or nothing ran at all; 0 only when every request was
 * measured and passed.
 */
export function evalExitCode(outcomes) {
  const measured = outcomes.filter((o) => !o.errored);
  if (measured.some((o) => o.failed)) return 1;
  if (!outcomes.length || measured.length < outcomes.length) return 2;
  return 0;
}

/**
 * Why a run exited 2, for stderr — null on 0 and 1. The two causes need
 * different fixes (a case list that skipped everything vs a key, quota or
 * vendor error), so one message for both sent the reader to the wrong one.
 */
export function evalExitReason(outcomes) {
  if (evalExitCode(outcomes) !== 2) return null;
  if (!outcomes.length) return "no request was sent (every case skipped?): the run is unknown, not healthy";
  const errored = outcomes.filter((o) => o.errored).length;
  return `${errored} of ${outcomes.length} requests errored and no measured case failed: the run is unknown, not healthy`;
}
