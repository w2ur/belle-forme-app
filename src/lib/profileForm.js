// The profile form edits a DRAFT copied from the profile prop; numbers are
// coerced back on save so age/height/weight never persist as strings.
import { DEFAULT_CYCLE_LENGTH_DAYS } from "../constants/index.js";
import { inventoryToDraft, inventoryFromDraft } from "./inventoryForm.js";
import { validateProfile } from "./profileDoc.js";

export const NUMERIC_FIELDS = ["age", "height", "weight"];

export function toDraft(profile) {
  return { ...profile };
}

export function fromDraft(draft) {
  const out = { ...draft };
  for (const key of NUMERIC_FIELDS) {
    if (!(key in out)) continue;
    const raw = out[key];
    if (raw === "" || raw === null || raw === undefined) {
      out[key] = null;
      continue;
    }
    const n = Number(raw);
    out[key] = Number.isFinite(n) ? n : null;
  }
  return out;
}

/**
 * The profile fields she has filled, each rendered by its own function, in the
 * order of `render` (its keys are the fields to show). A field counts as filled
 * when it is neither null, missing nor blank; string values are TRIMMED, for the
 * test and for what is printed. A cleared number is stored as null on purpose
 * (an emptied field must not become 0, and 0 itself is kept) and a text field
 * can be blank, so every reader skips an empty field rather than print it: the
 * coach export used to read « nullkg », « - , 34 ans » and « fréquence : ».
 */
export function filledProfileFields(profile, render) {
  return Object.keys(render).flatMap((key) => {
    const raw = profile?.[key];
    if (raw === null || raw === undefined) return [];
    const value = typeof raw === "string" ? raw.trim() : raw;
    return value === "" ? [] : [render[key](value)];
  });
}

// Keys that exist only in the edit draft and are folded back into the profile
// document on save.
const DRAFT_ONLY_KEYS = ["cycleEnabled", "cycleLengthDays", "inventoryDraft"];

/**
 * The full edit draft: the plain fields, the grammatical gender, the cycle
 * switch and the inventory as the strings the form shows.
 *
 * A profile that already has a name but no gender (saved before the field
 * existed) shows « f », which is what the coach already agrees in; a new
 * profile shows no gender at all, so the user has to choose one.
 */
export function toEditDraft(profile) {
  const named = typeof profile?.name === "string" && profile.name.trim() !== "";
  return {
    ...toDraft(profile),
    gender: profile?.gender || (named ? "f" : ""),
    coachNotes: profile?.coachNotes ?? "",
    cycleEnabled: profile?.cycle?.enabled === true,
    cycleLengthDays: String(profile?.cycle?.lengthDays ?? DEFAULT_CYCLE_LENGTH_DAYS),
    inventoryDraft: inventoryToDraft(profile?.inventory),
  };
}

/**
 * The edit draft → the profile document, with the problems found. `profile` is
 * null while there are any, so a half-valid save cannot reach storage.
 *
 * @returns {{ profile: object|null, errors: string[] }}
 */
export function fromEditDraft(draft) {
  const errors = [];
  const plain = { ...draft };
  for (const key of DRAFT_ONLY_KEYS) delete plain[key];
  const profile = fromDraft(plain);

  profile.name = typeof profile.name === "string" ? profile.name.trim() : "";
  if (profile.name === "") errors.push("Le prénom est obligatoire.");
  if (profile.gender !== "f" && profile.gender !== "m") errors.push("Choisis l'accord grammatical du coach.");

  const length = Number(draft.cycleLengthDays);
  profile.cycle = { enabled: draft.cycleEnabled === true, lengthDays: Number.isFinite(length) ? length : DEFAULT_CYCLE_LENGTH_DAYS };

  const inventory = inventoryFromDraft(draft.inventoryDraft);
  errors.push(...inventory.errors);
  profile.inventory = inventory.inventory;

  if (errors.length === 0) errors.push(...validateProfile(profile).errors);
  return { profile: errors.length === 0 ? profile : null, errors };
}
