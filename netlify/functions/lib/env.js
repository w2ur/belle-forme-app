/**
 * Reads an environment variable in BOTH runtimes this app deploys to.
 *
 * The sync endpoints are Node functions, where secrets live on `process.env`.
 * The coach is a Netlify EDGE function (Deno), where `process` does not exist —
 * reading `process.env.MISTRAL_API_KEY` there does not return undefined, it
 * throws a ReferenceError on the first request. The failure is also the least
 * legible one possible: every rung of the model ladder answers 401, and the user
 * reads a single generic "coach indisponible".
 *
 * `Netlify.env` is checked first because it is present in both runtimes on
 * Netlify, and `process.env` is the fallback for tests and local tooling.
 */
export function env(name) {
  const fromNetlify = globalThis.Netlify?.env?.get?.(name);
  if (fromNetlify !== undefined && fromNetlify !== null) return fromNetlify;
  return globalThis.process?.env?.[name];
}
