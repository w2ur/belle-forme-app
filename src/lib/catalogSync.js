/**
 * Sending catalog edits under optimistic concurrency. Pure apart from the
 * injected `push`: no React, no storage.
 *
 * The device keeps two things (`useSessionData`): the MIRROR — the document
 * the server last confirmed, with its `updatedAt` — and the edit OPERATIONS
 * not yet confirmed, queued in the outbox. What the lexique shows is the
 * mirror with the operations replayed on top. The server takes a document
 * only if it was built on the row's current version; otherwise it answers 409
 * with the row, and the operations are replayed onto THAT. Before this, the
 * PUT stored whatever document arrived, and an iPad holding an old copy erased
 * every edit made elsewhere since.
 */
import { applyCatalogOps, unappliedOps, opExerciseNames } from "./catalogForm.js";
import { validateCatalogDoc, buildCatalogViews, isUsableCatalog } from "./catalog.js";
import { queuedOps } from "./outbox.js";

/**
 * The operations cannot be applied to what the server holds now — a rename
 * whose target appeared meanwhile, an exercise deleted elsewhere, or a second
 * stale answer in a row. `status: 409`, so the outbox parks the entry (her
 * operations kept, « Réessayer » replays them) rather than retrying forever.
 * `server` is the server's `{ doc, updatedAt }` when known.
 */
export class CatalogConflictError extends Error {
  constructor(server) {
    super("Le catalogue a changé ailleurs — ta modification n'a pas pu être appliquée.");
    this.name = "CatalogConflictError";
    this.status = 409;
    this.server = server ?? null;
  }
}

function serverOf(err) {
  const body = err?.body;
  return body && typeof body === "object" ? { doc: body.doc ?? null, updatedAt: body.updatedAt ?? null } : null;
}

/**
 * Pushes `ops` replayed onto `base`, rebasing ONCE onto the server's document
 * if the base turns out stale.
 *
 * @param {{doc: object, updatedAt: string|null}|null} base - the mirror.
 * @param {Array} ops - the queued operations, in order.
 * @param {(body: {doc, baseUpdatedAt}) => Promise<{updatedAt}>} push
 * @returns {Promise<{doc: object, updatedAt: string|null}>} the server's new state.
 * @throws {CatalogConflictError} when the operations cannot be applied (parked).
 * @throws any other push failure unchanged (retried by the outbox); after a
 *   rebase it carries `server`, the state the retry was built on.
 */
export async function sendCatalogOps({ base, ops, push }) {
  // A document built from no base would be the queued operations applied to
  // nothing — one exercise, replacing the whole catalog. Never sent.
  if (!base?.doc) throw new CatalogConflictError(null);

  // Every operation is already in the confirmed document — a pull adopted the
  // commit whose response was lost. Nothing is owed; a PUT would only bump
  // the version.
  if (unappliedOps(base.doc, ops).length === 0) return { doc: base.doc, updatedAt: base.updatedAt ?? null };

  // An operation that no longer applies to the mirror (an edit of an exercise
  // a pull showed was deleted elsewhere) is a conflict, not a failure to
  // retry: thrown raw it would carry no status, read as transient, and hold
  // the head of the outbox forever.
  let doc;
  try {
    doc = applyCatalogOps(base.doc, ops);
  } catch {
    throw new CatalogConflictError(null);
  }
  try {
    const res = await push({ doc, baseUpdatedAt: base.updatedAt ?? null });
    return { doc, updatedAt: res?.updatedAt ?? null };
  } catch (err) {
    if (err?.status !== 409) throw err;
    const server = serverOf(err);
    if (!server?.doc) throw new CatalogConflictError(server);

    // The stale base may be our own commit whose response was lost: the
    // server's document then already lists these operations, and replaying
    // skips them (`appliedOps`) instead of applying them twice.
    if (unappliedOps(server.doc, ops).length === 0) return { doc: server.doc, updatedAt: server.updatedAt };

    let replayed;
    try {
      replayed = applyCatalogOps(server.doc, ops);
    } catch {
      throw new CatalogConflictError(server);
    }
    if (validateCatalogDoc(replayed).length) throw new CatalogConflictError(server);

    try {
      const res = await push({ doc: replayed, baseUpdatedAt: server.updatedAt });
      return { doc: replayed, updatedAt: res?.updatedAt ?? null };
    } catch (retryErr) {
      // Stale twice in a row: something else is writing right now. Park
      // rather than loop; « Réessayer » replays onto whatever is there then.
      if (retryErr?.status === 409) throw new CatalogConflictError(serverOf(retryErr) ?? server);
      retryErr.server = server;
      throw retryErr;
    }
  }
}

