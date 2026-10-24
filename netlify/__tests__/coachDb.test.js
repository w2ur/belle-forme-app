import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
vi.mock("../functions/lib/db.js", () => ({ getDb: () => mockSql }));

const { loadNotebook, saveNotebook, loadRecentMessages, appendMessage, deleteMessages, recordUsage } = await import("../functions/lib/coachDb.js");

describe("coachDb", () => {
  beforeEach(() => mockSql.mockReset());

  it("loadNotebook returns the row content or empty string", async () => {
    mockSql.mockResolvedValueOnce([{ content: "carnet" }]);
    expect(await loadNotebook()).toBe("carnet");
    mockSql.mockResolvedValueOnce([]);
    expect(await loadNotebook()).toBe("");
  });

  it("deleteMessages deletes exactly the rows it is given, in one statement", async () => {
    mockSql.mockResolvedValueOnce([]);
    await deleteMessages([7, 8]);
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(mockSql.mock.calls[0][0].join("?").replace(/\s+/g, " ")).toBe("DELETE FROM coach_messages WHERE id = ANY(?)");
    expect(mockSql.mock.calls[0][1]).toEqual([7, 8]);
  });

  it("deleteMessages sends nothing for an empty list", async () => {
    await deleteMessages([]);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("loadRecentMessages returns rows in ascending order", async () => {
    // DB returns DESC (newest first); helper reverses to chronological.
    mockSql.mockResolvedValueOnce([
      { role: "assistant", content: "b" },
      { role: "user", content: "a" },
    ]);
    expect(await loadRecentMessages(2)).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
  });

  // Without created_at the model-facing history has no clock at all, and
  // historyView silently degrades to stamping nothing — a week of conversation
  // reads to the model as one live thread (the user, 2026-08-05).
  it("loads the timestamp with each recent message", async () => {
    mockSql.mockResolvedValueOnce([]);
    await loadRecentMessages(5);
    expect(mockSql.mock.calls[0][0].join("")).toContain("created_at");
  });

  // alignHistoryWindow places the window on a block boundary counted from the
  // FIRST row ever written, so it needs the table total, not the tail length:
  // the tail is a fixed LIMIT and would make every turn look the same.
  //
  // Regression: f75a49d — the total was `count(*) OVER ()`, which counts
  // the whole table by materialising every row, content included, before LIMIT
  // keeps 49. A scalar subquery gives the same number without buffering the
  // transcript, and `id` is no longer selected because nothing reads it.
  it("loads the whole table's row count with a scalar subquery, not a window over every row", async () => {
    mockSql.mockResolvedValueOnce([]);
    await loadRecentMessages(49);
    const query = mockSql.mock.calls[0][0].join("").replace(/\s+/g, " ");
    expect(query).toMatch(/\(SELECT count\(\*\) FROM coach_messages\) AS total/i);
    expect(query).not.toMatch(/OVER\s*\(/i);
    expect(query).toMatch(/ORDER BY id DESC LIMIT/i);
    expect(query).not.toMatch(/SELECT\s+id\b/i);
  });

  // The three durations are the whole reason this table can answer a latency
  // question. Without them the only clock available is coach_messages.created_at,
  // which is stamped AFTER the model returned headers — so it cannot see the
  // 17-28 s that precede it, which is exactly the interval under investigation.
  it("recordUsage stores the three durations alongside the token counts", async () => {
    mockSql.mockResolvedValueOnce([]);
    await recordUsage({
      model: "mistral-large-2512",
      modelsSkipped: 0,
      rungRetries: 0,
      promptTokens: 27487,
      cachedTokens: 16285,
      completionTokens: 874,
      finishReason: "stop",
      headersMs: 19200,
      ttftMs: 19850,
      totalMs: 24100,
    });
    const [, ...values] = mockSql.mock.calls[0];
    expect(values).toContain(19200);
    expect(values).toContain(19850);
    expect(values).toContain(24100);
  });

  // A reply that never produced visible text has no time-to-first-token. That
  // is a real measurement ("we waited and got nothing"), not a zero — recording
  // it as 0 would drag the average down with the failures.
  // A row with no mode is from before the column existed, and that is unknown
  // rather than "discussion" — defaulting it would file every generated week
  // written before 2026-08-16 as a chat answer, in the one distribution the
  // column exists to keep clean.
  it("recordUsage stores the mode, and leaves an absent one null", async () => {
    // BY POSITION, not by `toContain`: mode is the last interpolated value, and
    // the row already carries three nulls of its own (the durations), so
    // `toContain(null)` would pass against any default whatsoever — a test that
    // cannot fail on the thing it names.
    const modeOf = (call) => call[call.length - 1];

    mockSql.mockResolvedValueOnce([]);
    await recordUsage({ model: "m", promptTokens: 1, completionTokens: 1, mode: "plan-emit" });
    expect(modeOf(mockSql.mock.calls[0])).toBe("plan-emit");

    mockSql.mockResolvedValueOnce([]);
    await recordUsage({ model: "m", promptTokens: 1, completionTokens: 1 });
    expect(modeOf(mockSql.mock.calls[1])).toBeNull();
  });

  // Regression: 0093a1b — completion_tokens includes reasoning on a
  // thinking rung (zai-glm-5-3), and the thinking length went only to the
  // function log, so the table could not tell a long think from a long answer.
  it("recordUsage stores thinking_chars, keeping 0 as 0 and an absent count null", async () => {
    // By the column's position in the INSERT, not by `toContain`: the row
    // carries other zeros and nulls of its own.
    const valueFor = (call, column) => {
      const columns = call[0].join("?").match(/INSERT INTO coach_usage \(([^)]*)\)/)[1].split(",").map((c) => c.trim());
      return call[1 + columns.indexOf(column)];
    };
    mockSql.mockResolvedValueOnce([]);
    await recordUsage({ model: "zai-glm-5-3", promptTokens: 20000, completionTokens: 900, thinkingChars: 3120 });
    expect(mockSql.mock.calls[0][0].join("")).toContain("thinking_chars");
    expect(valueFor(mockSql.mock.calls[0], "thinking_chars")).toBe(3120);

    mockSql.mockResolvedValueOnce([]);
    await recordUsage({ model: "mistral-medium-2604", promptTokens: 1, completionTokens: 1, thinkingChars: 0 });
    expect(valueFor(mockSql.mock.calls[1], "thinking_chars")).toBe(0);

    mockSql.mockResolvedValueOnce([]);
    await recordUsage({ model: "m", promptTokens: 1, completionTokens: 1 });
    expect(valueFor(mockSql.mock.calls[2], "thinking_chars")).toBeNull();
  });

  it("recordUsage keeps a missing duration null rather than coercing it to zero", async () => {
    mockSql.mockResolvedValueOnce([]);
    // Every other value is deliberately non-zero, so `not.toContain(0)` can
    // only fire on a `?? 0` coercion of the null duration itself.
    await recordUsage({
      model: "mistral-large-2512",
      modelsSkipped: 2,
      rungRetries: 1,
      promptTokens: 100,
      cachedTokens: 50,
      completionTokens: 7,
      finishReason: "stream_cut",
      headersMs: 21000,
      ttftMs: null,
      totalMs: 30000,
    });
    const [, ...values] = mockSql.mock.calls[0];
    expect(values).toContain(null);
    expect(values).not.toContain(0);
  });

  // rungRetries is a DIFFERENT fact from modelsSkipped: a rung-1 retry that
  // succeeds skips no model at all, so without its own column a successful
  // retry is indistinguishable from a clean first attempt — defeating the
  // reason the column exists.
  it("recordUsage stores rung_retries even when no model was skipped", async () => {
    mockSql.mockResolvedValueOnce([]);
    await recordUsage({
      model: "mistral-large-2512",
      modelsSkipped: 0,
      rungRetries: 1,
      promptTokens: 5000,
      cachedTokens: 0,
      completionTokens: 300,
      finishReason: "stop",
      headersMs: 16200,
      ttftMs: 16500,
      totalMs: 20000,
    });
    const [, ...values] = mockSql.mock.calls[0];
    expect(values).toContain(1);
  });

  it("recordUsage defaults rungRetries to zero when absent", async () => {
    mockSql.mockResolvedValueOnce([]);
    await recordUsage({
      model: "mistral-large-2512",
      modelsSkipped: 0,
      promptTokens: 5000,
      cachedTokens: 0,
      completionTokens: 300,
      finishReason: "stop",
      headersMs: 3000,
      ttftMs: 3200,
      totalMs: 6000,
    });
    const [, ...values] = mockSql.mock.calls[0];
    expect(values).toContain(0);
  });

  it("saveNotebook and appendMessage issue a query", async () => {
    mockSql.mockResolvedValueOnce([]);
    await saveNotebook("n");
    expect(mockSql).toHaveBeenCalledTimes(1);
    mockSql.mockResolvedValueOnce([]);
    await appendMessage("user", "hi");
    expect(mockSql).toHaveBeenCalledTimes(2);
  });
});
