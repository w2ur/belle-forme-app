import { useState, useCallback, useEffect, useRef } from "react";
import { storage } from "../lib/storage.js";
import { enqueue, drainWith, retryParkedUnderLock, createOutboxStore, withDrainLock, DRAIN_BUSY } from "../lib/outbox.js";
import { dirtyDuringPull } from "../lib/reconcile.js";

const RETRY_MS = 30000;

/**
 * Owns the sync outbox (`src/lib/outbox.js`) and the indicator status.
 *
 * Every write goes through `push(entry)`: it is enqueued and persisted BEFORE
 * the push is attempted, and leaves the outbox only when Neon confirmed it. So
 * a write made offline survives the tab being killed, and a write replaced by a
 * newer one is never replayed over it.
 *
 * `exec(entry)` maps an entry to a client call; it lives in `useSessionData`,
 * which holds the client. `enabled` is false in local-only mode (never logged
 * in): `push` then enqueues nothing, so the outbox cannot grow without bound on
 * a device that never unlocked.
 *
 * The outbox drains on a push, 30 s after a transient failure, on the window
 * `online` event, when the page becomes visible again, and once on mount when
 * something is left over from a previous visit. Draining is single-flight —
 * `online` and `visibilitychange` routinely fire together on iPad wake.
 *
 * The outbox is SHARED with every other tab and the installed PWA: it lives in
 * localStorage, and every read goes back to it (`createOutboxStore`), so a
 * write is a read-modify-write of what is there now rather than this tab's
 * copy written over the other's. Drains are serialised across tabs by a Web
 * Lock (`withDrainLock`), and the `storage` event keeps the counts current
 * when another tab changes the outbox.
 */
