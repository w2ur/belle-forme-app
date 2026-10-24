import { describe, it, expect, vi } from "vitest";
import { sendCatalogOps, replayCatalog, rebaseOnPull, mirrorToSave, catalogView, confirmedViews, CatalogConflictError,
  pendingRenames, retryNotice, sessionToConfirmed, planToConfirmed,
  opTime, logConfirmedOps, editsOf, pruneSupersededEdits, supersededNotice, CONFIRMED_LOG_LIMIT,
} from "./catalogSync.js";
import { classify, enqueue, drainWith, unparkAll, queuedOps } from "./outbox.js";
import { blankExercise, applyCatalogOps } from "./catalogForm.js";
import { normalizeSessionNames, normalizePlanNames } from "./helpers.js";
import { buildCatalogViews } from "./catalogTestkit.js";
import { reconcile } from "./reconcile.js";

const ENTRY = {
  ...blankExercise(),
  name: "A",
  group: "Upper Body",
  description: "Un haltère dans chaque main, tirer vers les hanches",
  formCues: "Dos plat",
  intent: "Le tirage horizontal",
  implementTypes: ["dumbbell", "dual_bar_symmetric"],
  equipmentNeeds: ["dumbbell"],
};
const ex = (name) => ({ ...ENTRY, name });
const docOf = (...names) => ({ version: 1, exercises: names.map(ex), aliases: {} });
const deactivate = (name) => ({ id: `off-${name}`, op: "setExerciseActive", args: [name, false, "2026-10-01"] });
const add = (name) => ({ id: `add-${name}`, op: "upsertExercise", args: [ex(name), null] });
const http = (status, body) => Object.assign(new Error(`HTTP ${status}`), { status, body });
const names = (doc) => doc.exercises.map((e) => `${e.name}${e.active === false ? "-" : ""}`);

