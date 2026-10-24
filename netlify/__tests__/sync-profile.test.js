import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
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

const { handler } = await import("../functions/sync-profile.js");

const authedEvent = (method, body) => ({
  httpMethod: method,
  headers: { authorization: "Bearer test-key" },
  body: body ? JSON.stringify(body) : null,
});

describe("sync-profile", () => {
  beforeEach(() => mockSql.mockReset());

  it("rejects unauthorized requests", async () => {
    const res = await handler({ httpMethod: "GET", headers: {} });
    expect(res.statusCode).toBe(401);
  });

  it("GET returns profile and settings", async () => {
    mockSql
      .mockResolvedValueOnce([{ data: { name: "Camille" }, updated_at: "2026-02-24T10:00:00Z" }])
      .mockResolvedValueOnce([{ data: { defaultTimer: 90 }, updated_at: "2026-02-24T10:00:00Z" }]);
    const res = await handler(authedEvent("GET"));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.profile.name).toBe("Camille");
    expect(body.settings.defaultTimer).toBe(90);
  });

  it("GET returns null when empty", async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = await handler(authedEvent("GET"));
    const body = JSON.parse(res.body);
    expect(body.profile).toBeNull();
    expect(body.settings).toBeNull();
  });

  it("POST upserts profile and settings", async () => {
    mockSql.mockResolvedValue([]);
    const res = await handler(authedEvent("POST", {
      profile: { name: "Camille" },
      settings: { defaultTimer: 90 }
    }));
    expect(res.statusCode).toBe(200);
  });

  // Regression: e3fc15f — a permanent data error (SQLSTATE class 22/23) was answered
  // 500, which the client outbox retries forever in order.
  it("answers 400, not 500, when Postgres refuses the row itself", async () => {
    mockSql.mockRejectedValueOnce(Object.assign(new Error("pg"), { code: "23514" }));
    const res = await handler(authedEvent("POST", { profile: { name: "Camille" } }));
    expect(res.statusCode).toBe(400);
  });

  it("still answers 500 when the database is unreachable", async () => {
    mockSql.mockRejectedValueOnce(new Error("fetch failed"));
    const res = await handler(authedEvent("POST", { profile: { name: "Camille" } }));
    expect(res.statusCode).toBe(500);
  });

  // The inventory, the cycle switch and the coach notes change what the coach
  // prescribes, so the endpoint checks them and not only the form. A refusal is
  // a 400: the client outbox retries a 5xx in order, forever.
  describe("validates the profile document", () => {
    const post = (profile) => handler(authedEvent("POST", { profile }));

    it("accepts a profile with the new fields", async () => {
      mockSql.mockResolvedValue([]);
      const res = await post({
        name: "Camille", gender: "f", coachNotes: "x", cycle: { enabled: true, lengthDays: 28 },
        inventory: { dumbbellOptionsKg: [4], barEmptyKg: 2, barCount: 2, plateStock: [{ weightKg: 5, count: 4 }], ankleWeightKg: 1, owned: ["dumbbell"] },
      });
      expect(res.statusCode).toBe(200);
    });

    it("accepts a legacy profile (an older build's fields, none of the new ones)", async () => {
      mockSql.mockResolvedValue([]);
      expect((await post({ name: "Camille", equipment: ["a"], age: 30 })).statusCode).toBe(200);
    });

    it.each([
      ["a negative dumbbell", { name: "C", inventory: { dumbbellOptionsKg: [-4], barEmptyKg: 2, barCount: 2, plateStock: [], ankleWeightKg: 1, owned: [] } }],
      ["an unknown gender", { name: "C", gender: "x" }],
      ["a cycle that is on with a nonsense length", { name: "C", cycle: { enabled: true, lengthDays: 4 } }],
      ["over-long coach notes", { name: "C", coachNotes: "x".repeat(5000) }],
    ])("answers 400 to %s, and writes nothing", async (_label, profile) => {
      const res = await post(profile);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/\S/);
      expect(mockSql).not.toHaveBeenCalled();
    });
  });

  it("answers 400 to a body that does not parse", async () => {
    expect((await handler({ ...authedEvent("POST"), body: "[1" })).statusCode).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });
});
