import { getDb, authorize, ok, err } from "./lib/db.js";
import { writeErrorStatus, parseBody } from "./lib/writeError.js";
import { validateProfile } from "../../src/lib/profileDoc.js";

export async function handler(event) {
  const authError = authorize(event);
  if (authError) return authError;

  const sql = getDb();

  if (event.httpMethod === "GET") {
    try {
      const profileRows = await sql`SELECT data, updated_at FROM profile WHERE id = 1`;
      const settingsRows = await sql`SELECT data, updated_at FROM settings WHERE id = 1`;
      return ok({
        profile: profileRows[0]?.data || null,
        profileUpdatedAt: profileRows[0]?.updated_at || null,
        settings: settingsRows[0]?.data || null,
        settingsUpdatedAt: settingsRows[0]?.updated_at || null,
      });
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
    const { profile, settings } = body;

    // A profile the server will refuse every time is a 400 (see above): the
    // equipment inventory, the cycle switch and the coach notes change what
    // the coach prescribes, so they are checked here and not only in the form.
    if (profile) {
      const checked = validateProfile(profile);
      if (!checked.ok) return err(checked.errors.join(" "), 400);
    }

    try {
      if (profile) {
        // Merged key by key, not replaced: a client that predates a field (an old
        // bundle can stay on a device for days after a deploy) pushes a profile
        // without it, and a replace would silently erase what the server acts on
        // (inventory, cycle, coach notes). The pushed value wins for every key it
        // carries, so an edit still lands; a key it omits is kept. `||` on jsonb
        // lets its right operand win.
        await sql`
          INSERT INTO profile (id, data, updated_at) VALUES (1, ${JSON.stringify(profile)}::jsonb, NOW())
          ON CONFLICT (id) DO UPDATE SET data = profile.data || EXCLUDED.data, updated_at = NOW()
        `;
      }
      if (settings) {
        await sql`
          INSERT INTO settings (id, data, updated_at) VALUES (1, ${JSON.stringify(settings)}::jsonb, NOW())
          ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
        `;
      }
      return ok({ success: true });
    } catch (e) {
      return err(e.message, writeErrorStatus(e));
    }
  }

  return err("Method not allowed", 405);
}
