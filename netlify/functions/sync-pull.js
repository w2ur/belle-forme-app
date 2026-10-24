import { getDb, authorize, ok, err } from "./lib/db.js";

export async function handler(event) {
  const authError = authorize(event);
  if (authError) return authError;

  if (event.httpMethod !== "GET") return err("Method not allowed", 405);

  const sql = getDb();

  try {
    const sessions = await sql`SELECT id, date, name, data, created_at, updated_at FROM sessions ORDER BY date DESC`;
    const plans = await sql`SELECT * FROM plans ORDER BY created_at DESC LIMIT 1`;
    const profileRows = await sql`SELECT data, updated_at FROM profile WHERE id = 1`;
    const settingsRows = await sql`SELECT data, updated_at FROM settings WHERE id = 1`;
    const catalogRows = await sql`SELECT data, updated_at FROM catalog WHERE id = 1`;

    return ok({
      sessions,
      plan: plans[0] || null,
      profile: profileRows[0]?.data || null,
      profileUpdatedAt: profileRows[0]?.updated_at || null,
      settings: settingsRows[0]?.data || null,
      settingsUpdatedAt: settingsRows[0]?.updated_at || null,
      catalog: catalogRows[0]?.data || null,
      catalogUpdatedAt: catalogRows[0]?.updated_at || null,
    });
  } catch (e) {
    return err(e.message);
  }
}