/**
 * The document the lexique shows: `doc` with `ops` replayed on it, or `doc`
 * alone when the replay throws or no longer validates (those operations are
 * then on their way to a 409 and a park, and showing a broken document in the
 * meantime would be worse than showing the confirmed one).
 */
export function replayCatalog(doc, ops) {
  if (!doc) return null;
  if (!ops?.length) return doc;
  try {
    const next = applyCatalogOps(doc, ops);
    return validateCatalogDoc(next).length ? doc : next;
  } catch {
    return doc;
  }
}

/**
 * The server state an executor should write to the mirror, or null to leave
 * the mirror alone.
 *
 * The mirror is shared by every tab, and a push settles long after it left:
 * another tab may have confirmed a newer version meanwhile. Writing this
 * push's result over it would move the mirror BACKWARDS — the next push is
 * then built on a stale base and refused, and the lexique replays onto a
 * document older than one the server already confirmed. Only a strictly
 * newer version replaces the one held; a mirror with no document always
 * takes it.
 *
 * @param {{doc, updatedAt}|null} held - the mirror as storage holds it now.
 * @param {{doc, updatedAt}|null} candidate - what this push learned.
 */
export function mirrorToSave(held, candidate) {
  if (!candidate?.doc) return null;
  if (!held?.doc) return candidate;
  return isNewer(candidate.updatedAt, held.updatedAt) ? candidate : null;
}

/**
 * What the lexique shows: the confirmed mirror with every catalog operation
 * still QUEUED in `outbox` replayed on it — parked ones excluded, since they
 * are not on their way. Recomputed whenever that set changes: a push settles,
 * an entry is parked, or « Réessayer » puts parked ones back in the queue.
 */
export function catalogView(mirror, outbox) {
  return replayCatalog(mirror?.doc ?? null, queuedOps(outbox, "catalog"));
}

/**
 * The catalog the exercise names in her history are normalised against: the
 * MIRROR's views, or null when it holds no usable document.
 *
 * Never the lexique's document. That one carries the queued operations, and a
 * rename normalised into her history before the server took it had to be
 * taken back out when it was parked — by pushing every past session holding
 * the exercise, and the plan, as writes she never made. A pending rename now
 * shows in the lexique only; once confirmed, its alias reaches her history
 * the ordinary way (alias → current name, on read).
 */
export function confirmedViews(mirror) {
  const views = mirror?.doc ? buildCatalogViews(mirror.doc) : null;
  return isUsableCatalog(views) ? views : null;
}

/**
 * The renames the lexique shows but the server has not confirmed, as
 * `{ newName: confirmedName }`: an alias in `shownDoc` absent from
 * `confirmedDoc` whose old name is still an exercise there. A chain of pending
 * renames maps its last name straight back to the confirmed one.
 *
 * Applied to what she SAVES (`sessionToConfirmed`, `planToConfirmed`). A plan
 * the coach wrote is resolved against the lexique, and the séance picker
 * offers its names, so both could reach Neon under a name the server does not
 * know yet; if that rename then never landed, her history was split for good.
 * Saved under the confirmed name, it needs nothing taken back when the rename
 * parks, and the alias renames it the ordinary way once confirmed.
 */
