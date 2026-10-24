/**
 * The catalog document → the shapes the app's consumers already expect.
 *
 * Pure, no I/O. The document is the single source of truth (Neon); this module
 * is the only place that knows its shape, so every consumer keeps working
 * against the grouped-name objects they always used, without knowing where
 * those came from.
 */
import {
  BILATERAL_HAND_IMPLEMENTS,
  SINGLE_HAND_HELD_IMPLEMENTS,
  EQUIPMENT_VOCABULARY,
  EQUIPMENT_LABELS_FR,
  buildInventoryViews,
} from "../constants/equipment.js";
import { normalizeBlacklistName } from "../constants/index.js";

/**
 * True set equality (order-insensitive, dedup-aware): `a` and `b` contain
 * exactly the same elements, regardless of position. Neither array is
 * mutated — no sort, no in-place reorder — since `implementTypes` is passed
 * straight through into the returned view and a caller must never observe it
 * change shape.
 *
 * Regression: cc12bd4 — was positional (`a.every((v, i) => v === b[i])`),
 * so a reversed but equal set (e.g. the bilateral pair stored as
 * `["dual_bar_symmetric", "dumbbell"]`) was silently classified as not
 * matching, which is exactly wrong for `isBilateral`: it decides whether a
 * weight is read as per-hand or total, ambiguous by a factor of two.
 */
export const sameSet = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const v of setA) if (!setB.has(v)) return false;
  return true;
};

/**
 * `bilateral` is DERIVED, never stored: it is exactly "one implement in each
 * hand", which is what BILATERAL_HAND_IMPLEMENTS means. Measured against all 70
 * catalog entries with zero exceptions. Storing it would be a second source for
 * one fact, free to disagree with the implement set.
 */
function isBilateral(implementTypes) {
  return sameSet(implementTypes, BILATERAL_HAND_IMPLEMENTS);
}

/**
 * @param {object|null} doc - the catalog document.
 * @param {object|null} [inventory] - `profile.inventory`, the equipment the
 *   load and location verdicts are derived from. Absent means the starter
 *   inventory; the result carries it as `views.inventory` so every validator
 *   that is handed the catalog is handed the equipment too.
 */
