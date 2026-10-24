import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { createSyncClient, SyncAuthError, getSyncClient, resetSyncClient, shouldForgetKey } = await import("./sync.js");

describe("sync client", () => {
  let sync;

  beforeEach(() => {
    mockFetch.mockReset();
    sync = createSyncClient("https://example.com", "test-api-key");
  });

  it("upsertSession sends POST with auth header", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) });
    const session = { id: "s_1", date: "2026-02-24", name: "Push", exercises: [], duration_minutes: "45", general_notes: "" };

    await sync.upsertSession(session);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/api/sync-sessions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-api-key",
        }),
      })
    );
  });

  it("upsertSession sends session data with id, date, name as top-level fields", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) });
    const session = { id: "s_1", date: "2026-02-24", name: "Push", exercises: [{ name: "Bench" }], duration_minutes: "45" };

    await sync.upsertSession(session);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.action).toBe("upsert");
    expect(body.session.id).toBe("s_1");
    expect(body.session.date).toBe("2026-02-24");
    expect(body.session.name).toBe("Push");
    expect(body.session.data.exercises).toEqual([{ name: "Bench" }]);
  });

  it("deleteSession sends POST with delete action", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) });

    await sync.deleteSession("s_1");

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.action).toBe("delete");
    expect(callBody.id).toBe("s_1");
  });

  it("pushCatalog PUTs the document with the version it was built on, and returns the body", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ saved: true, updatedAt: "2026-10-01T00:00:00.000Z" }) });
    const doc = { version: 1, exercises: [{ name: "Squat" }], aliases: {} };

    const res = await sync.pushCatalog({ doc, baseUpdatedAt: "2026-09-30T10:00:00.123Z" });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/api/sync-catalog",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({ Authorization: "Bearer test-api-key" }),
      })
    );
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ doc, baseUpdatedAt: "2026-09-30T10:00:00.123Z" });
    expect(res).toEqual({ saved: true, updatedAt: "2026-10-01T00:00:00.000Z" });
  });

  // A null base is sent as null, not dropped: the endpoint reads a body with
  // no `baseUpdatedAt` key as the legacy, unchecked shape.
  it("pushCatalog sends a null base explicitly", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ saved: true, updatedAt: "x" }) });
    await sync.pushCatalog({ doc: { exercises: [] }, baseUpdatedAt: null });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ doc: { exercises: [] }, baseUpdatedAt: null });
  });

  it("pushCatalog throws on a rejected document, so the caller can surface it", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, json: () => Promise.resolve({ error: "x" }) });
    await expect(sync.pushCatalog({ doc: { version: 1, exercises: [] }, baseUpdatedAt: null })).rejects.toThrow(/400/);
  });

  // The 409 carries the server's current document: the caller replays its
  // operations onto it without a second round trip.
  it("a 409 throws with the status and the server's body attached", async () => {
    const current = { doc: { exercises: [{ name: "C" }] }, updatedAt: "2026-10-01T00:00:00.000Z" };
    mockFetch.mockResolvedValueOnce({ ok: false, status: 409, json: () => Promise.resolve(current) });
    const err = await sync.pushCatalog({ doc: {}, baseUpdatedAt: "old" }).catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.body).toEqual(current);
  });

  it("pushPlan sends plan with correct field mapping", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) });

    await sync.pushPlan({ weekStart: "2026-02-10", weekEnd: "2026-02-16", sessions: [], coachNotes: "test", raw: "FITTRACK" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.plan.week_start).toBe("2026-02-10");
    expect(body.plan.week_end).toBe("2026-02-16");
    expect(body.plan.data.sessions).toEqual([]);
    expect(body.plan.raw).toBe("FITTRACK");
  });

  it("pushPlan returns null for null plan", async () => {
    const result = await sync.pushPlan(null);
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("pullAll fetches from sync-pull", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ sessions: [], plan: null, profile: null, settings: null })
    });

    const data = await sync.pullAll();

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/api/sync-pull",
      expect.objectContaining({ method: "GET" })
    );
    expect(data.sessions).toEqual([]);
  });

  it("throws on network error so callers can flag the failure and retry", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    await expect(sync.pullAll()).rejects.toThrow();
  });

  it("throws on non-ok response instead of silently reporting success", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    await expect(sync.pullAll()).rejects.toThrow(/500/);
  });

  it("upsertSession rejects on a failed push (so the outbox keeps it)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    const session = { id: "s_1", date: "2026-02-24", name: "Push", exercises: [] };

    await expect(sync.upsertSession(session)).rejects.toThrow(/401/);
  });

  // Regression: 2026-10-01 B4 — nothing handled a 401, so after a SYNC_API_KEY
  // rotation every sync failed silently and the indicator stayed red forever.
  it("a 401 rejects with a SyncAuthError carrying status 401", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    const err = await sync.pullAll().catch((e) => e);
    expect(err).toBeInstanceOf(SyncAuthError);
    expect(err.name).toBe("SyncAuthError");
    expect(err.status).toBe(401);
  });

  it("resetSyncClient drops the cached client so a new key is read", () => {
    const store = {};
    vi.stubGlobal("localStorage", {
      getItem: (k) => store[k] ?? null,
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; },
    });
    localStorage.setItem("fittrack_sync_key", "one");
    const a = getSyncClient();
    resetSyncClient();
    localStorage.setItem("fittrack_sync_key", "two");
    expect(getSyncClient()).not.toBe(a);
    resetSyncClient();
    localStorage.removeItem("fittrack_sync_key");
    expect(getSyncClient()).toBeNull();
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", mockFetch);
  });

  // The outbox decides from the status whether to retry, park or stop: a 4xx
  // the server will never accept must not block every write behind it.
  it("a failed request rejects with the HTTP status on the error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 422 });
    await expect(sync.pushProfile({}, {})).rejects.toMatchObject({ status: 422 });
  });

  it("a network failure rejects with no status", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const err = await sync.pushProfile({}, {}).catch((e) => e);
    expect(err.status).toBeUndefined();
  });

  // Regression: 7d09f00 — request() had no timeout. A request that never answered
  // never settled, so the drain awaiting it held the single-flight flag and
  // the cross-tab lock forever, and no tab synced again.
  it("abandons a request that never answers, as a transient failure", async () => {
    const hung = createSyncClient("https://example.com", "k", { timeoutMs: 20 });
    // A fetch that only ever settles through its abort signal.
    mockFetch.mockImplementationOnce((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason));
    }));
    const err = await hung.pushProfile({}, {}).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/timed out/);
    expect(err.status).toBeUndefined();
  });

  it("a request that answers in time keeps its status, timeout or not", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(sync.pushProfile({}, {})).rejects.toMatchObject({ status: 503 });
    expect(mockFetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  // Regression: f8ac8dc — AbortSignal.timeout was called bare. Safari 15.4–15.x
  // has navigator.locks but not AbortSignal.timeout, so every request threw a
  // TypeError before it left.
  it("still times out where AbortSignal.timeout does not exist", async () => {
    const original = AbortSignal.timeout;
    AbortSignal.timeout = undefined;
    try {
      const hung = createSyncClient("https://example.com", "k", { timeoutMs: 20 });
      mockFetch.mockImplementationOnce((_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      }));
      const err = await hung.pushProfile({}, {}).catch((e) => e);
      expect(err.message).toMatch(/timed out/);
      expect(err.status).toBeUndefined();
    } finally {
      AbortSignal.timeout = original;
    }
  });

  // Regression: debfdaa — the AbortSignal.timeout fallback never cleared its
  // timer: every request left one pending for the full timeout.
  it("leaves no timer behind once a request settles, on the fallback", async () => {
    const original = AbortSignal.timeout;
    AbortSignal.timeout = undefined;
    vi.useFakeTimers();
    try {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
      await sync.pushProfile({}, {});
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      AbortSignal.timeout = original;
    }
  });

  // Regression: a5509f0 — the coach and the export threw a plain Error on 401,
  // with no status, so neither could be told apart from an outage: the app
  // stayed on a « réessaie » banner (coach) or a toast (export) that no retry
  // could clear, instead of returning to the gate like every sync 401.
  it("sendCoachMessage and downloadExport reject a 401 as a SyncAuthError", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    await expect(sync.sendCoachMessage({ message: "x", exportContext: "" })).rejects.toBeInstanceOf(SyncAuthError);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    await expect(sync.downloadExport()).rejects.toMatchObject({ name: "SyncAuthError", status: 401 });
  });

  it("sendCoachMessage and downloadExport carry any other failing status", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502 });
    await expect(sync.sendCoachMessage({ message: "x", exportContext: "" })).rejects.toMatchObject({ status: 502 });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(sync.downloadExport()).rejects.toMatchObject({ status: 500 });
  });

  it("sendCoachMessage POSTs to coach-chat with auth and returns the raw response", async () => {
    const fakeRes = { ok: true, body: {} };
    mockFetch.mockResolvedValueOnce(fakeRes);

    const res = await sync.sendCoachMessage({ message: "salut", exportContext: "EXP" });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/api/coach-chat",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-api-key" }),
      }),
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.message).toBe("salut");
    expect(body.exportContext).toBe("EXP");
    expect(res).toBe(fakeRes);
  });

  it("sends the coach mode so the server can pick the right prompt", async () => {
    // The mode decides whether the model is even shown the FITTRACK PLAN format,
    // so it has to survive the round trip. Chat is the default: everything except
    // the explicit « Mon programme de la semaine » button is daily coaching.
    mockFetch.mockResolvedValueOnce({ ok: true, body: {} });
    await sync.sendCoachMessage({ message: "ma semaine", exportContext: "EXP", mode: "plan" });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).mode).toBe("plan");

    mockFetch.mockResolvedValueOnce({ ok: true, body: {} });
    await sync.sendCoachMessage({ message: "combien ?", exportContext: "EXP" });
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).mode).toBe("chat");
  });

  it("sendCoachMessage throws on a non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502 });
    await expect(sync.sendCoachMessage({ message: "x", exportContext: "" })).rejects.toThrow(/502/);
  });

  it("fetchCoachHistory GETs coach-chat", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ messages: [] }) });
    const data = await sync.fetchCoachHistory();
    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/api/coach-chat",
      expect.objectContaining({ method: "GET" }),
    );
    expect(data.messages).toEqual([]);
  });
});