export function pendingRenames(shownDoc, confirmedDoc) {
  const shown = shownDoc?.aliases ?? {};
  const held = confirmedDoc?.aliases ?? {};
  const confirmedNames = new Set((confirmedDoc?.exercises ?? []).map((ex) => ex?.name));
  const map = {};
  for (const [from, to] of Object.entries(shown)) {
    // A target that is itself a confirmed exercise (delete B + rename A→B,
    // both pending) is mapped all the same: a NEW séance logged on the picker's
    // name is the frequent case and must go under the rename's source. The
    // rare residual is re-editing an OLD session of the deleted-then-reused
    // name, which lands under A (see the belle-forme-catalog skill).
    if (!Object.hasOwn(held, from) && confirmedNames.has(from) && to !== from) map[to] = from;
  }
  return map;
}

/** `session` with every pending new name (`pendingRenames`) put back to its confirmed one. */
export function sessionToConfirmed(session, map) {
  if (!Array.isArray(session?.exercises) || !Object.keys(map ?? {}).length) return session;
  return {
    ...session,
    exercises: session.exercises.map((e) => (Object.hasOwn(map, e?.name) ? { ...e, name: map[e.name] } : e)),
  };
}

/** Same, for each of a plan's sessions. */
export function planToConfirmed(plan, map) {
  if (!Array.isArray(plan?.sessions)) return plan;
  return { ...plan, sessions: plan.sessions.map((s) => sessionToConfirmed(s, map)) };
}

/**
 * When an operation was MADE, read off its id (`generateId`: `s_<ms>_<rand>`),
 * or null for one with no readable time (built before ids existed).
 */
export function opTime(op) {
  const m = /^s_(\d+)_/.exec(typeof op?.id === "string" ? op.id : "");
  return m ? Number(m[1]) : null;
}

/** How many confirmed operations this device remembers for `pruneSupersededEdits`. */
export const CONFIRMED_LOG_LIMIT = 200;

// The operations this module can order against each other.
const EDIT_OPS = new Set(["upsertExercise", "applyRename", "deleteExercise", "setExerciseActive"]);

/**
 * `{ t, names }` for each edit operation with a readable time: what
 * `pruneSupersededEdits` compares an older edit against.
 */
export function overrideEntries(ops) {
  return (ops ?? [])
    .filter((op) => EDIT_OPS.has(op?.op))
    .map((op) => ({ t: opTime(op), names: opExerciseNames(op) }))
    .filter((e) => e.t != null && e.names.length);
}

/**
 * The log entries for operations the server just confirmed, appended to
 * `log` and bounded (`overrideEntries`).
 */
export function logConfirmedOps(log, ops) {
  return [...(Array.isArray(log) ? log : []), ...overrideEntries(ops)].slice(-CONFIRMED_LOG_LIMIT);
}

/**
 * Operations grouped into the EDITS she made: one save (`saveCatalog`) gives
 * its operations a shared `batch`, and a rename is two of them — the alias,
 * then the entry under its new name. An operation with no `batch` (built
 * before batches existed) is an edit on its own. Order is kept.
 */
export function editsOf(ops) {
  const edits = [];
  const byBatch = new Map();
  for (const op of ops ?? []) {
    const batch = typeof op?.batch === "string" ? op.batch : null;
    if (batch && byBatch.has(batch)) {
      byBatch.get(batch).push(op);
      continue;
    }
    const edit = [op];
    edits.push(edit);
    if (batch) byBatch.set(batch, edit);
  }
  return edits;
}

