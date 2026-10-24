/**
 * The vocabulary the exercise form offers, and the pure document edits it
 * makes. No React, no I/O.
 *
 * It lives beside `catalog.js` rather than inside it because `catalog.js` is
 * imported wholesale by the coach's edge function, and none of this is
 * something the model ever sees: these are French UI labels and form-shaped
 * defaults. The split is the same one the rest of the repo uses — the decision
 * is pure and tested, the component only wires it to state.
 */
import {
  BILATERAL_HAND_IMPLEMENTS,
  SINGLE_HAND_HELD_IMPLEMENTS,
  EQUIPMENT_VOCABULARY,
  EQUIPMENT_LABELS_FR,
} from "../constants/equipment.js";
import { applyRename, APPLIED_OPS_LIMIT, KNOWN_GROUPS } from "./catalog.js";

/** The muscle groups an exercise can be filed under, in lexique order: the validator's own list, so the form, the labels and validateCatalogDoc cannot drift apart. */
export const GROUP_CHOICES = KNOWN_GROUPS;

/**
 * Display label for a catalog group. The KEY stays English: it is stored in the
 * Neon catalog document and read by the validators and the coach prompt, so only
 * what the user sees is translated. A key with no label is shown as written, and the
 * lookup is own-property only, so a key like "constructor" can never return a
 * function into JSX. A test pins one label per GROUP_CHOICES entry, so a sixth
 * group cannot ship untranslated.
 */
const GROUP_LABELS = {
  "Upper Body": "Haut du corps",
  "Lower Body": "Bas du corps",
  "Full Body": "Corps entier",
  Core: "Gainage",
  Cardio: "Cardio",
};

export function groupLabel(key) {
  return Object.hasOwn(GROUP_LABELS, key) ? GROUP_LABELS[key] : key;
}

/**
 * The seven ways an exercise can be loaded, as one radio each.
 *
 * **This is a closed list, and that is the point.** The implement set decides
 * whether a weight is read as per-hand or as a total — ambiguous by a factor
 * of two — so the form never lets her compose one by ticking implements. Each
 * option writes a set the load model already reasons about, and
 * `validateCatalogDoc` refuses anything else; a test pins that these seven are
 * exactly the sets it accepts, so the two lists cannot drift apart.
 *
 * The labels say what she DOES, not which token gets stored: « un haltère ou
 * une barre dans chaque main » is a thing you can picture, `dual_bar_symmetric`
 * is not.
 */
export const IMPLEMENT_CHOICES = [
  { id: "bilateral", label: "Un haltère ou une barre dans chaque main", implementTypes: BILATERAL_HAND_IMPLEMENTS },
  { id: "single", label: "Un seul haltère ou une seule barre", implementTypes: SINGLE_HAND_HELD_IMPLEMENTS },
  { id: "bodyweight", label: "Poids du corps", implementTypes: ["bodyweight"] },
  { id: "dumbbell", label: "Haltère uniquement (une barre ne convient pas)", implementTypes: ["dumbbell"] },
  { id: "ankle_weight", label: "Lest de cheville", implementTypes: ["ankle_weight"] },
  { id: "elastic", label: "Élastique", implementTypes: ["elastic"] },
  { id: "cardio", label: "Cardio", implementTypes: ["cardio"] },
];

/**
 * What a set is counted in. Two radios rather than a free field, on the same
 * reasoning as `IMPLEMENT_CHOICES`: the unit used to live inside the `reps`
 * string and was enforced by nothing.
 */
export const METRIC_CHOICES = [
  { id: "reps", label: "Répétitions" },
  { id: "seconds", label: "Secondes (exercice de maintien)" },
];

/** Equipment tick-boxes, with the French names the validators already use in their messages. */
export const EQUIPMENT_CHOICES = EQUIPMENT_VOCABULARY.map((token) => ({
  token,
  label: EQUIPMENT_LABELS_FR[token] ?? token,
}));

/** The two heights the pull-up bar is rigged at. Only ever offered when the bar is ticked. */
export const BAR_HEIGHT_CHOICES = [
  { value: "haute", label: "Barre haute (suspendue, bras tendus)" },
  { value: "basse", label: "Barre basse (pieds au sol)" },
];

/** A new, empty exercise. Bodyweight by default: it is the only set that needs no equipment. */
export function blankExercise() {
  return {
    name: "",
    group: "Lower Body",
    description: "",
    formCues: "",
    intent: "",
    implementTypes: ["bodyweight"],
    equipmentNeeds: [],
    metric: "reps",
    perSide: false,
    barHeight: null,
    ceiling: null,
    active: true,
    inactiveReason: null,
    replacedBy: null,
    deactivatedAt: null,
  };
}

/** Which of the seven radios an entry's implement set corresponds to, or null for a set from elsewhere. */
export function implementChoiceOf(implementTypes) {
  const wanted = new Set(Array.isArray(implementTypes) ? implementTypes : []);
  return (
    IMPLEMENT_CHOICES.find(
      (choice) =>
        choice.implementTypes.length === wanted.size &&
        choice.implementTypes.every((type) => wanted.has(type))
    ) ?? null
  );
}

