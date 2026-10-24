/**
 * What a navigation tap does to the séance screen.
 *
 * Changing tab closes the screen; the draft is kept and `ResumeCard` resumes it.
 * A tap on the tab she is already on leaves it up: the séance runs under
 * « Séance », and that tap used to throw her out of it.
 */
export function navigate({ tab, next, seanceOpen }) {
  if (next === tab) return { tab, seanceOpen };
  return { tab: next, seanceOpen: false };
}

/**
 * Where the page should scroll when the screen changes, or null to leave it.
 *
 * A screen is `{ tab, view, seanceOpen }`. Nothing changed — a tap on the tab
 * she is on — → null, so the page never jumps mid-séance. Any change → 0: a
 * new tab, a session, a form or the séance screen opens at its top, and so does
 * the way back to the history.
 *
 * Restoring the history's offset on the way back was tried (review rounds 2–4)
 * and removed: everything above the list can change height while she is away —
 * a ResumeCard, a new session, the coach notes or a plan card collapsing on
 * remount, a late webfont — so a restored offset kept landing past her card.
 */
export function scrollOnScreenChange(prev, next) {
  const same = prev.tab === next.tab && prev.view === next.view && prev.seanceOpen === next.seanceOpen;
  return same ? null : 0;
}