export function buildCatalogViews(doc, inventory) {
  const exercises = Array.isArray(doc?.exercises) ? doc.exercises : [];

  // NULL-PROTOTYPE, all three, because every key here comes from the document:
  // `ex.group` and `ex.name` are catalog data, and slice 2 makes them strings
  // The user types. On a plain `{}` a hostile key is not a key at all, it is a
  // prototype member.
  //
  // `muscleGroups[ex.group] ??= []` read `Object.prototype` for `"__proto__"` —
  // not nullish, so nothing was assigned — and threw
  // `TypeError: ....push is not a function`, breaking the stated "never throws
  // on a malformed document" invariant. `descriptions`/`ceilings` had the worse
  // half: `obj["__proto__"] = {...}` does NOT throw, it reassigns the object's
  // prototype, so the entry was never an own property — `Object.keys` empty,
  // `JSON.stringify` `{}` — while a bracket read handed the value straight back
  // and looked healthy. The views cross a JSON boundary, so that one is silent
  // data loss rather than a crash.
  //
  // A null prototype fixes both at the source instead of guarding each write:
  // there are no inherited members to collide with, so every document key is
  // just a key. `catalog.aliases` needs no equivalent because it is passed
  // through unchanged and read via `Object.prototype.hasOwnProperty.call`.
  const muscleGroups = Object.create(null);
  const descriptions = Object.create(null);
  const ceilings = Object.create(null);
  const blacklist = [];

  for (const ex of exercises) {
    if (!ex || typeof ex.name !== "string") continue;

    (muscleGroups[ex.group] ??= []).push(ex.name);

    descriptions[ex.name] = {
      description: ex.description ?? "",
      formCues: ex.formCues ?? "",
      intent: ex.intent ?? "",
      // `active` is on the DESCRIPTION and not only on the blacklist, because
      // the two answer different questions and conflating them shipped a bug.
      // The blacklist answers "what is she told she must not do, and why";
      // this answers "may the coach propose it at all". Deactivating WITHOUT a
      // reason is a real state (§2bis.1) that the lexique's « Désactiver »
      // button now produces on every tap, and it used to reach the
      // model-facing catalog unchanged: `buildBlacklistSection`
      // only lists reasoned entries, so the prompt's filter — which keyed off
      // the blacklist — had nothing to filter on. The lexique needs it too:
      // a deactivated row renders greyed, and reading that off the raw document
      // in a component would be a second source for one fact.
      active: ex.active !== false,
      bilateral: isBilateral(ex.implementTypes),
      perSide: Boolean(ex.perSide),
      implementTypes: Array.isArray(ex.implementTypes) ? ex.implementTypes : [],
      equipmentNeeds: Array.isArray(ex.equipmentNeeds) ? ex.equipmentNeeds : [],
      barHeight: ex.barHeight ?? null,
      // Normalised here rather than at each reader, so an absent or malformed
      // value can only ever become "reps" in one place.
      metric: metricOf(ex.metric),
    };

    if (ex.ceiling) ceilings[ex.name] = ex.ceiling;

    // Deactivated WITHOUT a reason is filtered from the catalog but never
    // explained to the coach — see design §2bis.1. buildBlacklistSection was
    // written for four medical entries; at twenty-five it stops explaining.
    if (ex.active === false && ex.inactiveReason) {
      blacklist.push({
        name: ex.name,
        reason: ex.inactiveReason,
        replacedBy: ex.replacedBy ?? null,
        date: ex.deactivatedAt ?? null,
      });
    }
  }

  // FORBIDDEN NAMES: blacklisted movements that were never exercises here.
  // `Hip thrust` is the case that forced the field — banned « Nécessite un banc »
  // with no `EXERCISE_DESCRIPTIONS` entry, so the exercise list cannot carry it.
  // The design doc said the document "has no way to express 'forbidden but
  // non-existent', and it does not need one"; the second half was wrong. The
  // warmup/cooldown matcher (`findBlacklistEntryLoose`) works on FREE TEXT with
  // no catalog backstop, so a name absent from the blacklist is not caught by
  // anything at all — `- Hip thrusts | 3×12` in a cooldown was one of four real
  // production bypasses closed on 2026-07-26 and it had reopened.
  //
  // They join `blacklist` and NOTHING else. A forbidden name is not an exercise:
  // no group, no definition, no loading model. Leaking one into `allExercises`
  // would put it in the user's lexique and her manual picker — an exercise she is
  // forbidden to do, offered to her. `catalogSeed.test.js` pins both halves.
  for (const forbidden of Array.isArray(doc?.forbiddenNames) ? doc.forbiddenNames : []) {
    if (!forbidden || typeof forbidden.name !== "string") continue;
    blacklist.push({
      name: forbidden.name,
      reason: forbidden.reason ?? "",
      replacedBy: forbidden.replacedBy ?? null,
      date: forbidden.date ?? null,
    });
  }

  return {
    muscleGroups,
    allExercises: Object.values(muscleGroups).flat(),
    descriptions,
    blacklist,
    ceilings,
    aliases: doc?.aliases ?? {},
    inventory: buildInventoryViews(inventory),
  };
}

/**
 * Asserts that a consumer was handed a catalog, and throws when it was not.
 *
 * **Required, never defaulted.** A default parameter falling back to the seed
 * would be the runtime fallback the owner ruled out, reintroduced silently at
 * every call site that forgets one — and it would be invisible, since the seed
 * and the document agree today. A missing catalog is a programming error, so it
 * fails at the first test that exercises the path rather than in production
 * against a day-one catalog.
 *
 * Lives here rather than in each validator so the three modules that guard
 * cannot drift into three different verdicts about what counts as a catalog.
 * `descriptions` is the marker: every views object has it, and no plain
 * document does.
 *
 * @param {object} catalog - a `buildCatalogViews` result.
 * @param {string} fn - the calling function's name, for the message.
 * @returns {object} the same catalog, so callers can guard and read in one step.
 */
export function requireCatalog(catalog, fn) {
  if (!catalog?.descriptions) {
    throw new Error(`${fn}: a catalog is required — there is no fallback, by design`);
  }
  return catalog;
}