/**
 * Puts an edited exercise back into the document — replacing the entry that
 * was there, or appending a new one.
 *
 * `originalName` is what the entry was called when the form opened, and it is
 * the only way to tell an edit from an add. A RENAME is not handled here: the
 * caller applies `applyRename` first, so the alias and the new name are
 * written together and never one without the other.
 *
 * **An ADD never replaces anything, even when the name is already taken.** It
 * used to compute its target as `originalName ?? entry.name`, so adding an
 * exercise called « Squat » silently overwrote the real Squat — its implement
 * set, its form cues and its 11 kg-class ceiling gone, the entry count
 * unchanged, and `validateCatalogDoc` clean, because the duplicate had been
 * merged away rather than created. It reached state, localStorage and Neon with
 * nothing to undo it, and the lost ceiling is a guardrail regression rather
 * than only lost text: the coach may then prescribe an unbounded load.
 * Appending instead makes it a duplicate, which the validator already refuses
 * with the right message — the same idiom as everywhere else here, where the
 * fix is to make the bad state unrepresentable rather than to add a check.
 *
 * A new exercise is APPENDED rather than sorted into its group, because
 * `allExercises` is document order and the lexique groups on read — inserting
 * it "where it belongs" would silently reorder a list she has been reading for
 * months to save nothing.
 *
 * @param {object} doc - a catalog document.
 * @param {object} entry - the edited exercise.
 * @param {string|null} originalName - the entry's name before editing, or null for a new one.
 * @returns {object} a new document; the input is never mutated.
 * @throws when `originalName` is set and no exercise has that name.
 */
export function upsertExercise(doc, entry, originalName = null) {
  const exercises = Array.isArray(doc?.exercises) ? doc.exercises : [];
  const target = originalName;

  // An add whose exact entry is already there has already been applied. The
  // outbox replays operations after a failure, and a PUT that committed but
  // whose response was lost is exactly that: the retry is refused as stale,
  // the add is replayed onto a server document that already holds it, and
  // appending would make a duplicate that fails validation and parks her
  // edit for good. Only an IDENTICAL entry counts — a different exercise
  // under a taken name is still appended, so the collision above stays
  // visible to `validateCatalogDoc`.
  if (target === null && exercises.some((ex) => ex?.name === entry?.name && sameJson(ex, entry))) {
    return doc;
  }

  const found = target !== null && exercises.some((ex) => ex?.name === target);

  // An EDIT of an exercise that is no longer there is refused, never turned
  // into an add. Replayed onto the server's document after a 409, it would
  // otherwise bring back an exercise deleted on another device — and her
  // edit would read as a recreation nobody asked for. Throwing makes the
  // replay a `CatalogConflictError`, which parks the edit with her changes
  // kept for « Réessayer ».
  if (target !== null && !found) {
    throw new Error(`« ${target} » n'est plus dans le catalogue : il a été supprimé ailleurs.`);
  }

  return {
    ...doc,
    exercises: found
      ? exercises.map((ex) => (ex?.name === target ? entry : ex))
      : [...exercises, entry],
  };
}

// Equal as JSON, key order ignored: the server's copy has been through JSONB,
// which does not keep the order the form wrote the keys in, and a key holding
// `undefined` is one JSON drops.
function sameJson(a, b) {
  return JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => [k, canonicalJson(value[k])])
  );
}

/**
 * Flips an exercise between active and deactivated.
 *
 * Deactivating stamps the date, because `buildCatalogViews` renders it beside
 * the reason on the blacklist the coach reads, and « depuis quand » is half of
 * what makes a refusal legible. Reactivating clears the reason, the
 * replacement and the date together: leaving a stale « pourquoi c'est
 * désactivé » on a live exercise is the kind of contradiction the lexique is
 * meant to remove.
 *
 * @param {object} doc
 * @param {string} name
 * @param {boolean} active
 * @param {string} todayISO - injected, never read from the clock here (pure).
 */
export function setExerciseActive(doc, name, active, todayISO) {
  const exercises = Array.isArray(doc?.exercises) ? doc.exercises : [];
  return {
    ...doc,
    exercises: exercises.map((ex) => {
      if (!ex || ex.name !== name) return ex;
      return active
        ? { ...ex, active: true, inactiveReason: null, replacedBy: null, deactivatedAt: null }
        : { ...ex, active: false, deactivatedAt: ex.deactivatedAt ?? todayISO };
    }),
  };
}

/**
 * Stamps the deactivation date on an entry the form is about to write.
 *
 * The list button goes through `setExerciseActive`, which dates the
 * deactivation; the form's « Actif » toggle wrote `active: false` and left the
 * date null, so the SAME state transition produced two different documents
 * depending on which control she used. `buildCatalogViews` carries that date
 * onto the blacklist view, where « depuis quand » is half of what makes a
 * refusal legible to the coach — so the form's path was the lossy one.
 *
 * @param {object} entry
 * @param {string} todayISO - injected, never read from the clock here (pure).
 */
export function stampDeactivation(entry, todayISO) {
  if (entry?.active !== false) return entry;
  return { ...entry, deactivatedAt: entry.deactivatedAt ?? todayISO };
}

