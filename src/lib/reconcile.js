import { buildCatalogViews, isUsableCatalog } from "./catalog.js";
import { normalizeSessionNames, normalizePlanNames } from "./helpers.js";

/**
 * Merges the cloud snapshot from `pullAll` into the local state, on app load.
 *
 * The cloud copy wins for every entity EXCEPT a dirty one, and the outbox is
 * the dirty set: an entity with a queued or parked entry holds a local write
 * Neon has not confirmed, so the cloud copy of it is older by construction.
 * Because the outbox enqueues before it pushes, a write whose push is still in
 * flight is dirty too.
 *
 * The outbox at response time is NOT enough on its own, though: the pull's
 * snapshot was read on the server some time before the response arrived, and a
 * push that landed in between has already left the outbox while the snapshot
 * still holds the older row. Pass `dirtyDuringPull(...)` as `outbox`.
 *
 * Pure. `local` is `{ sessions, plan, profile, settings, catalog }` (catalog
 * being the raw document the lexique shows); `views` is the views of the
 * CONFIRMED local catalog (the mirror), or null; `cloud` is `pullAll`'s raw
 * response, its `catalog` the document to show and `confirmedCatalog` the
 * server's own document it was replayed from (`rebaseOnPull`). Exercise names
 * in her history are normalised against a confirmed document only, never
 * against one carrying unconfirmed edits: a pending rename stays out of her
 * history until the server has taken it, so a rename that is parked or lost
 * has nothing to take back. Returns the state to commit plus what must be
 * pushed:
 *   repush      — sessions Neon does not have, not already in the outbox
 *   seedPlan    — the local plan, when Neon has none (null otherwise)
 *   seedProfile — true when Neon has no profile row
 */
export function reconcile({ local = {}, cloud = {}, outbox, views = null }) {
  const dirty = dirtyKeys(outbox);

  // Catalog FIRST: every normalisation below reads it, and on a device that
  // has never synced this is the only point at which one exists at all.
  //
  // No dirtiness check here, unlike every other entity: the catalog is
  // decided by VERSION before this runs (`rebaseOnPull`, catalogSync.js), and
  // `cloud.catalog` is what that returned — the server's document with the
  // queued operations replayed on it, or null to keep the local one.
  let catalog = local.catalog ?? null;
  // What names are normalised against: a CONFIRMED document, never the shown
  // one, which may carry queued operations (see above).
  let activeViews = views;
  if (cloud.catalog) {
    const cloudViews = buildCatalogViews(cloud.catalog);
    // Usability is checked BEFORE the cloud document is adopted, not after: a
    // degenerate cloud document (an empty row, say) must not overwrite a
    // working local mirror. Adopting it first and only gating its USE would
    // drop `catalog` to null and the mirror with it — the lexique and the
    // import button then stay stuck behind "réessaie dans un instant" across
    // reloads and offline, since there is nothing left to retry. A missing row
    // (`cloud.catalog` falsy) never reaches this branch at all.
    if (isUsableCatalog(cloudViews)) {
      catalog = cloud.catalog;
      // No `confirmedCatalog`: the caller handed the server's document as is.
      const confirmed = cloud.confirmedCatalog ? buildCatalogViews(cloud.confirmedCatalog) : cloudViews;
      if (isUsableCatalog(confirmed)) activeViews = confirmed;
    }
  }

  // Whatever mounted before a catalog existed was passed through un-aliased,
  // and a rename confirmed from another device is an alias the local mirror
  // did not have yet. Normalise it now — still ON READ INTO STATE, never as a
  // derive-on-render, because the invariant that makes this work is that
  // every write goes through already-normalised state and so self-migrates to
  // localStorage and Neon on the next save.
  const renormalise = activeViews !== views && isUsableCatalog(activeViews);
  const localSessions = renormalise
    ? normalizeSessionNames(local.sessions ?? [], activeViews)
    : (local.sessions ?? []);
  const localPlan = renormalise ? normalizePlanNames(local.plan ?? null, activeViews) : (local.plan ?? null);

  // Sessions: merge cloud with any local session the cloud does not have.
  // Local-only sessions are kept AND re-pushed, so a workout whose push
  // silently failed is recovered instead of dropped on the next load.
  let sessions = localSessions;
  let repush;
  if (cloud.sessions && cloud.sessions.length > 0) {
    const cloudSessions = normalizeSessionNames(cloud.sessions.map((s) => ({
      id: s.id,
      // Normalize to a plain YYYY-MM-DD like plan dates: Postgres may hand
      // back a full timestamp, which would otherwise shift week bucketing.
      date: String(s.date).split("T")[0],
      name: s.name,
      ...s.data,
    })), activeViews);
    const localById = new Map(localSessions.map((s) => [s.id, s]));
    const cloudIds = new Set(cloudSessions.map((s) => s.id));
    const localOnly = localSessions.filter((s) => !cloudIds.has(s.id));
    const fromCloud = cloudSessions
      // Deleted here, delete not yet confirmed: the cloud copy must not
      // resurrect it.
      .filter((s) => !dirty.has(`session-delete:${s.id}`))
      // Edited here, edit not yet confirmed: the local copy is the newer one.
      .map((s) => (dirty.has(`session:${s.id}`) && localById.has(s.id) ? localById.get(s.id) : s));
    sessions = [...localOnly, ...fromCloud];
    // Trade-off: without delete tombstones a session deleted on another device
    // can reappear — re-syncing a recorded workout is preferred over
    // permanently losing it. A session already in the outbox is NOT re-pushed:
    // it is on its way, and a fresh entry would also supersede a parked one,
    // silently retrying what the server refused.
    repush = localOnly.filter((s) => !dirty.has(`session:${s.id}`));
  } else {
    // Neon has no session at all: seed it with every local one.
    repush = localSessions.filter((s) => !dirty.has(`session:${s.id}`));
  }

  // Plan
  let plan = localPlan;
  let seedPlan = null;
  if (cloud.plan) {
    if (!dirty.has("plan")) {
      // Cut to a plain YYYY-MM-DD, like session dates: the pull serialises the
      // DATE columns as full ISO timestamps ("2026-09-28T00:00:00.000Z"), and
      // everything downstream compares plan dates as YYYY-MM-DD strings.
      let ws = planDay(cloud.plan.week_start);
      let we = planDay(cloud.plan.week_end);
      // Repair an impossible range from the cloud (end year before start year).
      if (ws && we && we < ws) we = ws.slice(0, 4) + we.slice(4);
      plan = normalizePlanNames({
        weekStart: ws,
        weekEnd: we,
        ...cloud.plan.data,
        raw: cloud.plan.raw,
      }, activeViews);
    }
  } else if (localPlan && !dirty.has("plan")) {
    seedPlan = normalizePlanNames(localPlan, activeViews);
  }

  // Profile and settings travel in ONE entry (`profile`), so a pending write
  // of either protects both.
  const profileDirty = dirty.has("profile");
  const profile = cloud.profile && !profileDirty ? cloud.profile : (local.profile ?? null);
  const settings = cloud.settings && !profileDirty ? cloud.settings : (local.settings ?? null);
  const seedProfile = !cloud.profile && !profileDirty;

  return { sessions, plan, profile, settings, catalog, repush, seedPlan, seedProfile };
}

