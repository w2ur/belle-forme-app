import { useEffect, useState } from "react";
import { storage } from "../lib/storage.js";
import {
  createFromPlanned, validateSet, leaveExercise, skipExercise, back, moveExercise,
  toggleChecklistItem, finalize, restore, markQuit, markResumed, stampActive,
} from "../lib/activeSession.js";
import { generateId, today } from "../lib/helpers.js";

/**
 * Owns the running séance and its persistence.
 *
 * Every mutation writes through to localStorage immediately: iPad Safari kills
 * backgrounded tabs, and a séance lost mid-workout cannot be reconstructed.
 * Neon only ever sees the finished session, through the normal save path.
 */
export default function useActiveSession(onComplete) {
  const [state, setState] = useState(() => restore(storage.loadActiveSession()));

  useEffect(() => {
    if (state) storage.saveActiveSession(state);
  }, [state]);

  // The screen must stay awake for the whole séance, not only while a timer
  // runs — she is looking at the iPad between sets, not touching it.
  const hasSeance = !!state;
  useEffect(() => {
    if (!hasSeance) return;
    let lock = null;
    let cancelled = false;
    const acquire = async () => {
      if (!("wakeLock" in navigator)) return;
      try {
        const l = await navigator.wakeLock.request("screen");
        if (cancelled) l.release(); else lock = l;
      } catch { /* refused (low battery, backgrounded) — degrade silently */ }
    };
    acquire();
    // Safari drops the lock when the tab is backgrounded; re-take it on return.
    const onVisible = () => { if (document.visibilityState === "visible") acquire(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      lock?.release().catch(() => {});
    };
  }, [hasSeance]);

  const start = (planned, weekStart = null) =>
    setState(
      stampActive(
        createFromPlanned(planned, {
          id: generateId(),
          date: today(),
          startedAt: new Date().toISOString(),
          weekStart,
        })
      )
    );

  // Every mutation stamps the day she last worked on the draft (`activeOn`), which
  // is what tells the coach a séance that crossed midnight is still live.
  const work = (fn) => setState((s) => (s ? stampActive(fn(s)) : s));
  const validate = (values) => work((s) => validateSet(s, values));
  const leave = () => work(leaveExercise);
  const goBack = () => work(back);
  const move = (from, to) => work((s) => moveExercise(s, from, to));
  const toggleItem = (section, i) => work((s) => toggleChecklistItem(s, section, i));
  const skip = (reason) => work((s) => skipExercise(s, { reason }));
  const setNotes = (general_notes) => work((s) => ({ ...s, general_notes }));
  // How the screen closed: the X marks the draft, resuming clears it (see `markQuit`).
  const quit = () => setState((s) => (s ? markQuit(s) : s));
  const resume = () => setState((s) => (s ? markResumed(s) : s));

  const finish = () => {
    if (!state) return;
    const minutes = Math.max(1, Math.round((Date.now() - new Date(state.startedAt).getTime()) / 60000));
    onComplete(finalize(state, { durationMinutes: minutes }));
    storage.clearActiveSession();
    setState(null);
  };

  const abandon = () => {
    storage.clearActiveSession();
    setState(null);
  };

  return {
    state, start, validate, leave, skip, goBack, move, toggleItem, setNotes, quit, resume, finish, abandon,
    hasDraft: !!state,
  };
}
