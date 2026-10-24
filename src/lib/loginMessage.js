/**
 * The sign-in screen's message for a failed /api/login reply. A throttled
 * address (429, see netlify/functions/lib/loginThrottle.js) is refused even
 * with the right passphrase, so it must not read as a server fault: the user
 * would retry, and each retry inside the window is refused again.
 * `retryAfter` is the raw Retry-After header (seconds), or null.
 */
export function loginErrorMessage(status, retryAfter = null) {
  if (status === 401) return "Raté, darling. Réessaie.";
  if (status === 429) {
    const seconds = Number(retryAfter);
    const minutes = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : null;
    return minutes
      ? `Trop d'essais, darling. Réessaie dans ${minutes} min.`
      : "Trop d'essais, darling. Réessaie dans quelques minutes.";
  }
  return "Le rideau est coincé (serveur). Réessaie.";
}