/**
 * Is this views object a catalog a consumer can actually work from?
 *
 * `requireCatalog` answers a narrower question — "was I handed a catalog at
 * all" — and an EMPTY one passes it, because `buildCatalogViews(null)` returns
 * `descriptions: {}`, which is truthy. That gap has a user-visible cost: a Neon
 * read that comes back with nothing produces one « exercice « Squat »
 * introuvable dans le catalogue. Vérifie l'orthographe… » per exercise,
 * telling the user to correct a name that is perfectly correct.
 *
 * So the CLIENT decides here, once, that a degenerate catalog is the same thing
 * as no catalog: `useSessionData` hands out `null` rather than an empty views
 * object, the lexique shows its loading state and the import button is
 * disabled. The validators are never reached with an empty catalog because the
 * only control that reaches them is the one this disables.
 *
 * `allExercises` is the marker rather than `descriptions`: it is what the
 * lexique and the manual picker read, and a document carrying only
 * `forbiddenNames` (blacklist entries, no exercises) is still unusable.
 *
 * @param {object} catalog - a `buildCatalogViews` result, or null.
 * @returns {boolean}
 */
export function isUsableCatalog(catalog) {
  if (!catalog?.descriptions) return false;
  return Array.isArray(catalog.allExercises) && catalog.allExercises.length > 0;
}

/**
 * The views the UI hands to its components: the catalog built against the
 * profile's inventory, or null when there is no usable catalog yet. Pulled out
 * of `useSessionData` so the one decision it makes — the inventory the
 * validators see is the profile's — is a function a test can call.
 *
 * @param {object|null} doc - the catalog document (the lexique's view of it).
 * @param {object|null} [inventory] - `profile.inventory`.
 * @returns {object|null}
 */
export function usableCatalogViews(doc, inventory) {
  const views = doc ? buildCatalogViews(doc, inventory) : null;
  return isUsableCatalog(views) ? views : null;
}

/*
 * The two functions below used to have PRE-MIGRATION TWINS in
 * `src/constants/index.js` that read the build-time constants instead of a
 * catalog. The twins are gone, together with the constants themselves and the
 * `src/lib/catalogSeed.test.js` proof that the document reproduced them — a
 * proof of equality has nothing left to compare once one side is deleted.
 *
 * These two are now the only implementations. Both take a catalog as a REQUIRED
 * argument and throw without one; do not add a default that falls back to
 * `src/data/catalogSeed.json`, which would be the runtime fallback the owner
 * ruled out, reintroduced invisibly (the seed and the live document agree today
 * and will not once the user edits one).
 */

/**
 * The single blacklist lookup for catalog-backed consumers — never read
 * `catalog.blacklist` directly, so the matching rule has one definition.
 *
 * Matches forgivingly (trimmed, case-insensitive, diacritic-insensitive) on the
 * WHOLE name, exactly like the constants twin: safe for a main exercise line,
 * which needs exact identification of one exercise rather than a fuzzy free-text
 * guess. The looser substring variant used for warmup/cooldown free text lives
 * in `planValidation.js` and is deliberately separate.
 *
 * Covers the document's `forbiddenNames` as well as its deactivated exercises —
 * a blacklisted movement with no catalog entry (`Hip thrust`) is found here just
 * like one that has an entry. See `buildCatalogViews`.
 *
 * @param {unknown} rawName
 * @param {object} catalog - a `buildCatalogViews` result. Required.
 * @returns {{ name: string, reason: string, replacedBy: string|null, date: string|null } | null}
 */
export function findBlacklistEntry(rawName, catalog) {
  requireCatalog(catalog, "findBlacklistEntry");
  if (typeof rawName !== "string") return null;

  const normalized = normalizeBlacklistName(rawName);
  const entries = Array.isArray(catalog.blacklist) ? catalog.blacklist : [];
  return entries.find((entry) => normalizeBlacklistName(entry.name) === normalized) ?? null;
}

/**
 * The current name for an exercise, whatever it used to be called. Identity for
 * anything that is not a known alias — never guesses at the nearest catalog
 * entry, same ruling as `resolveCatalogName`.
 *
 * @param {unknown} name
 * @param {object} catalog - a `buildCatalogViews` result. Required.
 * @returns {unknown} the canonical name, or the input unchanged.
 */
