/**
 * Reads the catalog document. Deliberately NOT try/caught by its caller — see
 * the note in coach-chat.js. A missing row is as fatal as a failed query: an
 * empty catalog is indistinguishable from a coach deciding those exercises are
 * wrong.
 *
 * @param {Function} sql - a `getDb()` tagged-template client.
 * @returns {Promise<{ doc: object, updatedAt: unknown }>}
 */
export async function loadCatalog(sql) {
  const rows = await sql`SELECT data, updated_at FROM catalog WHERE id = 1`;
  const doc = rows[0]?.data;
  if (!doc?.exercises?.length) {
    throw new Error("catalog is empty or missing — refusing to answer without an exercise list");
  }
  return { doc, updatedAt: rows[0].updated_at };
}
