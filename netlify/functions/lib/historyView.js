import { isPlanPayload, planFromJson } from "../../../src/lib/planFromJson.js";
import { stripEchoedAnnotation } from "../../../src/lib/coachStream.js";

/**
 * Renders raw `coach_messages` rows as the history the MODEL sees.
 *
 * Three problems this fixes, all reported by the user on 2026-08-05 and none of them
 * fixable in the prompt:
 *
 * 1. **The transcript had no clock.** `loadRecentMessages` selected role and
 *    content only, so forty messages spanning a week arrived as one unbroken
 *    conversation and the coach picked four-day-old turns back up as live.
 * 2. **Sessions were invisible.** A gap of days looked identical to a gap of
 *    seconds.
 * 3. **Unanswered questions looked open.** coach-chat banks her message before
 *    the stream is consumed, so any reply that produced no visible text leaves
 *    her question in the transcript with nothing after it, permanently. A model
 *    reading that quite reasonably answers it.
 *
 * Deliberately does NOT drop turns — the count, the order and every role are
 * preserved, and her words are never altered beyond a prefix. Dropping turns is
 * the regression raising HISTORY_WINDOW from 15 to 40 was fixing.
 *
 * Pure. No I/O, no clock of its own: gaps are computed between consecutive rows,
 * and the absolute "today" grounding lives in the volatile block that
 * `buildMessages` assembles.
 */

/**
 * A gap this long or longer starts a new conversation. Six hours means a morning
 * and an evening exchange are marked as separate, which is correct — they are
 * different contexts, and the marker states the real elapsed time either way.
 */
export const SESSION_GAP_HOURS = 6;

/**
 * Marks a question that never got an answer. Worded as an instruction because
 * the alternative — leaving it bare — is what had the coach answering it.
 */
export const ORPHAN_NOTE = "[restée sans réponse — n'y reviens pas sauf si la question est reposée]";

/**
 * Europe/Paris, explicitly. The edge runtime is UTC; without the zone every
 * stamp is two hours early in summer and a late-evening exchange gets dated to
 * the wrong day — which is precisely the confusion this module exists to remove.
 */
const STAMP = new Intl.DateTimeFormat("fr-FR", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Paris",
});

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

/**
 * A stored plan payload reaches the model as one line, never as JSON.
 *
 * This is what makes the mode split hold. The format was never learned from the
 * prompt — it was learned from HISTORY: 40 messages of transcript saturated with
 * plan blocks, which is why discussion mode kept emitting programmes even after
 * the format was removed from its prompt (production #84, 2026-08-10: a message
 * about ironing and a walk answered with a full four-session week). Let JSON
 * payloads accumulate here and they will teach the new format exactly the same
 * way.
 *
 * Assistant turns only — a user turn is never collapsed however JSON-shaped it
 * looks, since it is her actual words, not a stored plan.
 *
 * Nothing is lost: generateExport ships the CURRENT plan on every request. What
 * goes is a pile of superseded copies.
 */
function collapsePlan(content) {
  if (isPlanPayload(content)) {
    const { plan } = planFromJson(content);
    const count = plan?.sessions?.length ?? 0;
    const [, m, d] = (plan?.weekStart || "").split("-");
    const week = m && d ? ` du ${d}/${m}` : "";
    return `[programme émis : ${count} séance${count === 1 ? "" : "s"}, semaine${week}]`;
  }
  if (looksLikeTruncatedPlanFragment(content)) {
    return TRUNCATED_PLAN_MARKER;
  }
  const legacy = collapseLegacyPlan(content);
  if (legacy !== null) return legacy;
  return content;
}

/** Stands in for an `=== FITTRACK PLAN ===` block. See `collapseLegacyPlan`. */
const LEGACY_PLAN_MARKER = "[programme émis (ancien format, abandonné)]";

