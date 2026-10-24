// Pure helpers for useCoachChat, kept out of the hook so they can be tested.

/** What the client shows on an empty thread. Never banked, so the server never returns it. */
export const OPENING_LINE =
  "Salut ! Raconte-moi ta dernière séance, ou demande-moi ton prochain programme.";

/** Whether a send may start. `busy` must come from a ref, not a render closure. */
export function canSend({ message, busy, client }) {
  return Boolean(message) && !busy && Boolean(client);
}

/** The banner a failed history refresh raises — the only error that refresh may clear. */
export const HISTORY_ERROR =
  "Conversation pas encore synchronisée — voici la copie gardée sur cet appareil.";

/**
 * Whether a history GET that just resolved may replace the transcript.
 *
 * `issuedGen` is the send generation captured when the GET was ISSUED, `gen`
 * the one now; it moves when a send starts AND when it ends, so it has moved
 * whenever a send was running at issue or started since. The result is
 * applied only when no send is running now and none started or ended while
 * it was out. Otherwise it is IGNORED — and that is a success, not a retry:
 * every turn this device sent is already on screen. The thread is then marked
 * stale and fetched once more after the next send that does not end cut
 * (`refreshAfterSend`), or at once if that send already ended; a cut reply is
 * left to her « Réessayer », since the server copy may be the shorter one.
 *
 * Ignoring replaced a merge of the two lists, matched by role and content
 * because production rows carry no id. Every rule that merge grew (a repeated
 * question, an identical older reply, a partial checkpoint, a cut reply) was a
 * way to get the matching wrong; a snapshot that may predate the screen is now
 * simply not used.
 */
export function historyAction({ issuedGen, gen, busy }) {
  return !busy && gen === issuedGen ? "apply" : "ignore";
}

/**
 * The error after a SUCCESSFUL history GET, given what `historyAction` decided.
 * Applied: only the refresh's own banner goes — a send that failed concurrently
 * raised its own (message not sent, reply cut, plan not generated, correction not
 * sent), and a refresh landing a moment later must not erase it. Ignored:
 * nothing changes, its banner included — the screen is still not the server's
 * copy, so « pas encore synchronisée » is still true.
 */
export function errorAfterHistory(current, action) {
  if (action !== "apply") return current;
  return current === HISTORY_ERROR ? null : current;
}

/**
 * The error after a FAILED history refresh: its banner only when nothing else
 * is showing. A send error says what to do next (the text is back in the
 * field, reload the cut reply, press « Plan » again, reimport); the refresh
 * banner only says the screen is the local copy, so it must not replace one.
 */
export function errorAfterHistoryFailure(current) {
  return current || HISTORY_ERROR;
}

/**
 * Whether a failed refresh leaves the thread STALE without saying so: its
 * banner was held back because a send's error was showing
 * (`errorAfterHistoryFailure`), so nothing on screen offers the reload.
 */
export function historyStaleAfterFailure(current) {
  return Boolean(current) && current !== HISTORY_ERROR;
}

/**
 * Whether to fetch the history again once a send has ended.
 *
 * An ignored GET (or a failure hidden behind a send's error) leaves the thread
 * stale, and nothing else would re-issue it: the hook fetches on mount and on
 * « Réessayer » only, so another device's turns could stay missing for the
 * whole session. One refresh per send end, so it is bounded. Never after a CUT
 * reply: the server may hold only a shorter checkpoint of what she read, and
 * the cut banner already offers the reload.
 */
export function refreshAfterSend({ stale, cut }) {
  return Boolean(stale) && !cut;
}
