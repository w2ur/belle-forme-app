import { describe, it, expect, vi } from "vitest";
import { enqueue, complete, drainWith, unpark, unparkAll, classify, queuedOps, MAX_SERVER_ERRORS,
  currentOutbox, createOutboxStore, withDrainLock, retryParkedUnderLock, singleFlight, DRAIN_LOCK, DRAIN_BUSY } from "./outbox.js";

const drain = async (source, exec) => (await drainWith(source, exec)).outbox;
import { SyncAuthError } from "./sync.js";

const E = { queue: [], parked: [] };
const failWith = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

describe("enqueue", () => {
  it("latest write per entity replaces the earlier one", () => {
    let o = enqueue(E, { key: "plan", kind: "plan", payload: { v: 1 } });
    o = enqueue(o, { key: "plan", kind: "plan", payload: { v: 2 } });
    expect(o.queue).toHaveLength(1); expect(o.queue[0].payload.v).toBe(2);
  });

  it("catalog entries accumulate their ops instead of replacing them", () => {
    let o = enqueue(E, { key: "catalog", kind: "catalog", payload: { ops: [{ op: "setExerciseActive", args: ["A", false] }] } });
    o = enqueue(o, { key: "catalog", kind: "catalog", payload: { ops: [{ op: "deleteExercise", args: ["B"] }] } });
    expect(o.queue).toHaveLength(1);
    expect(o.queue[0].payload.ops.map((x) => x.op)).toEqual(["setExerciseActive", "deleteExercise"]);
  });

  it("a delete cancels a pending upsert of the same session, and the reverse", () => {
    let o = enqueue(E, { key: "session:x", kind: "session", payload: { id: "x" } });
    o = enqueue(o, { key: "session-delete:x", kind: "session-delete", payload: { id: "x" } });
    expect(o.queue.map((e) => e.key)).toEqual(["session-delete:x"]);
    o = enqueue(o, { key: "session:x", kind: "session", payload: { id: "x" } });
    expect(o.queue.map((e) => e.key)).toEqual(["session:x"]);
  });

  it("does not touch other sessions when cancelling", () => {
    let o = enqueue(E, { key: "session:x", kind: "session", payload: { id: "x" } });
    o = enqueue(o, { key: "session-delete:xy", kind: "session-delete", payload: { id: "xy" } });
    expect(o.queue.map((e) => e.key)).toEqual(["session:x", "session-delete:xy"]);
  });

  it("gives every entry a strictly increasing seq, and does not mutate its input", () => {
    const a = enqueue(E, { key: "a", kind: "plan", payload: {} });
    const b = enqueue(a, { key: "b", kind: "plan", payload: {} });
    const c = enqueue(b, { key: "a", kind: "plan", payload: {} });
    expect(E.queue).toEqual([]);
    expect(a.queue).toHaveLength(1);
    const seqs = c.queue.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(c.queue.map((e) => e.key)).toEqual(["b", "a"]);
    expect(c.queue.every((e) => e.attempts === 0)).toBe(true);
  });

  it("keeps seq increasing across a JSON round-trip (the persisted shape)", () => {
    const o = JSON.parse(JSON.stringify(enqueue(E, { key: "a", kind: "plan", payload: {} })));
    const p = enqueue(o, { key: "b", kind: "plan", payload: {} });
    expect(p.queue[1].seq).toBeGreaterThan(p.queue[0].seq);
  });

  it("a newer whole-state write supersedes a parked one of the same entity", () => {
    const o = { queue: [], parked: [{ key: "profile", kind: "profile", payload: { v: 1 }, attempts: 0, seq: 1 }], lastSeq: 1 };
    const p = enqueue(o, { key: "profile", kind: "profile", payload: { v: 2 } });
    expect(p.parked).toEqual([]);
    expect(p.queue.map((e) => e.payload.v)).toEqual([2]);
  });

  it("a new catalog op list leaves a parked catalog entry alone", () => {
    const parked = { key: "catalog", kind: "catalog", payload: { ops: [{ op: "x" }] }, attempts: 0, seq: 1 };
    const p = enqueue({ queue: [], parked: [parked], lastSeq: 1 }, { key: "catalog", kind: "catalog", payload: { ops: [{ op: "y" }] } });
    expect(p.parked).toEqual([parked]);
    expect(p.queue[0].payload.ops).toEqual([{ op: "y" }]);
  });
});

describe("complete", () => {
  it("a success does not remove a newer entry that replaced the one in flight", () => {
    let o = enqueue(E, { key: "plan", kind: "plan", payload: { v: 1 } });
    const inFlight = o.queue[0];
    o = enqueue(o, { key: "plan", kind: "plan", payload: { v: 2 } });
    o = complete(o, inFlight);
    expect(o.queue.map((e) => e.payload.v)).toEqual([2]);
  });

  it("removes the entry when its seq matches", () => {
    const o = enqueue(E, { key: "plan", kind: "plan", payload: {} });
    expect(complete(o, o.queue[0]).queue).toEqual([]);
  });
});