export function canonicalExerciseName(name, catalog) {
  requireCatalog(catalog, "canonicalExerciseName");
  if (typeof name !== "string") return name;

  const aliases = catalog.aliases ?? {};
  return Object.prototype.hasOwnProperty.call(aliases, name) ? aliases[name] : name;
}

/**
 * The catalog entry a DISPLAY consumer should show for an exercise name, or
 * null when there is nothing to show.
 *
 * Two things it does that a bare `catalog.descriptions[name]` does not, both of
 * which were live defects:
 *
 * 1. It resolves the alias first. `descriptions` is keyed on CURRENT names, so
 *    a session or plan still carrying `Développé couché` looked up a key that
 *    does not exist and got `undefined` — and every consumer reads that as
 *    "no description", silently. `normalizeSessionNames`/`normalizePlanNames`
 *    rewrite names on read, so most of the app never sees an alias; the séance
 *    draft, an imported plan and the coach's free-text notebook can all still
 *    produce one, which is exactly why `canonicalExerciseName` exists.
 * 2. It tolerates a missing catalog instead of throwing. `requireCatalog` is
 *    right for the validators — a validator with no catalog is a programming
 *    error — but a display consumer legitimately renders before the first Neon
 *    pull lands, and the answer there is "show nothing yet", not a crash.
 *
 * @param {unknown} name
 * @param {object|null} catalog - a `buildCatalogViews` result, or null.
 * @returns {object|null} the descriptor from `catalog.descriptions`, or null.
 */
export function describeExercise(name, catalog) {
  if (!catalog?.descriptions || typeof name !== "string") return null;
  return catalog.descriptions[canonicalExerciseName(name, catalog)] ?? null;
}

/*
 * ---------------------------------------------------------------------------
 * Write-time validation
 * ---------------------------------------------------------------------------
 *
 * Everything above reads the document. Everything below decides whether a
 * document may be WRITTEN, which is new in slice 2: until the user could edit the
 * catalog, the only document that ever existed was the seed, and its
 * invariants were checked by a test over a frozen fixture
 * (`src/data/catalogSeed.test.js`). A test cannot reach a document she edited
 * in the app, so the same invariants have to run at the moment of the write.
 *
 * They split in two, and the split is an owner ruling (2026-08-14) rather than
 * a matter of taste:
 *
 *   `validateCatalogDoc`  BLOCKS. Structure — the things a consumer crashes
 *                         on, silently mis-reads, or quietly drops. Runs in
 *                         the form AND in the PUT handler: the form is the
 *                         belt, the endpoint is the suspenders, same idiom as
 *                         the plan validators.
 *
 *   `checkCatalogQuality` WARNS, never blocks. The copy-consistency
 *                         invariants, which are heuristic French text
 *                         matching. The two failure modes do not cost the
 *                         same: an entry whose prose contradicts its load
 *                         model is a line the user reads and can fix, while a form
 *                         that refuses to save is an exercise she cannot add
 *                         at all.
 *
 * Neither ever throws. A malformed document is exactly what these are for.
 */

/** The muscle groups the app renders as lexique sections and the validators group by. */
export const KNOWN_GROUPS = Object.freeze(["Upper Body", "Lower Body", "Full Body", "Core", "Cardio"]);

/**
 * The seven implement sets the load model reasons about — the two general
 * rules plus the five single-implement exceptions. A hand-composed set is
 * REFUSED rather than accepted-and-derived-from, because `isBilateral` reads
 * a set it does not recognise as "not per-hand", which is the factor-of-two
 * ambiguity this whole model exists to remove. If a genuinely new loading
 * shape is ever needed, it is named here and in `equipment.js` first.
 */
const ALLOWED_IMPLEMENT_SETS = [
  BILATERAL_HAND_IMPLEMENTS,
  SINGLE_HAND_HELD_IMPLEMENTS,
  ["bodyweight"],
  ["dumbbell"],
  ["ankle_weight"],
  ["elastic"],
  ["cardio"],
];

/** The two heights the pull-up bar is ever rigged at. */
const BAR_HEIGHTS = ["haute", "basse"];

/** The two units a ceiling can be expressed in — the same pair `computeTotalAndPerHand` reads. */
const CEILING_UNITS = ["total", "per_hand"];

