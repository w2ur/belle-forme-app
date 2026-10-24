import { describe, it, expect } from "vitest";
import { reconcile, dirtyDuringPull, sessionsAfterPull, entityAfterPull, isDirty } from "./reconcile.js";
import { enqueue, drainWith } from "./outbox.js";

const drain = async (source, exec) => (await drainWith(source, exec)).outbox;
// A usable document only, for the adopt/keep decision. The seed is a frozen
// fixture, not the live catalog — nothing here asserts on its content.
import seed from "../data/catalogSeed.json";

const ob = (...keys) => ({ queue: keys.map((key) => ({ key })), parked: [] });

describe("reconcile — the outbox is the dirty set", () => {
  // Regression (2026-09-30 plan review): an edit whose immediate push was still
  // in flight when the pull landed was not in the queue yet, so the cloud copy
  // reverted it. B2 now enqueues first; this pins that the in-flight entry counts.
  it("an edit whose push is still in flight survives a concurrent pull", () => {
    const o = enqueue({ queue: [], parked: [] }, { key: "session:x", kind: "session", payload: { id: "x" } });
    // no complete() yet: the push has not returned
    const out = reconcile({ local: { sessions: [{ id: "x", name: "local" }] }, cloud: { sessions: [{ id: "x", name: "cloud" }] }, outbox: o });
    expect(out.sessions[0].name).toBe("local");
  });

  it("a parked entry is dirty too", () => {
    const out = reconcile({ local: { plan: { v: "L" } }, cloud: { plan: { v: "C" } }, outbox: { queue: [], parked: [{ key: "plan" }] } });
    expect(out.plan.v).toBe("L");
  });

  it("a session pending in the outbox keeps its local copy over the cloud's", () => {
    const local = { sessions: [{ id: "x", name: "local" }] };
    const cloud = { sessions: [{ id: "x", name: "cloud" }] };
    const out = reconcile({ local, cloud, outbox: ob("session:x") });
    expect(out.sessions.find((s) => s.id === "x").name).toBe("local");
  });

  it("with an empty outbox the cloud copy wins, as today", () => {
    const out = reconcile({ local: { sessions: [{ id: "x", name: "l" }] }, cloud: { sessions: [{ id: "x", name: "c" }] }, outbox: ob() });
    expect(out.sessions[0].name).toBe("c");
  });

  it("local-only sessions are kept and listed for re-push", () => {
    const out = reconcile({ local: { sessions: [{ id: "only" }] }, cloud: { sessions: [] }, outbox: ob() });
    expect(out.sessions.map((s) => s.id)).toEqual(["only"]);
    expect(out.repush.map((s) => s.id)).toEqual(["only"]);
  });

  // Beyond the plan's list: the other dirty keys and their edges.

  it("a pending delete keeps the cloud copy from resurrecting the session", () => {
    const out = reconcile({
      local: { sessions: [] },
      cloud: { sessions: [{ id: "gone", name: "c" }, { id: "kept", name: "c" }] },
      outbox: ob("session-delete:gone"),
    });
    expect(out.sessions.map((s) => s.id)).toEqual(["kept"]);
  });

  it("a local-only session already in the outbox is not re-pushed a second time", () => {
    const out = reconcile({
      local: { sessions: [{ id: "q" }, { id: "fresh" }] },
      cloud: { sessions: [{ id: "other", name: "c" }] },
      outbox: { queue: [], parked: [{ key: "session:q" }] },
    });
    expect(out.sessions.map((s) => s.id).sort()).toEqual(["fresh", "other", "q"]);
    // A re-push of a parked session would supersede the parked entry and
    // silently retry what the server refused.
    expect(out.repush.map((s) => s.id)).toEqual(["fresh"]);
  });

  it("a pending profile write keeps both local profile and local settings", () => {
    const out = reconcile({
      local: { profile: { name: "L" }, settings: { defaultTimer: 60 } },
      cloud: { profile: { name: "C" }, settings: { defaultTimer: 120 } },
      outbox: ob("profile"),
    });
    expect(out.profile.name).toBe("L");
    expect(out.settings.defaultTimer).toBe(60);
  });

  it("with no pending profile the cloud profile and settings win", () => {
    const out = reconcile({
      local: { profile: { name: "L" }, settings: { defaultTimer: 60 } },
      cloud: { profile: { name: "C" }, settings: { defaultTimer: 120 } },
      outbox: ob(),
    });
    expect(out.profile.name).toBe("C");
    expect(out.settings.defaultTimer).toBe(120);
    expect(out.seedProfile).toBe(false);
  });

  it("an empty cloud is seeded with every local session, the plan and the profile", () => {
    const out = reconcile({
      local: { sessions: [{ id: "a" }, { id: "b" }], plan: { weekStart: "2026-09-28" }, profile: { name: "L" }, settings: {} },
      cloud: { sessions: [], plan: null, profile: null, settings: null },
      outbox: ob(),
    });
    expect(out.repush.map((s) => s.id)).toEqual(["a", "b"]);
    expect(out.seedPlan).toEqual({ weekStart: "2026-09-28" });
    expect(out.seedProfile).toBe(true);
  });

  it("a cloud plan replaces a clean local plan, with its dates normalised and its impossible range repaired", () => {
    const out = reconcile({
      local: { plan: { v: "L" } },
      // End year before start year: the legacy repair borrows the start's year.
      cloud: { plan: { week_start: new Date("2026-09-28T00:00:00.000Z"), week_end: "2025-10-04", data: { sessions: [] }, raw: "r" } },
      outbox: ob(),
    });
    expect(out.plan).toEqual({ weekStart: "2026-09-28", weekEnd: "2026-10-04", sessions: [], raw: "r" });
    expect(out.seedPlan).toBeNull();
  });

  // Regression: f791469 — the pull serialises the plan's DATE columns as full ISO
  // timestamps, and only a Date object was cut: a string came through whole, so
  // weekStart read "2026-09-28T00:00:00.000Z" where every reader compares YYYY-MM-DD.
  it("cloud plan dates sent as ISO timestamp strings are cut to YYYY-MM-DD", () => {
    const out = reconcile({
      local: {},
      cloud: { plan: { week_start: "2026-09-28T00:00:00.000Z", week_end: "2026-10-04T00:00:00.000Z", data: { sessions: [] }, raw: "" } },
      outbox: ob(),
    });
    expect(out.plan.weekStart).toBe("2026-09-28");
    expect(out.plan.weekEnd).toBe("2026-10-04");
  });

  it("a cloud plan with only one date still has it cut, and a missing one stays missing", () => {
    const out = reconcile({
      local: {},
      cloud: { plan: { week_start: "2026-09-28T00:00:00.000Z", week_end: null, data: {}, raw: "" } },
      outbox: ob(),
    });
    expect(out.plan.weekStart).toBe("2026-09-28");
    expect(out.plan.weekEnd).toBeNull();
  });

  it("cloud session rows are flattened and their timestamp date cut to YYYY-MM-DD", () => {
    const out = reconcile({
      local: { sessions: [] },
      cloud: { sessions: [{ id: "x", date: "2026-09-29T00:00:00.000Z", name: "Haut", data: { exercises: [] } }] },
      outbox: ob(),
    });
    expect(out.sessions).toEqual([{ id: "x", date: "2026-09-29", name: "Haut", exercises: [] }]);
  });

  it("a degenerate cloud catalog never replaces the local one", () => {
    const out = reconcile({ local: { catalog: { v: "L" } }, cloud: { catalog: { entries: [] } }, outbox: ob() });
    expect(out.catalog.v).toBe("L");
  });
});