describe("classify", () => {
  it("sorts errors by what the line should do next", () => {
    expect(classify(failWith(401))).toBe("auth");
    expect(classify(failWith(409))).toBe("refused");
    expect(classify(failWith(400))).toBe("refused");
    expect(classify(failWith(422))).toBe("refused");
    expect(classify(failWith(500))).toBe("transient");
    expect(classify(failWith(503))).toBe("transient");
    expect(classify(new TypeError("Failed to fetch"))).toBe("transient");
    expect(classify(undefined)).toBe("transient");
  });

  // Regression: 700accc — 408 and 429 were parked as permanent refusals, so a request
  // that merely timed out or hit a rate limit shelved a good write until she
  // tapped « Réessayer ».
  it("treats 408 and 429 as transient — they mean \"not now\", not \"never\"", () => {
    expect(classify(failWith(408))).toBe("transient");
    expect(classify(failWith(429))).toBe("transient");
    expect(classify(failWith(404))).toBe("refused");
  });
});

describe("drain", () => {
  it("runs entries in seq order and empties the queue on success", async () => {
    let o = ["a", "b", "c"].reduce((acc, k) => enqueue(acc, { key: k, kind: "plan", payload: {} }), E);
    const ran = [];
    o = await drain(o, async (e) => { ran.push(e.key); });
    expect(ran).toEqual(["a", "b", "c"]);
    expect(o.queue).toEqual([]);
  });

  it("drain stops at a transient failure without losing it", async () => {
    let o = ["a", "b", "c"].reduce((acc, k) => enqueue(acc, { key: k, kind: "plan", payload: {} }), E);
    const ran = [];
    o = await drain(o, async (e) => { ran.push(e.key); if (e.key === "b") throw failWith(503); });
    expect(ran).toEqual(["a", "b"]);
    expect(o.queue.map((e) => [e.key, e.attempts])).toEqual([["b", 1], ["c", 0]]);
  });

  // Regression (2026-09-30 plan review): with "stop at the first failure" and
  // "never drop", one document the server rejects with a 400 blocked every
  // session queued behind it, forever.
  it("a permanently refused entry is parked and the entries behind it still land", async () => {
    let o = ["catalog", "session:x"].reduce((acc, k) => enqueue(acc, { key: k, kind: "x", payload: { ops: [] } }), E);
    const landed = [];
    o = await drain(o, async (e) => { if (e.key === "catalog") throw failWith(400); landed.push(e.key); });
    expect(landed).toEqual(["session:x"]);
    expect(o.queue).toEqual([]);
    expect(o.parked.map((e) => e.key)).toEqual(["catalog"]);
    expect(unpark(o, "catalog").queue.map((e) => e.key)).toEqual(["catalog"]);
    expect(unpark(o, "catalog").parked).toEqual([]);
  });

  // Regression (2026-09-30 review): the old retry queue skipped an item for
  // good once it had failed three times — a workout recorded offline for a
  // long enough stretch never reached Neon.
  it("no entry is ever dropped for having failed many times", async () => {
    let o = enqueue(E, { key: "a", kind: "plan", payload: {} });
    for (let i = 0; i < 10; i++) o = await drain(o, async () => { throw new Error("offline"); });
    expect(o.queue).toHaveLength(1); expect(o.queue[0].attempts).toBe(10);
  });

  it("an auth failure stops the line and changes nothing", async () => {
    const o = ["a", "b"].reduce((acc, k) => enqueue(acc, { key: k, kind: "plan", payload: {} }), E);
    const ran = [];
    const p = await drain(o, async (e) => { ran.push(e.key); throw failWith(401); });
    expect(ran).toEqual(["a"]);
    expect(p).toEqual(o);
  });

  // Regression: 2026-10-01 B4 — a 401 during a drain must keep the entry
  // queued (not parked), with attempts untouched, and run nothing behind it.
  it("a SyncAuthError keeps the entry queued with attempts unchanged", async () => {
    const o = ["a", "b"].reduce((acc, k) => enqueue(acc, { key: k, kind: "plan", payload: {} }), E);
    const ran = [];
    const { outbox, stoppedOn, error } = await drainWith(o, async (e) => { ran.push(e.key); throw new SyncAuthError("x"); });
    expect(stoppedOn).toBe("auth");
    expect(error).toBeInstanceOf(SyncAuthError);
    expect(ran).toEqual(["a"]);
    expect(outbox.queue.map((e) => [e.key, e.attempts])).toEqual([["a", 0], ["b", 0]]);
    expect(outbox.parked ?? []).toEqual([]);
  });

  // Regression (2026-09-30 review): a failed write was retried from a closure
  // holding the payload of the moment it failed, so a replay landed after a
  // newer write had succeeded and put the older document back in Neon.
  it("pushes the newest payload when an entity is rewritten while the queue is failing", async () => {
    let o = enqueue(E, { key: "plan", kind: "plan", payload: { v: 1 } });
    o = await drain(o, async () => { throw new Error("offline"); });
    o = enqueue(o, { key: "plan", kind: "plan", payload: { v: 2 } });
    const sent = [];
    o = await drain(o, async (e) => { sent.push(e.payload.v); });
    expect(sent).toEqual([2]);
    expect(o.queue).toEqual([]);
  });
});

