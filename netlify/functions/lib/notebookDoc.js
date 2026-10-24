/**
 * The coach's notebook as a document you EDIT, not a blob you replace.
 *
 * WHY THIS EXISTS. `saveNotebook` is `INSERT … ON CONFLICT DO UPDATE SET
 * content = $1`: whatever the model emitted this turn BECAME the notebook, and
 * the previous one was gone in the same statement. The prompt said « reprends-le
 * en ENTIER » and « ce que tu n'y écris pas est perdu », which is an instruction
 * standing alone in front of a destructive write.
 *
 * Measured on production 2026-08-30: the live notebook was 495 characters, three
 * lines, all dated the same day, holding zero standing decisions — and every
 * request that day had been answered by `mistral-small-2603` (6 of 6,
 * `models_skipped: 1`). Weeks of memory were overwritten by one rung-2 reply,
 * with no error, no log line, and nothing in the suite able to see it.
 *
 * THE ROOT CAUSE IS NOT THE MODEL. It is that SILENCE DELETES: under a wholesale
 * rewrite, "the model forgot to repeat a line" and "the model decided to remove
 * a line" are the same bytes. That is the shape of every other defect this
 * subsystem has had — an unmarked truncation reading as a finished reply, a
 * missing finish reason reading as `stop` — and it is fixed the same way, by
 * making the two cases different on the wire.
 *
 * So the notebook is injected NUMBERED and comes back as OPERATIONS:
 *
 *     ## Ton carnet actuel (privé)
 *     1. Décision (05/03) : charge bas du corps maintenue à 2×12 kg — sa demande.
 *     2. Objectif (12/03) : dix pompes d'affilée.
 *
 *     <<<NOTEBOOK>>>
 *     + Décision (20/03) : fentes à 8 kg, on ne monte pas.
 *     - 2
 *     <<<END>>>
 *
 * Silence now PRESERVES and removal is explicit. A model that says nothing
 * changes nothing; a model that says three lines adds three lines.
 *
 * Pure. No I/O, no clock. Every rule below is one the wholesale write got wrong.
 */

/**
 * The cap the prompt states. Exceeding it WARNS and never truncates — dropping
 * the oldest line to hold a cap is the wholesale-overwrite bug at a smaller
 * scale, and it would silently delete exactly the oldest standing decisions,
 * which are the ones the notebook exists to carry.
 */
export const NOTEBOOK_MAX_LINES = 20;

/** A bullet the model wrote in front of a line. Cosmetic; never part of the fact. */
const BULLET = /^[-*•]\s+/;
/** The « 1. » the prompt renders in front of each line; copied back, it is not part of the fact. READ side only. */
const NUMBERING = /^\d{1,3}[.)]\s+/;

/**
 * The stored notebook as a list of facts.
 *
 * Normalises on READ rather than on write, because the rows already in Neon were
 * written by the old wholesale path with `- ` prefixes and must keep working
 * without a migration.
 */
export function notebookLines(content) {
  if (typeof content !== "string") return [];
  return content
    .split("\n")
    .map((line) => line.trim().replace(BULLET, "").replace(NUMBERING, "").trim())
    .filter(Boolean);
}

/**
 * The notebook as the model sees it, numbered — the numbers ARE the addresses a
 * `- n` operation refers to.
 *
 * Numbered rather than quoted back for removal because a model does not
 * reproduce a line byte for byte; it decorates it. That is the same behaviour
 * that retired the `=== FITTRACK PLAN ===` header and forced the exercise-name
 * enum, and matching a removal on fuzzy text would put a third heuristic in a
 * subsystem that has been steadily removing them.
 */
export function renderNotebookForPrompt(content) {
  return notebookLines(content)
    .map((line, i) => `${i + 1}. ${line}`)
    .join("\n");
}

const ADD = /^\s*\+\s*(.*\S)\s*$/;
/**
 * A removal: `- 3`.
 *
 * The number may carry a trailing JUSTIFICATION, because the model writes one.
 * Production 2026-08-30 banked `- 1 (ligne sur le gainage planche doublé en
 * séance 5)`: anchored on the end of the line, that fell through to the
 * loose-add branch, so the line it named SURVIVED and the justification was
 * appended as a new fact — a removal turned into its own opposite, twice over.
 *
 * The trailing text is accepted only after a separator that cannot open a fact:
 * an opening parenthesis, a colon, an em dash or an en dash. A bare space is
 * deliberately NOT one of them, and that is the whole safety argument. The old
 * wholesale style wrote every fact as `- texte`, so `- 3 séries de squat à
 * 15 kg` is a shape this parser really receives, and a rule accepting any
 * trailing text would read it as "remove line 3". An add can never delete and a
 * removal can, so the tolerance runs only in the direction that cannot lose a
 * line — the same asymmetry that governs the loose branch below.
 */
