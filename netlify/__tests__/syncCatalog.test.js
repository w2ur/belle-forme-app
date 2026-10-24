import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
vi.mock("../functions/lib/db.js", () => ({
  getDb: () => mockSql,
  authorize: () => null,
  ok: (data) => ({ statusCode: 200, body: JSON.stringify(data) }),
  err: (message, status = 500) => ({ statusCode: status, body: JSON.stringify({ error: message }) }),
}));

const { handler } = await import("../functions/sync-catalog.js");

describe("GET /api/sync-catalog", () => {
  beforeEach(() => mockSql.mockReset());

  it("returns the document and its updated_at", async () => {
    mockSql.mockResolvedValueOnce([
      { data: { version: 1, exercises: [] }, updated_at: "2026-08-11T00:00:00Z" },
    ]);
    const res = await handler({ httpMethod: "GET" });
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.catalog).toEqual({ version: 1, exercises: [] });
    expect(body.catalogUpdatedAt).toBe("2026-08-11T00:00:00Z");
  });

  it("returns catalog: null when the table has no row", async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = await handler({ httpMethod: "GET" });
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.catalog).toBeNull();
    expect(body.catalogUpdatedAt).toBeNull();
  });

  it("rejects a method it does not implement", async () => {
    const res = await handler({ httpMethod: "DELETE" });
    expect(res.statusCode).toBe(405);
  });
});

