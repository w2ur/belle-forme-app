import { getDb } from "./db.js";

export async function loadNotebook() {
  const sql = getDb();
  const rows = await sql`SELECT content FROM coach_notebook WHERE id = 1`;
  return rows[0]?.content || "";
}

export async function saveNotebook(content) {
  const sql = getDb();
  await sql`
    INSERT INTO coach_notebook (id, content, updated_at)
    VALUES (1, ${content}, NOW())
    ON CONFLICT (id) DO UPDATE SET content = ${content}, updated_at = NOW()`;
}

/**
 * The coach's working memory. `created_at` is not decoration: `historyView`
 * turns it into the date stamps and session breaks that stop the model reading a
 * week-old exchange as live (the user, 2026-08-05).
 */
export async function loadRecentMessages(limit = 15) {
  const sql = getDb();
  // `total` is the whole table's row count, not the tail's — alignHistoryWindow
  // needs the absolute position of the tail to keep the prompt prefix fixed
  // across turns. It comes back from Neon as a bigint STRING, on every row.
  //
  // A SCALAR SUBQUERY, not `count(*) OVER ()`. The window function also counts
  // the whole table, but only by materialising every row (content included)
  // before LIMIT keeps 49 of them, so the read grew with the transcript. The
  // subquery is evaluated once and the outer scan stops at LIMIT. `id` is not
  // selected: it orders the scan, and nothing downstream reads it.
  const rows = await sql`
    SELECT role, content, created_at, (SELECT count(*) FROM coach_messages) AS total
    FROM coach_messages ORDER BY id DESC LIMIT ${limit}`;
  return rows.reverse();
}

export async function loadAllMessages(limit = 200) {
  const sql = getDb();
  const rows = await sql`
    SELECT role, content, created_at
    FROM (SELECT * FROM coach_messages ORDER BY id DESC LIMIT ${limit}) t
    ORDER BY id ASC`;
  return rows;
}

/**
 * Returns the new row's id, so a reply can keep being written as it streams.
 * Null if the driver returned no row — the caller must then stop checkpointing
 * rather than insert again, or one interrupted reply becomes several bubbles.
 */
export async function appendMessage(role, content) {
  const sql = getDb();
  const rows = await sql`
    INSERT INTO coach_messages (role, content) VALUES (${role}, ${content}) RETURNING id`;
  return rows[0]?.id ?? null;
}

/**
 * Rewrites a message in place. Exists for ONE reason: a reply is persisted while
 * it streams, not once it ends. The end is exactly what cannot be relied upon —
 * the platform kills a streamed invocation at 10 s and nothing after that point
 * runs, so an answer the user had already read on screen was disappearing from the
 * transcript the moment she reloaded. Checkpoints turn that into, at worst, a
 * reply missing its last couple of seconds.
 */
export async function updateMessage(id, content) {
  const sql = getDb();
  await sql`UPDATE coach_messages SET content = ${content} WHERE id = ${id}`;
}

/**
 * Removes the given messages, in ONE statement. Exists for ONE reason:
 * `coach-chat.js` rolls back the rows of an exchange whose reply turned out to
 * have nothing visible in it (her question, and the reply row if a checkpoint
 * wrote one), so her question is not left banked with no answer while the
 * client hands it back to her composer. One statement so the rollback cannot
 * stop halfway — a reply row deleted and her question kept is the orphan this
 * exists to prevent. Only the ids passed are touched; an empty list is a no-op.
 */
export async function deleteMessages(ids) {
  if (!ids.length) return;
  const sql = getDb();
  await sql`DELETE FROM coach_messages WHERE id = ANY(${ids})`;
}

/**
 * Records what one answered request cost, in tokens. Counts only — no content.
 *
 * Stores raw counts and never a computed price: per-token rates change, models
 * change, and a cost column would freeze whatever assumption was true the day it
 * was written. The rates belong in the analysis, the facts belong here.
 */
export async function recordUsage({
  model, modelsSkipped, rungRetries, promptTokens, cachedTokens, completionTokens, thinkingChars, finishReason,
  headersMs, ttftMs, totalMs, mode,
}) {
  const sql = getDb();
  // The durations are passed through UNCOERCED. `?? 0` on modelsSkipped and
  // rungRetries is safe (no models skipped / no retry really is zero); the
  // same idiom on a duration would turn "never produced a visible token" into
  // "produced one instantly".
  //
  // rungRetries is ALWAYS 0 since 2026-09-30, when the rung-1 retry was
  // deleted (it doubled the wait on a dead rung: 15 s timeout + 15 s retry +
  // Medium). The column stays for the rows written before, where it was NOT
  // the same fact as modelsSkipped: a rung-1 retry that succeeded skipped no
  // rung, so only rung_retries told it apart from a clean first attempt.
  //
  // `mode` is likewise uncoerced: an unrecorded mode is NULL, not "discussion".
  // Rows written before the column existed are genuinely unknown, and reading
  // them as chat would put a pile of generated weeks into the very distribution
  // this column exists to keep them out of.
  //
  // `thinkingChars` is uncoerced too: completion_tokens includes reasoning on
  // a thinking model, and this is the only record of how much of it there was.
  // 0 is a real reading (no thinking sent); absent is NULL, not 0.
  //
  // thinking_chars is a hand-applied column (schema.sql). Like every column
  // before it, a missing one fails this INSERT, and the caller swallows that:
  // the row is lost, the reply she already read is not, and it costs no more
  // time than a successful write. Apply the ALTER before deploying.
  await sql`
    INSERT INTO coach_usage (
      model, models_skipped, rung_retries, prompt_tokens, cached_tokens, completion_tokens, thinking_chars,
      finish_reason, headers_ms, ttft_ms, total_ms, mode)
    VALUES (
      ${model}, ${modelsSkipped ?? 0}, ${rungRetries ?? 0}, ${promptTokens}, ${cachedTokens}, ${completionTokens},
      ${thinkingChars ?? null}, ${finishReason}, ${headersMs ?? null}, ${ttftMs ?? null}, ${totalMs ?? null},
      ${mode ?? null})`;
}