describe("drain — the backstop for a permanent 5xx", () => {
  const twoEntries = () => ["poison", "session:x"].reduce((acc, k) => enqueue(acc, { key: k, kind: "plan", payload: {} }), E);

  // Regression: 2aaf8d4 — a payload the server refused with a 500 on every try was
  // retried forever at the head of the line, and every write behind it waited
  // with it. After MAX_SERVER_ERRORS answered 5xx it is parked instead.
  it("parks an entry the server keeps answering with a 5xx, and the one behind it lands", async () => {
    let o = twoEntries();
    const landed = [];
    const exec = async (e) => { if (e.key === "poison") throw failWith(500); landed.push(e.key); };
    for (let i = 1; i < MAX_SERVER_ERRORS; i++) {
      o = await drain(o, exec);
      expect(landed).toEqual([]);
      expect(o.queue.map((e) => e.key)).toEqual(["poison", "session:x"]);
    }
    o = await drain(o, exec);
    expect(landed).toEqual(["session:x"]);
    expect(o.queue).toEqual([]);
    expect(o.parked.map((e) => e.key)).toEqual(["poison"]);
  });

  it("never parks for being offline, however long", async () => {
    let o = twoEntries();
    for (let i = 0; i < MAX_SERVER_ERRORS * 3; i++) o = await drain(o, async () => { throw new TypeError("Failed to fetch"); });
    expect(o.parked ?? []).toEqual([]);
    expect(o.queue[0]).toMatchObject({ key: "poison", attempts: MAX_SERVER_ERRORS * 3, serverErrors: 0 });
  });

  it("starts counting afresh once « Réessayer » puts it back", async () => {
    let o = twoEntries();
    for (let i = 0; i < MAX_SERVER_ERRORS; i++) o = await drain(o, async (e) => { if (e.key === "poison") throw failWith(503); });
    o = unpark(o, "poison");
    expect(o.queue[0]).toMatchObject({ key: "poison", attempts: 0, serverErrors: 0 });
    o = await drain(o, async () => { throw failWith(503); });
    expect(o.queue.map((e) => e.key)).toEqual(["poison"]);
  });

  // Regression: d729c00 — enqueue reset serverErrors to 0 on an entry replaced
  // during the retry WAIT (the in-flight carry covered only a replacement made
  // while the push was out), so a head the server 500s every time, re-saved
  // between retries, never reached MAX_SERVER_ERRORS and held the line.
  it("a re-save between retries inherits the count of the entry it replaces", async () => {
    let o = enqueue(E, { key: "plan", kind: "plan", payload: { v: 0 } });
    for (let i = 1; i <= MAX_SERVER_ERRORS; i++) {
      o = await drain(o, async () => { throw failWith(500); });
      if (o.parked.length) break;
      o = enqueue(o, { key: "plan", kind: "plan", payload: { v: i } });
    }
    expect(o.parked.map((e) => e.key)).toEqual(["plan"]);
  });

  it("a write to another entity, or the opposing session write, starts at zero", () => {
    let o = enqueue(E, { key: "session:x", kind: "session", payload: { id: "x" } });
    o = { ...o, queue: o.queue.map((e) => ({ ...e, serverErrors: 3 })) };
    expect(enqueue(o, { key: "plan", kind: "plan", payload: {} }).queue.at(-1).serverErrors).toBe(0);
    expect(enqueue(o, { key: "session-delete:x", kind: "session-delete", payload: { id: "x" } }).queue.at(-1).serverErrors).toBe(0);
  });
});

describe("drain — telling the caller an entry was parked", () => {
  const cat = (id) => ({ key: "catalog", kind: "catalog", payload: { ops: [{ id, op: "deleteExercise", args: ["A"] }] } });

  // Regression: 4759ea8 — the 5xx backstop parked a catalog entry without telling
  // anyone. Only a refusal reached the executor's own park handling, so the
  // edit parked by the backstop stayed in the lexique as if it had been saved.
  it("reports a park by the 5xx backstop, after the park is stored", async () => {
    let current = enqueue(E, cat("1"));
    const store = { get: () => current, set: (o) => { current = o; } };
    const parks = [];
    const onPark = (entry, err) => parks.push({ key: entry.key, status: err.status, parkedNow: current.parked.length });
    for (let i = 0; i < MAX_SERVER_ERRORS; i++) {
      await drainWith(store, async () => { throw failWith(500); }, { onPark });
    }
    expect(parks).toEqual([{ key: "catalog", status: 500, parkedNow: 1 }]);
  });

  it("reports a park by refusal, and nothing for a transient failure or a success", async () => {
    const parks = [];
    const onPark = (entry) => parks.push(entry.key);
    await drainWith(enqueue(E, cat("1")), async () => { throw failWith(409); }, { onPark });
    await drainWith(enqueue(E, cat("2")), async () => { throw failWith(503); }, { onPark });
    await drainWith(enqueue(E, cat("3")), async () => {}, { onPark });
    expect(parks).toEqual(["catalog"]);
  });
});