/**
 * What a set of this exercise is COUNTED in. A closed list, on the same
 * reasoning as `ALLOWED_IMPLEMENT_SETS`: the unit used to live inside the
 * `reps` string (`"45s"`), by convention, enforced by nothing — which is the
 * defect `weightType` already fixed one level up on 2026-08-11. A free-form
 * unit would put the ambiguity straight back.
 *
 * Absent means `"reps"`. Every session recorded before this field existed
 * therefore keeps meaning exactly what it meant, and no migration is needed
 * for correctness.
 */
export const METRICS = ["reps", "seconds"];
export const DEFAULT_METRIC = "reps";

/** The document's metric for an entry, or the default. Never throws. */
export const metricOf = (value) => (METRICS.includes(value) ? value : DEFAULT_METRIC);

const asArray = (value) => (Array.isArray(value) ? value : []);

/**
 * How many edit-operation ids the document remembers in `appliedOps`, most
 * recent last.
 *
 * The list is what makes replaying an edit idempotent (`applyCatalogOps`).
 * A PUT whose response is lost has committed, yet its operations are still
 * queued; the retry is refused as stale, and the operations are replayed onto
 * a document that already holds them. Only the ids say "already done": an
 * add + deactivate replayed re-adds the exercise as a duplicate, a rename
 * replayed finds its source gone, and either one parked her edit for good.
 *
 * The window has to cover the operations of one PUT in doubt plus whatever
 * other devices commit before the retry lands. A burst of edits is a handful
 * of operations; two hundred is far beyond any of it, at ~5 kB on a document
 * every pull already carries.
 */
export const APPLIED_OPS_LIMIT = 200;
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Blocking errors for a catalog document, in French, ready to render beside
 * the offending field. Empty means the document may be written.
 *
 * @param {unknown} doc - a catalog document (never a `buildCatalogViews` result).
 * @returns {string[]}
 */
