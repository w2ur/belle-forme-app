/**
 * Reads the profile document: who the coach is talking to, what equipment they
 * own, whether cycle periodization is on.
 *
 * Like the catalog read, the CALLER does not catch this one: a coach that
 * cannot read the inventory would prescribe loads the user cannot lift, and a
 * wrong plan reads as a coaching decision rather than as a bug. A MISSING row is
 * not a failure — a fresh database has none until the first profile save — and
 * comes back as `data: null` dated at the epoch, so the prompt cache has a
 * stable, datable key for "no profile yet".
 *
 * @param {Function} sql - a `getDb()` tagged-template client.
 * @returns {Promise<{ data: object|null, updatedAt: unknown }>}
 */
export async function loadProfile(sql) {
  const rows = await sql`SELECT data, updated_at FROM profile WHERE id = 1`;
  if (!rows[0]) return { data: null, updatedAt: new Date(0) };
  return { data: rows[0].data ?? null, updatedAt: rows[0].updated_at };
}
