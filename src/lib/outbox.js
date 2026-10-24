/**
 * The sync outbox: every write bound for Neon, as plain data.
 *
 * It replaces an in-memory queue of closures that captured the payload of the
 * moment a push failed, lived only as long as the tab, dropped an item after
 * three attempts, and replayed stale writes over newer ones. Here an entry
 * carries the LATEST payload for its entity, survives a reload (the caller
 * persists the whole object), and is never dropped for having failed.
 *
 * Shape: `{ queue: Entry[], parked: Entry[], lastSeq: number }`, where an entry
 * is `{ key, kind, payload, attempts, serverErrors, seq, at, retry? }`. `key` names the entity —
 * `session:<id>`, `session-delete:<id>`, `plan`, `profile`, `catalog` — and is
 * what makes the outbox latest-per-entity. The one exception is `catalog`:
 * operations put back by « Réessayer » are queued as their own entry
 * (`retry: true`) ahead of the edits queued since, see `unpark`. `seq` is a counter carried by the
 * outbox itself, so ordering survives a reload without reading a clock.
 *
 * Writes are enqueued BEFORE their push is attempted and removed only once it
 * succeeds, so the queue is the true dirty set, in-flight writes included.
 *
 * Pure: no React, no storage, no clock. `at` is whatever the caller passes.
 */

import { timeoutSignal } from "./timeoutSignal.js";

export const EMPTY_OUTBOX = Object.freeze({ queue: [], parked: [], lastSeq: 0 });

// The counter is persisted as `lastSeq`; an outbox written before it existed
// (or built by hand) still yields a seq above every entry it holds.
function lastSeqOf(outbox) {
  const seen = [...(outbox.queue ?? []), ...(outbox.parked ?? [])].map((e) => e.seq ?? 0);
  return Math.max(outbox.lastSeq ?? 0, 0, ...seen);
}

// A session upsert and a delete of the same session cancel each other: only
// the most recent intent about that session is worth sending.
function opposingKey(key) {
  if (key.startsWith("session:")) return `session-delete:${key.slice("session:".length)}`;
  if (key.startsWith("session-delete:")) return `session:${key.slice("session-delete:".length)}`;
  return null;
}

// A `catalog` entry is a list of edit operations, not a whole document, so a
// second edit APPENDS to the queued one — replacing it would lose the first.
function accumulates(kind) {
  return kind === "catalog";
}

export function enqueue(outbox, entry) {
  const seq = lastSeqOf(outbox) + 1;
  const opposing = opposingKey(entry.key);
  const queue = outbox.queue ?? [];
  const parked = outbox.parked ?? [];

  // Catalog operations join the LATEST ordinary entry for the key, never a
  // retried one: retried operations may be refused again, and whatever is
  // merged into them is parked with them.
  const existing = accumulates(entry.kind)
    ? latestOrdinary(queue, entry.key)
    : queue.find((e) => e.key === entry.key);

  let payload = entry.payload;
  if (accumulates(entry.kind) && existing && accumulates(existing.kind)) {
    payload = { ...entry.payload, ops: [...(existing.payload?.ops ?? []), ...(entry.payload?.ops ?? [])] };
  }

  const isSuperseded = accumulates(entry.kind)
    ? (e) => e === existing
    : (e) => e.key === entry.key || e.key === opposing;
  // The replaced entry's 5xx count is inherited (`MAX_SERVER_ERRORS`): an
  // entity she re-saves between retries otherwise restarts at zero every time
  // and never parks. Same key only — never the opposing session write, a
  // different request whose failures say nothing about this one.
  const serverErrors = existing?.key === entry.key ? (existing.serverErrors ?? 0) : 0;
  return {
    queue: [
      ...queue.filter((e) => !isSuperseded(e)),
      { at: entry.at ?? null, ...entry, payload, attempts: 0, serverErrors, seq },
    ],
    // A parked whole-state write is superseded by a newer one for the same
    // entity: the new payload already holds everything the refused one did.
    // Parked catalog OPS are not — they are edits the new list does not
    // repeat — so they stay parked until she retries them.
    parked: accumulates(entry.kind) ? parked : parked.filter((e) => !isSuperseded(e)),
    lastSeq: seq,
  };
}

