/**
 * Write-time validation of the profile document.
 *
 * The profile is last-writer-wins JSON, key by key (the server merges a push
 * over the stored row), and it carries things the server acts on (the equipment the loads are checked against, whether the cycle
 * section is in the prompt, the notes spliced into it). A document the server
 * will refuse every time must be a 400, never a 500: the client outbox retries a
 * 5xx in order, so one such entry would block every write queued behind it.
 *
 * Unknown fields are allowed on purpose — a profile saved by an older build
 * carries fields this one no longer reads, and rejecting them would strand it.
 *
 * Pure, never throws; messages are French and read by the user.
 */
import { CYCLE_LENGTH_RANGE_DAYS } from "../constants/index.js";
import { validateInventory } from "../constants/equipment.js";
import { COACH_NOTES_MAX_CHARS, NAME_MAX_CHARS } from "./persona.js";

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * @param {unknown} profile
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateProfile(profile) {
  if (!isPlainObject(profile)) return { ok: false, errors: ["Le profil doit être un objet."] };
  const errors = [];

  if (profile.name != null && (typeof profile.name !== "string" || profile.name.length > NAME_MAX_CHARS)) {
    errors.push(`Le prénom doit tenir en ${NAME_MAX_CHARS} caractères.`);
  }
  if (profile.gender != null && !["", "f", "m"].includes(profile.gender)) {
    errors.push("L'accord grammatical doit être « f » ou « m ».");
  }
  if (profile.coachNotes != null
    && (typeof profile.coachNotes !== "string" || profile.coachNotes.length > COACH_NOTES_MAX_CHARS)) {
    errors.push(`Les notes pour le coach doivent tenir en ${COACH_NOTES_MAX_CHARS} caractères.`);
  }

  if (profile.cycle != null) {
    const cycle = profile.cycle;
    if (!isPlainObject(cycle) || typeof cycle.enabled !== "boolean") {
      errors.push("Le suivi du cycle doit indiquer s'il est activé.");
    } else if (cycle.enabled) {
      const { min, max } = CYCLE_LENGTH_RANGE_DAYS;
      if (!Number.isInteger(cycle.lengthDays) || cycle.lengthDays < min || cycle.lengthDays > max) {
        errors.push(`La durée du cycle doit être un nombre entier de jours entre ${min} et ${max}.`);
      }
    }
  }

  if (profile.inventory != null) {
    errors.push(...validateInventory(profile.inventory).errors);
  }

  return { ok: errors.length === 0, errors };
}
