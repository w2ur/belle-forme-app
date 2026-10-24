/**
 * The HTTP status for a write that failed, as the client outbox reads it: a
 * 4xx is parked (`classify` in src/lib/outbox.js), a 5xx is retried in order
 * and blocks every write queued behind it until it lands.
 *
 * So a failure the SAME payload will hit again must not be a 5xx, or one bad
 * entry stops the line for good. Postgres says which failures those are in the
 * SQLSTATE class, which the Neon driver carries as `e.code`:
 *   22 — data exception (a value out of range, a date that does not parse)
 *   23 — integrity constraint violation (NOT NULL, unique, check)
 * Both are facts about the row being written. Everything else — a connection
 * error, a timeout, the database down — says nothing about the payload, and
 * stays a 500 so the outbox tries again.
 *
 * Kept out of db.js on purpose: the endpoint tests mock db.js whole, and this
 * is exactly what they need to run for real.
 */
export function writeErrorStatus(e) {
  const code = typeof e?.code === "string" ? e.code : "";
  return code.startsWith("22") || code.startsWith("23") ? 400 : 500;
}

/** The parsed JSON object body, or null when it is not one (answered 400). */
export function parseBody(raw) {
  try {
    const body = JSON.parse(raw);
    return body !== null && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}