describe("shouldForgetKey", () => {
  // Regression: b529c18 — a 401 removed the stored key unconditionally, so a
  // tab still running on a rotated key deleted the fresh key another tab had just
  // stored at login, and every tab went back to the gate.
  it("keeps a stored key that is not the one refused", () => {
    expect(shouldForgetKey({ stored: "fresh", used: "stale" })).toBe(false);
  });

  it("forgets the stored key when it is the one refused", () => {
    expect(shouldForgetKey({ stored: "k", used: "k" })).toBe(true);
  });

  it("forgets it when the refused key is unknown, as before", () => {
    expect(shouldForgetKey({ stored: "k", used: null })).toBe(true);
  });

  // Regression: 760fcd1 — the refused key was read off this tab's CURRENT client.
  // A request sent on the stale key, answering 401 after the shell had
  // remounted on the fresh one, made the fresh key look refused, and it was
  // deleted. The 401 now carries the key its own request sent.
  it("keeps a fresh stored key when a request sent on the stale one answers 401 late", async () => {
    const stale = createSyncClient("https://example.com", "stale");
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    const err = await stale.pullAll().catch((e) => e);
    expect(err.key).toBe("stale");
    expect(shouldForgetKey({ stored: "fresh", used: err.key ?? null })).toBe(false);
  });

  it("every 401 carries the key its request sent", async () => {
    const client = createSyncClient("https://example.com", "k1");
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    expect((await client.sendCoachMessage({ message: "x", exportContext: "" }).catch((e) => e)).key).toBe("k1");
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    expect((await client.downloadExport().catch((e) => e)).key).toBe("k1");
  });
});