export function validateCatalogDoc(doc) {
  const errors = [];
  const exercises = asArray(doc?.exercises);

  // An EMPTY catalog is the one document that must never be saved, and it is
  // worth stating separately rather than leaving to the per-entry loop.
  // Every downstream verdict inverts under it: the lexique empties, the manual
  // picker empties, the coach's exercise list empties, and every plan import
  // reports each exercise « introuvable dans le catalogue » — telling the user to
  // correct names that are perfectly correct. `isUsableCatalog` already
  // refuses to hand one out on READ; this refuses to create one.
  if (exercises.length === 0) {
    return ["Le catalogue ne contient aucun exercice — impossible d'enregistrer."];
  }

  const names = new Set();

  for (const ex of exercises) {
    const rawName = isPlainObject(ex) ? ex.name : null;
    if (typeof rawName !== "string" || !rawName.trim()) {
      errors.push("Un exercice n'a pas de nom.");
      continue;
    }
    const name = rawName.trim();
    const label = `« ${name} »`;

    if (names.has(name)) errors.push(`${label} est déjà dans le catalogue.`);
    names.add(name);

    if (typeof ex.group !== "string" || !ex.group.trim()) {
      errors.push(`${label} : aucun groupe musculaire.`);
    } else if (!KNOWN_GROUPS.includes(ex.group)) {
      errors.push(`${label} : groupe « ${ex.group} » inconnu.`);
    }

    if (!ALLOWED_IMPLEMENT_SETS.some((set) => sameSet(ex.implementTypes, set))) {
      errors.push(`${label} : façon de se charger non reconnue.`);
    }

    for (const need of asArray(ex.equipmentNeeds)) {
      if (!EQUIPMENT_VOCABULARY.includes(need)) {
        errors.push(`${label} : matériel « ${need} » inconnu.`);
      }
    }

    if (ex.ceiling != null) {
      if (!isPlainObject(ex.ceiling) || !CEILING_UNITS.includes(ex.ceiling.unit)) {
        errors.push(`${label} : plafond de charge exprimé dans une unité inconnue.`);
      } else if (!Number.isFinite(ex.ceiling.maxKg) || ex.ceiling.maxKg <= 0) {
        errors.push(`${label} : plafond de charge sans nombre de kilos valide.`);
      }
    }

    // Absent is legal and means "reps"; a value that is neither is refused
    // rather than silently defaulted, because a document that says "minutes"
    // is a document someone believes counts minutes.
    if (ex.metric != null && !METRICS.includes(ex.metric)) {
      errors.push(`${label} : unité de série « ${ex.metric} » inconnue (répétitions ou secondes).`);
    }

    if (ex.barHeight != null) {
      if (!BAR_HEIGHTS.includes(ex.barHeight)) {
        errors.push(`${label} : hauteur de barre « ${ex.barHeight} » inconnue.`);
      } else if (!asArray(ex.equipmentNeeds).includes("pullup_bar")) {
        errors.push(`${label} : hauteur de barre indiquée sans barre de traction.`);
      }
    }
  }

  // `buildCatalogViews` pushes forbiddenNames and deactivated exercises into
  // ONE `blacklist` array, so a name in both places lands twice with two
  // reasons free to disagree — `findBlacklistEntry` then returns whichever
  // came first. Carried from slice 1's review.
  for (const forbidden of asArray(doc?.forbiddenNames)) {
    const name = isPlainObject(forbidden) ? forbidden.name : null;
    if (typeof name !== "string" || !name.trim()) {
      errors.push("Un mouvement interdit n'a pas de nom.");
      continue;
    }
    if (names.has(name.trim())) {
      errors.push(`« ${name.trim()} » est à la fois interdit et présent dans le catalogue.`);
    }
  }

  // Written by `applyCatalogOps`, never by hand, and read back by it to skip
  // operations already applied. A malformed list would make a replay apply
  // twice, so it is refused like any other structural fault.
  if (doc?.appliedOps !== undefined) {
    const ids = doc.appliedOps;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id)) {
      errors.push("Le journal des modifications du catalogue est illisible.");
    } else if (ids.length > APPLIED_OPS_LIMIT) {
      errors.push("Le journal des modifications du catalogue est trop long.");
    }
  }

  // Aliases are written by the rename path, so they are as editable as any
  // other field, and a broken one is silent: `canonicalExerciseName` rewrites
  // a session's exercise name to something no catalog entry matches, and the
  // import then rejects an exercise she really does have.
  const aliases = isPlainObject(doc?.aliases) ? doc.aliases : {};
  for (const [oldName, canonical] of Object.entries(aliases)) {
    if (names.has(oldName)) {
      errors.push(`« ${oldName} » est à la fois un ancien nom et un exercice du catalogue.`);
    }
    if (typeof canonical !== "string" || !names.has(canonical.trim())) {
      errors.push(`L'ancien nom « ${oldName} » renvoie vers « ${canonical} », qui n'existe pas dans le catalogue.`);
    }
  }

  return errors;
}

/*
 * The quality half. Everything below is a port of the copy-consistency
 * assertions in `src/data/catalogSeed.test.js`, which are the reason this app
 * does not show the user a definition contradicting the weights the coach may
 * prescribe: `Squat`, `Squat sumo` and `Soulevé de terre roumain` once
 * described "haltères" while being tagged bar-only. The seed still asserts
 * them (they must hold for the day-one catalog with no warnings at all); this
 * is the same rule applied to entries she writes.
 */

/**
 * The French word the copy uses for each load-bearing implement type. Both bar
 * types share one word on purpose — the lexique has no reason to spell out
 * which plating scheme applies. `barre chargeable`, not a bare `barre`:
 * `Tirage vertical élastique` legitimately mentions a "barre de traction" and
 * `Tapis de course` its handrails, neither of which is a loadable bar.
 */
const IMPLEMENT_WORD = {
  dumbbell: /haltère/i,
  dual_bar_symmetric: /barre chargeable/i,
  single_bar_heavy: /barre chargeable/i,
  ankle_weight: /lest/i,
  elastic: /élastique/i,
};

/** How each implement word is named back to her in a warning. */
const IMPLEMENT_LABEL_FR = {
  dumbbell: "haltère",
  dual_bar_symmetric: "barre chargeable",
  single_bar_heavy: "barre chargeable",
  ankle_weight: "lest",
  elastic: "élastique",
};