/**
 * The old text format's header, anchored to a LINE OF ITS OWN.
 *
 * Anchored rather than matched anywhere, which is the same guard
 * `coachInstructionsDoc.test.js` uses on the doc: a reply that merely *mentions*
 * the string in a sentence — explaining what replaced it, say — must not have
 * everything after it swallowed. A real block always put the header on its own
 * line. No `g` flag, so `exec` carries no lastIndex between calls.
 *
 * The middle is deliberately loose (`[^\n]*`) while the two ends stay strict.
 * Checked against the real transcript on 2026-08-11: of 23 stored blocks, 22
 * used the bare header and one read `=== FITTRACK PLAN (option 1 : pont fessier
 * optimisé) ===`. The model decorated a format it was told to reproduce exactly
 * — which is the same behaviour that killed the text format in the first place,
 * and the reason this is matched by shape rather than by literal. Loosening the
 * middle costs nothing: the line-start `===` and the trailing `===$` are what
 * keep prose out, not the words between them.
 */
const LEGACY_PLAN_RE = /^[ \t]*===[ \t]*FITTRACK PLAN\b[^\n]*===[ \t]*$/m;

/**
 * Collapses the format the schema replaced — and this is the branch that was
 * missing, not an extra safety net.
 *
 * `collapsePlan` above recognises only the NEW format (a JSON payload, or a
 * fragment of one). An `=== FITTRACK PLAN ===` block is neither, so it reached
 * the model verbatim while every new-format plan was reduced to one line. The
 * result was a selection effect running exactly the wrong way: inside the
 * 40-message window the coach could see zero examples of the format it is meant
 * to produce and N examples of the one it must not, because we were deleting
 * the good examples and preserving the bad ones on every single request.
 *
 * Two things made it worse. `budgetHistory` abridges older assistant turns to
 * their first 600 characters, which on a legacy block keeps the header, the
 * `Semaine :` line and the first exercise lines while throwing away the
 * coaching underneath — turning a plan into a pure format specimen. And it was
 * self-sustaining: a relapse is itself an assistant turn containing the header,
 * banked in `coach_messages` and re-entering the window at the front, so the
 * coach re-taught itself the format faster than the old blocks could age out.
 *
 * The prose BEFORE the block is kept. It is real coaching the user read, it is the
 * part she may refer back to, and it carries none of the syntax.
 *
 * Returns null when there is no block, so an empty string can still be a
 * legitimate result (a reply that was nothing but a plan).
 */
function collapseLegacyPlan(content) {
  if (typeof content !== "string") return null;
  const match = LEGACY_PLAN_RE.exec(content);
  if (!match) return null;
  const prose = content.slice(0, match.index).trimEnd();
  return prose ? `${prose}\n${LEGACY_PLAN_MARKER}` : LEGACY_PLAN_MARKER;
}

export { LEGACY_PLAN_MARKER };

/**
 * Shown for a plan-emit reply that was cut mid-stream — a fragment of the JSON
 * payload, not a well-formed one. Deliberately states no session count: at
 * this point the payload never finished, so any number here would be invented.
 */
const TRUNCATED_PLAN_MARKER = "[programme émis, réponse coupée]";

/**
 * Catches the one shape `isPlanPayload` cannot: a plan-emit reply truncated
 * mid-stream (rung timeout, `max_tokens`, a dropped connection — all real and
 * frequent in this codebase, see coach-chat.js's checkpoint/finish/
 * TRUNCATION_NOTE machinery). `response_format: json_schema` guarantees the
 * whole visible reply IS the JSON object in plan-emit mode, so a cut one is
 * stored as e.g. `{"weekStart":"2026-08-11",...,"sessions":[{"name":"Bas du`
 * plus TRUNCATION_NOTE appended as plain text — never valid JSON, so
 * `isPlanPayload` (which parses) correctly says no, and without this the
 * fragment would pass through and leak raw plan-schema syntax to the model.
 *
 * Deliberately narrow, and bound in exactly the two ways the payload's own
 * shape allows: the content must START with `{` (nothing precedes the JSON
 * object on this path) AND fail to parse as JSON at all. Content that starts
 * with `{` but parses fine (e.g. `{}`, or unrelated valid JSON) is left to
 * `isPlanPayload` — this function only fills the parse-failure gap, it does
 * not second-guess a payload that already parsed. Ordinary prose merely
 * containing or discussing a brace does not start with one and never reaches
 * the parse attempt at all. This is exactly the kind of heuristic the project
 * is otherwise moving away from, hence the narrow bound and the
 * false-positive guard test beside the positive ones.
 */