// The operations of `entry` that are NOT among `sent`'s. An edit made while a
// catalog push is in flight is merged into that entry (`enqueue`), so once
// the push is settled only the operations it did not carry are still owed.
// Operations carry an `id`; without one, the merge appended, so the sent
// ones are a prefix.
function opsNotIn(entry, sent) {
  const ops = entry.payload?.ops ?? [];
  const sentOps = sent?.payload?.ops ?? [];
  if (sentOps.every((o) => o?.id != null)) {
    const ids = new Set(sentOps.map((o) => o.id));
    return ops.filter((o) => !ids.has(o?.id));
  }
  return ops.slice(sentOps.length);
}

// The queued catalog entry for `key` that new operations may join: the
// newest one that is not a retry.
function latestOrdinary(queue, key) {
  return queue
    .filter((e) => e.key === key && accumulates(e.kind) && !e.retry)
    .reduce((a, b) => (a && a.seq > b.seq ? a : b), null);
}

// The queued entry for `sent.key` that superseded `sent` while it was in
// flight — only meaningful for an accumulating kind, whose newer entry still
// holds `sent`'s operations. With operation ids, it is the entry that holds
// any of them (a retried entry under the same key holds none); without, the
// latest ordinary one, as the merge left it.
function supersededBy(queue, sent) {
  if (!sent || !accumulates(sent.kind)) return null;
  const others = queue.filter((e) => e.key === sent.key && e.seq !== sent.seq && accumulates(e.kind));
  const sentOps = sent.payload?.ops ?? [];
  if (sentOps.length && sentOps.every((o) => o?.id != null)) {
    const ids = new Set(sentOps.map((o) => o.id));
    return others.find((e) => (e.payload?.ops ?? []).some((o) => ids.has(o?.id))) ?? null;
  }
  return latestOrdinary(others, sent.key);
}

/**
 * Records that `sent`, the entry that was pushed, landed: it is removed only
 * if it is still there under its own `seq`.
 *
 * Otherwise something replaced it in flight. For an accumulating kind, the
 * newer entry that absorbed it loses the operations it carried and keeps the
 * rest — sending them twice would add an exercise twice.
 */
export function complete(outbox, sent) {
  const { key, seq } = sent;
  const found = outbox.queue.some((e) => e.key === key && e.seq === seq);
  const queue = outbox.queue.filter((e) => !(e.key === key && e.seq === seq));
  // Still there under its own seq: nothing absorbed it. Other catalog entries
  // under the key (a retry, or edits queued behind one) are not its business.
  if (found) return { ...outbox, queue };
  // Superseded in flight. The replacement inherited `sent`'s 5xx count at
  // `enqueue`; this success ends that streak, or it parks after a single 5xx.
  if (!accumulates(sent.kind)) {
    return { ...outbox, queue: queue.map((e) => (e.key === key ? { ...e, serverErrors: 0 } : e)) };
  }
  const newer = supersededBy(queue, sent);
  if (!newer) return { ...outbox, queue };
  const rest = opsNotIn(newer, sent);
  return {
    ...outbox,
    queue: rest.length
      ? queue.map((e) => (e === newer ? { ...e, payload: { ...e.payload, ops: rest }, serverErrors: 0 } : e))
      : queue.filter((e) => e !== newer),
  };
}

/** The operations queued (not parked) under `key`, across its entries, in replay order. */
export function queuedOps(outbox, key) {
  return (outbox?.queue ?? [])
    .filter((e) => e.key === key)
    .sort((a, b) => a.seq - b.seq)
    .flatMap((e) => e.payload?.ops ?? []);
}

/**
 * What the line should do after a failed push.
 *   auth      — 401: stop, change nothing; the credential is the problem.
 *   refused   — any other 4xx (a 409 that escaped its executor included): the
 *               server will never accept this payload, so park it and go on.
 *   transient — 5xx, 408, 429, a network failure, or no status: retry later,
 *               in order. 408 (the request timed out) and 429 (too many
 *               requests) are 4xx by number only: they say "not now", nothing
 *               about the payload, and parking on them would shelve a good
 *               write until she taps « Réessayer ».
 */
const RETRYABLE_4XX = new Set([408, 429]);

export function classify(err) {
  const status = err?.status;
  if (status === 401) return "auth";
  if (RETRYABLE_4XX.has(status)) return "transient";
  if (typeof status === "number" && status >= 400 && status < 500) return "refused";
  return "transient";
}