describe("drain after its owner has gone", () => {
  // Regression: e8f15e4 — a drain in flight when the hook unmounted carried on — it went
  // on to send the entries behind, and armed a 30 s retry after the cleanup
  // had cleared it. `active` stops the line; the in-flight result still lands.
  it("records the push in flight, then sends nothing more once inactive", async () => {
    let alive = true;
    const o = ["a", "b"].reduce((acc, k) => enqueue(acc, { key: k, kind: "plan", payload: {} }), E);
    const sent = [];
    const { outbox, stoppedOn } = await drainWith(o, async (e) => { sent.push(e.key); alive = false; }, { active: () => alive });
    expect(sent).toEqual(["a"]);
    expect(outbox.queue.map((e) => e.key)).toEqual(["b"]);
    expect(stoppedOn).toBeNull();
  });

  it("sends nothing at all when already inactive", async () => {
    const o = enqueue(E, { key: "a", kind: "plan", payload: {} });
    const sent = [];
    await drainWith(o, async (e) => { sent.push(e.key); }, { active: () => false });
    expect(sent).toEqual([]);
  });
});

describe("drain against a live store", () => {
  // The hook enqueues while a drain is awaiting a push. `drain` must apply its
  // results to the CURRENT outbox, not to the snapshot it started from.
  function store(initial) {
    let current = initial;
    return { get: () => current, set: (o) => { current = o; } };
  }

  it("a write enqueued while its predecessor is in flight is pushed after it, not lost", async () => {
    const s = store(enqueue(E, { key: "plan", kind: "plan", payload: { v: 1 } }));
    const sent = [];
    await drain(s, async (e) => {
      sent.push(e.payload.v);
      if (e.payload.v === 1) s.set(enqueue(s.get(), { key: "plan", kind: "plan", payload: { v: 2 } }));
    });
    expect(sent).toEqual([1, 2]);
    expect(s.get().queue).toEqual([]);
  });

  // Regression: 2f7c309 — a transient failure of an entry superseded while in
  // flight stopped the line for the 30 s retry, although the entry that replaced
  // it had never been tried.
  it("a transient failure of a superseded entry goes on to the entry that replaced it", async () => {
    const s = store(enqueue(E, { key: "plan", kind: "plan", payload: { v: 1 } }));
    const sent = [];
    const { stoppedOn } = await drainWith(s, async (e) => {
      sent.push(e.payload.v);
      if (e.payload.v === 1) {
        s.set(enqueue(s.get(), { key: "plan", kind: "plan", payload: { v: 2 } }));
        throw failWith(503);
      }
    });
    expect(sent).toEqual([1, 2]);
    expect(stoppedOn).toBeNull();
    expect(s.get()).toMatchObject({ queue: [], parked: [] });
  });

  // Regression: adeb1b6 — the entry that replaced a superseded one started its 5xx
  // count from zero, so an entity she kept editing while the server answered
  // 500 every time was never parked, and held the line behind it for good.
  it("a superseded entry's 5xx count carries onto the entry that replaced it", async () => {
    const s = store(enqueue(E, { key: "plan", kind: "plan", payload: { v: 0 } }));
    let v = 0;
    let parked = 0;
    // Every send is superseded in flight and answered 503.
    await drainWith(s, async () => {
      if (v < MAX_SERVER_ERRORS + 2) s.set(enqueue(s.get(), { key: "plan", kind: "plan", payload: { v: ++v } }));
      throw failWith(503);
    }, { onPark: () => { parked += 1; } });
    expect(parked).toBe(1);
    expect(s.get().parked.map((e) => e.key)).toEqual(["plan"]);
  });

  // Regression: 7d8ceec — a session upsert's 5xx count was handed to the
  // session-delete that replaced it in flight. The delete is another request
  // to another endpoint: the upsert's failures say nothing about it, and it
  // could park after a single 5xx of its own.
  it("a session upsert's 5xx count does not carry onto the delete that replaced it", async () => {
    const s = store(enqueue(E, { key: "session:x", kind: "session", payload: { id: "x" } }));
    s.set({ ...s.get(), queue: s.get().queue.map((e) => ({ ...e, serverErrors: MAX_SERVER_ERRORS - 1 })) });
    await drainWith(s, async (e) => {
      if (e.kind === "session") {
        s.set(enqueue(s.get(), { key: "session-delete:x", kind: "session-delete", payload: { id: "x" } }));
      }
      throw failWith(503);
    });
    expect(s.get().parked).toEqual([]);
    expect(s.get().queue).toMatchObject([{ key: "session-delete:x", serverErrors: 1 }]);
  });

  // Regression: 8630512 — enqueue copied the count of an entry still IN FLIGHT;
  // when that push then succeeded the replacement kept it (here 9) and parked
  // after a single transient 5xx. A success ends the streak.
  it("a push that lands resets the count its in-flight replacement inherited", async () => {
    const s = store(enqueue(E, { key: "plan", kind: "plan", payload: { v: 0 } }));
    s.set({ ...s.get(), queue: s.get().queue.map((e) => ({ ...e, serverErrors: MAX_SERVER_ERRORS - 1 })) });
    let first = true;
    await drainWith(s, async () => {
      if (first) {
        first = false;
        s.set(enqueue(s.get(), { key: "plan", kind: "plan", payload: { v: 1 } }));
        return;
      }
      throw failWith(503);
    });
    expect(s.get().parked).toEqual([]);
    expect(s.get().queue).toMatchObject([{ key: "plan", payload: { v: 1 }, serverErrors: 1 }]);
  });

  it("the same for a catalog entry that absorbed the operations in flight", async () => {
    const op = (id) => ({ id, op: "deleteExercise", args: [id] });
    const s = store(enqueue(E, { key: "catalog", kind: "catalog", payload: { ops: [op("a")] } }));
    s.set({ ...s.get(), queue: s.get().queue.map((e) => ({ ...e, serverErrors: MAX_SERVER_ERRORS - 1 })) });
    let first = true;
    await drainWith(s, async () => {
      if (first) {
        first = false;
        s.set(enqueue(s.get(), { key: "catalog", kind: "catalog", payload: { ops: [op("b")] } }));
        return;
      }
      throw failWith(503);
    });
    expect(s.get().parked).toEqual([]);
    expect(s.get().queue).toMatchObject([{ payload: { ops: [op("b")] }, serverErrors: 1 }]);
  });

  it("a transient failure of an entry still queued stops the line as before", async () => {
    const s = store(enqueue(enqueue(E, { key: "plan", kind: "plan", payload: { v: 1 } }), { key: "profile", kind: "profile", payload: {} }));
    const sent = [];
    const { stoppedOn } = await drainWith(s, async (e) => { sent.push(e.key); throw failWith(503); });
    expect(sent).toEqual(["plan"]);
    expect(stoppedOn).toBe("transient");
  });

  it("a refused entry that was superseded while in flight is not parked", async () => {
    const s = store(enqueue(E, { key: "plan", kind: "plan", payload: { v: 1 } }));
    const sent = [];
    await drain(s, async (e) => {
      sent.push(e.payload.v);
      if (e.payload.v === 1) {
        s.set(enqueue(s.get(), { key: "plan", kind: "plan", payload: { v: 2 } }));
        throw failWith(400);
      }
    });
    expect(sent).toEqual([1, 2]);
    expect(s.get()).toMatchObject({ queue: [], parked: [] });
  });
});

