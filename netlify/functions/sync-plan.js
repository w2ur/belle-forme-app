import { getDb, authorize, ok, err } from "./lib/db.js";
import { writeErrorStatus, parseBody } from "./lib/writeError.js";

export async function handler(event) {
  const authError = authorize(event);
  if (authError) return authError;

  const sql = getDb();

  if (event.httpMethod === "GET") {
    try {
      const rows = await sql`SELECT * FROM plans ORDER BY created_at DESC LIMIT 1`;
      return ok({ plan: rows[0] || null });
    } catch (e) {
      return err(e.message);
    }
  }

  if (event.httpMethod === "POST") {
    // A body or a row the server will refuse every time is a 400, never a
    // 500: the client outbox retries a 5xx in order, so one such entry would
    // block every write queued behind it for good (`writeErrorStatus`).
    const plan = parseBody(event.body)?.plan;
    if (plan === null || typeof plan !== "object") return err("Corps de requête illisible.", 400);

    try {
      // Single non-interactive transaction: if the INSERT fails, the DELETE is
      // rolled back so a botched push can never wipe the cloud plan and leave
      // nothing behind.
      await sql.transaction([
        sql`DELETE FROM plans WHERE 1=1`,
        sql`
          INSERT INTO plans (week_start, week_end, data, raw, updated_at)
          VALUES (${plan.week_start}, ${plan.week_end}, ${JSON.stringify(plan.data)}::jsonb, ${plan.raw}, NOW())
        `,
      ]);
      return ok({ success: true });
    } catch (e) {
      return err(e.message, writeErrorStatus(e));
    }
  }

  return err("Method not allowed", 405);
}
