import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
vi.mock("../functions/lib/db.js", () => ({
  getDb: () => mockSql,
  authorize: (event) => {
    const token = (event.headers.authorization || "").replace("Bearer ", "");
    if (token !== "test-key") {
      return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
    }
    return null;
  },
  ok: (data) => ({ statusCode: 200, body: JSON.stringify(data) }),
  err: (msg, status = 500) => ({ statusCode: status, body: JSON.stringify({ error: msg }) }),
}));

const { handler } = await import("../functions/sync-sessions.js");
const { enqueue, drainWith } = await import("../../src/lib/outbox.js");
const drain = async (source, exec) => (await drainWith(source, exec)).outbox;

const authedEvent = (method, body) => ({
  httpMethod: method,
  headers: { authorization: "Bearer test-key" },
  body: body ? JSON.stringify(body) : null,
});

describe("sync-sessions", () => {
  beforeEach(() => {
    mockSql.mockReset();
  });

  it("rejects unauthorized requests", async () => {
    const res = await handler({ httpMethod: "GET", headers: {} });
    expect(res.statusCode).toBe(401);
  });

  it("GET returns sessions from db", async () => {
    mockSql.mockResolvedValueOnce([
      { id: "s_1", date: "2026-02-24", name: "Push", data: { exercises: [] }, created_at: "2026-02-24T10:00:00Z", updated_at: "2026-02-24T10:00:00Z" }
    ]);
    const res = await handler(authedEvent("GET"));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe("s_1");
  });

  it("POST upsert inserts a session", async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = await handler(authedEvent("POST", {
      action: "upsert",
      session: { id: "s_1", date: "2026-02-24", name: "Push", data: { exercises: [] } }
    }));
    expect(res.statusCode).toBe(200);
  });

  it("POST delete removes a session", async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = await handler(authedEvent("POST", {
      action: "delete",
      id: "s_1"
    }));
    expect(res.statusCode).toBe(200);
  });

  it("rejects unknown actions", async () => {
    const res = await handler(authedEvent("POST", { action: "drop" }));
    expect(res.statusCode).toBe(400);
  });

  // Regression: e3fc15f — a permanent data error (SQLSTATE class 22/23) was answered
  // 500, which the client outbox retries forever in order — so one bad
  // session blocked every write queued behind it.
  it("answers 400, not 500, when Postgres refuses the row itself", async () => {
    mockSql.mockRejectedValueOnce(Object.assign(new Error("pg"), { code: "23502" }));
    const res = await handler(authedEvent("POST", {
      action: "upsert",
      session: { id: "s_1", date: null, name: "Push", data: {} },
    }));
    expect(res.statusCode).toBe(400);
    mockSql.mockRejectedValueOnce(Object.assign(new Error("pg"), { code: "22007" }));
    const res2 = await handler(authedEvent("POST", {
      action: "upsert",
      session: { id: "s_1", date: "pas une date", name: "Push", data: {} },
    }));
    expect(res2.statusCode).toBe(400);
  });

  it("still answers 500 when the failure says nothing about the payload", async () => {
    mockSql.mockRejectedValueOnce(Object.assign(new Error("pg"), { code: "08006" }));
    const res = await handler(authedEvent("POST", { action: "delete", id: "s_1" }));
    expect(res.statusCode).toBe(500);
    mockSql.mockRejectedValueOnce(new Error("fetch failed"));
    const res2 = await handler(authedEvent("POST", { action: "delete", id: "s_1" }));
    expect(res2.statusCode).toBe(500);
  });

  it("answers 400 to a body that does not parse or an upsert with no session", async () => {
    const res = await handler({ ...authedEvent("POST"), body: "{pas du json" });
    expect(res.statusCode).toBe(400);
    const res2 = await handler(authedEvent("POST", { action: "upsert" }));
    expect(res2.statusCode).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  // Regression: 2aaf8d4 — end to end, endpoint to outbox. A session Postgres refuses
  // (SQLSTATE 23) used to come back 500, so the outbox retried it at the head
  // of the line forever and the session queued behind it never landed.
  it("a session Postgres refuses is parked and the one behind it lands", async () => {
    const landed = [];
    mockSql.mockImplementation(async (_strings, ...values) => {
      if (values.includes("s_bad")) throw Object.assign(new Error("null value in column"), { code: "23502" });
      landed.push(values[0]);
      return [];
    });
    const exec = async (entry) => {
      const res = await handler(authedEvent("POST", { action: "upsert", session: entry.payload }));
      if (res.statusCode !== 200) throw Object.assign(new Error("sync failed"), { status: res.statusCode });
    };
    let o = { queue: [], parked: [] };
    o = enqueue(o, { key: "session:s_bad", kind: "session", payload: { id: "s_bad", date: null, name: "x", data: {} } });
    o = enqueue(o, { key: "session:s_ok", kind: "session", payload: { id: "s_ok", date: "2026-10-01", name: "y", data: {} } });
    o = await drain(o, exec);
    expect(landed).toEqual(["s_ok"]);
    expect(o.queue).toEqual([]);
    expect(o.parked.map((e) => e.key)).toEqual(["session:s_bad"]);
  });
});
