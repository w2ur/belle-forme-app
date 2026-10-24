import { getDb, authorize, ok, err } from "./lib/db.js";
import { writeErrorStatus, parseBody } from "./lib/writeError.js";

export async function handler(event) {
  const authError = authorize(event);
  if (authError) return authError;

  const sql = getDb();

  if (event.httpMethod === "GET") {
    try {
      const rows = await sql`SELECT id, date, name, data, created_at, updated_at FROM sessions ORDER BY date DESC`;
      return ok({ sessions: rows });
    } catch (e) {
      return err(e.message);
    }
  }

  if (event.httpMethod === "POST") {
    // A body or a row the server will refuse every time is a 400, never a
    // 500: the client outbox retries a 5xx in order, so one such entry would
    // block every write queued behind it for good (`writeErrorStatus`).
    const body = parseBody(event.body);
    if (!body) return err("Corps de requête illisible.", 400);
    if (body.action === "upsert" && (body.session === null || typeof body.session !== "object")) {
      return err("Séance manquante.", 400);
    }

    try {
      if (body.action === "upsert") {
        const { id, date, name, data } = body.session;
        await sql`
          INSERT INTO sessions (id, date, name, data, updated_at)
          VALUES (${id}, ${date}, ${name}, ${JSON.stringify(data)}::jsonb, NOW())
          ON CONFLICT (id) DO UPDATE SET
            date = EXCLUDED.date,
            name = EXCLUDED.name,
            data = EXCLUDED.data,
            updated_at = NOW()
        `;
        return ok({ success: true });
      }

      if (body.action === "delete") {
        await sql`DELETE FROM sessions WHERE id = ${body.id}`;
        return ok({ success: true });
      }

      return err("Unknown action", 400);
    } catch (e) {
      return err(e.message, writeErrorStatus(e));
    }
  }

  return err("Method not allowed", 405);
}