describe("unparkAll with the keys « Réessayer » showed", () => {
  // Regression: f9b01dd — « Réessayer » unparked everything storage held,
  // including an entry another tab parked after the count she tapped was shown.
  it("puts back only the keys it is given", () => {
    const o = { queue: [], parked: [
      { key: "plan", kind: "plan", payload: {}, seq: 1, attempts: 1, serverErrors: 0 },
      { key: "profile", kind: "profile", payload: {}, seq: 2, attempts: 1, serverErrors: 0 },
    ], lastSeq: 2 };
    const out = unparkAll(o, ["plan"]);
    expect(out.queue.map((e) => e.key)).toEqual(["plan"]);
    expect(out.parked.map((e) => e.key)).toEqual(["profile"]);
    expect(unparkAll(o).parked).toEqual([]);
  });
});

describe("catalog operations in flight", () => {
  function store(initial) {
    let current = initial;
    return { get: () => current, set: (o) => { current = o; } };
  }
  const op = (id, name) => ({ id, op: "setExerciseActive", args: [name, false, "2026-10-01"] });
  const cat = (...ops) => ({ key: "catalog", kind: "catalog", payload: { ops } });

  // Regression: B6 (2026-10-01) — an edit made while the previous catalog push
  // was in flight was merged into that entry, and the success then left the
  // merged entry queued with the confirmed operation still in it. It was sent
  // a second time: harmless for a toggle, a duplicate (and a 400) for an add.
  it("a success removes only the operations it sent, and the later ones still go out", async () => {
    const s = store(enqueue(E, cat(op("1", "A"))));
    const sent = [];
    await drain(s, async (e) => {
      sent.push(e.payload.ops.map((o) => o.id));
      if (sent.length === 1) s.set(enqueue(s.get(), cat(op("2", "B"))));
    });
    expect(sent).toEqual([["1"], ["2"]]);
    expect(s.get().queue).toEqual([]);
  });

  it("a refusal parks only the operations it sent, and the later ones still go out", async () => {
    const s = store(enqueue(E, cat(op("1", "A"))));
    const sent = [];
    await drain(s, async (e) => {
      sent.push(e.payload.ops.map((o) => o.id));
      if (sent.length === 1) {
        s.set(enqueue(s.get(), cat(op("2", "B"))));
        throw failWith(409);
      }
    });
    expect(sent).toEqual([["1"], ["2"]]);
    expect(s.get().queue).toEqual([]);
    expect(s.get().parked.map((e) => e.payload.ops.map((o) => o.id))).toEqual([["1"]]);
  });

  // Two refusals in a row must not lose the first one's edits: « Réessayer »
  // is the only way back for them.
  it("a second refused catalog entry joins the parked one instead of replacing it", async () => {
    let o = enqueue(E, cat(op("1", "A")));
    o = await drain(o, async () => { throw failWith(409); });
    o = enqueue(o, cat(op("2", "B")));
    o = await drain(o, async () => { throw failWith(409); });
    expect(o.parked).toHaveLength(1);
    expect(o.parked[0].payload.ops.map((x) => x.id)).toEqual(["1", "2"]);
  });

  // The parked edits are OLDER than anything queued since, so they replay
  // first: « désactiver A » then « réactiver A » must end active.
  it("Réessayer puts the parked operations before the queued ones", () => {
    let o = { queue: [], parked: [{ ...cat(op("1", "A")), attempts: 0, seq: 1 }], lastSeq: 1 };
    o = enqueue(o, cat(op("2", "B")));
    o = unparkAll(o);
    expect(o.parked).toEqual([]);
    expect(queuedOps(o, "catalog").map((x) => x.id)).toEqual(["1", "2"]);
  });

  // Regression: e2968c1 — « Réessayer » MERGED the parked operations into the
  // catalog entry queued since. Parked operations are the ones most likely to
  // be refused again, and a second refusal parked the merged entry whole: the
  // edits made since went with it, and out of the lexique.
  it("a retried entry refused again does not take the edits queued since with it", async () => {
    let o = { queue: [], parked: [{ ...cat(op("1", "A")), attempts: 0, seq: 1 }], lastSeq: 1 };
    o = enqueue(o, cat(op("2", "B")));
    o = unparkAll(o);
    expect(o.queue.map((e) => e.payload.ops.map((x) => x.id))).toEqual([["1"], ["2"]]);
    const sent = [];
    o = await drain(o, async (e) => {
      const ids = e.payload.ops.map((x) => x.id);
      sent.push(ids);
      if (ids.includes("1")) throw failWith(409);
    });
    expect(sent).toEqual([["1"], ["2"]]);
    expect(o.queue).toEqual([]);
    expect(o.parked.map((e) => e.payload.ops.map((x) => x.id))).toEqual([["1"]]);
  });

  it("an edit made after « Réessayer » joins the ordinary entry, never the retry", () => {
    let o = { queue: [], parked: [{ ...cat(op("1", "A")), attempts: 0, seq: 1 }], lastSeq: 1 };
    o = unparkAll(o);
    o = enqueue(o, cat(op("2", "B")));
    o = enqueue(o, cat(op("3", "C")));
    expect(o.queue.map((e) => [e.retry === true, e.payload.ops.map((x) => x.id)])).toEqual([
      [true, ["1"]],
      [false, ["2", "3"]],
    ]);
    expect(queuedOps(o, "catalog").map((x) => x.id)).toEqual(["1", "2", "3"]);
  });

  it("an entry in flight when « Réessayer » renumbers it still completes", async () => {
    const s = store(enqueue({ ...E, parked: [{ ...cat(op("1", "A")), attempts: 0, seq: 0 }] }, cat(op("2", "B"))));
    const sent = [];
    await drain(s, async (e) => {
      sent.push(e.payload.ops.map((x) => x.id));
      if (sent.length === 1) s.set(unparkAll(s.get()));
    });
    // "2" was already on the wire; the retry follows it, and "2" is not sent twice.
    expect(sent).toEqual([["2"], ["1"]]);
    expect(s.get().queue).toEqual([]);
  });

  it("queuedOps is empty when nothing is queued for the key", () => {
    expect(queuedOps(E, "catalog")).toEqual([]);
  });
});

