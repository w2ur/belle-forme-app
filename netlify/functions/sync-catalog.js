import { getDb, authorize, ok, err } from "./lib/db.js";
import { validateCatalogDoc } from "../../src/lib/catalog.js";
import { writeErrorStatus, parseBody } from "./lib/writeError.js";

export async function handler(event) {
  const authError = authorize(event);
  if (authError) return authError;

  const sql = getDb();

  if (event.httpMethod === "GET") {
    try {
      const rows = await sql`SELECT data, updated_at FROM catalog WHERE id = 1`;
      return ok({
        catalog: rows[0]?.data ?? null,
        catalogUpdatedAt: rows[0]?.updated_at ?? null,
      });
    } catch (e) {
      return err(e.message);
    }
  }

  // Whole-document writes under OPTIMISTIC CONCURRENCY. The body is
  // `{ doc, baseUpdatedAt }`: the document, and the `updated_at` of the row
  // it was built on. A base that no longer matches is refused with 409 and the
  // current row, and the client replays its edit operations onto that
  // (`applyCatalogOps`). Before this, the row became whatever document
  // arrived, and an iPad holding an old copy erased every edit made since.
  //
  // Validation runs HERE as well as in the form, and that is not belt-and-
  // braces for its own sake: a malformed catalog does not break one screen, it
  // breaks every plan import at once and takes the coach's whole exercise list
  // with it (`loadCatalog` refuses to answer without one). The endpoint is the
  // boundary that can be reasoned about; a form is a client.
  //
  // Only `validateCatalogDoc` runs. `checkCatalogQuality` deliberately does
  // NOT — its warnings are heuristics over French prose and the user may save
  // through them, so enforcing them here would make the form's "save anyway"
  // fail with a 400 it cannot explain.
  if (event.httpMethod === "PUT") {
    // A bad document and a bad database are 400 and 500 respectively, and the
    // difference is worth the extra block: the client outbox retries a 5xx
    // and parks a 4xx, so a rejected document reported as a 500 would be
    // retried forever against a server that will never accept it.
    const body = parseBody(event.body);
    if (!body) return err("Corps de requête illisible.", 400);

    // The legacy body is the bare document. Kept for ONE release, so a
    // resident PWA that has not picked up the new bundle can still save; it is
    // last-writer-wins, exactly as before. Delete this branch once the update
    // check (plan Task D6) is in production.
    const wrapped = isWrapped(body);
    const doc = wrapped ? body.doc : body;
    const baseUpdatedAt = wrapped ? body.baseUpdatedAt : undefined;

    const errors = validateCatalogDoc(doc);
    if (errors.length) return err(errors.join(" "), 400);

    try {
      // `updated_at` is also stamped by a BEFORE UPDATE trigger (schema.sql) —
      // it is the coach's prompt cache key and, now, the version this endpoint
      // compares against, and a convention that has to be remembered at every
      // call site is one that will be forgotten at one of them.
      if (!wrapped) {
        console.warn("sync-catalog: legacy bare-document PUT, saved without a concurrency check");
        const rows = await sql`
          INSERT INTO catalog (id, data, updated_at) VALUES (1, ${doc}, NOW())
          ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
          RETURNING updated_at
        `;
        return ok({ saved: true, updatedAt: rows[0]?.updated_at ?? null });
      }

      // A null base means "built on no catalog at all": insert, and refuse if
      // a row appeared meanwhile rather than overwrite it.
      if (baseUpdatedAt === null) {
        const rows = await sql`
          INSERT INTO catalog (id, data, updated_at) VALUES (1, ${doc}, NOW())
          ON CONFLICT (id) DO NOTHING
          RETURNING updated_at
        `;
        if (rows.length) return ok({ saved: true, updatedAt: rows[0].updated_at });
        return conflict(sql);
      }

      // Compared at millisecond precision: the column keeps microseconds, the
      // client's ISO string does not, and a raw equality would refuse every
      // write. The BEFORE UPDATE trigger stamps the new updated_at. No row at
      // all matches nothing, so a base sent against an empty table is a 409.
      const rows = await sql`
        UPDATE catalog SET data = ${doc}
        WHERE id = 1
          AND date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', ${baseUpdatedAt}::timestamptz)
        RETURNING updated_at
      `;
      if (rows.length === 0) return conflict(sql);
      return ok({ saved: true, updatedAt: rows[0].updated_at });
    } catch (e) {
      // A base that is not a timestamp fails the cast (SQLSTATE 22007) on
      // every retry, so it is a 400 like a bad document (`writeErrorStatus`).
      return err(e.message, writeErrorStatus(e));
    }
  }

  return err("Method not allowed", 405);
}

// `{ doc, baseUpdatedAt }`, and nothing else: a catalog document has
// `exercises`, never `doc`, so the two shapes cannot be confused.
function isWrapped(body) {
  return (
    Object.hasOwn(body, "doc") && Object.hasOwn(body, "baseUpdatedAt") &&
    (body.baseUpdatedAt === null || typeof body.baseUpdatedAt === "string")
  );
}

// The 409 carries the row as it stands, so the client can replay its edits
// onto it without a second round trip.
async function conflict(sql) {
  const current = await sql`SELECT data, updated_at FROM catalog WHERE id = 1`;
  return {
    statusCode: 409,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ doc: current[0]?.data ?? null, updatedAt: current[0]?.updated_at ?? null }),
  };
}
