/**
 * Everything `buildSystemPrompt` needs, assembled from the catalog DOCUMENT.
 *
 * `coachPrompt.js` deliberately imports nothing from `src/` — every fact it
 * states is injected, which is what keeps it independently testable and what
 * keeps its load data from drifting. The assembly of those facts still has to
 * happen somewhere, and it used to happen inside `coach-chat.js` while the
 * prompt tests built their own parallel copy. Two hand-maintained copies of the
 * injected data is exactly the drift this whole guardrail layer exists to
 * prevent, so both sides now call this function: the test asserts against the
 * object production actually sends.
 *
 * It used to be three frozen module-level constants, assembled once from
 * `src/constants`. The exercise catalog now lives in Neon, so the exercise half
 * of the assembly is a function of a document that changes between requests —
 * `coach-chat.js` caches the result on the document's `updated_at` rather than
 * rebuilding it per request. What is NOT a function of the catalog stays a
 * constant here: the physical equipment inventory, the validators' own numbers,
 * the plan schema, and the coaching judgement inputs.
 *
 * Nothing here is a literal — every value is derived from the catalog, from
 * `src/constants/equipment.js` or from the validator that enforces it.
 */

import { deriveLocations, describeHomeBlockers } from "../../../src/constants/equipment.js";
import {
  resolveCycle,
  CLEAN_SESSIONS_BEFORE_LOAD_INCREASE,
} from "../../../src/constants/index.js";
import { resolvePersona } from "../../../src/lib/persona.js";
import { findBlacklistEntry, requireCatalog } from "../../../src/lib/catalog.js";
import { PLAN_JSON_SCHEMA } from "../../../src/lib/planSchema.js";
import { NOTEBOOK_MAX_LINES } from "./notebookDoc.js";
import {
  USUAL_EXERCISES_PER_FORCE_SESSION,
  CORE_MUSCLE_GROUP,
  LOWER_BODY_MUSCLE_GROUP,
} from "../../../src/lib/planValidation.js";

/** Every catalog name whose implement set satisfies the given predicate. */
function exercisesWithImplementSet(catalog, predicate) {
  return catalog.allExercises.filter((name) => {
    const types = catalog.descriptions[name]?.implementTypes;
    return Array.isArray(types) && predicate(types);
  });
}

/**
 * Coaching judgement inputs — the `coaching` argument. Kept apart from the
 * `structure` object on purpose: every value there is a rule that blocks or
 * corrects a plan, and nothing here is enforced anywhere. Cycle phase and
 * time-at-load are context the coach weighs, and the owner's ruling is explicit
 * that over-determinising them would prevent coaching rather than protect the user.
 *
 * A CONSTANT, deliberately, and not a function of the catalog: neither value
 * describes an exercise, so neither belongs in a document the user can edit.
 */
function coachingFor(profile) {
  return {
    // Null unless the profile opted into cycle periodization: null keeps the
    // whole cycle section out of the prompt.
    cycle: resolveCycle(profile),
    cleanSessionsBeforeIncrease: CLEAN_SESSIONS_BEFORE_LOAD_INCREASE,
    // Who is being coached, for the template tokens and the coach notes.
    persona: resolvePersona(profile),
  };
}

/**
 * Returns `name` only if the schema really declares it as a property, and
 * throws otherwise.
 *
 * The prompt has to name two of the payload's fields — the one progression
 * goes into at a ceiling, and the notebook — and a field name typed into prompt
 * prose is a fact that can drift from the schema exactly as a retyped ceiling
 * drifts from the constants. There is no way to DERIVE a name from a schema
 * without saying it once, so it is said once, here, checked against the schema
 * the API is actually given. Renaming a field then breaks the prompt build
 * rather than producing a prompt that describes a field that is gone.
 */
function schemaField(properties, name) {
  if (!properties?.[name]) {
    throw new Error(`planSchema no longer declares the "${name}" property the coach prompt names`);
  }
  return name;
}

const planExerciseProperties =
  PLAN_JSON_SCHEMA.properties.sessions.items.properties.exercises.items.properties;

/**
 * The three arguments `buildSystemPrompt` takes, built from one catalog.
 *
 * REQUIRED, never defaulted: the prompt is the model's source of truth, so this
 * is validator-shaped rather than display-shaped. A display consumer degrades to
 * showing less on a missing catalog; a coach with no exercise list invents
 * movements the user cannot do, and a wrong plan reads to her as a coaching decision
 * rather than as a bug.
 *
 * @param {object} catalog - a `buildCatalogViews` result, built with the
 *   profile's inventory (`catalog.inventory`). Required.
 * @param {object|null} [profile] - the profile document. Optional: a fresh
 *   database has none, and the persona then falls back to a neutral one.
 * @returns {{ equipment: object, structure: object, coaching: object }}
 */