describe("an outbox shared between tabs", () => {
  // A stand-in for localStorage as two tabs see it: one string, JSON in and out.
  function sharedStorage() {
    let raw = null;
    return {
      read: () => (raw === null ? null : JSON.parse(raw)),
      write: (o) => { raw = JSON.stringify(o); return true; },
    };
  }
  const entry = (key) => ({ key, kind: "session", payload: { id: key } });

  // Regression: d98f824 — each tab read the outbox once at mount and wrote it back whole
  // from memory, so two tabs (or a tab and the installed PWA) erased each
  // other's entries — and catalog operations exist nowhere else.
  it("keeps what both tabs enqueue", () => {
    const disk = sharedStorage();
    const a = createOutboxStore(disk);
    const b = createOutboxStore(disk);
    a.set(enqueue(a.get(), entry("session:1")));
    b.set(enqueue(b.get(), entry("session:2")));
    a.set(enqueue(a.get(), entry("session:3")));
    expect(disk.read().queue.map((e) => e.key)).toEqual(["session:1", "session:2", "session:3"]);
    expect(new Set(disk.read().queue.map((e) => e.seq)).size).toBe(3);
  });

  it("a drain in one tab completes against what the other tab added meanwhile", async () => {
    const disk = sharedStorage();
    const a = createOutboxStore(disk);
    const b = createOutboxStore(disk);
    a.set(enqueue(a.get(), entry("session:1")));
    const sent = [];
    await drain(a, async (e) => {
      sent.push(e.key);
      if (e.key === "session:1") b.set(enqueue(b.get(), entry("session:2")));
    });
    expect(sent).toEqual(["session:1", "session:2"]);
    expect(disk.read().queue).toEqual([]);
  });

  it("does not resurrect an entry the other tab completed", async () => {
    const disk = sharedStorage();
    const a = createOutboxStore(disk);
    const b = createOutboxStore(disk);
    a.set(enqueue(a.get(), entry("session:1")));
    await drain(b, async () => {});
    a.set(enqueue(a.get(), entry("session:2")));
    expect(disk.read().queue.map((e) => e.key)).toEqual(["session:2"]);
  });

  it("falls back on its own copy when storage cannot be read or a write failed", () => {
    let readable = true;
    let writable = true;
    let raw = null;
    const store = createOutboxStore({
      read: () => (readable ? (raw === null ? null : JSON.parse(raw)) : undefined),
      write: (o) => { if (!writable) return false; raw = JSON.stringify(o); return true; },
    });
    store.set(enqueue(store.get(), entry("session:1")));
    readable = false;
    expect(store.get().queue.map((e) => e.key)).toEqual(["session:1"]);
    readable = true;
    writable = false;
    store.set(enqueue(store.get(), entry("session:2")));
    // Storage still holds only session:1; reading it back would drop session:2.
    expect(store.get().queue.map((e) => e.key)).toEqual(["session:1", "session:2"]);
  });
});