/**
 * Removes an exercise from the document, and every alias that pointed at it.
 *
 * **Alias cleanup is required now, not optional.** `deleteVerdict`
 * (`catalogUsage.js`) used to refuse deleting any name an alias pointed at, so
 * this function could assume there was never one to clean up. The owner
 * reversed that: a rename writes a permanent alias whether or not the entry
 * was ever used, so a typo fixed by renaming — « Squt » → « Squat » — made
 * that entry undeletable forever for a history that never existed. The delete
 * is allowed now, which means it must also drop the aliases, or the result
 * points at an exercise that no longer exists: `validateCatalogDoc`
 * (`catalog.js`) rejects exactly that document, and `saveCatalog` runs it
 * before anything reaches state, localStorage or Neon — so without this, the
 * delete this fix exists to allow would be refused right back at save time.
 *
 * Emptying the catalog is not refused here either: `validateCatalogDoc` already
 * refuses the resulting document, and `saveCatalog` runs it before anything
 * reaches state, localStorage or Neon.
 *
 * @param {object} doc - a catalog document.
 * @param {string} name - the exercise to remove.
 * @returns {object} a new document; the input is never mutated.
 */
export function deleteExercise(doc, name) {
  const exercises = Array.isArray(doc?.exercises) ? doc.exercises : [];
  const aliases = doc?.aliases && typeof doc.aliases === "object" ? doc.aliases : {};
  const nextAliases = Object.fromEntries(
    Object.entries(aliases).filter(([, canonical]) => canonical !== name)
  );
  return {
    ...doc,
    exercises: exercises.filter((ex) => ex?.name !== name),
    aliases: nextAliases,
  };
}

/**
 * The edits the lexique can make, by name. Each is one of the pure functions
 * above (or `applyRename`), so an operation means exactly what the form did.
 */
const CATALOG_OPS = {
  upsertExercise,
  setExerciseActive,
  deleteExercise,
  applyRename,
};

/**
 * The exercise names an operation reads or writes: the entry's name and the
 * name it replaces for an upsert, both sides of a rename, the one name
 * otherwise. Used to tell whether two edits are about the same exercise.
 */
export function opExerciseNames(op) {
  const args = Array.isArray(op?.args) ? op.args : [];
  const names = op?.op === "upsertExercise" ? [args[0]?.name, args[1]]
    : op?.op === "applyRename" ? [args[0], args[1]]
    : [args[0]];
  return names.filter((n) => typeof n === "string" && n.length > 0);
}

/**
 * Replays edit operations over a catalog document.
 *
 * **Why the lexique sends operations rather than a document.** The PUT used to
 * store whatever document arrived, so an iPad holding an old copy toggled one
 * exercise and erased every addition made elsewhere since. With operations,
 * a write the server refuses as stale (409) is replayed onto the server's
 * current document instead of overwriting it — which only works if the edit
 * still exists as an edit by then.
 *
 * An operation is `{ op, args }`, plain JSON so the outbox can persist it.
 * Everything time-dependent (`today()`, `stampDeactivation`) is applied BEFORE
 * the operation is built, so replaying it later, onto another document, is
 * deterministic.
 *
 * **Replaying is idempotent by operation id.** Every operation the lexique
 * builds carries an `id`, and the document remembers the last
 * `APPLIED_OPS_LIMIT` ids it was built from (`appliedOps`). An operation
 * whose id is already there is skipped, and the ids of the ones applied are
 * appended. The ids travel INSIDE the document, so the server records them in
 * the same UPDATE as the edit they describe — no column, no migration, and
 * the 409 body and the SQL export carry them for free. An operation with no
 * id (built before ids existed) is always applied, as before.
 *
 * @param {object} doc - a catalog document; never mutated.
 * @param {Array<{id?: string, op: string, args: Array}>} ops
 * @returns {object} the document after every operation not yet applied, in order.
 * @throws on an operation name this module does not know.
 */
export function applyCatalogOps(doc, ops) {
  const pending = unappliedOps(doc, ops);
  const next = pending.reduce((acc, { op, args } = {}) => {
    const fn = Object.hasOwn(CATALOG_OPS, op) ? CATALOG_OPS[op] : null;
    if (!fn) throw new Error(`Unknown catalog operation "${op}"`);
    return fn(acc, ...(Array.isArray(args) ? args : []));
  }, doc);
  const ids = pending.map((o) => o?.id).filter(isOpId);
  if (!ids.length) return next;
  return { ...next, appliedOps: [...appliedIds(doc), ...ids].slice(-APPLIED_OPS_LIMIT) };
}

/** The operations of `ops` that `doc` was not already built from. */
export function unappliedOps(doc, ops) {
  const applied = new Set(appliedIds(doc));
  return (ops ?? []).filter((o) => !(isOpId(o?.id) && applied.has(o.id)));
}

const isOpId = (id) => typeof id === "string" && id.length > 0;

function appliedIds(doc) {
  return Array.isArray(doc?.appliedOps) ? doc.appliedOps.filter(isOpId) : [];
}
