/**
 * The plan button's label, in one place because the coach's PROMPT names it too.
 *
 * It used to be a function returning « Mets le plan à jour » or « Propose-moi un
 * plan » depending on whether the stored week had already ended. Two labels for
 * one byte-identical request bought nothing and cost something real: the prompt
 * hardcoded « Mets le plan à jour », so on exactly the occasion she was most
 * likely to ask — an expired week — the coach sent her to a button that was not
 * on her screen.
 *
 * One fixed string removes that failure by construction. `coachPrompt.js` cannot
 * import from `src/` (it is the edge bundle), so it declares its own copy and a
 * parity test pins the two together.
 */
export const PLAN_BUTTON_LABEL = "Plan";
