/**
 * The guarded service-worker update check behind PWAUpdateToast.
 *
 * Offline, `registration.update()` rejects, and an unhandled rejection from a
 * timer or a visibility handler is noise at best. Offline the call is skipped
 * outright; online, a rejection is swallowed because the check is simply
 * retried on the next tick or focus. `online` is injected so this stays pure.
 */
export function checkForSwUpdate(registration, online) {
  if (!registration || !online) return Promise.resolve(false);
  return Promise.resolve()
    .then(() => registration.update())
    .then(() => true, () => false);
}