/** Equipment the copy may only name when `equipmentNeeds` declares it. */
const EQUIPMENT_WORD = {
  bench: /banc/i,
  machine: /machine/i,
  pulley: /poulie/i,
  kettlebell: /kettlebell/i,
  rack: /\brack\b/i,
  chair: /chaise/i,
};

/**
 * A description that ENDS on the hold instruction — « …corps droit, tenir »,
 * « …maintenir la position ». Deliberately anchored at the end, and
 * deliberately blind to `formCues`.
 *
 * The obvious rule — "`tenir` or `maintenir` appears anywhere in the copy" —
 * was measured against the seed and matches nine exercises where this one
 * matches five. The four it adds are Shrugs (« maintenir 1 seconde en haut »),
 * Pont fessier, Bird dog and Tapis de course: every one carries a tempo cue in
 * `formCues` and counts repetitions. A warning wrong four times in nine is a
 * warning the user learns to dismiss, and this file's own contract says a false
 * positive here is the dangerous direction. `catalog.test.js` pins both the
 * five and the four.
 */
const HOLD_DESCRIPTION = /(?:\btenir|\bmaintenir la position)\s*[.!]?\s*$/i;

const TWO_IMPLEMENTS = /chaque main|haltères|barres/i;
const PER_SIDE = /par (jambe|côté|bras)/i;
const ANY_LOAD_WORD = /haltère|barre chargeable|lest|élastique/i;

/**
 * Non-blocking quality warnings for a catalog document, in French.
 *
 * NOTHING here may ever move into `validateCatalogDoc`: these are heuristics
 * over free prose, and a false positive would leave the user unable to save a
 * perfectly good exercise. A test pins that a document failing every check
 * here still validates clean.
 *
 * @param {unknown} doc - a catalog document.
 * @returns {string[]}
 */
export function checkCatalogQuality(doc) {
  const warnings = [];

  for (const ex of asArray(doc?.exercises)) {
    if (!isPlainObject(ex) || typeof ex.name !== "string" || !ex.name.trim()) continue;

    const label = `« ${ex.name.trim()} »`;
    const description = typeof ex.description === "string" ? ex.description : "";
    const formCues = typeof ex.formCues === "string" ? ex.formCues : "";
    const intent = typeof ex.intent === "string" ? ex.intent : "";
    const copy = `${description} ${formCues}`;
    const implementTypes = asArray(ex.implementTypes);
    const equipmentNeeds = asArray(ex.equipmentNeeds);

    if (!description.trim()) {
      warnings.push(`${label} : pas de définition — c'est la première ligne du lexique.`);
    }
    if (!intent.trim()) {
      warnings.push(`${label} : « à quoi ça sert » est vide, et c'est la ligne qui explique pourquoi l'exercice est là.`);
    } else if (intent.trim() === description.trim()) {
      warnings.push(`${label} : « à quoi ça sert » répète mot pour mot la définition.`);
    }

    if (HOLD_DESCRIPTION.test(description) && metricOf(ex.metric) !== "seconds") {
      warnings.push(
        `${label} : la définition décrit un maintien, mais les séries sont comptées en répétitions — passe l'unité en secondes.`
      );
    }

    // Which implement words this entry's set legitimately allows. Empty for
    // bodyweight and cardio, which carry no implement at all.
    const allowed = implementTypes.filter((type) => IMPLEMENT_WORD[type]);
    const isLoaded = allowed.length > 0;

    if (isLoaded) {
      const named = allowed.some((type) => IMPLEMENT_WORD[type].test(copy));
      if (!named) {
        const words = [...new Set(allowed.map((type) => IMPLEMENT_LABEL_FR[type]))].join(", ");
        warnings.push(`${label} : le texte ne dit jamais avec quoi l'exercice se charge (${words}).`);
      }

      const allowedWords = new Set(allowed.map((type) => IMPLEMENT_WORD[type].source));
      for (const [type, word] of Object.entries(IMPLEMENT_WORD)) {
        if (allowedWords.has(word.source)) continue;
        if (word.test(copy)) {
          warnings.push(`${label} : le texte parle d'un ${IMPLEMENT_LABEL_FR[type]}, que cet exercice ne peut pas porter.`);
        }
      }
    } else if (implementTypes.includes("bodyweight") && ANY_LOAD_WORD.test(copy)) {
      warnings.push(`${label} : exercice au poids du corps, mais le texte décrit une charge.`);
    }

    for (const [token, word] of Object.entries(EQUIPMENT_WORD)) {
      if (equipmentNeeds.includes(token)) continue;
      if (word.test(copy)) {
        warnings.push(`${label} : le texte parle de ${EQUIPMENT_LABELS_FR[token] ?? token}, sans le déclarer dans le matériel nécessaire.`);
      }
    }

    // Ankle-weight work is skipped exactly as the seed test skips it: a lest
    // is worn on both ankles without the copy ever saying "chaque main".
    if (isLoaded && !implementTypes.includes("ankle_weight")) {
      const describesTwo = TWO_IMPLEMENTS.test(copy);
      if (sameSet(implementTypes, BILATERAL_HAND_IMPLEMENTS) && !describesTwo) {
        warnings.push(`${label} : la charge est comptée par main, mais le texte ne décrit pas un implement dans chaque main.`);
      }
      if (!sameSet(implementTypes, BILATERAL_HAND_IMPLEMENTS) && describesTwo) {
        warnings.push(`${label} : le texte décrit deux implements alors que l'exercice se charge avec un seul.`);
      }
    }

    // A pull-up-bar exercise with no height is not malformed — nothing crashes
    // on it — but it is invisible to the two things that exist to protect her:
    // it is omitted from the prompt's high/low lists and skipped by
    // `checkBarHeightRule`, so it can be programmed alongside either height
    // with no error at all. A WARNING rather than a block, per the same ruling
    // as the rest of this function, and no default is written for her: guessing
    // « haute » on a low-bar exercise would manufacture false rejections, which
    // is the failure mode this repo guards hardest against.
    if (equipmentNeeds.includes("pullup_bar") && ex.barHeight !== "haute" && ex.barHeight !== "basse") {
      warnings.push(`${label} : exercice à la barre de traction sans hauteur — sans elle, la règle « une seule hauteur par séance » ne le voit pas.`);
    }

    const announcesSides = PER_SIDE.test(copy);
    if (ex.perSide && !announcesSides) {
      warnings.push(`${label} : les répétitions sont comptées par côté, mais le texte ne le dit pas.`);
    }
    if (!ex.perSide && announcesSides) {
      warnings.push(`${label} : le texte compte les répétitions par côté, mais la case « par côté » n'est pas cochée.`);
    }
  }

  return warnings;
}

