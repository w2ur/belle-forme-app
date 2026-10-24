/**
 * What the user reads while she waits for the coach's first character.
 *
 * It exists because the wait used to be long: measured on prod under Gemini,
 * the model returned nothing for 17-28 s while it ingested a 22-27k prompt and
 * generated hidden reasoning tokens. A single line held for that long reads as a
 * frozen app, and "connexion instable" is how she described the whole
 * experience.
 *
 * THE THRESHOLDS BELOW ARE STILL CALIBRATED TO THAT WAIT and are very likely too
 * slow for Mistral, which returned headers in 0.84-6.9 s across 8 measured calls
 * — the later stages may now be unreachable on a healthy request. They are
 * deliberately left alone until `coach_usage.ttft_ms` says what the real wait is
 * on the new ladder: that is the number this is supposed to track, it is already
 * being recorded, and guessing at it in the same change that swapped the vendor
 * would make neither result interpretable.
 *
 * Purely a timer. Nothing here comes from the server — the client knows when it
 * sent and nothing else — so the copy may describe the wait but must never
 * report progress. No percentage, no countdown, no "presque fini": a promise the
 * client cannot keep is worse than a static line, because the next thing she
 * learns is that it was invented.
 *
 * Driving this from real server events was considered and rejected. The only
 * event worth emitting is "the model returned headers", and that lands within
 * about a second of the first visible character — it would light up just as the
 * text arrives and make the placeholder redundant. The long phase is the one
 * BEFORE any server event exists to report.
 */

/**
 * Ordered by `fromMs`, ascending. The last entry has no upper bound.
 *
 * The thresholds track the measured shape of the wait rather than round
 * numbers: the first few seconds are our own overhead plus prefill, the middle
 * is the model reasoning, and past ~25 s the request is in the tail that used
 * to hit the old 30 s execution wall.
 */
export const COACH_WAIT_STAGES = [
  { fromMs: 0, text: "Je regarde tes données…" },
  { fromMs: 4000, text: "Je réfléchis à ta semaine…" },
  { fromMs: 12000, text: "Je construis ma réponse…" },
  // Worded as an ORDINARY long wait, not as an anomaly. It used to read
  // « C'est un peu long, je suis toujours dessus… », which was fair when the
  // only way to reach 25 s was a bad day. Since `plan-emit` became buffered,
  // every programme request sits here by construction — the client receives
  // nothing until the whole payload lands — so an anomaly wording would report a
  // fault each time she asks for her week. Still describes the wait and still
  // reports no progress: no percentage, no countdown, no "presque fini".
  { fromMs: 25000, text: "Je prends le temps de bien faire, je suis toujours dessus…" },
];

/**
 * The plan-emit wait. One line from the first tick: the reply is buffered, so
 * the client receives nothing until the whole payload lands and the staged
 * "je regarde tes données" copy would describe work that is not happening.
 * Like every stage above it reports no progress.
 */
export const PLAN_WAIT_TEXT = "Je rédige ton programme…";

/**
 * The line to show after `elapsedMs` of waiting. `mode` is the wire mode of the
 * request in flight; the programme request gets its own fixed line.
 *
 * Monotonic by construction: stages are scanned in order and the last one whose
 * threshold has passed wins, so the text can only ever move forward. A
 * placeholder that flickered backwards would read as a retry loop.
 */
export function coachWaitMessage(elapsedMs, mode = "discussion") {
  if (mode === "plan-emit") return PLAN_WAIT_TEXT;
  // A clock adjustment mid-wait can hand us a negative or non-finite value.
  const ms = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  let current = COACH_WAIT_STAGES[0].text;
  for (const stage of COACH_WAIT_STAGES) {
    if (ms >= stage.fromMs) current = stage.text;
    else break;
  }
  return current;
}