/**
 * The parked operations still worth putting back in the queue, decided once,
 * when « Réessayer » unparks them, and by whole EDIT rather than operation by
 * operation.
 *
 * A parked edit is older than anything she did since. Sent as it was, it
 * lands last and undoes a newer edit of the same exercise — one she re-made
 * by hand after the park, or one that landed before the retry ran. So an edit is
 * dropped when ANY later operation names the same exercise, whatever either
 * of them writes. A toggle included: an upsert, a rename or a delete carries
 * the whole entry, active flag and deactivation stamp with it, so kept under
 * a later « désactiver » it reactivated the exercise she had just switched
 * off. Dropping it whole is the simpler rule, and the notice names it, so she
 * re-makes the part she still wants. "Later" is the time each operation was
 * MADE (`opTime`). `overriders` is THIS DEVICE's log of confirmed operations (an
 * edit confirmed from another device is not in it)
 * (`logConfirmedOps`) — what has LANDED, which under the drain lock is
 * everything that precedes the retry. Never the operations merely queued.
 *
 * Whole edits, because a rename is two operations and only one of them names
 * the old exercise: dropped one at a time, the alias went and the entry under
 * the new name stayed, so the retry could never apply. Deciding here, once,
 * means the outbox entry, the lexique (which replays what is queued) and the
 * executor (which sends what is queued) all see the same operations. An edit
 * with an operation of no readable time is kept: it cannot be ordered.
 *
 * @returns {{kept: Array, dropped: Array<Array>}} the operations to queue, in
 *   order, and the dropped edits, for the notice that names them.
 */
export function pruneSupersededEdits(ops, overriders) {
  const later = Array.isArray(overriders) ? overriders : [];
  const kept = [];
  const dropped = [];
  for (const edit of editsOf(ops)) {
    const times = edit.map(opTime);
    if (times.some((t) => t == null)) {
      kept.push(...edit);
      continue;
    }
    const t = Math.min(...times);
    const names = new Set(edit.flatMap(opExerciseNames));
    const overridden = later.some((e) => e.t > t && (e.names ?? []).some((n) => names.has(n)));
    (overridden ? dropped : kept).push(...(overridden ? [edit] : edit));
  }
  return { kept, dropped };
}

/** One dropped edit, as the user would name it. */
function describeEdit(edit) {
  const rename = edit.find((op) => op?.op === "applyRename");
  if (rename) return `renommage de « ${rename.args?.[0]} » en « ${rename.args?.[1]} »`;
  const op = edit[0];
  const name = opExerciseNames(op).at(-1) ?? "?";
  switch (op?.op) {
    case "setExerciseActive": return `${op.args?.[1] ? "réactivation" : "désactivation"} de « ${name} »`;
    case "deleteExercise": return `suppression de « ${name} »`;
    case "upsertExercise": return op.args?.[1] == null ? `ajout de « ${name} »` : `modification de « ${name} »`;
    default: return `modification de « ${name} »`;
  }
}

/**
 * The notice after a « Réessayer »: the new one when it dropped something,
 * else the current one untouched — a retry that dropped nothing never clears
 * the notice of an earlier tap.
 */
export function retryNotice(current, dropped) {
  return dropped?.length > 0 ? supersededNotice(dropped) : current;
}

/** The notice for the edits `pruneSupersededEdits` dropped, or null. */
export function supersededNotice(dropped) {
  if (!dropped?.length) return null;
  const list = dropped.map(describeEdit).join(" ; ");
  return dropped.length > 1
    ? `Pas renvoyées, des modifications plus récentes les ont remplacées : ${list}.`
    : `Pas renvoyée, une modification plus récente l'a remplacée : ${list}.`;
}

function isNewer(candidate, than) {
  if (than == null) return true;
  if (candidate == null) return false;
  const a = Date.parse(candidate);
  const b = Date.parse(than);
  if (Number.isNaN(b)) return true;
  return !Number.isNaN(a) && a > b;
}

/**
 * The catalog half of the pull. The server's document becomes the new mirror
 * only if it is NEWER than the one held — a push confirmed during the pull
 * has already moved the mirror past the pull's snapshot — and the operations
 * still queued are replayed on it, so an unconfirmed edit is neither lost nor
 * blocks the device from seeing what changed elsewhere.
 *
 * @returns {{mirror: {doc, updatedAt}, doc: object}|null} null to keep what is held.
 */
export function rebaseOnPull({ mirror, cloudDoc, cloudUpdatedAt, ops }) {
  if (!cloudDoc) return null;
  if (mirror?.doc && !isNewer(cloudUpdatedAt, mirror.updatedAt)) return null;
  const next = { doc: cloudDoc, updatedAt: cloudUpdatedAt ?? null };
  return { mirror: next, doc: replayCatalog(cloudDoc, ops) };
}