/**
 * How many times the server may ANSWER an entry with a 5xx before it is
 * parked rather than retried again.
 *
 * The endpoints answer a failure the same payload will hit again with a 400
 * (`writeErrorStatus`), but a 500 can still be permanent — a bug, a payload
 * the database chokes on in a way no SQLSTATE class names — and a transient
 * failure stops the line, so a permanent one would block every write queued
 * behind it, silently and for good.
 *
 * Ten is about five minutes of a server that is up and still refuses this one
 * entry, at the hook's 30 s retry (sooner if she keeps saving). A real outage
 * that long parks writes too, and that is the cheaper error: parking keeps the
 * payload, « Réessayer » puts it back, and a newer write to the same entity
 * supersedes a parked whole-state entry anyway. A failure with NO status — the
 * device is offline — never counts: it says nothing about the entry, and a
 * séance recorded in a basement must not end up parked.
 */
export const MAX_SERVER_ERRORS = 10;

function isServerAnswer(err) {
  return typeof err?.status === "number" && err.status >= 500;
}

function bump(outbox, key, seq, err) {
  const counts = isServerAnswer(err);
  return {
    ...outbox,
    queue: outbox.queue.map((e) =>
      e.key === key && e.seq === seq
        ? { ...e, attempts: e.attempts + 1, serverErrors: (e.serverErrors ?? 0) + (counts ? 1 : 0) }
        : e
    ),
  };
}

// The entry that replaced `sent` while it was in flight and inherits its 5xx
// count: for a catalog entry the one holding its operations (`supersededBy`),
// otherwise the entry now queued under the SAME key. Not the opposing session
// write: a delete that replaced an upsert is another request to another
// endpoint, and the upsert's failures say nothing about it.
function replacementOf(queue, sent) {
  if (accumulates(sent.kind)) return supersededBy(queue, sent);
  return queue.find((e) => e.key === sent.key) ?? null;
}

/**
 * Hands a superseded entry's 5xx count to the entry that replaced it, plus
 * this answer when it is one, so `MAX_SERVER_ERRORS` still counts across
 * replacements. Never lowers a count the replacement already holds.
 */
function carryServerErrors(outbox, sent, err) {
  const next = replacementOf(outbox.queue, sent);
  if (!next) return outbox;
  const carried = (sent.serverErrors ?? 0) + (isServerAnswer(err) ? 1 : 0);
  if (carried <= (next.serverErrors ?? 0)) return outbox;
  return { ...outbox, queue: outbox.queue.map((e) => (e === next ? { ...e, serverErrors: carried } : e)) };
}

function exhausted(outbox, key, seq) {
  const entry = outbox.queue.find((e) => e.key === key && e.seq === seq);
  return (entry?.serverErrors ?? 0) >= MAX_SERVER_ERRORS;
}

function park(outbox, key, seq, sent = null) {
  const entry = outbox.queue.find((e) => e.key === key && e.seq === seq);
  if (!entry) {
    // Superseded while in flight. A whole-state write: the newer entry carries
    // the entity's latest state, so the refused one has nothing left to save.
    // Catalog operations: the newer entry holds the refused ones AND the edits
    // made since — park the refused ones, let the rest go out.
    const newer = supersededBy(outbox.queue, sent);
    if (!newer) return outbox;
    const rest = opsNotIn(newer, sent);
    const queue = rest.length
      ? outbox.queue.map((e) => (e === newer ? { ...e, payload: { ...e.payload, ops: rest } } : e))
      : outbox.queue.filter((e) => e !== newer);
    return { ...outbox, queue, parked: addParked(outbox.parked, sent) };
  }
  return {
    ...outbox,
    queue: outbox.queue.filter((e) => e !== entry),
    parked: addParked(outbox.parked, entry),
  };
}

// One parked entry per key. A refused whole-state write replaces the older
// refused one; refused catalog operations JOIN the ones already parked, since
// each list holds edits the other does not.
function addParked(parked = [], entry) {
  const existing = parked.find((e) => e.key === entry.key);
  const others = parked.filter((e) => e.key !== entry.key);
  if (existing && accumulates(entry.kind) && accumulates(existing.kind)) {
    const ops = [...(existing.payload?.ops ?? []), ...(entry.payload?.ops ?? [])];
    return [...others, { ...entry, payload: { ...entry.payload, ops } }];
  }
  return [...others, entry];
}

