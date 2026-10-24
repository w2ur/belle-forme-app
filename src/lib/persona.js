/**
 * Who the coach is talking to, as the prompt and the export need to say it.
 *
 * The app is for one person per deployment, and that person is described by
 * the profile document: a name, a grammatical gender (French agrees its
 * pronouns and participles with it) and free-form coaching notes. Nothing about
 * a particular user lives in code.
 *
 * Pure, no I/O, shared by the browser and the edge function.
 */

/** The two grammatical genders the French prompt can agree with. */
export const GENDERS = Object.freeze(["f", "m"]);

/** Trims and bounds a free-text profile field read from a stored document. */
function cleanText(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export const NAME_MAX_CHARS = 40;
export const COACH_NOTES_MAX_CHARS = 4000;

/**
 * The profile → the words the prompt substitutes.
 *
 * An absent or unknown `gender` agrees in the FEMININE: that is the grammar the
 * prompt was written in and the deployment this app grew out of, so a profile
 * saved before the field existed keeps the coach's voice unchanged rather than
 * flipping it. The first-run setup asks for the gender explicitly, so a new
 * install never reaches this default by accident.
 *
 * With no name the prompt says « l'utilisatrice » / « l'utilisateur » instead of
 * leaving a hole.
 *
 * @param {object|null|undefined} profile
 * @returns {{ name: string, gender: "f"|"m", she: string, She: string, her: string, self: string, la: string, e: string, coachNotes: string }}
 */
export function resolvePersona(profile) {
  const gender = profile?.gender === "m" ? "m" : "f";
  const given = cleanText(profile?.name, NAME_MAX_CHARS);
  const name = given || (gender === "m" ? "l'utilisateur" : "l'utilisatrice");
  return {
    name,
    gender,
    // The prompt's template tokens, one per agreement it needs: the subject
    // pronoun, the stressed pronoun (« avec elle » / « avec lui »), the
    // reflexive (« elle-même »), the object pronoun (« la suivre » / « le
    // suivre ») and the feminine ending of a participle.
    she: gender === "m" ? "il" : "elle",
    She: gender === "m" ? "Il" : "Elle",
    her: gender === "m" ? "lui" : "elle",
    self: gender === "m" ? "lui-même" : "elle-même",
    la: gender === "m" ? "le" : "la",
    e: gender === "m" ? "" : "e",
    coachNotes: cleanText(profile?.coachNotes, COACH_NOTES_MAX_CHARS),
  };
}

/**
 * True until the profile holds a name. The Profil tab opens in its edit form
 * with a welcome line while this is true; the gender is asked in the same form.
 */
export function needsProfileSetup(profile) {
  return cleanText(profile?.name, NAME_MAX_CHARS) === "";
}