describe("currentOutbox", () => {
  const cached = { queue: [{ key: "x", seq: 4 }], parked: [], lastSeq: 4 };
  it("reads storage, not the cache, when storage is readable and current", () => {
    const stored = { queue: [{ key: "y", seq: 7 }], parked: [] };
    expect(currentOutbox({ stored, cached })).toEqual({ queue: stored.queue, parked: [], lastSeq: 7 });
  });
  it("treats no stored outbox as an empty one", () => {
    expect(currentOutbox({ stored: null, cached })).toEqual({ queue: [], parked: [], lastSeq: 0 });
  });
  it("keeps the cache when storage is unreadable, corrupt, or behind", () => {
    expect(currentOutbox({ stored: undefined, cached })).toBe(cached);
    expect(currentOutbox({ stored: "garbage", cached })).toBe(cached);
    expect(currentOutbox({ stored: { queue: [] }, cached, storageBehind: true })).toBe(cached);
  });
});

describe("withDrainLock", () => {
  function fakeLocks() {
    let tail = Promise.resolve();
    const names = [];
    return {
      names,
      request(name, opts, cb) {
        if (typeof opts === "function") cb = opts;
        names.push(name);
        const signal = opts?.signal;
        const granted = tail.then(() => {
          if (signal?.aborted) throw signal.reason;
        });
        const waited = signal
          ? Promise.race([granted, new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))])
          : granted;
        const run = waited.then(() => cb({ name }));
        tail = run.catch(() => {});
        return run;
      },
    };
  }

  it("never lets two drains overlap", async () => {
    const locks = fakeLocks();
    const log = [];
    const job = (id) => async () => { log.push(`start ${id}`); await Promise.resolve(); await Promise.resolve(); log.push(`end ${id}`); return id; };
    const results = await Promise.all([withDrainLock(job("a"), locks), withDrainLock(job("b"), locks)]);
    expect(results).toEqual(["a", "b"]);
    expect(log).toEqual(["start a", "end a", "start b", "end b"]);
    expect(locks.names).toEqual([DRAIN_LOCK, DRAIN_LOCK]);
  });

  it("runs unserialised without the Locks API, or when it refuses the request", async () => {
    expect(await withDrainLock(async () => 1, undefined)).toBe(1);
    const refusing = { request: () => Promise.reject(new DOMException("denied", "SecurityError")) };
    expect(await withDrainLock(async () => 2, refusing)).toBe(2);
  });

  // Regression: 7d09f00 — a tab waited for the lock with no bound, so a holder
  // stuck on a request that never answered stalled every other tab's syncing.
  it("gives up after the wait instead of queueing behind a holder forever", async () => {
    const locks = fakeLocks();
    let release;
    const holder = withDrainLock(() => new Promise((r) => { release = r; }), locks);
    let ran = false;
    const waiter = await withDrainLock(async () => { ran = true; }, locks, { waitMs: 20 });
    expect(waiter).toBe(DRAIN_BUSY);
    // Never run unserialised: that is the double send the lock prevents.
    expect(ran).toBe(false);
    release("done");
    expect(await holder).toBe("done");
  });

  it("does not run the drain twice when the drain itself throws", async () => {
    let runs = 0;
    const boom = async () => { runs++; throw new Error("boom"); };
    await expect(withDrainLock(boom, fakeLocks())).rejects.toThrow("boom");
    expect(runs).toBe(1);
  });

  // Regression: f8ac8dc — AbortSignal.timeout was called bare, outside the try:
  // on Safari 15.4–15.x (locks but no AbortSignal.timeout) the TypeError
  // escaped as an unhandled rejection and no retry was armed.
  it("still bounds the wait where AbortSignal.timeout does not exist", async () => {
    const original = AbortSignal.timeout;
    AbortSignal.timeout = undefined;
    try {
      const locks = fakeLocks();
      let release;
      const holder = withDrainLock(() => new Promise((r) => { release = r; }), locks);
      expect(await withDrainLock(async () => "ran", locks, { waitMs: 20 })).toBe(DRAIN_BUSY);
      release("done");
      expect(await holder).toBe("done");
    } finally {
      AbortSignal.timeout = original;
    }
  });

  // Regression: debfdaa — the AbortSignal.timeout fallback never cleared its
  // timer: every drain left one pending for the full lock wait.
  it("leaves no timer behind once the drain has run, on the fallback", async () => {
    const original = AbortSignal.timeout;
    AbortSignal.timeout = undefined;
    vi.useFakeTimers();
    try {
      expect(await withDrainLock(async () => "ran", fakeLocks())).toBe("ran");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      AbortSignal.timeout = original;
    }
  });
});