describe("sendCatalogOps", () => {
  it("sends the operations replayed on the base, with the base's version", async () => {
    const push = vi.fn(async () => ({ saved: true, updatedAt: "T2" }));
    const next = await sendCatalogOps({ base: { doc: docOf("A", "B"), updatedAt: "T1" }, ops: [deactivate("A")], push });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].baseUpdatedAt).toBe("T1");
    expect(names(push.mock.calls[0][0].doc)).toEqual(["A-", "B"]);
    expect(next).toEqual({ doc: push.mock.calls[0][0].doc, updatedAt: "T2" });
  });

  // Regression: B6 (2026-09-30 review) — a stale device's toggle erased the
  // exercise another device had just added. On 409 the toggle is replayed
  // onto the server's document instead, and both edits survive.
  it("on a stale base, replays the operations onto the server's document and retries once", async () => {
    const push = vi.fn()
      .mockRejectedValueOnce(http(409, { doc: docOf("A", "B", "C"), updatedAt: "T5" }))
      .mockResolvedValueOnce({ saved: true, updatedAt: "T6" });
    const next = await sendCatalogOps({ base: { doc: docOf("A", "B"), updatedAt: "T1" }, ops: [deactivate("A")], push });
    expect(push).toHaveBeenCalledTimes(2);
    expect(push.mock.calls[1][0].baseUpdatedAt).toBe("T5");
    expect(names(next.doc)).toEqual(["A-", "B", "C"]);
    expect(next.updatedAt).toBe("T6");
  });

  it("refuses, with the server's state, when the replay no longer validates", async () => {
    // B was added here; the server already holds a B of its own — a
    // DIFFERENT one. An identical B is the same add already applied.
    const other = docOf("A", "B");
    other.exercises[1] = { ...other.exercises[1], intent: "Un autre B" };
    const server = { doc: other, updatedAt: "T5" };
    const push = vi.fn().mockRejectedValueOnce(http(409, server));
    const err = await sendCatalogOps({ base: { doc: docOf("A"), updatedAt: "T1" }, ops: [add("B")], push }).catch((e) => e);
    expect(err).toBeInstanceOf(CatalogConflictError);
    expect(err.server).toEqual(server);
    expect(push).toHaveBeenCalledTimes(1);
    // The outbox parks it rather than retrying forever or dropping it.
    expect(classify(err)).toBe("refused");
  });

  it("refuses when the retry is stale again, with the newest server state", async () => {
    const push = vi.fn()
      .mockRejectedValueOnce(http(409, { doc: docOf("A", "C"), updatedAt: "T5" }))
      .mockRejectedValueOnce(http(409, { doc: docOf("A", "C", "D"), updatedAt: "T7" }));
    const err = await sendCatalogOps({ base: { doc: docOf("A"), updatedAt: "T1" }, ops: [deactivate("A")], push }).catch((e) => e);
    expect(err).toBeInstanceOf(CatalogConflictError);
    expect(err.server.updatedAt).toBe("T7");
    expect(push).toHaveBeenCalledTimes(2);
  });

  it("lets a transient failure through unchanged, so the outbox retries it in order", async () => {
    const push = vi.fn().mockRejectedValueOnce(http(503));
    const err = await sendCatalogOps({ base: { doc: docOf("A"), updatedAt: "T1" }, ops: [deactivate("A")], push }).catch((e) => e);
    expect(classify(err)).toBe("transient");
    expect(err.server).toBeUndefined();
  });

  // After a rebase, a network failure on the retry still tells the caller what
  // the server holds, so the lexique can show it while the retry waits.
  it("a transient failure on the retry carries the server state it rebased on", async () => {
    const server = { doc: docOf("A", "C"), updatedAt: "T5" };
    const push = vi.fn().mockRejectedValueOnce(http(409, server)).mockRejectedValueOnce(new Error("offline"));
    const err = await sendCatalogOps({ base: { doc: docOf("A"), updatedAt: "T1" }, ops: [deactivate("A")], push }).catch((e) => e);
    expect(classify(err)).toBe("transient");
    expect(err.server).toEqual(server);
  });

  // Regression: ba3ba7f — an add is replayed after a PUT that committed but whose
  // response was lost. The retry is stale (409), the add was replayed onto a
  // server document that already held it, appended a duplicate, failed
  // validation and parked her edit for good.
  it("treats an add the server already holds as applied when it replays", async () => {
    // Through JSON with the keys reversed: what JSONB hands back keeps neither
    // the order the form wrote them in nor an undefined-valued key.
    const reorder = (doc) => ({
      ...doc,
      exercises: doc.exercises.map((e) => Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(e))).reverse())),
    });
    const push = vi.fn()
      .mockRejectedValueOnce(http(409, { doc: reorder(docOf("A", "B")), updatedAt: "T2" }))
      .mockResolvedValueOnce({ saved: true, updatedAt: "T3" });
    const next = await sendCatalogOps({ base: { doc: docOf("A"), updatedAt: "T1" }, ops: [add("B")], push });
    expect(push).toHaveBeenCalledTimes(2);
    expect(names(push.mock.calls[1][0].doc)).toEqual(["A", "B"]);
    expect(next.updatedAt).toBe("T3");
  });

  // Regression: d76bf4d — replay was idempotent only for an add that was the LAST
  // operation on its exercise. [add X, deactivate X] or [add X, rename X]
  // committed, response lost: the 409 replay re-added X beside the committed
  // one (a duplicate) or renamed an X that was already gone, and either parked
  // her edit for good. The document now lists the ids it was built from.
  it.each([
    ["add then deactivate", [add("X"), { id: "off-X", op: "setExerciseActive", args: ["X", false, "2026-10-01"] }]],
    ["add then rename", [add("X"), { id: "ren-X", op: "applyRename", args: ["X", "Y"] }, { id: "up-Y", op: "upsertExercise", args: [ex("Y"), "Y"] }]],
  ])("a committed %s whose response was lost replays as already applied", async (_label, ops) => {
    const base = { doc: docOf("A"), updatedAt: "T1" };
    // What the lost PUT committed — through JSON, as the 409 body arrives.
    const committed = JSON.parse(JSON.stringify(applyCatalogOps(base.doc, ops)));
    const push = vi.fn().mockRejectedValueOnce(http(409, { doc: committed, updatedAt: "T2" }));
    const next = await sendCatalogOps({ base, ops, push });
    expect(next).toEqual({ doc: committed, updatedAt: "T2" });
    // Nothing owed, so nothing re-sent: a second PUT would only bump the version.
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("replays only the operations the server's document has not applied", async () => {
    const base = { doc: docOf("A"), updatedAt: "T1" };
    const off = { id: "off-X", op: "setExerciseActive", args: ["X", false, "2026-10-01"] };
    const server = JSON.parse(JSON.stringify(applyCatalogOps(base.doc, [add("X")])));
    const push = vi.fn()
      .mockRejectedValueOnce(http(409, { doc: server, updatedAt: "T2" }))
      .mockResolvedValueOnce({ saved: true, updatedAt: "T3" });
    const next = await sendCatalogOps({ base, ops: [add("X"), off], push });
    expect(names(next.doc)).toEqual(["A", "X-"]);
    expect(next.doc.appliedOps).toEqual(["add-X", "off-X"]);
  });

  it("sends nothing when the confirmed document already holds every operation", async () => {
    const doc = applyCatalogOps(docOf("A"), [add("X")]);
    const push = vi.fn();
    const next = await sendCatalogOps({ base: { doc, updatedAt: "T4" }, ops: [add("X")], push });
    expect(push).not.toHaveBeenCalled();
    expect(next).toEqual({ doc, updatedAt: "T4" });
  });

  // Regression: 266c67f — an edit of an exercise deleted on another device was
  // replayed after a 409 as an append, bringing the deleted exercise back.
  it("refuses an edit whose exercise was deleted elsewhere, instead of re-adding it", async () => {
    const edit = { id: "edit-B", op: "upsertExercise", args: [{ ...ex("B"), intent: "revu" }, "B"] };
    const server = { doc: docOf("A"), updatedAt: "T5" };
    const push = vi.fn().mockRejectedValueOnce(http(409, server));
    const err = await sendCatalogOps({ base: { doc: docOf("A", "B"), updatedAt: "T1" }, ops: [edit], push }).catch((e) => e);
    expect(err).toBeInstanceOf(CatalogConflictError);
    expect(err.server).toEqual(server);
    expect(push).toHaveBeenCalledTimes(1);
    expect(classify(err)).toBe("refused");
  });

  it("parks, rather than retrying forever, an edit the mirror itself no longer holds", async () => {
    const edit = { id: "edit-B", op: "upsertExercise", args: [ex("B"), "B"] };
    const push = vi.fn();
    const err = await sendCatalogOps({ base: { doc: docOf("A"), updatedAt: "T1" }, ops: [edit], push }).catch((e) => e);
    expect(err).toBeInstanceOf(CatalogConflictError);
    expect(classify(err)).toBe("refused");
    expect(push).not.toHaveBeenCalled();
  });

  it("never sends a document built from no base at all", async () => {
    const push = vi.fn();
    const err = await sendCatalogOps({ base: null, ops: [add("B")], push }).catch((e) => e);
    expect(err).toBeInstanceOf(CatalogConflictError);
    expect(push).not.toHaveBeenCalled();
  });
});