/**
 * Moves a parked entry back to the queue (the « Réessayer » tap).
 *
 * Parked catalog operations go back as THEIR OWN entry, marked `retry`, ahead
 * of the catalog edits queued since — never merged into them. They used to be
 * merged, and they are the operations most likely to be refused again: a
 * second refusal then parked the merged entry whole, and the edits she had
 * made since went with it (and out of the lexique, which shows only what is
 * still queued). Ahead, because they are older: « désactiver » parked then
 * « réactiver » queued must end active, as she last asked. The queued entries
 * are renumbered behind the retry; one already in flight is still recognised
 * by its operation ids when it settles (`supersededBy`).
 *
 * `keepOps(ops)`, when given, decides which of a parked catalog entry's
 * operations go back at all (`pruneSupersededEdits`). It gets the operations
 * and nothing else, on purpose: the queued edits must never decide it, since
 * the retry goes out AHEAD of them and a queued edit already wins by order.
 * This is the ONE place a retried operation is dropped, so the queue, the
 * lexique replaying it and the executor sending it agree. An entry left with
 * no operation is simply gone.
 */
export function unpark(outbox, key, { keepOps } = {}) {
  const entry = (outbox.parked ?? []).find((e) => e.key === key);
  if (!entry) return outbox;
  const { attempts: _attempts, serverErrors: _serverErrors, seq: _seq, ...base } = entry;
  const without = { ...outbox, parked: outbox.parked.filter((e) => e !== entry) };
  if (!accumulates(entry.kind)) return enqueue(without, base);

  const ops = keepOps ? keepOps(base.payload?.ops ?? []) : (base.payload?.ops ?? []);
  if (!ops.length) return without;
  const rest = { ...base, payload: { ...base.payload, ops } };

  let seq = lastSeqOf(without);
  const queue = without.queue ?? [];
  const behind = queue
    .filter((e) => e.key === entry.key)
    .sort((a, b) => a.seq - b.seq);
  const retry = { at: rest.at ?? null, ...rest, retry: true, attempts: 0, serverErrors: 0, seq: ++seq };
  const renumbered = behind.map((e) => ({ ...e, seq: ++seq }));
  return {
    ...without,
    queue: [...queue.filter((e) => e.key !== entry.key), retry, ...renumbered],
    lastSeq: seq,
  };
}

/**
 * Parked entries back to the queue, in the order they were parked: every one,
 * or with `keys` only those — the ones the « Réessayer » she tapped was
 * showing, not whatever another tab parked since. `options` go to `unpark`.
 */
export function unparkAll(outbox, keys = null, options = {}) {
  const only = keys ? new Set(keys) : null;
  return (outbox.parked ?? [])
    .filter((e) => !only || only.has(e.key))
    .reduce((o, e) => unpark(o, e.key, options), outbox);
}

/**
 * « Réessayer »: `unparkAll` as a read-modify-write of `store`, run UNDER the
 * drain lock. While this tab holds it no catalog push is in flight in any tab,
 * so everything that will land before the retry is already in the confirmed
 * log, and `keepOps` may prune against that log alone — no in-flight record to
 * go stale when a tab dies mid-push. A tab's own drain holding the lock simply
 * finishes first.
 *
 * The lock is taken only when a retried key accumulates operations (the
 * catalog, the one entry with `keepOps` pruning). A session, plan or profile
 * key has no pruning to protect, so it is unparked directly and never waits
 * behind a push.
 *
 * `options.active`, when given, is asked once the lock is held: false (the
 * hook unmounted while waiting) means nothing is unparked and the call
 * resolves `false`.
 *
 * Resolves `false` when the lock wait ran out (`DRAIN_BUSY`): nothing was
 * unparked and `keepOps` never ran — the retry is NEVER done without the lock,
 * so the entries stay parked and « Réessayer » stays on screen. Without the
 * Locks API `withDrainLock` runs it unserialised, and a push in flight in
 * another tab is then not seen: an older retried edit can be replayed over a
 * newer one in flight from another tab (rare; iPadOS has `navigator.locks`).
 * The catalog's 409 replay still protects the document's consistency, but the
 * newer edit can lose.
 */