describe("PUT /api/sync-catalog", () => {
  beforeEach(() => mockSql.mockReset());

  const ENTRY = {
    name: "Rowing", group: "Upper Body",
    description: "Un haltère dans chaque main, tirer vers les hanches",
    formCues: "Dos plat", intent: "Le tirage horizontal",
    implementTypes: ["dumbbell", "dual_bar_symmetric"], equipmentNeeds: ["dumbbell"],
    perSide: false, barHeight: null, ceiling: null,
    active: true, inactiveReason: null, replacedBy: null,
  };
  const DOC = { version: 1, exercises: [ENTRY], aliases: {} };
  const put = (body) => handler({ httpMethod: "PUT", body });

  it("writes a valid document and reports it saved", async () => {
    mockSql.mockResolvedValueOnce([{ updated_at: "2026-10-01T00:00:00.000Z" }]);
    const res = await put(JSON.stringify({ doc: DOC, baseUpdatedAt: "2026-09-30T00:00:00.000Z" }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ saved: true, updatedAt: "2026-10-01T00:00:00.000Z" });
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  // The endpoint is the boundary, not the form: a malformed catalog does not
  // break one screen, it breaks every plan import at once and takes the
  // coach's whole exercise list with it.
  it("rejects an invalid document with 400 and never touches the database", async () => {
    const res = await put(JSON.stringify({ ...DOC, exercises: [{ ...ENTRY, group: "Bras" }] }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/groupe/i);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("rejects an empty catalog", async () => {
    const res = await put(JSON.stringify({ version: 1, exercises: [], aliases: {} }));
    expect(res.statusCode).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  // A rejected document and a broken database are 400 and 500: the client
  // outbox retries a 5xx and parks a 4xx, so a document the server will never
  // accept must not be reported as retryable.
  it("rejects an unparseable body with 400", async () => {
    const res = await put("{ not json");
    expect(res.statusCode).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("reports a database failure as 500", async () => {
    mockSql.mockRejectedValueOnce(new Error("connection lost"));
    const res = await put(JSON.stringify({ doc: DOC, baseUpdatedAt: null }));
    expect(res.statusCode).toBe(500);
  });

  // Regression: e3fc15f — a base that is not a timestamp failed its cast (SQLSTATE
  // 22007) with a 500, which the outbox retries forever in order.
  it("reports a data error on the write as 400", async () => {
    mockSql.mockRejectedValueOnce(Object.assign(new Error("invalid input syntax"), { code: "22007" }));
    const res = await put(JSON.stringify({ doc: DOC, baseUpdatedAt: "pas une date" }));
    expect(res.statusCode).toBe(400);
  });
});

/**
 * A one-row stand-in for the `catalog` table that answers the four statements
 * the PUT can send, by their text. It truncates timestamps to milliseconds
 * exactly where the SQL does, so a test can give the row MICROSECONDS — the
 * shape Postgres really stores — and see whether the comparison survives it.
 */
function catalogTable(initial) {
  let row = initial ? { ...initial } : null;
  let clock = 0;
  const ms = (ts) => new Date(ts).toISOString(); // Date keeps milliseconds only, truncating
  const stamp = () => `2026-10-01T00:00:0${++clock}.000Z`;
  const sql = vi.fn(async (strings, ...values) => {
    const text = strings.join("?");
    if (/^\s*UPDATE catalog/.test(text)) {
      expect(text).toMatch(/date_trunc\('milliseconds', updated_at\)\s*=\s*date_trunc\('milliseconds', \?::timestamptz\)/);
      const [doc, base] = values;
      if (!row || ms(row.updated_at) !== ms(base)) return [];
      row = { data: doc, updated_at: stamp() };
      return [{ updated_at: row.updated_at }];
    }
    if (/^\s*SELECT data, updated_at FROM catalog/.test(text)) return row ? [{ ...row }] : [];
    if (/ON CONFLICT \(id\) DO NOTHING/.test(text)) {
      if (row) return [];
      row = { data: values[0], updated_at: stamp() };
      return [{ updated_at: row.updated_at }];
    }
    if (/ON CONFLICT \(id\) DO UPDATE/.test(text)) {
      row = { data: values[0], updated_at: stamp() };
      return [{ updated_at: row.updated_at }];
    }
    throw new Error(`unexpected statement: ${text}`);
  });
  return { sql, row: () => row };
}

describe("PUT /api/sync-catalog — optimistic concurrency", () => {
  const ENTRY = {
    name: "Rowing", group: "Upper Body",
    description: "Un haltère dans chaque main, tirer vers les hanches",
    formCues: "Dos plat", intent: "Le tirage horizontal",
    implementTypes: ["dumbbell", "dual_bar_symmetric"], equipmentNeeds: ["dumbbell"],
    perSide: false, barHeight: null, ceiling: null,
    active: true, inactiveReason: null, replacedBy: null,
  };
  const DOC = { version: 1, exercises: [ENTRY], aliases: {} };
  const SERVER_DOC = { version: 1, exercises: [ENTRY, { ...ENTRY, name: "Squat", group: "Lower Body" }], aliases: {} };
  const ROW_TS = "2026-09-30T10:00:00.123456Z";
  const put = (body) => handler({ httpMethod: "PUT", body: JSON.stringify(body) });

  function useTable(initial) {
    const table = catalogTable(initial);
    mockSql.mockReset();
    mockSql.mockImplementation(table.sql);
    return table;
  }

  // Regression: B6 (2026-09-30 review) — the PUT stored whatever document
  // arrived, so a device holding an old copy erased every edit made since.
  it("refuses a stale base with 409 and hands back the current document", async () => {
    const table = useTable({ data: SERVER_DOC, updated_at: ROW_TS });
    const res = await put({ doc: DOC, baseUpdatedAt: "2026-09-29T08:00:00.000Z" });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ doc: SERVER_DOC, updatedAt: ROW_TS });
    expect(table.row().data).toEqual(SERVER_DOC);
  });

  // The column keeps microseconds and a JS Date does not: a raw equality would
  // refuse every write and turn the feature into "always 409".
  it("accepts a base equal to the row's updated_at truncated to milliseconds", async () => {
    const table = useTable({ data: SERVER_DOC, updated_at: ROW_TS });
    const res = await put({ doc: DOC, baseUpdatedAt: "2026-09-30T10:00:00.123Z" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.saved).toBe(true);
    expect(body.updatedAt).toBe(table.row().updated_at);
    expect(body.updatedAt).not.toBe(ROW_TS);
    expect(table.row().data).toEqual(DOC);
  });

  // Kept for one release: a resident PWA that has not updated yet still sends
  // the bare document. Delete once Task D6's update check is in production.
  it("still accepts the legacy bare-document body, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const table = useTable({ data: SERVER_DOC, updated_at: ROW_TS });
    const res = await put(DOC);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).saved).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect(table.row().data).toEqual(DOC);
    warn.mockRestore();
  });

  it("refuses a base when no row exists: a base implies a row", async () => {
    const table = useTable(null);
    const res = await put({ doc: DOC, baseUpdatedAt: "2026-09-30T10:00:00.123Z" });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ doc: null, updatedAt: null });
    expect(table.row()).toBeNull();
  });

  it("inserts when the base is null and no row exists", async () => {
    const table = useTable(null);
    const res = await put({ doc: DOC, baseUpdatedAt: null });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ saved: true, updatedAt: table.row().updated_at });
    expect(table.row().data).toEqual(DOC);
  });

  // A null base says "there is no catalog yet". If one appeared meanwhile, the
  // insert must not overwrite it.
  it("refuses a null base when a row exists", async () => {
    const table = useTable({ data: SERVER_DOC, updated_at: ROW_TS });
    const res = await put({ doc: DOC, baseUpdatedAt: null });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).doc).toEqual(SERVER_DOC);
    expect(table.row().data).toEqual(SERVER_DOC);
  });

  it("validates the wrapped document first: a 400 stays a 400", async () => {
    useTable({ data: SERVER_DOC, updated_at: ROW_TS });
    const res = await put({ doc: { ...DOC, exercises: [] }, baseUpdatedAt: ROW_TS });
    expect(res.statusCode).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });
});