describe("replayCatalog", () => {
  it("replays the operations onto the document", () => {
    expect(names(replayCatalog(docOf("A"), [deactivate("A"), add("B")]))).toEqual(["A-", "B"]);
  });

  it("falls back to the document when the replay does not validate", () => {
    // A DIFFERENT exercise under a taken name: a duplicate the validator
    // refuses. (An identical one is the same add already applied, a no-op.)
    const doc = docOf("A");
    const other = { id: "add-other-A", op: "upsertExercise", args: [{ ...ex("A"), intent: "Un autre A" }, null] };
    expect(replayCatalog(doc, [other])).toBe(doc);
  });

  it("falls back to the document on an unknown operation", () => {
    const doc = docOf("A");
    expect(replayCatalog(doc, [{ op: "nope", args: [] }])).toBe(doc);
  });

  it("returns null without a document", () => {
    expect(replayCatalog(null, [add("B")])).toBeNull();
  });
});

describe("rebaseOnPull", () => {
  const mirror = { doc: docOf("A", "B"), updatedAt: "2026-10-01T10:00:00.000Z" };

  it("adopts a newer server document and replays what is still queued on it", () => {
    const out = rebaseOnPull({ mirror, cloudDoc: docOf("A", "B", "C"), cloudUpdatedAt: "2026-10-01T11:00:00.000Z", ops: [deactivate("A")] });
    expect(out.mirror).toEqual({ doc: docOf("A", "B", "C"), updatedAt: "2026-10-01T11:00:00.000Z" });
    expect(names(out.doc)).toEqual(["A-", "B", "C"]);
  });

  // A push confirmed during the pull already moved the mirror past the
  // pull's snapshot: the older snapshot must not undo it.
  it("ignores a server document that is not newer than the mirror", () => {
    expect(rebaseOnPull({ mirror, cloudDoc: docOf("A"), cloudUpdatedAt: "2026-10-01T09:00:00.000Z", ops: [] })).toBeNull();
    expect(rebaseOnPull({ mirror, cloudDoc: docOf("A"), cloudUpdatedAt: mirror.updatedAt, ops: [] })).toBeNull();
  });

  it("adopts the server document over a mirror with no known version", () => {
    const out = rebaseOnPull({ mirror: { doc: docOf("A"), updatedAt: null }, cloudDoc: docOf("A", "C"), cloudUpdatedAt: "2026-10-01T11:00:00.000Z", ops: [] });
    expect(names(out.doc)).toEqual(["A", "C"]);
  });

  it("adopts the server document on a device with no mirror", () => {
    const out = rebaseOnPull({ mirror: null, cloudDoc: docOf("A"), cloudUpdatedAt: "2026-10-01T11:00:00.000Z", ops: [] });
    expect(out.mirror.updatedAt).toBe("2026-10-01T11:00:00.000Z");
  });

  it("does nothing when the server has no catalog", () => {
    expect(rebaseOnPull({ mirror, cloudDoc: null, cloudUpdatedAt: null, ops: [] })).toBeNull();
  });
});

