/**
 * Turns the model's schema-generated JSON into the plan shape the app already
 * consumes, and answers the one question both ends of the app need to ask:
 * "is this message a plan?"
 *
 * `isPlanPayload` REPLACES `detectPlanBlock`. Detection is now a parse rather
 * than a regex: prose cannot parse as JSON, so there are no false positives and
 * there is no pattern left to drift. It is used in two places that MUST agree —
 * `CoachConversation` (to show the import button) and `historyView` (to collapse
 * plan payloads before the model sees them). A disagreement between the two
 * would push full JSON plans back into history and re-teach the format, undoing
 * the whole mode split.
 *
 * THE PRODUCED SHAPE HAS FOUR CONSUMERS, not just the validators:
 *   WeeklyPlan.jsx:89       ex.sets  — a DISPLAY string, rendered verbatim
 *   WeeklyPlan.jsx:180-181  ex.setsCount / reps / weight / weightType / progressionNote
 *   plannedSession.js:15-16 ex.weightType / setsCount
 *   planValidation.js       the whole plan
 * Every one of those reads is optional at the render site, so a field this
 * module forgets renders BLANK rather than throwing. `sets` in particular is
 * derived here and deliberately absent from the schema — see planSchema.js.
 */

const ERR_UNREADABLE = "Le programme reçu est illisible (JSON invalide).";
const ERR_NOT_A_PLAN = "La réponse ne contient pas de programme.";