const REMOVE = /^\s*[-–—]\s*(\d{1,3})\s*(?:[(:—–].*)?$/;

/**
 * A loose line that is nothing but a number — `24`, `24.`, `3)`.
 *
 * Production 2026-08-30 banked one of these too, the turn after the justified
 * removal above: the model tried to withdraw its own bad line by number and the
 * digits landed as a fact. It is NOT read as a removal — a bare number is
 * exactly the shape a model produces when it has lost the syntax, and giving it
 * the power to delete is the one direction this parser must never be tolerant
 * in. It is discarded instead, which costs nothing: a notebook line carrying
 * only digits holds no fact, and discarding an add can never lose stored
 * memory.
 */
const BARE_NUMBER = /^\d{1,3}[.)]?$/;

/**
 * Reads an operations block.
 *
 * TOLERANT IN ONE DIRECTION ONLY. A line carrying no `+` is treated as an ADD,
 * not as an error and never as a replacement — which is what makes a model that
 * ignores the format harmless rather than destructive. A model re-emitting the
 * whole notebook in the old wholesale style produces a list of adds, every one
 * of which `applyNotebookOps` de-duplicates against what is already stored, so
 * the net effect is exactly the lines that are genuinely new. Adds can never
 * delete; that is the entire safety argument, and it is why the loose branch is
 * safe here when a loose branch was not safe in `notebookStream`.
 *
 * `looseAdds` is reported separately so compliance can be MEASURED rather than
 * assumed — the same reason `coach_usage.mode` exists.
 */
export function parseNotebookOps(block) {
  const adds = [];
  const removes = [];
  const looseAdds = [];
  const discarded = [];
  if (typeof block !== "string") return { adds, removes, looseAdds, discarded };

  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const remove = REMOVE.exec(line);
    if (remove) {
      removes.push(Number(remove[1]));
      continue;
    }

    const add = ADD.exec(line);
    if (add) {
      adds.push(add[1].replace(BULLET, "").trim());
      continue;
    }

    // No marker. Kept as an add — see the tolerance note above.
    const loose = line.replace(BULLET, "").trim();
    if (BARE_NUMBER.test(loose)) {
      discarded.push(loose);
      continue;
    }
    if (loose) {
      adds.push(loose);
      looseAdds.push(loose);
    }
  }

  return { adds, removes, looseAdds, discarded };
}

/**
 * Applies the operations to the stored notebook.
 *
 * Returns `{ content, warnings }`. It never throws: every malformed operation
 * degrades to a warning, because a throw here costs the whole notebook write
 * while a warning costs one line kept or one line dropped.
 */
export function applyNotebookOps(previous, ops) {
  const lines = notebookLines(previous);
  const warnings = [];
  const { adds = [], removes = [], looseAdds = [], discarded = [] } = ops || {};

  if (discarded.length) {
    warnings.push(`${discarded.length} ligne(s) réduites à un numéro, ignorées : ${discarded.join(", ")}`);
  }

  // Resolved against the ORIGINAL numbering, all at once. Applying removals one
  // by one would shift every index after the first, so `- 2` followed by `- 3`
  // would delete lines 2 and 4 — silently, and only when more than one line is
  // removed in a turn, which is exactly the case nobody would test by hand.
  const doomed = new Set();
  for (const n of removes) {
    if (!Number.isInteger(n) || n < 1 || n > lines.length) {
      warnings.push(`removal out of range: ${n} (carnet: ${lines.length} lignes)`);
      continue;
    }
    doomed.add(n - 1);
  }

  const kept = lines.filter((_, i) => !doomed.has(i));
  const seen = new Set(kept.map((line) => line.toLowerCase()));

  for (const raw of adds) {
    // Same READ-side normalisation as the stored lines, so a numbered copy-back
    // matches its original. The `- n` removal parser is untouched and stays strict.
    const add = raw.replace(NUMBERING, "").trim();
    if (!add) continue;
    const key = add.toLowerCase();
    if (seen.has(key)) {
      // Not an error: it is what a model re-emitting the whole notebook does,
      // and the de-duplication is what makes that harmless.
      continue;
    }
    seen.add(key);
    kept.push(add);
  }

  if (looseAdds.length) {
    warnings.push(`${looseAdds.length} ligne(s) sans opérateur, traitées comme des ajouts`);
  }
  if (kept.length > NOTEBOOK_MAX_LINES) {
    // WARN, never truncate. Holding a cap by dropping the oldest line deletes
    // the oldest standing decisions — the ones with no conversation left to
    // recover them, and the whole reason the notebook exists.
    warnings.push(`carnet à ${kept.length} lignes (max annoncé ${NOTEBOOK_MAX_LINES})`);
  }
  if (lines.length && !kept.length) {
    // Reachable ONLY by explicitly removing every line — which is the property
    // test's whole subject. Loud, because it is indistinguishable in the data
    // from the bug this module replaced.
    warnings.push(`carnet vidé : ${lines.length} ligne(s) retirées explicitement`);
  }

  return { content: kept.join("\n"), warnings };
}