describe("mirrorToSave", () => {
  const at = (h) => `2026-10-01T${h}:00:00.000Z`;
  const v = (h, ...n) => ({ doc: docOf(...n), updatedAt: at(h) });

  // Regression: 560f706 — the catalog executor saved the server state its push
  // learned unconditionally, so a slow push settling after another tab had
  // confirmed a newer version moved the shared mirror backwards.
  it("never moves the mirror backwards to an older confirmed version", () => {
    expect(mirrorToSave(v("11", "A", "B"), v("10", "A"))).toBeNull();
  });

  it("leaves the mirror alone for the version it already holds", () => {
    expect(mirrorToSave(v("10", "A"), v("10", "A"))).toBeNull();
  });

  it("takes a newer version", () => {
    const next = v("12", "A", "C");
    expect(mirrorToSave(v("10", "A"), next)).toBe(next);
  });

  it("takes any version over no mirror, or a mirror of unknown version", () => {
    const next = v("12", "A");
    expect(mirrorToSave(null, next)).toBe(next);
    expect(mirrorToSave({ doc: docOf("A"), updatedAt: null }, next)).toBe(next);
  });

  it("has nothing to save without a document", () => {
    expect(mirrorToSave(v("10", "A"), { doc: null, updatedAt: at("12") })).toBeNull();
  });
});

describe("catalogView", () => {
  const mirror = { doc: docOf("A", "B"), updatedAt: "2026-10-01T10:00:00.000Z" };
  const cat = (...ops) => ({ key: "catalog", kind: "catalog", payload: { ops } });

  it("is the mirror with the queued operations replayed, parked ones left out", async () => {
    const parked = (await drainWith(enqueue({ queue: [], parked: [] }, cat(deactivate("A"))), async () => { throw http(409); })).outbox;
    expect(parked.parked).toHaveLength(1);
    expect(names(catalogView(mirror, parked))).toEqual(["A", "B"]);
  });

  // Regression: 48dd421 — « Réessayer » put the parked operations back in the
  // queue but left the lexique on the park's view, so the retried edit stayed
  // invisible while it was on its way.
  it("shows the parked operations again once « Réessayer » has re-queued them", async () => {
    const parked = (await drainWith(enqueue({ queue: [], parked: [] }, cat(deactivate("A"))), async () => { throw http(409); })).outbox;
    expect(names(catalogView(mirror, unparkAll(parked)))).toEqual(["A-", "B"]);
  });

  it("is null without a mirror", () => {
    expect(catalogView(null, enqueue({ queue: [], parked: [] }, cat(add("C"))))).toBeNull();
  });
});