describe("reconcile — catalog against a usable cloud document", () => {
  it("a clean local catalog is replaced by a usable cloud document", () => {
    const out = reconcile({ local: { catalog: { v: "L" } }, cloud: { catalog: seed }, outbox: ob() });
    expect(out.catalog).toBe(seed);
  });

  // The caller decides the catalog by version and passes the rebased
  // document (or null): pending operations are already replayed on it.
  it("no cloud catalog keeps the local document", () => {
    const out = reconcile({ local: { catalog: { v: "L" } }, cloud: { catalog: null }, outbox: ob() });
    expect(out.catalog.v).toBe("L");
  });
});

describe("dirtyDuringPull — a write that LANDED during the pull is still newer than it", () => {
  // Regression (2026-10-01, B3 preview check): offline edit, then a reload
  // online. The mount drain pushed the queued session while the pull was in
  // flight; the push completed first, so the response-time outbox no longer
  // held `session:x`, and the pull's snapshot — read before the push landed —
  // reverted her edit to the cloud copy (reproduced in the production preview).
  it("an entry queued when the pull left and completed before it returned still protects the local copy", async () => {
    const atSend = enqueue({ queue: [], parked: [] }, { key: "session:x", kind: "session", payload: { id: "x" } });
    const atResponse = await drain(atSend, async () => {});
    expect(atResponse.queue).toEqual([]);
    const out = reconcile({
      local: { sessions: [{ id: "x", name: "local" }] },
      cloud: { sessions: [{ id: "x", name: "stale cloud" }] },
      outbox: dirtyDuringPull({ atSend, written: [], atResponse }),
    });
    expect(out.sessions[0].name).toBe("local");
  });

  it("an edit made AND confirmed during the round trip protects the local copy", () => {
    const empty = { queue: [], parked: [] };
    const out = reconcile({
      local: { plan: { v: "L" } },
      cloud: { plan: { week_start: "2026-09-28", week_end: "2026-10-04", data: {}, raw: "" } },
      outbox: dirtyDuringPull({ atSend: empty, written: ["plan"], atResponse: empty }),
    });
    expect(out.plan.v).toBe("L");
  });

  it("is the union of the three, parked entries included", () => {
    const d = dirtyDuringPull({
      atSend: { queue: [{ key: "a" }], parked: [{ key: "p" }] },
      written: ["b"],
      atResponse: { queue: [{ key: "c" }], parked: [] },
    });
    expect(d.queue.map((e) => e.key).sort()).toEqual(["a", "b", "c", "p"]);
  });
});

