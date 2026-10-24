import { getDb, authorize, err } from "./lib/db.js";

export function escapeSQL(value) {
  if (value === null || value === undefined) return "NULL";
  // The Neon driver hands back every timestamptz column as a JS Date, and
  // String(date) is "Thu Oct 01 2026 05:55:26 GMT+0000 (Coordinated Universal
  // Time)" — a literal Postgres refuses, so the whole BEGIN…COMMIT restore
  // aborted on the first row that had one. ISO 8601 with its Z is unambiguous
  // whatever the session time zone.
  if (value instanceof Date) return "'" + value.toISOString() + "'";
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/**
 * A DATE column's value as a 'YYYY-MM-DD' literal.
 *
 * Not `escapeSQL`: the driver parses a bare date as LOCAL midnight
 * (`new Date(y, m, d)`), so its ISO form is the previous day wherever the
 * function runs east of UTC. The local calendar fields are the date Postgres
 * sent. A string (a test, or a driver configured to keep text) passes through.
 */
export function sqlDate(value) {
  if (!(value instanceof Date)) return escapeSQL(value);
  const pad = (n) => String(n).padStart(2, "0");
  return `'${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}'`;
}

export async function handler(event) {
  const authError = authorize(event);
  if (authError) return authError;

  if (event.httpMethod !== "GET") return err("Method not allowed", 405);

  const sql = getDb();

  try {
    const sessions = await sql`SELECT * FROM sessions ORDER BY date DESC`;
    const plans = await sql`SELECT * FROM plans ORDER BY created_at DESC`;
    const profileRows = await sql`SELECT * FROM profile`;
    const settingsRows = await sql`SELECT * FROM settings`;
    const catalogRows = await sql`SELECT * FROM catalog ORDER BY id`;
    const notebookRows = await sql`SELECT * FROM coach_notebook ORDER BY id`;
    const messageRows = await sql`SELECT * FROM coach_messages ORDER BY id ASC`;

    let dump = `-- Belle Forme backup ${new Date().toISOString()}\nBEGIN;\n\n`;
    dump += "TRUNCATE sessions, plans, profile, settings, catalog, coach_notebook, coach_messages;\n\n";

    for (const s of sessions) {
      dump += `INSERT INTO sessions (id, date, name, data, created_at, updated_at) VALUES (${escapeSQL(s.id)}, ${sqlDate(s.date)}, ${escapeSQL(s.name)}, ${escapeSQL(JSON.stringify(s.data))}::jsonb, ${escapeSQL(s.created_at)}, ${escapeSQL(s.updated_at)});\n`;
    }
    dump += "\n";

    for (const p of plans) {
      dump += `INSERT INTO plans (id, week_start, week_end, data, raw, created_at, updated_at) VALUES (${p.id}, ${sqlDate(p.week_start)}, ${sqlDate(p.week_end)}, ${escapeSQL(JSON.stringify(p.data))}::jsonb, ${escapeSQL(p.raw)}, ${escapeSQL(p.created_at)}, ${escapeSQL(p.updated_at)});\n`;
    }
    dump += "\n";

    for (const p of profileRows) {
      dump += `INSERT INTO profile (id, data, updated_at) VALUES (${p.id}, ${escapeSQL(JSON.stringify(p.data))}::jsonb, ${escapeSQL(p.updated_at)});\n`;
    }
    dump += "\n";

    for (const s of settingsRows) {
      dump += `INSERT INTO settings (id, data, updated_at) VALUES (${s.id}, ${escapeSQL(JSON.stringify(s.data))}::jsonb, ${escapeSQL(s.updated_at)});\n`;
    }
    dump += "\n";

    // updated_at is NOW(), not the dumped value. It is the version every
    // device compares its mirror against (`rebaseOnPull`), and the trigger
    // that bumps it fires on UPDATE only, so an INSERT keeps whatever it is
    // given: restoring the old stamp left the restored catalog OLDER than the
    // mirror on any device that had synced since, and every pull ignored it.
    for (const c of catalogRows) {
      dump += `INSERT INTO catalog (id, data, updated_at) VALUES (${c.id}, ${escapeSQL(JSON.stringify(c.data))}::jsonb, NOW());\n`;
    }
    dump += "\n";

    for (const n of notebookRows) {
      dump += `INSERT INTO coach_notebook (id, content, updated_at) VALUES (${n.id}, ${escapeSQL(n.content)}, ${escapeSQL(n.updated_at)});\n`;
    }
    dump += "\n";

    // id is left to the SERIAL default; rows are emitted in id order so it is preserved relatively.
    for (const m of messageRows) {
      dump += `INSERT INTO coach_messages (role, content, created_at) VALUES (${escapeSQL(m.role)}, ${escapeSQL(m.content)}, ${escapeSQL(m.created_at)});\n`;
    }

    dump += "\nCOMMIT;\n";

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/sql",
        "Content-Disposition": `attachment; filename="belle-forme-backup-${new Date().toISOString().split("T")[0]}.sql"`,
      },
      body: dump,
    };
  } catch (e) {
    return err(e.message);
  }
}