describe("pruneSupersededEdits — « Réessayer » drops whole edits a later one overrode", () => {
  const toggle = (ms, name, active, batch) => ({ id: `s_${ms}_t${name}`, batch, op: "setExerciseActive", args: [name, active, "2026-10-01"] });
  const upsert = (ms, name, batch) => ({ id: `s_${ms}_u${name}`, batch, op: "upsertExercise", args: [{ ...ex(name), description: "Nouvelle description, haltères" }, name] });
  const renameOps = (ms, from, to) => [
    { id: `s_${ms}_r`, batch: `b${ms}`, op: "applyRename", args: [from, to] },
    { id: `s_${ms}_u`, batch: `b${ms}`, op: "upsertExercise", args: [ex(to), to] },
  ];
  const cat = (...ops) => ({ key: "catalog", kind: "catalog", payload: { ops } });
  const parkedWith = async (ops) =>
    (await drainWith(enqueue({ queue: [], parked: [] }, cat(...ops)), async () => { throw new CatalogConflictError(null); })).outbox;

  it("reads when an operation was made off its id", () => {
    expect(opTime(toggle(1700, "A", false))).toBe(1700);
    expect(opTime({ id: "off-A" })).toBeNull();
    expect(opTime({})).toBeNull();
  });

  it("groups operations by the save that made them; one with no batch is its own edit", () => {
    const [r, u] = renameOps(1000, "A", "A2");
    expect(editsOf([r, toggle(900, "B", false), u, toggle(900, "C", false, undefined)]))
      .toEqual([[r, u], [toggle(900, "B", false)], [toggle(900, "C", false)]]);
  });

  // Regression: f9b01dd — « Réessayer » sent a parked « désactiver A » as it
  // was, after she had re-activated A by hand and that edit was confirmed: the
  // older edit landed last and silently undid the newer one.
  it("drops a toggle a later toggle of the same exercise overrode, and keeps the rest", () => {
    const { kept, dropped } = pruneSupersededEdits(
      [toggle(1000, "A", false), toggle(1000, "B", false)],
      logConfirmedOps([], [toggle(2000, "A", true)])
    );
    expect(kept).toEqual([toggle(1000, "B", false)]);
    expect(dropped).toEqual([[toggle(1000, "A", false)]]);
  });

  // Regression: 25899ac — a parked edit kept under a later confirmed toggle
  // replayed the whole entry, active flag included, over the toggle: « Réessayer »
  // reactivated an exercise she had deactivated since. A later toggle now
  // overrides any earlier edit of the exercise, and the notice names it.
  it("a later toggle overrides an earlier upsert, rename or delete of the exercise", () => {
    const deactivated = toggle(2000, "A", false);
    const log = logConfirmedOps([], [deactivated]);
    const confirmed = applyCatalogOps(docOf("A", "B"), [deactivated]);

    const described = pruneSupersededEdits([upsert(1000, "A", "b1")], log);
    expect(described).toEqual({ kept: [], dropped: [[upsert(1000, "A", "b1")]] });
    expect(names(replayCatalog(confirmed, described.kept))).toEqual(["A-", "B"]);

    const renamed = pruneSupersededEdits(renameOps(1000, "A", "A2"), log);
    expect(renamed).toEqual({ kept: [], dropped: [renameOps(1000, "A", "A2")] });
    expect(names(replayCatalog(confirmed, renamed.kept))).toEqual(["A-", "B"]);

    const del = { id: "s_1000_d", batch: "bd", op: "deleteExercise", args: ["A"] };
    const reactivated = logConfirmedOps([], [toggle(2000, "A", true)]);
    expect(pruneSupersededEdits([del], reactivated)).toEqual({ kept: [], dropped: [[del]] });
    expect(supersededNotice([[upsert(1000, "A", "b1")]])).toBe(
      "Pas renvoyée, une modification plus récente l'a remplacée : modification de « A »."
    );
  });

  it("a later whole-entry edit overrides an earlier toggle, upsert or rename", () => {
    const later = logConfirmedOps([], [upsert(2000, "A")]);
    expect(pruneSupersededEdits([toggle(1000, "A", false)], later).kept).toEqual([]);
    expect(pruneSupersededEdits([upsert(1000, "A")], later).kept).toEqual([]);
    expect(pruneSupersededEdits(renameOps(1000, "A", "A2"), later).kept).toEqual([]);
  });

  // Regression: 7162c2e — the retry kept a rename's upsert (named only by the NEW
  // name) and dropped its applyRename (which names the old one), so it could
  // never apply: every tap re-parked it.
  it("keeps or drops a rename WHOLE, and what it keeps applies to the server's document", async () => {
    const ops = renameOps(1000, "A", "A2");
    const peer = toggle(2000, "B", false);
    const server = applyCatalogOps(docOf("A", "B"), [peer]);
    const confirmed = logConfirmedOps([], [peer]);

    const parked = await parkedWith(ops);
    const keepOps = (o) => pruneSupersededEdits(o, confirmed).kept;
    const retried = unparkAll(parked, null, { keepOps });
    expect(queuedOps(retried, "catalog")).toEqual(ops);
    expect(names(applyCatalogOps(server, queuedOps(retried, "catalog")))).toEqual(["A2", "B-"]);

    const overridden = logConfirmedOps([], [upsert(2000, "A")]);
    expect(pruneSupersededEdits(ops, overridden)).toEqual({ kept: [], dropped: [ops] });
  });

  it("keeps an edit newer than the later operation, or with no readable time", () => {
    expect(pruneSupersededEdits([toggle(3000, "A", false)], logConfirmedOps([], [toggle(2000, "A", true)])).kept).toHaveLength(1);
    expect(pruneSupersededEdits([deactivate("A")], logConfirmedOps([], [toggle(2000, "A", true)])).kept).toHaveLength(1);
    expect(pruneSupersededEdits([toggle(1000, "A", false)], []).kept).toHaveLength(1);
  });

  // Rule documentation, not a regression: passes on the pre-fix code too.
  it("counts an edit that LANDED before the retry ran as later", async () => {
    const parked = await parkedWith([toggle(1000, "A", false)]);
    const inFlight = [toggle(2000, "A", true)];
    // The retry runs under the drain lock, so the push that was out when she
    // tapped has settled and is in the confirmed log.
    const confirmed = logConfirmedOps([], inFlight);
    const withNewer = enqueue(parked, cat(...inFlight));
    let dropped = [];
    const keepOps = (o) => {
      const r = pruneSupersededEdits(o, confirmed);
      dropped = r.dropped;
      return r.kept;
    };
    const retried = unparkAll(withNewer, null, { keepOps });
    // Gone from the queue AND from the lexique: both read the same operations.
    expect(queuedOps(retried, "catalog")).toEqual(inFlight);
    expect(retried.parked).toEqual([]);
    expect(names(catalogView({ doc: docOf("A"), updatedAt: null }, retried))).toEqual(["A"]);
    expect(supersededNotice(dropped)).toBe(
      "Pas renvoyée, une modification plus récente l'a remplacée : désactivation de « A »."
    );
  });

  // Regression: 10fcb55 — a parked edit was pruned against a later edit merely
  // QUEUED; when that one then parked in its turn, her older edit was gone
  // with nothing left to send it. A queued edit already wins by order — the
  // retry goes out ahead of it — so only the confirmed log counts.
  it("keeps an edit a later one merely QUEUED would override: order settles it", async () => {
    const described = { ...upsert(1000, "A", "b1") };
    const rename = renameOps(2000, "A", "A2");
    const parked = await parkedWith([described]);
    const queued = enqueue(parked, cat(...rename));
    const keepOps = (o) => pruneSupersededEdits(o, []).kept;
    const retried = unparkAll(queued, null, { keepOps });
    expect(queuedOps(retried, "catalog")).toEqual([described, ...rename]);
    // Sent in that order, the rename lands last, as she made it.
    expect(names(applyCatalogOps(docOf("A", "B"), queuedOps(retried, "catalog")))).toEqual(["A2", "B"]);
    // And should the rename park in its turn, her description edit has
    // already gone out ahead of it rather than vanished.
    expect(retried.queue[0]).toMatchObject({ retry: true, payload: { ops: [described] } });
  });

  it("names every dropped edit, and says nothing when none was", () => {
    expect(supersededNotice([])).toBeNull();
    expect(supersededNotice([renameOps(1, "A", "A2"), [upsert(1, "B")]])).toBe(
      "Pas renvoyées, des modifications plus récentes les ont remplacées : renommage de « A » en « A2 » ; modification de « B »."
    );
  });

  it("keeps the log bounded to the most recent confirmations", () => {
    const ops = Array.from({ length: CONFIRMED_LOG_LIMIT + 5 }, (_, i) => toggle(i + 1, `E${i}`, false));
    const log = logConfirmedOps([], ops);
    expect(log).toHaveLength(CONFIRMED_LOG_LIMIT);
    expect(log.at(-1)).toEqual({ t: CONFIRMED_LOG_LIMIT + 5, names: [`E${CONFIRMED_LOG_LIMIT + 4}`] });
  });
});

