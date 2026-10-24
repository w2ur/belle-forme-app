import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "react";
import { DEFAULT_PROFILE } from "../constants/index.js";
import { storage } from "../lib/storage.js";
import { usableCatalogViews, validateCatalogDoc } from "../lib/catalog.js";
import { reconcile, sessionsAfterPull, dirtyDuringPull, entityAfterPull } from "../lib/reconcile.js";
import { getSyncClient } from "../lib/sync.js";
import { applyCatalogOps } from "../lib/catalogForm.js";
import {
  sendCatalogOps, replayCatalog, rebaseOnPull, mirrorToSave, catalogView, confirmedViews, CatalogConflictError,
  pendingRenames, sessionToConfirmed, planToConfirmed,
  logConfirmedOps, pruneSupersededEdits, retryNotice,
} from "../lib/catalogSync.js";
import { queuedOps, classify, singleFlight, EMPTY_OUTBOX } from "../lib/outbox.js";
import { upsertSession } from "../lib/sessionsReducer.js";
import { generateId, today, normalizeSessionNames, normalizePlanNames } from "../lib/helpers.js";
import useSyncStatus from "./useSyncStatus.js";

// Shown when a catalog edit is parked for any reason other than a conflict
// (which carries its own message): the server kept refusing it.
const CATALOG_PARKED_NOTICE =
  "Ta modification du catalogue n'a pas pu être enregistrée — « Réessayer » la renverra.";

