/**
 * The JSON Schema the coach's plan is generated against.
 *
 * This replaces the hand-written `=== FITTRACK PLAN ===` text format, and the
 * reason is measured rather than stylistic. On 2026-08-10 the user wrote « Respect
 * le format fittrack plan pour que l'import fonctionne » and the very next
 * reply broke it again — in a NEW way, swapping the `|` field separator for
 * ` : ` rather than merely adding Markdown. An instruction could not fix it and
 * a more tolerant parser would only have chased the previous dialect.
 *
 * Probed live 2026-08-10 against both ladder rungs, streaming: `json_schema`
 * with `strict: true` produced a fully valid plan on the first attempt on
 * `mistral-large-2512` (637 ms to headers) and `mistral-small-2603` (432 ms),
 * while `json_object` — no schema — failed on BOTH, carrying neither
 * `sessions` nor `weekStart`. That failure is the control: the check can fail,
 * which is what makes it passing mean something.
 *
 * STRICT MODE RULES: every object node needs `additionalProperties: false` and
 * must list every one of its properties in `required`. A schema that violates
 * either is rejected by the API, not silently relaxed — `planSchema.test.js`
 * walks the tree and asserts it.
 *
 * THE SCHEMA GUARANTEES SHAPE, NEVER DOMAIN VALIDITY. In the same probe, Small
 * titled sessions "(Lundi)" and "(Mercredi)" — the day-pinning the user explicitly
 * rejected on 2026-07-26. Ceilings, blacklist, home-doability, core-on-lower-
 * body and the exercise cap are all still enforced by `evaluatePlanImport`.
 */
export const PLAN_SCHEMA_NAME = "fittrack_plan";

/** A warmup or cooldown line: free text, deliberately not a catalog lookup. */
const movementItem = {
  type: "object",
  additionalProperties: false,
  required: ["name", "detail"],
  properties: {
    name: { type: "string", description: "Nom du mouvement" },
    detail: { type: "string", description: "Durée ou séries×reps, ex. « 2×10 » ou « 30s par côté »" },
  },
};

const exerciseItem = {
  type: "object",
  additionalProperties: false,
  // NOTE: no `sets` field. That is a DISPLAY string ("4×10") derived from
  // setsCount and reps by planFromJson. Letting the model author it too would
  // create two sources for one fact, free to disagree.
  required: ["name", "setsCount", "reps", "weight", "weightType", "restSeconds", "progressionNote"],
  properties: {
    name: { type: "string", description: "Nom exact tel qu'il figure dans le catalogue" },
    setsCount: { type: "integer", description: "Nombre de séries" },
    // A NUMBER, never a number carrying its unit. The catalog decides whether
    // this exercise counts repetitions or seconds (`metric`), exactly as it
    // decides whether a weight is per-hand or total — the unit is a field, and
    // a suffix here is one more piece of syntax the model can drop.
    // `validatePlanDomain` strips it if it appears anyway.
    reps: { type: "string", description: "Nombre de répétitions, ou nombre de SECONDES pour un exercice de maintien. Un nombre nu, jamais d'unité : ni « s », ni « sec », ni « reps »" },
    weight: { type: "number", description: "Charge en kg, 0 au poids du corps" },
    weightType: { type: "string", enum: ["total", "per_hand"] },
    restSeconds: { type: "integer", description: "Repos entre séries, en secondes" },
    progressionNote: {
      type: "string",
      description: "Note de progression (tempo, variante, raison d'une baisse de charge). Chaîne vide si rien à dire.",
    },
  },
};

// NOTE: `exercises` deliberately carries NO `minItems`. Probed live 2026-08-16
// against `mistral-large-2512` in strict mode, and the keyword is genuinely
// enforced — which is precisely why it must not be here. Asked for a rest day
// ("la liste d'exercices doit être VIDE") under `minItems: 1`, the model could
// not return an empty array and returned `[{"name": "", "reps": ""}]` instead.
// With the name enum below it could not even do that: it would have to insert a
// REAL exercise into a rest day, and no validator catches a plausible exercise
// in a session that should not exist. An empty array, by contrast, is caught by
// validatePlan with a message that names the remedy. A loud, correctly-worded
// rejection is worth more here than a silent wrong plan.
const sessionItem = {
  type: "object",
  additionalProperties: false,
  required: ["name", "warmup", "exercises", "cooldown"],
  properties: {
    name: {
      type: "string",
      description: "Nom de la séance. JAMAIS de jour de la semaine : l'utilisateur choisit ses jours.",
    },
    warmup: { type: "array", items: movementItem },
    exercises: { type: "array", items: exerciseItem },
    cooldown: { type: "array", items: movementItem },
  },
};