describe("a pending rename and the names in her history", () => {
  const mirror = { doc: docOf("A", "B"), updatedAt: "2026-10-01T10:00:00.000Z" };
  const rename = [
    { id: "s_1000_r", op: "applyRename", args: ["A", "A2"] },
    { id: "s_1000_u", op: "upsertExercise", args: [ex("A2"), "A2"] },
  ];
  const history = [{ id: "s1", exercises: [{ name: "A" }, { name: "B" }] }];
  const queued = enqueue({ queue: [], parked: [] }, { key: "catalog", kind: "catalog", payload: { ops: rename } });
  const namesIn = (sessions) => sessions.flatMap((x) => x.exercises.map((e) => e.name));

  it("the lexique shows a queued rename; her history keeps the old name", () => {
    expect(names(catalogView(mirror, queued))).toEqual(["A2", "B"]);
    expect(namesIn(normalizeSessionNames(history, confirmedViews(mirror)))).toEqual(["A", "B"]);
  });

  it("once the rename is confirmed, its alias renames her history", () => {
    const confirmed = { doc: applyCatalogOps(mirror.doc, rename), updatedAt: "2026-10-01T10:01:00.000Z" };
    expect(namesIn(normalizeSessionNames(history, confirmedViews(confirmed)))).toEqual(["A2", "B"]);
  });

  it("parked, or failing to replay, the rename never touched her history", async () => {
    const parked = (await drainWith(queued, async () => { throw new CatalogConflictError(null); })).outbox;
    expect(names(catalogView(mirror, parked))).toEqual(["A", "B"]);
    // The names come from the mirror alone, whatever the outbox holds.
    expect(namesIn(normalizeSessionNames(history, confirmedViews(mirror)))).toEqual(["A", "B"]);
  });

  // Regression: 33dff73 — a plan imported, or a séance recorded, while a rename
  // was pending reached Neon under the NEW name (the import resolves against
  // the lexique, the picker offers it). Had the rename never landed, her
  // history was split for good. The save maps it back to the confirmed name;
  // the alias carries it forward once the server has taken the rename.
  it("a save made while a rename is pending carries the confirmed name", () => {
    const shown = catalogView(mirror, queued);
    const map = pendingRenames(shown, mirror.doc);
    expect(map).toEqual({ A2: "A" });

    // The coach's plan, resolved against the lexique, names the new one.
    expect(buildCatalogViews(shown).allExercises).toContain("A2");
    const plan = { sessions: [{ name: "S", exercises: [{ name: "A2" }, { name: "B" }] }] };
    const saved = planToConfirmed(plan, map);
    expect(saved.sessions[0].exercises.map((e) => e.name)).toEqual(["A", "B"]);
    const session = { id: "s9", exercises: [{ name: "A2", sets: [] }] };
    expect(sessionToConfirmed(session, map).exercises[0].name).toBe("A");

    // Parked: nothing to take back. Confirmed: the alias renames it.
    const confirmed = { doc: applyCatalogOps(mirror.doc, rename), updatedAt: "2026-10-01T10:01:00.000Z" };
    expect(normalizePlanNames(saved, confirmedViews(confirmed)).sessions[0].exercises.map((e) => e.name)).toEqual(["A2", "B"]);
    expect(pendingRenames(applyCatalogOps(mirror.doc, rename), confirmed.doc)).toEqual({});
  });

  it("maps a chain of pending renames back to the confirmed name, and only pending ones", () => {
    const chain = [...rename,
      { id: "s_2000_r", op: "applyRename", args: ["A2", "A3"] },
      { id: "s_2000_u", op: "upsertExercise", args: [ex("A3"), "A3"] }];
    expect(pendingRenames(applyCatalogOps(mirror.doc, chain), mirror.doc)).toEqual({ A3: "A" });

    // A rename already confirmed (A → A2), then a pending one (A2 → A3).
    const held = applyCatalogOps(mirror.doc, rename);
    expect(pendingRenames(applyCatalogOps(held, chain.slice(2)), held)).toEqual({ A3: "A2" });
    expect(planToConfirmed(null, { A3: "A2" })).toBeNull();
  });

  it("is null for a mirror with no usable document", () => {
    expect(confirmedViews(null)).toBeNull();
    expect(confirmedViews({ doc: { exercises: [] }, updatedAt: null })).toBeNull();
  });

  // Regression: cfd327b — a pull rebased a pending rename onto the server's
  // document and normalised her history against the result, so the sessions
  // took the new name before the server had it; when the rename was then
  // parked (or lost to a 409), nothing took the name back out.
  it("a pull normalises her history against the server's document, not the rebased one", () => {
    const rebased = rebaseOnPull({
      mirror,
      cloudDoc: docOf("A", "B", "C"),
      cloudUpdatedAt: "2026-10-01T11:00:00.000Z",
      ops: queuedOps(queued, "catalog"),
    });
    const out = reconcile({
      local: { sessions: history, catalog: catalogView(mirror, queued) },
      views: confirmedViews(mirror),
      cloud: {
        sessions: [{ id: "s2", date: "2026-10-01", name: "x", data: { exercises: [{ name: "A" }] } }],
        catalog: rebased.doc,
        confirmedCatalog: rebased.mirror.doc,
      },
      outbox: { queue: [], parked: [] },
    });
    expect(names(out.catalog)).toEqual(["A2", "B", "C"]);
    expect(out.sessions.flatMap((x) => x.exercises.map((e) => e.name))).toEqual(["A", "B", "A"]);
  });
});