export function looksLikeTruncatedPlanFragment(content) {
  if (typeof content !== "string") return false;
  if (!content.trimStart().startsWith("{")) return false;
  try {
    JSON.parse(content);
    return false; // parsed fine — not a fragment; isPlanPayload already handles this case
  } catch {
    return true;
  }
}

/** A Date, or null when the row carries no usable timestamp. */
function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** How long the break was, in words the user's coach can read. */
function describeGap(ms) {
  const days = Math.floor(ms / DAY_MS);
  if (days >= 2) return `${days} jours plus tard`;
  if (days === 1) return "le lendemain";
  return `${Math.floor(ms / HOUR_MS)} heures plus tard`;
}

export function annotateHistory(rows) {
  const turns = Array.isArray(rows) ? rows : [];

  return turns.map((row, i) => {
    const when = toDate(row.created_at);
    const prev = toDate(turns[i - 1]?.created_at);

    let prefix = "";

    // A session break goes on the first turn of the new session whatever its
    // role — the coach needs to know the thread restarted, not who spoke first.
    if (when && prev) {
      const gap = when.getTime() - prev.getTime();
      if (gap >= SESSION_GAP_HOURS * HOUR_MS) {
        prefix += `[— nouvelle conversation, ${describeGap(gap)} —]\n`;
      }
    }

    // BOTH roles are stamped, and the reason the coach's own turns need it is
    // not symmetry. On a live transcript the user had to ask the coach repeatedly
    // to stop talking about an appointment already past. It was not misremembering
    // the date — asked directly it gave it correctly. It was QUOTING ITSELF: it
    // had written « le rendez-vous de demain », that sentence was still inside
    // the 40-message window days later carrying no date, and « demain » reads as
    // tomorrow. One reply could hold both readings at once.
    //
    // A stamp costs ~22 characters against a 2 000-6 000 character reply. The
    // note that used to stand here claimed stamping both roles would "double
    // the cost", which is arithmetic about the stamps rather than about the
    // prompt: 20 assistant turns is ~440 characters, about 0.4% of the history
    // block and ~0.06% of a 20k-token request.
    //
    // HER stamp stays inline and HIS goes on its own line, which is not a
    // cosmetic difference: `stripReplyScaffolding` reads the coach's first line
    // to find a self-announcing opener, so an inline stamp would hide the label
    // from it. That function skips leading annotation lines for the same
    // reason — the two guards are one mechanism and must move together.
    if (when) {
      prefix += row.role === "user" ? `[${STAMP.format(when)}] ` : `[${STAMP.format(when)}]\n`;
    }

    // A stamp the MODEL wrote is removed before ours is added, and this is the
    // half that acts immediately. Since 2026-08-24 every assistant turn in the
    // window opens on a bracketed date line, and the model learned to write one
    // itself — 25 of the 46 replies since, measured 2026-08-30. That is the
    // `collapsePlan` selection effect exactly: twelve verbatim specimens beat a
    // prompt. Stripping here removes them from the window on the very next
    // request, rows already banked included; nothing in Neon is rewritten, on
    // the same ruling that governed the legacy plan blocks. Without it the
    // stamps also stack, ours in front of the model's copy of the last one.
    const body =
      row.role === "assistant" ? collapsePlan(stripEchoedAnnotation(row.content)) : row.content;
    let content = `${prefix}${body}`;

    // A question with no assistant turn after it never got an answer. That
    // includes the trailing turn: history is read before her current message is
    // banked, so a trailing user turn is by definition unanswered.
    if (row.role === "user" && turns[i + 1]?.role !== "assistant") {
      content += `\n${ORPHAN_NOTE}`;
    }

    return { role: row.role, content };
  });
}