export default function useSessionData({ onAuthLost } = {}) {
  // FIRST, because the two initialisers below normalise exercise names against
  // it. Read synchronously from the mirror for the same reason sessions and the
  // plan are: any device that has synced once already holds the document, so the
  // catalog-less mount is rare rather than routine.
  //
  // The mirror is the document the SERVER last confirmed; edits not yet
  // confirmed are operations in the outbox (`src/lib/catalogSync.js`). What
  // the lexique shows is the one replayed on the other, so an edit made
  // offline is still there after a reload.
  const [catalogDoc, setCatalogDoc] = useState(() => catalogView(storage.loadCatalog(), storage.loadOutbox()));
  // « Le catalogue a changé ailleurs… », set when an edit could not be
  // replayed onto the server's document and was parked.
  const [catalogNotice, setCatalogNotice] = useState(null);

  // Declared before the catalog views because the inventory they are derived
  // against lives in the profile.
  const [profile, setProfile] = useState(() => storage.loadProfile(DEFAULT_PROFILE));

  // Memoised: `buildCatalogViews` walks 70 entries and this hook re-renders on
  // every session mutation. An empty/degenerate document is handed out as
  // `null` — see `isUsableCatalog` for why that is not merely tidiness.
  const catalog = useMemo(() => {
    return usableCatalogViews(catalogDoc, profile?.inventory);
  }, [catalogDoc, profile?.inventory]);

  // Normalised at every point data enters state, so nothing downstream — stats,
  // export, the lexique — ever sees a retired exercise name. Against the
  // CONFIRMED catalog only (`confirmedViews`): a rename still in the outbox
  // stays out of her history until the server has taken it. With no catalog
  // yet this is a pass-through, and the pull below re-normalises what it let
  // past.
  const [sessions, setSessions] = useState(() =>
    normalizeSessionNames(storage.loadSessions([]), confirmedViews(storage.loadCatalog())));
  const [settings, setSettings] = useState(() => storage.loadSettings({ defaultTimer: 90 }));
  const [plan, setPlan] = useState(() =>
    normalizePlanNames(storage.loadPlan(), confirmedViews(storage.loadCatalog())));

  // Read once, at mount, as before: logging in remounts the shell.
  const [initialClient] = useState(() => getSyncClient());
  const syncClient = useRef(initialClient);
  // The state as it stands NOW (kept current by a layout effect below), for
  // the pull and for the catalog executor, which both run long after render.
  const latest = useRef(null);
  // `peek` from useSyncStatus, which is called after the executor is defined.
  const peekOutbox = useRef(() => EMPTY_OUTBOX);

  /**
   * Puts a catalog document into the lexique, and re-normalises what is
   * already in memory against the CONFIRMED catalog (the mirror) — not
   * against `nextDoc`, which may carry edits the server has not taken.
   *
   * The re-normalisation is what makes a confirmed RENAME land immediately.
   * Aliases are applied on read into state, so without it everything already
   * in memory would keep the retired name until the next reload —
   * `computePRs` and `computeLoadStreaks` key on the name, so for the rest of
   * the session her history would read as two exercises. Nothing is pushed
   * back to Neon for it, ever: the alias travels with the document, so every
   * device normalises the same way on its own next read. Sessions and the plan
   * reach Neon only through her own saves (and the first login's re-push of
   * local-only sessions).
   */
  const adoptCatalog = useCallback((nextDoc) => {
    setCatalogDoc(nextDoc);
    const views = confirmedViews(storage.loadCatalog());
    if (!views) return;
    // Functional, both: this runs from async drain callbacks, and the plan
    // read off `latest` (the last render) overwrote a newer one still queued
    // in state — a save or a pull committed in the same tick. Persisted by the
    // effect below, from whatever state ends up holding.
    setSessions((prev) => normalizeSessionNames(prev, views));
    setPlan((prev) => normalizePlanNames(prev, views));
  }, []);

  /**
   * Sends the catalog entry's operations (`sendCatalogOps`) and moves the
   * mirror to whatever the server ends up holding. The lexique then shows
   * that document with the operations still owed replayed on it: those queued
   * behind this entry, and this entry's own while a transient failure leaves
   * them queued.
   */
  const execCatalog = useCallback(async (entry) => {
    const client = syncClient.current;
    // Sent as queued: a retried entry was pruned once, when it was unparked
    // (`retryParkedEntries`), so what goes out is what the lexique shows.
    const ops = entry.payload?.ops ?? [];
    const sentIds = new Set(ops.map((o) => o?.id));
    // Another tab may have confirmed a newer version while this push was in
    // flight: the mirror only ever moves forward (`mirrorToSave`), and the
    // view is rebuilt on whichever version that leaves.
    const keepNewest = (server) => {
      const save = mirrorToSave(storage.loadCatalog(), server);
      if (save) storage.saveCatalog(save);
      return storage.loadCatalog() ?? server;
    };
    const rebase = (server, keepSent) => {
      const mirror = keepNewest(server);
      const queued = queuedOps(peekOutbox.current(), "catalog");
      adoptCatalog(replayCatalog(mirror.doc, keepSent ? queued : queued.filter((o) => !sentIds.has(o?.id))));
    };
    try {
      const next = await sendCatalogOps({
        base: storage.loadCatalog(),
        ops,
        push: (body) => client.pushCatalog(body),
      });
      storage.saveConfirmedCatalogOps(logConfirmedOps(storage.loadConfirmedCatalogOps(), ops));
      rebase(next, false);
      return next;
    } catch (err) {
      const verdict = classify(err);
      if (verdict === "refused") {
        // About to be parked. The server's row is the newest confirmed
        // document; what she sees is recomputed once the park is stored
        // (`onParkEntry`), the one place every park path goes through.
        if (err?.server?.doc) keepNewest(err.server);
      } else if (verdict === "transient" && err?.server?.doc) {
        rebase(err.server, true);
      }
      throw err;
    }
  }, [adoptCatalog]);

  /**
   * Called once an outbox entry is parked, by a refusal or by the 5xx
   * backstop. A parked catalog edit leaves the lexique until « Réessayer »:
   * the view is the mirror with only the operations STILL QUEUED replayed on
   * it. The backstop used to park without telling anyone, so the edit stayed
   * on screen as if saved — a phantom that vanished on the next reload.
   */
  const onParkEntry = useCallback((entry, err) => {
    if (entry?.key !== "catalog") return;
    const view = catalogView(storage.loadCatalog(), peekOutbox.current());
    if (view) adoptCatalog(view);
    setCatalogNotice(err instanceof CatalogConflictError ? err.message : CATALOG_PARKED_NOTICE);
  }, [adoptCatalog]);

  // Maps an outbox entry to the client call that sends it. The payload is the
  // entry's own, never a value captured when an earlier push failed.
  const execEntry = useCallback((entry) => {
    const client = syncClient.current;
    switch (entry.kind) {
      case "session": return client.upsertSession(entry.payload);
      case "session-delete": return client.deleteSession(entry.payload.id);
      case "plan": return client.pushPlan(entry.payload);
      case "profile": return client.pushProfile(entry.payload.profile, entry.payload.settings);
      // Edit operations under optimistic concurrency, see `execCatalog`.
      case "catalog": return execCatalog(entry);
      default:
        // An unknown kind can never be sent: a 4xx-shaped error parks it
        // rather than letting it block the line or vanish.
        return Promise.reject(Object.assign(new Error(`Unknown outbox kind "${entry.kind}"`), { status: 400 }));
    }
  }, [execCatalog]);

  // Local-only mode (never logged in): no client, so `push` enqueues nothing.
  // The first successful login re-pushes local-only sessions through the
  // pull-and-reconcile below; plan, profile and catalog edits made before it
  // stay local until they are edited again.
  const {
    status: syncStatus, pendingCount, parkedCount, push, retryParked, peek, beginPull, endPull,
    startSync, syncSuccess, syncError,
  } = useSyncStatus({ enabled: Boolean(initialClient), exec: execEntry, onAuthLost, onPark: onParkEntry });
  useEffect(() => { peekOutbox.current = peek; }, [peek]);

  // « Réessayer »: the parked catalog operations are back in the queue, so
  // they are on their way again and the lexique shows them again — the same
  // view every other change of the queued set recomputes. Without this the
  // lexique kept the park's view, and her retried edit stayed invisible until
  // its push settled (or for good, if it parked again).
  //
  // A parked edit a later one has overridden does not go back at all
  // (`pruneSupersededEdits`, against the confirmed log alone — the retry runs
  // under the drain lock, so nothing is in flight to count), and the notice
  // names it rather than letting it vanish.
  // Single-flight: a second tap while the first waits for the drain lock is
  // ignored (it used to clear the first tap's notice), and the button is
  // disabled meanwhile (`retrying`).
  const [retrying, setRetrying] = useState(false);
  const retryFlight = useRef({ current: false });
  const retryParkedEntries = useCallback(() => singleFlight(retryFlight.current, async () => {
    let dropped = [];
    const done = await retryParked({
      keepOps: (ops) => {
        const pruned = pruneSupersededEdits(ops, storage.loadConfirmedCatalogOps());
        dropped = pruned.dropped;
        return pruned.kept;
      },
    });
    if (!done) return;
    const view = catalogView(storage.loadCatalog(), peek());
    if (view) adoptCatalog(view);
    setCatalogNotice((current) => retryNotice(current, dropped));
  }, setRetrying), [retryParked, peek, adoptCatalog]);
  const hasPulled = useRef(false);

  // Persist on change
  useEffect(() => { storage.saveSessions(sessions); }, [sessions]);
  useEffect(() => { storage.saveProfile(profile); }, [profile]);
  useEffect(() => { storage.saveSettings(settings); }, [settings]);
  // Like the three above: storage follows state, never a value computed
  // beside it, so a functional update can never persist a different plan
  // from the one state commits.
  useEffect(() => { storage.savePlan(plan); }, [plan]);

  // The state as it stands NOW, for the pull below. It reconciles against what
  // is in state when the RESPONSE arrives, not what was there at mount: a
  // session saved during the round trip is in state and in the outbox, and
  // reconciling against the mount-time copy would drop it from state. A layout
  // effect, so the ref is current before any network callback can run.
  useLayoutEffect(() => {
    latest.current = { sessions, plan, profile, settings, catalogDoc, catalog };
  });

  // Pull & reconcile on mount (once). The merge itself is `reconcile`
  // (src/lib/reconcile.js, pure): the cloud copy wins except for an entity the
  // outbox still holds a write for. Everything it asks to send goes through
  // the outbox like any other write, so one failed push no longer abandons the
  // ones after it.
  useEffect(() => {
    if (hasPulled.current || !syncClient.current) return;
    hasPulled.current = true;

    (async () => {
      startSync();
      beginPull();
      let cloud;
      try {
        cloud = await syncClient.current.pullAll();
      } catch (err) {
        // Pull failed: keep all local data untouched and surface the error
        // rather than reconciling against a missing/partial cloud snapshot.
        endPull();
        syncError(err);
        return;
      }
      // Taken synchronously with the commit below, at response time.
      const dirty = endPull();
      if (!cloud) {
        syncError();
        return;
      }

      try {
        const now = latest.current;
        // The mirror BEFORE this pull moves it: the names in state were
        // normalised against it.
        const heldViews = confirmedViews(storage.loadCatalog());
        // The catalog is decided by VERSION, not by dirtiness: its unconfirmed
        // edits are operations, which replay onto a newer server document as
        // well as onto the old one (`rebaseOnPull`). So a pending edit no
        // longer hides what changed elsewhere, and a snapshot older than the
        // mirror (a push confirmed during the round trip) is ignored.
        const rebased = rebaseOnPull({
          mirror: storage.loadCatalog(),
          cloudDoc: cloud.catalog ?? null,
          cloudUpdatedAt: cloud.catalogUpdatedAt ?? null,
          ops: queuedOps(peek(), "catalog"),
        });
        const withoutCatalog = (o) => ({ ...o, queue: o.queue.filter((e) => e.key !== "catalog") });
        const args = {
          local: {
            sessions: now.sessions,
            plan: now.plan,
            profile: now.profile,
            settings: now.settings,
            catalog: now.catalogDoc,
          },
          views: heldViews,
          cloud: { ...cloud, catalog: rebased?.doc ?? null, confirmedCatalog: rebased?.mirror.doc ?? null },
          outbox: withoutCatalog(dirty),
        };
        const out = reconcile(args);

        // `reconcile` still refuses a degenerate document; only an adopted
        // one moves the mirror.
        if (rebased && out.catalog === rebased.doc) storage.saveCatalog(rebased.mirror);
        if (out.catalog !== now.catalogDoc) setCatalogDoc(out.catalog);
        // Functional: a session saved in this same tick is in `prev` but not
        // in `now`, and committing `out.sessions` as a value would erase it.
        const dirtyNow = withoutCatalog(dirtyDuringPull({ atSend: dirty, written: [], atResponse: peek() }));
        setSessions((prev) => sessionsAfterPull(prev, {
          snapshot: now.sessions,
          reconciled: out.sessions,
          args: { ...args, outbox: dirtyNow },
        }));
        // Functional, and the pending write wins, for the same reason: a save
        // in this tick is in `prev` and in the outbox but not in `now`.
        // `entityAfterPull` alone decides dirtiness.
        const afterPull = (key, reconciled) => (prev) =>
          entityAfterPull(prev, { key, dirty: dirtyNow, reconciled });
        if (out.plan !== now.plan) setPlan(afterPull("plan", out.plan));
        setProfile(afterPull("profile", out.profile));
        setSettings(afterPull("profile", out.settings));

        // First successful login included: local-only sessions reach Neon here.
        for (const session of out.repush) {
          push({ key: `session:${session.id}`, kind: "session", payload: session });
        }
        if (out.seedPlan) push({ key: "plan", kind: "plan", payload: out.seedPlan });
        if (out.seedProfile) {
          push({ key: "profile", kind: "profile", payload: { profile: out.profile, settings: out.settings } });
        }

        // Reports "synced" only if the outbox is empty, never on the pull alone.
        syncSuccess();
      } catch {
        // Local data is intact; flag the error so the indicator reflects
        // reality instead of a false "synced".
        syncError();
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // With no catalog the picker still offers everything she has already
  // recorded, so a manual entry is never blocked on a pull that has not landed.
  const allExerciseNames = [
    ...new Set([
      ...(catalog?.allExercises ?? []),
      ...sessions.flatMap(s => s.exercises.map(e => e.name)),
    ]),
  ].sort();

  // A name the lexique shows from a rename the server has not confirmed yet
  // is saved under the confirmed one (`pendingRenames`): Neon only ever holds
  // names it knows, and the alias carries them forward once it has the rename.
  const toConfirmed = () => pendingRenames(catalogDoc, storage.loadCatalog()?.doc);

  const saveSession = (session) => {
    const data = sessionToConfirmed(session, toConfirmed());
    setSessions(prev => upsertSession(prev, data));
    push({ key: `session:${data.id}`, kind: "session", payload: data });
  };

  const deleteSession = (id) => {
    setSessions(prev => prev.filter(s => s.id !== id));
    push({ key: `session-delete:${id}`, kind: "session-delete", payload: { id } });
  };

  const duplicateSession = (session) => {
    return { ...session, id: generateId(), date: today() };
  };

  /**
   * Applies catalog edit operations: validate, state, outbox.
   *
   * Takes an operation `{ op, args }` (`applyCatalogOps`) or a list of them
   * applied together — a rename is two, `applyRename` then `upsertExercise`,
   * so the alias and the new name are never written one without the other.
   * Each gets an `id`, which is how the outbox tells the ones a push carried
   * from those queued while it was in flight, and the save's shared `batch`.
   *
   * Returns the blocking errors rather than throwing, so the form can render
   * them beside the offending field. An empty array means it was saved. The
   * quality warnings are deliberately NOT returned here — they never block, so
   * the form asks for them itself and decides what to do with them.
   *
   * Validating here as well as in the endpoint is the belt: `push` is
   * fire-and-forget with the outbox behind it, so a document rejected only
   * server-side would already be in state, and would sit parked in the outbox
   * against a server that will never take it.
   *
   * The mirror is not written here: it holds what the server confirmed, and
   * the operations in the outbox are what survive a reload until it does.
   */
  const saveCatalog = useCallback((opOrOps) => {
    // One save is one EDIT: its operations share a `batch`, so a parked
    // rename is kept or dropped whole when retried (`pruneSupersededEdits`).
    const batch = generateId();
    const ops = (Array.isArray(opOrOps) ? opOrOps : [opOrOps]).map((o) => ({ id: generateId(), batch, ...o }));
    let nextDoc;
    try {
      nextDoc = applyCatalogOps(catalogDoc, ops);
    } catch (e) {
      return [e.message];
    }
    const errors = validateCatalogDoc(nextDoc);
    if (errors.length) return errors;

    adoptCatalog(nextDoc);
    setCatalogNotice(null);
    push({ key: "catalog", kind: "catalog", payload: { ops } });
    return [];
  }, [push, catalogDoc, adoptCatalog]);

  const savePlan = (imported) => {
    const parsedPlan = planToConfirmed(imported, toConfirmed());
    setPlan(parsedPlan);
    push({ key: "plan", kind: "plan", payload: parsedPlan });
  };

  const saveProfile = (newProfile) => {
    setProfile(newProfile);
    push({ key: "profile", kind: "profile", payload: { profile: newProfile, settings } });
  };

  const saveSettings = (newSettings) => {
    setSettings(newSettings);
    push({ key: "profile", kind: "profile", payload: { profile, settings: newSettings } });
  };

  return {
    sessions,
    profile,
    setProfile: saveProfile,
    settings,
    setSettings: saveSettings,
    plan,
    savePlan,
    // The derived views, or null when there is no usable catalog yet. The RAW
    // document is exposed alongside it because slice 2 edits the document, not
    // the views.
    catalog,
    catalogDoc,
    saveCatalog,
    catalogNotice,
    dismissCatalogNotice: () => setCatalogNotice(null),
    allExerciseNames,
    saveSession,
    deleteSession,
    duplicateSession,
    syncStatus,
    pendingCount,
    parkedCount,
    retryParked: retryParkedEntries,
    retrying,
  };
}