// Rule documentation (these pass on the pre-fa4f890 code too, so they are not
// regressions): « Réessayer » pruned against a localStorage record of
// the push in flight, which a tab killed mid-push left set for good; and a push
// that was refused after the tap had already cost her older edit. The retry now
// runs under the drain lock and prunes against the confirmed log alone.
describe("« Réessayer » prunes against what landed, never what was in flight", () => {
  const toggle = (ms, name, active) => ({ id: `s_${ms}_t${name}`, op: "setExerciseActive", args: [name, active, "2026-10-01"] });
  const older = toggle(1000, "A", true);
  const newer = toggle(2000, "A", false);

  it("a later push REFUSED (409 after the tap) leaves nothing in the log: her edit is kept", () => {
    const confirmed = []; // the refused toggle never reached the log
    expect(pruneSupersededEdits([older], confirmed)).toEqual({ kept: [older], dropped: [] });
  });

  it("the same push CONFIRMED is in the log: her older edit is dropped, named", () => {
    const confirmed = logConfirmedOps([], [newer]);
    expect(pruneSupersededEdits([older], confirmed)).toEqual({ kept: [], dropped: [[older]] });
  });
});

describe("pendingRenames — a target that is a confirmed exercise", () => {
  // delete B + rename A→B, both pending: a NEW séance logged on the picker's
  // name B is the frequent case and must map to the rename's source A. The
  // rare residual (re-editing an old session of the deleted B) is accepted.
  it("maps the target all the same", () => {
    const shown = { ...docOf("B"), aliases: { A: "B" } };
    expect(pendingRenames(shown, docOf("A", "B"))).toEqual({ B: "A" });
  });
});

describe("retryNotice", () => {
  // Regression: d38bd2f — a second « Réessayer » that dropped nothing cleared
  // the first tap's dropped-edit notice.
  const dropped = [[{ id: "s_1_a", op: "deleteExercise", args: ["A"] }]];
  it("keeps the current notice when nothing was dropped", () => {
    expect(retryNotice("kept", [])).toBe("kept");
    expect(retryNotice(null, [])).toBeNull();
  });
  it("replaces it with the new one when something was dropped", () => {
    expect(retryNotice("old", dropped)).toBe(supersededNotice(dropped));
  });
});
