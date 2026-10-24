/**
 * An AbortSignal that aborts after `ms`, with a `TimeoutError` reason, and a
 * `clear` the caller runs once it no longer needs it.
 *
 * `AbortSignal.timeout` where it exists, else an AbortController and a timer.
 * Safari shipped `AbortSignal.timeout` in 16.0 but `navigator.locks` in 15.4:
 * on 15.4–15.x a bare call threw a TypeError, so every sync request failed
 * before it left, and `withDrainLock` threw before its own try — an unhandled
 * rejection, with no retry armed. The fallback's timer must be cleared (in the
 * caller's `finally`), or every request leaves one pending for the full wait.
 *
 * @returns {{signal: AbortSignal, clear: () => void}}
 */
export function timeoutSignal(ms) {
  if (typeof AbortSignal.timeout === "function") return { signal: AbortSignal.timeout(ms), clear: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}
