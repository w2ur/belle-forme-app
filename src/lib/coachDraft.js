/**
 * The coach composer's draft, kept in sessionStorage.
 *
 * A 401 sends the app back to the password gate, which UNMOUNTS the shell and
 * `useCoachChat` with it: a draft held only in React state is gone by the time
 * she has typed the password. That happens on her own send (the question was
 * cleared from the composer at send time) and on a 401 from anywhere else —
 * the sync line draining in the background, the history fetch — while a
 * half-typed question sits in the composer. sessionStorage survives the
 * remount and a reload, and stays with the tab.
 *
 * Every access is guarded: private mode or a locked store loses the draft
 * across the gate, exactly as before, and never breaks the composer.
 */
export const DRAFT_KEY = "fittrack_coach_draft";

const defaultStore = () => globalThis.sessionStorage;

export function loadDraft(store = defaultStore()) {
  try {
    const text = store?.getItem(DRAFT_KEY);
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}

export function saveDraft(text, store = defaultStore()) {
  try {
    if (text) store?.setItem(DRAFT_KEY, text);
    else store?.removeItem(DRAFT_KEY);
  } catch {
    // Quota or private mode — the draft survives the gate only when it can.
  }
}

/**
 * The draft to keep when a send is refused with a 401: her question, put back
 * if the send had consumed it from the composer and she has not typed anything
 * since; otherwise whatever the composer holds.
 */
export function draftToKeep({ draft, message, consumesDraft }) {
  return consumesDraft ? draft || message : draft;
}