export async function retryParkedUnderLock(store, keys, options = {}, locks, lockOptions) {
  const { active, ...unparkOptions } = options ?? {};
  const only = keys ? new Set(keys) : null;
  const needsLock = (store.get().parked ?? []).some((e) => (!only || only.has(e.key)) && accumulates(e.kind));
  const run = () => {
    if (active && !active()) return false;
    store.set(unparkAll(store.get(), keys, unparkOptions));
    return true;
  };
  if (!needsLock) return run();
  const done = await withDrainLock(run, locks, lockOptions);
  // `DRAIN_BUSY` (the wait ran out) is not `true`, so it reads as not done.
  return done === true;
}

/**
 * Single-flight over a caller-held `flag` (`{ current: boolean }`, a React
 * ref in the hook): resolves `undefined` without calling `fn` while a call is
 * pending, else runs it. `onChange(pending)` is told when the state flips, so
 * a button can disable itself.
 */
export async function singleFlight(flag, fn, onChange = () => {}) {
  if (flag.current) return undefined;
  flag.current = true;
  onChange(true);
  try {
    return await fn();
  } finally {
    flag.current = false;
    onChange(false);
  }
}

/**
 * The outbox to read-modify-write against: what storage holds NOW, not this
 * tab's copy of it.
 *
 * Two tabs (or a tab and the installed PWA) share one localStorage outbox.
 * Each used to keep the outbox in memory, read once at mount, and write the
 * whole object back from that copy — so each write erased whatever the other
 * had enqueued or completed since, and catalog operations, which live nowhere
 * but the outbox, were lost outright. Storage is the shared truth; the cached
 * copy is only for when storage cannot be trusted:
 *   - `stored` is undefined: storage could not be read at all;
 *   - `storageBehind`: this tab's last write failed (quota), so storage is
 *     older than the cache, and reading it would drop that write.
 * `stored` null means storage holds no outbox, which is an empty one.
 */
export function currentOutbox({ stored, cached, storageBehind = false }) {
  if (storageBehind || stored === undefined) return cached ?? EMPTY_OUTBOX;
  if (stored === null) return EMPTY_OUTBOX;
  if (typeof stored !== "object" || Array.isArray(stored)) return cached ?? EMPTY_OUTBOX;
  const queue = Array.isArray(stored.queue) ? stored.queue : [];
  const parked = Array.isArray(stored.parked) ? stored.parked : [];
  return { queue, parked, lastSeq: lastSeqOf({ ...stored, queue, parked }) };
}

/**
 * A `{ get, set }` store over a shared persisted outbox (see `currentOutbox`).
 * `get` re-reads storage every time, and `drainWith` and `enqueue` always
 * apply their change to a fresh `get()`, so every write is a read-modify-
 * write of what is there now — synchronous, so nothing in this tab can
 * interleave with it. `read` is `storage.readOutbox`, `write` is
 * `storage.saveOutbox` (false on failure); injected, so this stays pure.
 */
export function createOutboxStore({ read, write }) {
  let cached = currentOutbox({ stored: read(), cached: EMPTY_OUTBOX });
  let storageBehind = false;
  return {
    get() {
      cached = currentOutbox({ stored: read(), cached, storageBehind });
      return cached;
    },
    set(next) {
      cached = next;
      storageBehind = write(next) === false;
    },
  };
}

export const DRAIN_LOCK = "belle-forme-outbox-drain";

/**
 * How long a drain waits for another tab's before giving up on this turn.
 * Longer than one request may take (`REQUEST_TIMEOUT_MS`), so a holder that is
 * merely slow is waited for; bounded, so a holder that never finishes cannot
 * stall this tab's syncing with it.
 */
export const LOCK_WAIT_MS = 30000;

/** What `withDrainLock` returns when the wait ran out: the drain did not run. */
export const DRAIN_BUSY = Object.freeze({ busy: true });

/**
 * Runs `fn` under a Web Lock shared by every tab of the origin, so two tabs
 * never drain at once — otherwise both send the same head entry, and a
 * catalog operation goes out twice. A tab that finds the lock held WAITS for
 * it rather than giving up: an entry it just enqueued may have arrived after
 * the other tab's loop last looked, and the waiting drain then sends it (or
 * finds the queue empty and returns at once).
 *
 * The wait is bounded by `waitMs`. It used to be unbounded, and a holder
 * awaiting a request that never answered held the lock forever, so every
 * other tab's drain queued behind it for good. When the wait runs out this
 * returns `DRAIN_BUSY` without running `fn` — never `fn` unserialised,
 * which is exactly the double send the lock exists to prevent — and the
 * caller retries on its timer.
 *
 * Without the Locks API (an old Safari, an insecure context) or when it
 * refuses the request, `fn` runs unserialised, as it always did: every write
 * the endpoints take is idempotent or version-checked, so a double send
 * costs a round trip, not data.
 */