/**
 * The sessions to commit from a pull, against the state as it stands when the
 * update is APPLIED, for a functional `setSessions`.
 *
 * `reconcile` ran on a snapshot of state. A session saved in the same tick —
 * its `setSessions(prev => …)` queued but not yet rendered into that snapshot
 * — would be erased by committing the snapshot's result as a plain value; it
 * would come back only on the next pull, from the outbox. When state has not
 * moved, the result stands; when it has, the sessions are reconciled again
 * onto what is there now, with `args` (the same `reconcile` input, its
 * `outbox` widened to every key written since) unchanged otherwise.
 */
export function sessionsAfterPull(current, { snapshot, reconciled, args }) {
  if (current === snapshot) return reconciled;
  return reconcile({ ...args, local: { ...args.local, sessions: current } }).sessions;
}

/**
 * A whole-state entity (plan, profile, settings) to commit from a pull, for a
 * functional setter: what state holds NOW when `key` is dirty, the
 * reconciled value otherwise.
 *
 * `reconcile` keeps the LOCAL copy of a dirty entity, but its local copy is
 * the render snapshot. A save made in the same tick as the response — its
 * push already in the outbox, its `setProfile(new)` queued but not rendered —
 * is newer than that snapshot, and committing the snapshot as a plain value
 * erased it from state (the outbox still sent it, so the screen and Neon then
 * disagreed until the next pull). `dirty` is the outbox read at commit time.
 */
export function entityAfterPull(current, { key, dirty, reconciled }) {
  return isDirty(dirty, key) ? current : reconciled;
}

/** Whether the outbox `outbox` holds a queued or parked write for `key`. */
export function isDirty(outbox, key) {
  return dirtyKeys(outbox).has(key);
}

/**
 * The dirty set for one pull: every key the outbox held when the request left
 * (`atSend`), every key written while it was in flight (`written`), and every
 * key it holds when the response arrives (`atResponse`). A write in any of the
 * three is at least as new as the pull's snapshot, whether or not Neon has
 * confirmed it since — confirmed during the round trip means the snapshot may
 * predate it. Returned in the outbox's shape, for `reconcile`.
 */
export function dirtyDuringPull({ atSend, written = [], atResponse }) {
  const keys = new Set([...dirtyKeys(atSend), ...written, ...dirtyKeys(atResponse)]);
  return { queue: [...keys].map((key) => ({ key })), parked: [] };
}

// A plan date as YYYY-MM-DD, whether it arrives as a date string, an ISO
// timestamp string or a Date. Null and undefined pass through.
function planDay(value) {
  if (value == null || value === "") return value;
  return (typeof value === "string" ? value : new Date(value).toISOString()).slice(0, 10);
}

function dirtyKeys(outbox) {
  return new Set([...(outbox?.queue ?? []), ...(outbox?.parked ?? [])].map((e) => e.key));
}