export const PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["weekStart", "weekEnd", "coachNotes", "sessions", "notebook"],
  properties: {
    weekStart: { type: "string", description: "Date ISO AAAA-MM-JJ du lundi de la semaine" },
    weekEnd: { type: "string", description: "Date ISO AAAA-MM-JJ du dimanche de la semaine" },
    coachNotes: { type: "string", description: "Observations de la semaine, visibles par l'utilisateur" },
    sessions: { type: "array", items: sessionItem },
    // The notebook is a FIELD, not a sentinel in the visible text. On the
    // streaming paths it still arrives between <<<NOTEBOOK>>> markers, but every
    // recent production reply wrote it as a visible `### Carnet mis à jour`
    // heading instead — so saveNotebook was never called, the coach had no
    // long-term memory at all, and the user read the notes written about her.
    // It carries OPERATIONS, not the document. A wholesale field is what let a
    // rung-2 reply replace weeks of standing decisions with three lines on
    // 2026-08-30 — see notebookDoc.js. The type stays `string` deliberately:
    // making it an array would be a shape change to a `strict` schema for
    // something no schema can validate anyway (the syntax inside an op), and
    // `splitPlanPayload` would need reworking for no gain. The DESCRIPTION is
    // the part that changes behaviour here, which is why it is probed live and
    // not reasoned about — the `metric` precedent.
    notebook: {
      type: "string",
      description:
        "Carnet privé, JAMAIS montré à l'utilisateur. Opérations seulement, une par ligne : "
        + "« + texte » pour ajouter, « - numéro » pour retirer la ligne numérotée. "
        + "Ne recopie pas les lignes conservées. Chaîne vide si rien ne change.",
    },
  },
};

/**
 * The plan schema with the exercise name pinned to the catalog's offered names.
 *
 * WHY AN ENUM AND NOT AN INSTRUCTION. On 2026-08-16 five consecutive plan
 * imports were rejected, and the largest single error class — 4 of 13 — was an
 * exercise name the catalog does not hold. THREE of those four were a real
 * catalog name with a qualifier appended: « Gainage latéral » became « Gainage
 * latéral jambe soulevée », « Gainage planche » became « Gainage planche pieds
 * au mur ». The schema already said « Nom exact tel qu'il figure dans le
 * catalogue » and the prompt already listed every name.
 *
 * That is the same behaviour that retired the `=== FITTRACK PLAN ===` header —
 * the model decorates a string it was told to reproduce exactly — and no
 * instruction fixed it there either. So the answer is the idiom this codebase
 * uses everywhere else: a model never shown a way to write the name cannot
 * decorate it. A variant, a regression or an assisted version goes in
 * `progressionNote`, which is free text and exists for that.
 *
 * PROBED LIVE 2026-08-16 against `mistral-large-2512`, strict mode, with the
 * exact production prompt shape (« un gainage latéral jambe soulevée et une
 * traction assistée »):
 *   - plain string, the CONTROL → « Gainage latéral jambe soulevée »,
 *     « Traction assistée » — the production bug reproduced on demand;
 *   - enum of 5 → « Gainage latéral » with "(avec jambe soulevée)" moved into
 *     the reps field, « Traction australienne » with "(assistée si
 *     nécessaire)". The qualifier moves OUT of the name, which is the whole
 *     design;
 *   - enum of 70, the real catalog's scale → same, no size problem.
 *
 * The differential IS the evidence: one prompt, two schemas, two behaviours.
 * An empty enum is NOT rejected by the API (200), but the model then answers
 * with zero exercises rather than inventing names — an impossible constraint
 * forcing the only satisfiable output, which is constrained decoding showing
 * its hand more clearly than a 4xx would have.
 *
 * That last result is also why the fallback below is load-bearing rather than
 * defensive tidiness: `enum: []` would silently produce a plan of empty
 * sessions instead of a visible failure. `loadCatalog` already refuses an empty
 * document upstream, and this is the second belt on the one path that cannot
 * degrade — a partial plan can never be imported.
 *
 * The list must be exactly what the model-facing catalog renders. Use
 * `offeredExerciseNames` (coachPrompt.js), never a second computation: a name
 * shown to the model but missing from the enum is unpickable with nothing to
 * explain why, and the reverse makes a blacklisted movement emittable.
 */
export function buildPlanJsonSchema(exerciseNames) {
  if (!Array.isArray(exerciseNames) || exerciseNames.length === 0) return PLAN_JSON_SCHEMA;

  const sessions = PLAN_JSON_SCHEMA.properties.sessions;
  const session = sessions.items;
  const exercises = session.properties.exercises;
  const exercise = exercises.items;

  return {
    ...PLAN_JSON_SCHEMA,
    properties: {
      ...PLAN_JSON_SCHEMA.properties,
      sessions: {
        ...sessions,
        items: {
          ...session,
          properties: {
            ...session.properties,
            exercises: {
              ...exercises,
              items: {
                ...exercise,
                properties: {
                  ...exercise.properties,
                  name: {
                    type: "string",
                    // Copied, so a caller mutating its array afterwards cannot
                    // widen what the model may emit.
                    enum: [...exerciseNames],
                    description: "Nom de l'exercice, choisi dans la liste. Jamais composé.",
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}