export async function withDrainLock(fn, locks = globalThis.navigator?.locks, { waitMs = LOCK_WAIT_MS } = {}) {
  if (typeof locks?.request !== "function") return fn();
  let ran = false;
  const { signal, clear } = timeoutSignal(waitMs);
  try {
    return await locks.request(DRAIN_LOCK, { signal }, () => {
      ran = true;
      clear();
      return fn();
    });
  } catch (err) {
    if (ran) throw err;
    if (signal.aborted) return DRAIN_BUSY;
    return fn();
  } finally {
    clear();
  }
}

function asStore(source) {
  if (typeof source?.get === "function" && typeof source?.set === "function") return source;
  let current = source;
  return { get: () => current, set: (o) => { current = o; } };
}

/**
 * Sends queued entries in `seq` order, one at a time.
 *
 * `source` is either an outbox (the result is returned) or a `{ get, set }`
 * store. The store form is what the hook uses: writes keep arriving while a
 * push is awaited, so every result is applied to the CURRENT outbox, never to
 * the snapshot the drain started from.
 *
 * On success the entry is completed. A transient failure bumps `attempts` and
 * stops the line, order kept, with two exceptions. An entry the server has now
 * answered with a 5xx `MAX_SERVER_ERRORS` times is parked like a refusal. An
 * entry superseded while in flight hands its 5xx count to the entry that
 * replaced it (`carryServerErrors`), and the line goes on to that one rather
 * than waiting for the timer. A refusal parks the entry and the line goes on,
 * so one document the server rejects cannot block every write behind it. An
 * auth failure stops the line and changes nothing. Returns the final outbox
 * and, as `stoppedOn`, the class of the failure that stopped it (or null),
 * with that failure as `error` (the 401's `key` is what the app checks).
 *
 * `active`, when given, is asked before each send: once it answers false (the
 * hook unmounted) nothing more goes out. The result of a push already in
 * flight is still recorded — that is what the server now holds.
 *
 * `onPark(entry, err)`, when given, is called once an entry has been parked
 * and the outbox saved, whichever path parked it — a refusal, or the 5xx
 * backstop. What a caller shows from the queue (the lexique replays the
 * queued catalog operations) must be recomputed then: a parked operation is
 * no longer on its way, and the executor that sent it cannot tell a 5xx that
 * will be retried from the tenth one, which parks.
 */
export async function drainWith(source, exec, { active = () => true, onPark = () => {} } = {}) {
  const store = asStore(source);
  let stoppedOn = null;
  let error = null;
  for (;;) {
    if (!active()) break;
    const queue = store.get().queue ?? [];
    if (queue.length === 0) break;
    const head = queue.reduce((a, b) => (b.seq < a.seq ? b : a));
    try {
      await exec(head);
      store.set(complete(store.get(), head));
    } catch (err) {
      const verdict = classify(err);
      if (verdict === "refused") {
        store.set(park(store.get(), head.key, head.seq, head));
        onPark(head, err);
        continue;
      }
      if (verdict === "transient") {
        // Superseded while in flight: the failure was about a payload nothing
        // owes any more, and the entry that replaced it has not been tried.
        // Send it now rather than hold the line for the retry timer — with the
        // count carried over, or an entity she edits faster than a failing
        // server answers starts from zero every time and never parks.
        if (!store.get().queue.some((e) => e.key === head.key && e.seq === head.seq)) {
          store.set(carryServerErrors(store.get(), head, err));
          continue;
        }
        const bumped = bump(store.get(), head.key, head.seq, err);
        if (exhausted(bumped, head.key, head.seq)) {
          store.set(park(bumped, head.key, head.seq, head));
          onPark(head, err);
          continue;
        }
        store.set(bumped);
      }
      stoppedOn = verdict;
      error = err;
      break;
    }
  }
  return { outbox: store.get(), stoppedOn, error };
}

