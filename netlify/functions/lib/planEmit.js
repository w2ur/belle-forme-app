import { isPlanPayload } from "../../../src/lib/planFromJson.js";

/**
 * Separates a buffered `plan-emit` reply into what the user may receive and what must
 * only ever reach the notebook.
 *
 * WHY THE EMIT PATH IS BUFFERED AT ALL. The payload carries a `notebook` field —
 * « JAMAIS montré à l'utilisateur » in the schema's own words — and on that path the
 * streamed visible text IS the whole payload. So the private notes were going
 * out on the wire, into `coach_messages`, back down on every history GET, and
 * into `localStorage` under `fittrack_coach_transcript`. Nothing RENDERED them
 * (`CoachConversation` refuses to send a JSON-shaped turn to ReactMarkdown), but
 * content whose entire premise is that she does not read it was sitting on her
 * device one devtools panel away. Buffering costs nothing she can see: the
 * client displays a placeholder for the whole emit stream anyway, never the
 * payload as it arrives.
 *
 * THE SAFETY PROPERTY IS STRUCTURAL, not a matter of careful string handling:
 * what this returns is RE-SERIALISED from a parsed object with the field
 * deleted. Nothing that was not inside that object can travel — not the prose a
 * model may have written around it, not a stray sentinel, not the field under
 * any type. That is also what closes the disclosed "prose before JSON"
 * residual, where a payload wrapped in a sentence reached ReactMarkdown whole.
 *
 * ALL OR NOTHING. A buffer that does not parse into a plan yields
 * `{payload: null, notebook: null}` and the caller emits *nothing* — never the
 * raw fragment, which could carry the notebook field, and never a partial plan,
 * which can never be imported anyway. The caller then persists nothing and the
 * client returns her question to the composer, which beats leaving a
 * « Programme interrompu » bubble stranded in the transcript forever.
 */
export function splitPlanPayload(raw) {
  const nothing = { payload: null, notebook: null };
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return nothing;

  const obj = parseObject(text);
  if (!obj || !isPlanPayload(obj)) return nothing;

  // Deleted by destructuring rather than by `delete`, so the field cannot
  // survive on a prototype or be re-added by a later edit to this function.
  const { notebook, ...rest } = obj;
  return {
    payload: JSON.stringify(rest),
    // A blank field carries no operations, so there is nothing to apply. It is
    // no longer DANGEROUS to pass one through — `applyNotebookOps` treats an
    // empty block as "change nothing" — but returning null keeps the caller
    // from making a Neon round trip to write what it already has.
    notebook: typeof notebook === "string" && notebook.trim() ? notebook.trim() : null,
  };
}

/**
 * A strict parse, then ONE narrow retry on the substring between the outermost
 * braces — for the model that opened with a sentence before the object.
 *
 * This is not a tolerant parser and must not become one: the retry either
 * produces a JSON object or it produces nothing, and the caller emits nothing in
 * the second case. It cannot mis-read a payload into existence, because the
 * result still has to parse and still has to satisfy `isPlanPayload`.
 */
function parseObject(text) {
  const direct = tryParse(text);
  if (direct) return direct;
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open === -1 || close <= open) return null;
  return tryParse(text.slice(open, close + 1));
}

function tryParse(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