export function buildPromptInputs(catalog, profile) {
  requireCatalog(catalog, "buildPromptInputs");
  const inventory = catalog.inventory;

  /**
   * The exercises that do NOT follow the general "dumbbells or bars, as you
   * like" rule. Derived from `implementTypes` itself so an exception can never
   * be stated in the prompt without being enforced by the validator, or the
   * reverse: naming them by hand here is how the prompt drifted from the code
   * before.
   */
  const dumbbellOnlyExercises = exercisesWithImplementSet(
    catalog,
    (types) => types.length === 1 && types[0] === "dumbbell"
  );
  const ankleWeightExercises = exercisesWithImplementSet(catalog, (types) =>
    types.includes("ankle_weight")
  );

  /**
   * The ceilings the coach is told about: every ceiling EXCEPT those of
   * exercises it must never prescribe. `Russian twist` has a ceiling (added with
   * the implement-union fix, so widening its implement set could not remove the
   * bound its dumbbell set gave it) and is also blacklisted — stating a maximum
   * load for an exercise the same prompt forbids is contradictory guidance, and
   * the "no blacklisted name outside the blacklist section" guard rightly
   * refuses it. Filtered through `findBlacklistEntry`, never a hand-written skip
   * list.
   */
  const ceilings = Object.fromEntries(
    Object.entries(catalog.ceilings).filter(([name]) => !findBlacklistEntry(name, catalog))
  );

  /** Achievable loads and per-exercise ceilings — the `equipment` argument. */
  const equipment = {
    ceilings,
    dumbbellLoads: inventory.dumbbellOptionsKg,
    dualBarPerHandLoads: inventory.achievable.dual_bar_symmetric,
    perHandUnion: inventory.perHandUnion,
    ankleWeightKg: inventory.ankleWeightKg,
    owned: inventory.owned,
    dumbbellOnlyExercises,
    ankleWeightExercises,
  };

  /**
   * Where each exercise can actually be done, and what stands in the way at
   * home. DERIVED from `deriveLocations` over the catalog's own descriptor
   * (never a hand-written list of names), so a change to the inventory — buying
   * a bench, buying an upper-body elastic — flows through to the model-facing
   * catalog on its own. This used to call `getExerciseLocations(name)`, which is
   * that same derivation over the build-time constants.
   */
  const exerciseAvailability = Object.fromEntries(
    catalog.allExercises.map((name) => {
      const entry = catalog.descriptions[name];
      return [
        name,
        {
          locations: deriveLocations(entry?.equipmentNeeds ?? [], entry?.implementTypes ?? [], inventory),
          // The unit its sets are counted in. Without it the prompt tells the
          // coach to write a bare number of SECONDS for a held exercise while
          // leaving it to infer WHICH entries those are from French prose —
          // a validator rule the model has no data to comply with. It would
          // then write `reps: "12"` for a plank meaning repetitions,
          // `normalizeReps` would parse it cleanly, and the app would record a
          // 12-second plank with no error and no warning anywhere.
          metric: entry?.metric === "seconds" ? "seconds" : "reps",
          homeBlockers: describeHomeBlockers(entry?.equipmentNeeds, inventory),
          // Whether the coach may propose it AT ALL, which is not the same
          // question as the blacklist's "what must she not do, and why".
          // A deactivated exercise carrying no reason is absent from the
          // blacklist by design (§2bis.1) and used to reach the model-facing
          // catalog unchanged — so the lexique's « Désactiver » button, which
          // collects no reason, changed nothing the coach could see. Not a
          // production leak: every deactivated entry in the day-one catalog
          // carries a reason. `isOffered` reads this.
          active: entry?.active !== false,
          // The definition the user reads in the lexique, so the coach and she are
          // describing the same movement. The model-facing catalog used to be
          // bare names and the model filled the gap from general training data,
          // which is wrong wherever this app is deliberately non-standard.
          description: entry?.description ?? "",
          formCues: entry?.formCues ?? "",
          // NO `intent` here, deliberately, and the catalog document makes that
          // easier to get wrong than the constants did: `catalog.descriptions`
          // carries the field, where the pre-migration code only ever read two
          // fields off the constants. It is user-facing — the lexique renders it,
          // the prompt does not (owner ruling 2026-08-11). Injecting it was
          // measured at +9 476 chars / +2 632 tokens on EVERY request, twice
          // what the 22 new exercises cost, on a rung where 5 of 9 production
          // requests already hit the 15 s header timeout. It shipped once, was
          // priced, and was taken back out.
          //
          // The pull-up bar is rigged at one physical height per session — it is
          // never re-rigged mid-workout. Only the exercises that need the bar
          // carry a value; everything else is `null` and drops out of the
          // grouping in `coachPrompt.js`.
          barHeight: entry?.barHeight ?? null,
        },
      ];
    })
  );

  /** Structure rules — the `structure` argument, sourced from the validators that enforce them. */
  const structure = {
    exerciseAvailability,
    usualExercisesPerForceSession: USUAL_EXERCISES_PER_FORCE_SESSION,
    coreGroup: CORE_MUSCLE_GROUP,
    lowerBodyGroup: LOWER_BODY_MUSCLE_GROUP,
    // The API enforces the shape now, so the shape belongs on the `structure`
    // side rather than the `coaching` one: it is a rule the request is rejected
    // over, not a judgement the coach weighs. The schema is CODE, not catalog.
    planFields: {
      progressionNote: schemaField(planExerciseProperties, "progressionNote"),
      notebook: schemaField(PLAN_JSON_SCHEMA.properties, "notebook"),
    },
    // Injected, never retyped: the cap the prompt announces and the cap
    // `applyNotebookOps` warns on have to be the same number.
    notebookMaxLines: NOTEBOOK_MAX_LINES,
  };

  return { equipment, structure, coaching: coachingFor(profile) };
}