export default function useSyncStatus({ enabled = false, exec, onAuthLost, onPark } = {}) {
  const [status, setStatus] = useState("idle");
  const [counts, setCounts] = useState(() => countsOf(storage.readOutbox()));
  // False once the hook has unmounted. A drain awaiting a push outlives the
  // component: what it learns is still persisted — storage is shared, and
  // dropping a confirmed completion would only send the entry again — but it
  // touches no React state, arms no retry timer, and sends nothing further.
  const mounted = useRef(false);
  // setCounts is stable, so the store can be built once, in an initialiser.
  const [store] = useState(() => {
    const shared = createOutboxStore({ read: storage.readOutbox, write: storage.saveOutbox });
    return {
      get: () => shared.get(),
      set: (next) => {
        shared.set(next);
        if (mounted.current) setCounts(countsOf(next));
      },
    };
  });
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const execRef = useRef(exec);
  useEffect(() => { execRef.current = exec; }, [exec]);
  const authLostRef = useRef(onAuthLost);
  useEffect(() => { authLostRef.current = onAuthLost; }, [onAuthLost]);
  const parkRef = useRef(onPark);
  useEffect(() => { parkRef.current = onPark; }, [onPark]);

  const draining = useRef(false);
  const pullWatch = useRef(null);
  const retryTimer = useRef(null);
  const syncedTimer = useRef(null);

  // The indicator never says "synced" while anything is still unconfirmed.
  const settle = useCallback(() => {
    clearTimeout(syncedTimer.current);
    const { pendingCount, parkedCount } = countsOf(store.get());
    if (draining.current) {
      setStatus("syncing");
    } else if (pendingCount > 0 || parkedCount > 0) {
      setStatus("error");
    } else {
      setStatus("synced");
      syncedTimer.current = setTimeout(() => setStatus((s) => (s === "synced" ? "idle" : s)), 3000);
    }
  }, [store]);

  const drainNow = useCallback(async () => {
    if (!enabled || draining.current) return;
    if ((store.get().queue ?? []).length === 0) return;
    draining.current = true;
    clearTimeout(retryTimer.current);
    retryTimer.current = null;
    setStatus("syncing");
    let stoppedOn;
    let error;
    try {
      const result = await withDrainLock(() =>
        drainWith(store, (entry) => execRef.current(entry), {
          active: () => mounted.current,
          onPark: (entry, err) => { if (mounted.current) parkRef.current?.(entry, err); },
        })
      );
      // Another tab held the drain lock for the whole wait: nothing was sent,
      // so this is a turn to retry on the timer, like a transient failure.
      stoppedOn = result === DRAIN_BUSY ? "transient" : result.stoppedOn;
      error = result === DRAIN_BUSY ? null : result.error;
    } finally {
      draining.current = false;
    }
    // Unmounted while the push was in flight: the cleanup has already cleared
    // the retry timer, and arming a new one here would outlive it.
    if (!mounted.current) return;
    // A 401 is not retried on a timer: the credential will not heal by
    // itself. The outbox is untouched; the app goes back to the gate, and the
    // drain on the next mount sends it once she has typed the password.
    if (stoppedOn === "auth") {
      settle();
      authLostRef.current?.(error);
      return;
    }
    if (stoppedOn === "transient" && !retryTimer.current) {
      retryTimer.current = setTimeout(() => {
        retryTimer.current = null;
        drainNow();
      }, RETRY_MS);
    }
    settle();
    // Belt: a write that landed in the outbox just as the loop saw it empty.
    if (stoppedOn === null && (store.get().queue ?? []).length > 0) drainNow();
  }, [enabled, store, settle]);

  const push = useCallback((entry) => {
    if (!enabled) return;
    pullWatch.current?.written.push(entry.key);
    store.set(enqueue(store.get(), { at: new Date().toISOString(), ...entry }));
    drainNow();
  }, [enabled, store, drainNow]);

  // « Réessayer » retries what it was showing: the parked keys of the last
  // counts rendered, not an entry another tab parked since. `options` go to
  // `unpark` (the catalog's `keepOps`), inside the same read-modify-write.
  const shownParked = useRef(counts.parkedKeys);
  useEffect(() => { shownParked.current = counts.parkedKeys; }, [counts.parkedKeys]);
  // Resolves false when nothing was unparked (local-only, or the drain lock
  // stayed busy): the entries stay parked, so the caller shows nothing new.
  const retryParked = useCallback(async (options) => {
    if (!enabled) return false;
    const done = await retryParkedUnderLock(store, shownParked.current, { ...options, active: () => mounted.current });
    if (done) drainNow();
    return done;
  }, [enabled, store, drainNow]);

  useEffect(() => {
    if (!enabled) return undefined;
    const onOnline = () => drainNow();
    const onVisible = () => { if (document.visibilityState === "visible") drainNow(); };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    // Left over from a previous visit (offline edits, then a reload).
    drainNow();
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    };
  }, [enabled, drainNow]);

  useEffect(() => () => clearTimeout(syncedTimer.current), []);

  // Another tab changed the outbox: refresh the counts, and stop showing an
  // error this tab has nothing left to be in error about. `key` is null when
  // the whole of localStorage was cleared.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== "outbox" && e.key !== null) return;
      const next = countsOf(store.get());
      setCounts(next);
      if (next.pendingCount === 0 && next.parkedCount === 0) {
        setStatus((s) => (s === "error" ? "idle" : s));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [store]);

  // The pull-and-reconcile on mount reports through these three. It is not an
  // outbox write, so a failure has nothing to queue.
  const startSync = useCallback(() => setStatus("syncing"), []);
  const syncSuccess = settle;
  // The pull settles long after it left: unmounted by then (a 401 elsewhere
  // already sent the app to the gate, or the shell remounted on a fresh key),
  // it must not send the NEW shell back to the gate too.
  const syncError = useCallback((err) => {
    if (!mounted.current) return;
    setStatus("error");
    if (err?.status === 401) authLostRef.current?.(err);
  }, []);

  // The dirty set the pull reconciles against (`dirtyDuringPull`): the outbox
  // when the pull leaves, every key written while it is in flight, and the
  // outbox when it returns. A write confirmed by Neon during the round trip
  // has left the outbox but may be newer than the pull's snapshot.
  const beginPull = useCallback(() => {
    pullWatch.current = { atSend: store.get(), written: [] };
  }, [store]);
  const endPull = useCallback(() => {
    const watch = pullWatch.current ?? { atSend: store.get(), written: [] };
    pullWatch.current = null;
    return dirtyDuringPull({ ...watch, atResponse: store.get() });
  }, [store]);

  // The outbox as it stands right now, for an executor that must know what
  // is still queued behind the entry it is sending (the catalog's).
  const peek = useCallback(() => store.get(), [store]);

  const { pendingCount, parkedCount } = counts;
  return { status, pendingCount, parkedCount, push, retryParked, peek, beginPull, endPull, startSync, syncSuccess, syncError };
}

function countsOf(outbox) {
  return {
    pendingCount: (outbox?.queue ?? []).length,
    parkedCount: (outbox?.parked ?? []).length,
    parkedKeys: (outbox?.parked ?? []).map((e) => e.key),
  };
}
