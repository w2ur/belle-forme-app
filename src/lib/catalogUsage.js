/**
 * Whether an exercise may be deleted from the catalog, and why not.
 *
 * Its own module rather than an addition to `catalogForm.js`: that file is form
 * vocabulary and document edits, this one reads HISTORY — a different source of
 * truth — and it is the one piece of the panel whose failure mode is
 * irreversible.
 *
 * **Why refusal rather than a warning.** Exercise names are the primary key for
 * The user's history: `computePRs` and `computeLoadStreaks` key their maps on
 * `ex.name`. Deleting a used exercise does not corrupt those — they read
 * sessions, not the catalog — it removes the entry carrying that exercise's
 * load CEILING, and a name with no ceiling is a name the coach may prescribe an
 * unbounded load on. Silent, and nothing undoes it. The need the user actually
 * stated — removing a test entry — is fully served by the safe case, so there
 * is nothing to trade away.
 */

const asArray = (v) => (Array.isArray(v) ? v : []);

/**
 * How an exercise name is referenced outside the catalog document.
 *
 * A name counts under the exercise it resolves to in `doc` — itself, or the
 * current name its alias points at. Normalisation on read is not enough on its
 * own: her history is normalised against the CONFIRMED catalog, and `doc` is
 * the one the lexique shows, which carries renames still on their way. While
 * one is, her sessions hold the old name and the entry the new one; counted by
 * raw name, the renamed exercise read as unused and could be deleted along
 * with the alias that is its whole history's link to it.
 *
 * There is a FOURTH place a name lives besides sessions, the plan and the
 * aliases: the in-progress séance draft `useActiveSession` owns (shaped
 * `state.exercises[].name`, same as a session). Quitting a séance keeps the
 * draft, resumable from `ResumeCard`, so it can outlive the plan it was
 * started from — importing a new week replaces `plan` but leaves the draft
 * exactly as it was. Reusing `uses()` for it (rather than writing a second
 * predicate) is deliberate: it is already the exact shape check the
 * sessions/plan branches need.
 *
 * @param {string} name
 * @param {object} context
 * @param {Array|null} context.sessions - recorded sessions.
 * @param {object|null} context.plan - the stored weekly plan.
 * @param {object|null} context.doc - the catalog document.
 * @param {object|null} [context.activeSession] - the running séance draft (`useActiveSession`'s `state`), if any.
 * @returns {{sessionCount: number, inPlan: boolean, inActiveSession: boolean, aliasedFrom: string[]}}
 */
export function exerciseUsage(name, { sessions, plan, doc, activeSession } = {}) {
  const aliases = doc?.aliases && typeof doc.aliases === "object" ? doc.aliases : {};
  const aliasedFrom = Object.entries(aliases)
    .filter(([, canonical]) => canonical === name)
    .map(([retired]) => retired);
  // One hop, like `canonicalExerciseName`: `applyRename` repoints every alias.
  const names = new Set([name, ...aliasedFrom]);
  const uses = (session) => asArray(session?.exercises).some((ex) => names.has(ex?.name));

  const sessionCount = asArray(sessions).filter(uses).length;
  const inPlan = asArray(plan?.sessions).some(uses);
  const inActiveSession = Boolean(activeSession) && uses(activeSession);

  return { sessionCount, inPlan, inActiveSession, aliasedFrom };
}

/**
 * The verdict, with a French reason the user reads in the row.
 *
 * The reasons are ordered by how concrete they are to her: a session count is
 * something she recognises, a draft in progress less so. Only the first
 * applicable one is returned — a row is not the place for a list, and any
 * single reason is already sufficient to refuse.
 *
 * **Aliases do NOT refuse a delete** (owner ruling): a rename writes a
 * permanent alias regardless of whether the entry was ever used, so a typo
 * fixed by renaming — « Squt » → « Squat » — produced an alias with nothing
 * behind it, and the old refusal made that entry undeletable forever while
 * asserting a history that never existed (`sessionCount === 0`, `inPlan ===
 * false`). `aliasedFrom` is still reported by `exerciseUsage`: `deleteExercise`
 * reads it to drop the now-dangling aliases along with the entry.
 *
 * The last-exercise case duplicates a rule `validateCatalogDoc` already
 * enforces. That is deliberate: enforced there, EXPLAINED here, so she is told
 * before the tap rather than shown a red error after it.
 *
 * @param {{sessionCount: number, inPlan: boolean, inActiveSession: boolean, aliasedFrom: string[]}} usage
 * @param {{totalExercises: number}} catalogSize
 * @returns {{deletable: boolean, reason: string|null}}
 */
export function deleteVerdict(usage, catalogSize) {
  const sessionCount = usage?.sessionCount ?? 0;
  const inPlan = usage?.inPlan ?? false;
  const inActiveSession = usage?.inActiveSession ?? false;
  const total = catalogSize?.totalExercises ?? 0;

  if (!usage) {
    return { deletable: false, reason: "Impossible de vérifier si cet exercice est utilisé." };
  }

  if (sessionCount > 0) {
    const plural = sessionCount > 1 ? "séances enregistrées" : "séance enregistrée";
    return {
      deletable: false,
      reason: `Utilisé dans ${sessionCount} ${plural} — utilise Désactiver pour ne plus le voir proposé.`,
    };
  }

  if (inPlan) {
    return {
      deletable: false,
      reason: "Il est dans ton programme de la semaine — utilise Désactiver.",
    };
  }

  if (inActiveSession) {
    return {
      deletable: false,
      reason: "Il est dans la séance en cours — utilise Désactiver.",
    };
  }

  if (total <= 1) {
    return {
      deletable: false,
      reason: "C'est le dernier exercice du catalogue — il doit en rester au moins un.",
    };
  }

  return { deletable: true, reason: null };
}