/**
 * Renames an exercise, and records the alias in the same write.
 *
 * Never one without the other. An exercise name is the primary key for the user's
 * history — `computePRs` and `computeLoadStreaks` key their maps on it, and it
 * is embedded in every session in localStorage and in Neon — so an unaliased
 * rename splits one exercise's history in two, resets its clean-session count
 * to zero, and the coach then withholds a load increase she has already
 * earned. That reads to her as a coaching decision rather than as a bug, which
 * is why this is one function rather than two steps a caller has to remember.
 *
 * EXISTING aliases pointing at the old name are REPOINTED, not left behind:
 * `canonicalExerciseName` resolves exactly one hop, so `A → B` plus a rename
 * of `B` to `C` would otherwise leave `A` resolving to a name that no longer
 * exists — which `validateCatalogDoc` then refuses, blocking a rename that is
 * perfectly reasonable. The catalog already has three such aliases from
 * 2026-07-26, so this is a path a second rename genuinely reaches.
 *
 * @param {object} doc - a catalog document.
 * @param {string} oldName
 * @param {string} newName
 * @returns {object} a new document; the input is never mutated.
 */
export function applyRename(doc, oldName, newName) {
  if (!isPlainObject(doc) || oldName === newName) return doc;
  if (typeof oldName !== "string" || typeof newName !== "string" || !newName.trim()) return doc;

  const aliases = isPlainObject(doc.aliases) ? doc.aliases : {};
  const repointed = Object.fromEntries(
    Object.entries(aliases).map(([from, to]) => [from, to === oldName ? newName : to])
  );

  return {
    ...doc,
    aliases: { ...repointed, [oldName]: newName },
    exercises: asArray(doc.exercises).map((ex) =>
      isPlainObject(ex) && ex.name === oldName ? { ...ex, name: newName } : ex
    ),
  };
}