describe("sessionsAfterPull — commit against the state as it is now", () => {
  const cloud = { sessions: [{ id: "x", date: "2026-09-29", name: "cloud", data: {} }] };
  const snapshot = [{ id: "x", date: "2026-09-29", name: "local" }];
  const args = { local: { sessions: snapshot }, cloud, outbox: ob() };

  // Regression: 4a4f6bc — the pull committed `setSessions(out.sessions)`, computed from a
  // snapshot, so a session saved in the same tick (queued, not yet rendered
  // into the snapshot) was erased from state until the next pull.
  it("keeps a session saved after the snapshot was taken", () => {
    const out = reconcile(args);
    const current = [{ id: "new", date: "2026-10-01", name: "à l'instant" }, ...snapshot];
    const next = sessionsAfterPull(current, {
      snapshot, reconciled: out.sessions, args: { ...args, outbox: ob("session:new") },
    });
    expect(next.map((s) => s.id).sort()).toEqual(["new", "x"]);
    expect(next.find((s) => s.id === "x").name).toBe("cloud");
  });

  it("keeps an edit made after the snapshot over the cloud copy", () => {
    const out = reconcile(args);
    const current = [{ id: "x", date: "2026-09-29", name: "modifiée" }];
    const next = sessionsAfterPull(current, {
      snapshot, reconciled: out.sessions, args: { ...args, outbox: ob("session:x") },
    });
    expect(next).toEqual(current);
  });

  it("commits the reconciled result as is when state has not moved", () => {
    const out = reconcile(args);
    expect(sessionsAfterPull(snapshot, { snapshot, reconciled: out.sessions, args })).toBe(out.sessions);
  });
});

describe("entityAfterPull — a pending write beats the render snapshot", () => {
  // Regression: 75896e9 — profile, settings and plan were committed from the
  // pull as plain values. `reconcile` keeps the local copy of a dirty entity,
  // but that copy is the render SNAPSHOT: a profile saved in the same tick as
  // the response (pushed, its setProfile queued but not rendered) was
  // overwritten in state by the snapshot's older profile.
  it("keeps what state holds now when the key is dirty", () => {
    const saved = { name: "Camille", weight: 70 };
    const snapshot = { name: "Camille", weight: 71 };
    const dirty = { queue: [{ key: "profile" }], parked: [] };
    expect(entityAfterPull(saved, { key: "profile", dirty, reconciled: snapshot })).toBe(saved);
  });

  it("a parked write is dirty too", () => {
    const dirty = { queue: [], parked: [{ key: "plan" }] };
    expect(entityAfterPull("mine", { key: "plan", dirty, reconciled: "cloud" })).toBe("mine");
    expect(isDirty(dirty, "plan")).toBe(true);
    expect(isDirty(dirty, "profile")).toBe(false);
  });

  it("takes the reconciled value when nothing is pending for the key", () => {
    const dirty = { queue: [{ key: "session:s1" }], parked: [] };
    expect(entityAfterPull("mine", { key: "profile", dirty, reconciled: "cloud" })).toBe("cloud");
    expect(entityAfterPull("mine", { key: "profile", dirty: null, reconciled: "cloud" })).toBe("cloud");
  });
});