function coerceObject(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Is this a plan payload? DETECTION only — "does this look like a plan
 * attempt", the question `CoachConversation` (show the import button) and
 * `historyView` (collapse it before the model sees it) need answered.
 * Deliberately NOT "is this plan valid": that is `evaluatePlanImport`'s job,
 * and it stays there.
 *
 * This used to also require `typeof obj.weekStart === "string"`, which made
 * detection do part of validation's job. The result: a payload with a real
 * `sessions` array but a malformed `weekStart` (e.g. `null`) was accepted by
 * `planFromJson` — which tolerates it and defers to `validatePlan` — but
 * rejected here, so no import button would show and the payload wouldn't be
 * collapsed in history, even though `evaluatePlanImport` would go on to
 * report it as a normal structural error. `planFromJson` now calls this
 * function directly for its own gate (below), so the two can never diverge
 * again — this checks exactly what `planFromJson` needs to attempt
 * construction: an object carrying a `sessions` array. Nothing more.
 */
export function isPlanPayload(value) {
  const obj = coerceObject(value);
  return !!obj && Array.isArray(obj.sessions);
}

function movement(item) {
  return {
    name: typeof item?.name === "string" ? item.name : "",
    detail: typeof item?.detail === "string" ? item.detail : "",
  };
}

/**
 * The display string `WeeklyPlan` renders verbatim — `"4×10"`, `"3×45"`.
 *
 * Exported because it is derived from `reps`, and `reps` is normalised LATER,
 * in `validatePlanDomain`, once the catalog says whether this exercise counts
 * seconds. Deriving it in two places would let `sets: "3×45s"` sit beside
 * `reps: "45"` — two sources for one fact, free to disagree, which is exactly
 * what this field being derived was meant to prevent. One implementation, two
 * call sites.
 */
export function formatSets(setsCount, reps) {
  return `${setsCount}×${reps}`;
}

/**
 * Strips the unit from a held exercise's `reps`, leaving a bare number.
 *
 * `metric` carries the unit now (see the catalog skill), so `"45s"` and
 * `"45 s"` and `"45"` are the same prescription and must be stored the same
 * way — otherwise the stepper, the record and the export each re-derive the
 * unit from prose. Anything that is not a plain duration is returned UNCHANGED
 * with a warning rather than mangled: `"30-40min"` is a real shape the coach
 * emits for cardio, and a lossy rewrite of it is worse than leaving it alone.
 *
 * @returns {{ reps: string, changed: boolean, unparsed: boolean }}
 */
export function normalizeReps(reps, metric) {
  const raw = typeof reps === "string" ? reps.trim() : "";
  if (metric !== "seconds" || raw === "") return { reps, changed: false, unparsed: false };

  const match = raw.match(/^(\d+(?:[.,]\d+)?)\s*(?:s|sec|secs|seconde|secondes)?$/i);
  if (!match) return { reps, changed: false, unparsed: true };

  const bare = match[1].replace(",", ".");
  return { reps: bare, changed: bare !== reps, unparsed: false };
}

function exercise(raw) {
  // Defensive despite the API's guarantee: strict mode covers the model, not a
  // truncated stream, and a missing field must degrade to something renderable
  // rather than to an empty cell.
  const setsCount = Number.isFinite(raw?.setsCount) && raw.setsCount > 0 ? raw.setsCount : 1;
  const reps = typeof raw?.reps === "string" && raw.reps !== "" ? raw.reps : "?";
  return {
    name: typeof raw?.name === "string" ? raw.name : "",
    // Derived, never model-authored. WeeklyPlan renders this verbatim.
    sets: formatSets(setsCount, reps),
    setsCount,
    reps,
    weight: Number.isFinite(raw?.weight) ? raw.weight : 0,
    weightType: raw?.weightType === "per_hand" ? "per_hand" : "total",
    restSeconds: Number.isFinite(raw?.restSeconds) ? raw.restSeconds : 60,
    progressionNote: typeof raw?.progressionNote === "string" ? raw.progressionNote : "",
  };
}

/**
 * Turns a plan payload into the shape the app consumes. DETECTION (is this a
 * plan attempt at all) is `isPlanPayload`'s job, called directly below so the
 * two functions can never disagree about it. This function does the next
 * step — building the best plan object it can from what's there — and
 * deliberately does NOT reject on a missing/malformed `weekStart`,
 * `sessions.length === 0`, or any domain rule: every field below degrades to
 * a safe default (`null`, `""`, `[]`) rather than failing construction, and
 * validity is entirely `evaluatePlanImport`'s job (`validatePlan` +
 * `validatePlanDomain`), which needs the sessions it validates to actually
 * exist here first — see its two-pass reporting rule (`planValidation.js`).
 *
 * @param {string|object} value - the model's JSON payload, parsed or not.
 * @returns {{plan: object|null, errors: string[]}} Never throws.
 */
export function planFromJson(value) {
  const obj = coerceObject(value);
  if (!obj) return { plan: null, errors: [ERR_UNREADABLE] };
  if (!isPlanPayload(obj)) return { plan: null, errors: [ERR_NOT_A_PLAN] };

  const plan = {
    weekStart: typeof obj.weekStart === "string" ? obj.weekStart : null,
    weekEnd: typeof obj.weekEnd === "string" ? obj.weekEnd : null,
    coachNotes: typeof obj.coachNotes === "string" ? obj.coachNotes : "",
    // Deliberately NOT copied through. `notebook` is « JAMAIS montré à l'utilisateur »
    // in the schema's own words, and no caller reads `plan.notebook` any
    // more — the server strips it server-side before the payload is ever
    // streamed (`splitPlanPayload`), `PlanCard` never destructures it, and
    // `evaluatePlanImport` doesn't reference it either. Copying it through
    // here was the one remaining route it could still travel: it survives
    // `validatePlanDomain`'s `{ ...plan }` spread and lands in `savePlan`
    // (localStorage `fittrack_plan`), the Neon `plans.data` JSONB via
    // `sync.js`, and ProfileTab's emergency SQL export — none of which the
    // `_v2` transcript-cache purge can reach.
    sessions: (Array.isArray(obj.sessions) ? obj.sessions : []).map((s) => ({
      name: typeof s?.name === "string" ? s.name : "",
      warmup: (Array.isArray(s?.warmup) ? s.warmup : []).map(movement),
      exercises: (Array.isArray(s?.exercises) ? s.exercises : []).map(exercise),
      cooldown: (Array.isArray(s?.cooldown) ? s.cooldown : []).map(movement),
    })),
    // Kept for shape parity with what the parser used to produce; domain
    // warnings are appended downstream by evaluatePlanImport.
    warnings: [],
  };

  return { plan, errors: [] };
}
