import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
mockSql.transaction = vi.fn();
vi.mock("../functions/lib/db.js", () => ({
  getDb: () => mockSql,
  authorize: (event) => {
    const token = (event.headers.authorization || "").replace("Bearer ", "");
    if (token !== "test-key") return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
    return null;
  },
  ok: (data) => ({ statusCode: 200, body: JSON.stringify(data) }),
  err: (msg, status = 500) => ({ statusCode: status, body: JSON.stringify({ error: msg }) }),
}));

const { handler } = await import("../functions/sync-plan.js");

const authedEvent = (method, body) => ({
  httpMethod: method,
  headers: { authorization: "Bearer test-key" },
  body: body ? JSON.stringify(body) : null,
});

describe("sync-plan", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockSql.transaction.mockReset();
  });

  it("rejects unauthorized requests", async () => {
    const res = await handler({ httpMethod: "GET", headers: {} });
    expect(res.statusCode).toBe(401);
  });

  it("GET returns latest plan", async () => {
    mockSql.mockResolvedValueOnce([
      { id: 1, week_start: "2026-02-10", week_end: "2026-02-16", data: { sessions: [] }, raw: "FITTRACK PLAN", updated_at: "2026-02-24T10:00:00Z" }
    ]);
    const res = await handler(authedEvent("GET"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).plan).toBeTruthy();
  });

  it("GET returns null when no plan", async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = await handler(authedEvent("GET"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).plan).toBeNull();
  });

  it("POST upserts a plan inside a single transaction", async () => {
    mockSql.mockReturnValue({});
    mockSql.transaction.mockResolvedValue([]);
    const res = await handler(authedEvent("POST", {
      plan: { week_start: "2026-02-10", week_end: "2026-02-16", data: { sessions: [] }, raw: "FITTRACK PLAN" }
    }));
    expect(res.statusCode).toBe(200);
    // DELETE + INSERT must run atomically, never as separate awaited queries.
    expect(mockSql.transaction).toHaveBeenCalledTimes(1);
    const queries = mockSql.transaction.mock.calls[0][0];
    expect(queries).toHaveLength(2);
  });

  it("does not wipe the plan when the insert fails (transaction rolls back)", async () => {
    // Regression: DELETE + INSERT were awaited separately, so a failed INSERT
    // left the plans table empty. The transaction must fail as a unit → 500.
    mockSql.mockReturnValue({});
    mockSql.transaction.mockRejectedValueOnce(new Error("insert failed"));
    const res = await handler(authedEvent("POST", {
      plan: { week_start: "2026-02-10", week_end: "2026-02-16", data: { sessions: [] }, raw: "FITTRACK PLAN" }
    }));
    expect(res.statusCode).toBe(500);
    expect(mockSql.transaction).toHaveBeenCalledTimes(1);
  });

  // Regression: e3fc15f — a permanent data error (SQLSTATE class 22/23) was answered
  // 500, which the client outbox retries forever in order.
  it("answers 400, not 500, when Postgres refuses the row itself", async () => {
    mockSql.mockReturnValue({});
    mockSql.transaction.mockRejectedValueOnce(Object.assign(new Error("pg"), { code: "22008" }));
    const res = await handler(authedEvent("POST", {
      plan: { week_start: "2026-99-99", week_end: "2026-02-16", data: {}, raw: "" },
    }));
    expect(res.statusCode).toBe(400);
  });

  it("answers 400 to a body that does not parse or carries no plan", async () => {
    expect((await handler({ ...authedEvent("POST"), body: "{" })).statusCode).toBe(400);
    expect((await handler(authedEvent("POST", { nope: 1 }))).statusCode).toBe(400);
    expect(mockSql.transaction).not.toHaveBeenCalled();
  });
});
