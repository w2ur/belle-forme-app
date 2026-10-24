// The write behind `scripts/seed-catalog.mjs`, split out so it can be tested
// against a real Postgres without a network.

/**
 * Puts the day-one catalog in an EMPTY catalog table, and does nothing at all
 * when a catalog is already there. The seed describes a new database; the user's
 * own edits live in the stored document, so a run against a live instance (a
 * wrong NEON_DATABASE_URL, a re-run "to be sure") must never replace them.
 *
 * @param {(strings: TemplateStringsArray, ...values: unknown[]) => Promise<object[]>} sql
 * @param {object} seed - the catalog document.
 * @returns {Promise<{ seeded: boolean, exercises: number }>} `exercises` counts the stored document.
 */
export async function seedCatalog(sql, seed) {
  const inserted = await sql`
    INSERT INTO catalog (id, data, updated_at) VALUES (1, ${JSON.stringify(seed)}::jsonb, NOW())
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;
  const [row] = await sql`SELECT jsonb_array_length(data->'exercises') AS n FROM catalog WHERE id = 1`;
  return { seeded: inserted.length > 0, exercises: row.n };
}