describe("retryParkedUnderLock", () => {
  // Regression: 9ee8acc — « Réessayer » ran outside the drain lock, so a catalog
  // push in flight in another tab was invisible to its pruning.
  const parkedOutbox = () => {
    const o = enqueue(E, { key: "catalog", kind: "catalog", payload: { ops: [{ id: "s_1_a", op: "x", args: [] }] } });
    return { ...o, queue: [], parked: o.queue };
  };
  const memStore = (o) => ({ get: () => o, set: (n) => { o = n; } });

  it("unparks while the drain lock is held, and not before", async () => {
    const events = [];
    const locks = {
      request: async (_name, _opts, fn) => { events.push("lock"); const r = await fn(); events.push("unlock"); return r; },
    };
    const store = memStore(parkedOutbox());
    const done = await retryParkedUnderLock(store, null, {
      keepOps: (ops) => { events.push("keepOps"); return ops; },
    }, locks);
    expect(done).toBe(true);
    expect(events).toEqual(["lock", "keepOps", "unlock"]);
    expect(store.get().parked).toEqual([]);
    expect(store.get().queue).toHaveLength(1);
  });

  it("waits behind a holder, so a push in flight settles first", async () => {
    let release;
    const order = [];
    let tail = Promise.resolve();
    const locks = {
      request: (_n, _o, fn) => { const run = tail.then(fn); tail = run.catch(() => {}); return run; },
    };
    const push = withDrainLock(() => new Promise((r) => { release = () => { order.push("push settled"); r(); }; }), locks);
    const store = memStore(parkedOutbox());
    const retry = retryParkedUnderLock(store, null, { keepOps: (o) => { order.push("prune"); return o; } }, locks);
    await Promise.resolve();
    expect(order).toEqual([]);
    release();
    await push;
    expect(await retry).toBe(true);
    expect(order).toEqual(["push settled", "prune"]);
  });

  it("never prunes or unparks when the lock wait ran out", async () => {
    const locks = { request: (_n, { signal }) => new Promise((_r, rej) => signal.addEventListener("abort", () => rej(new DOMException("t", "AbortError")))) };
    const store = memStore(parkedOutbox());
    let ran = false;
    const done = await retryParkedUnderLock(store, null, { keepOps: (o) => { ran = true; return o; } }, locks, { waitMs: 5 });
    expect(done).toBe(false);
    expect(ran).toBe(false);
    expect(store.get().parked).toHaveLength(1);
  });

  // Regression: d38bd2f — every key took the drain lock, so a session retry
  // waited behind an unrelated catalog push.
  it("unparks a non-catalog key without taking the lock", async () => {
    const o = enqueue(E, { key: "plan", kind: "plan", payload: { x: 1 } });
    const store = memStore({ ...o, queue: [], parked: o.queue });
    let taken = 0;
    const locks = { request: async (_n, _o, fn) => { taken++; return fn(); } };
    expect(await retryParkedUnderLock(store, null, {}, locks)).toBe(true);
    expect(taken).toBe(0);
    expect(store.get().parked).toEqual([]);
    expect(store.get().queue).toHaveLength(1);
  });

  // Regression: d38bd2f — a retry waiting for the lock ran after unmount.
  it("does nothing, and returns false, once inactive", async () => {
    const locks = { request: async (_n, _o, fn) => fn() };
    const store = memStore(parkedOutbox());
    expect(await retryParkedUnderLock(store, null, { active: () => false }, locks)).toBe(false);
    expect(store.get().parked).toHaveLength(1);
  });
});

describe("singleFlight", () => {
  // Regression: d38bd2f — a second « Réessayer » tap ran concurrently and
  // cleared the first tap's notice.
  it("ignores calls while one is pending, then allows the next", async () => {
    let release;
    let runs = 0;
    const flips = [];
    const flag = { current: false };
    const run = () => singleFlight(flag, () => { runs++; return new Promise((r) => { release = r; }); }, (p) => flips.push(p));
    const first = run();
    expect(await run()).toBeUndefined();
    expect(runs).toBe(1);
    release("ok");
    expect(await first).toBe("ok");
    run();
    expect(runs).toBe(2);
    expect(flips).toEqual([true, false, true]);
  });
});
