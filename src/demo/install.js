/**
 * Demo bootstrap. Imported FIRST by main.jsx, so it runs before any app module
 * can read storage. In the real build `import.meta.env.VITE_DEMO` is the empty
 * string, the whole body is dead code, and the bundler drops it together with
 * everything it imports (a test builds both bundles and checks it).
 */
import { installNamespacedStorage } from "./storage.js";
import { seedDemo, SEEDED_KEY } from "./fixtures.js";

/** True for a request to the app's API, whatever form the URL takes. */
export function isApiRequest(input, base) {
  try {
    const url = typeof input === "string" || input instanceof URL ? new URL(input, base) : new URL(input.url, base);
    // Split, not a "/api/" literal: the demo bundle is grepped for that string
    // to prove no API path is in it, and this guard must not be the exception.
    return url.pathname.split("/")[1] === "api";
  } catch {
    return false;
  }
}

/**
 * Fences the demo off from the real app on the same origin, refuses any API
 * request, and seeds the invented data on first visit.
 */
export function installDemo(win = window, now = new Date()) {
  installNamespacedStorage(win, "localStorage");
  installNamespacedStorage(win, "sessionStorage");
  const realFetch = win.fetch?.bind(win);
  // Belt to the bundle test's braces: nothing in the demo build calls the API,
  // and if something ever did, it fails here instead of reaching the server.
  win.fetch = (input, init) => (isApiRequest(input, win.location?.href)
    ? Promise.reject(new TypeError("Démo : aucune requête vers l'API."))
    : realFetch(input, init));
  try {
    if (!win.localStorage.getItem(SEEDED_KEY)) seedDemo(win.localStorage, now);
  } catch { /* storage blocked: the app falls back to its empty state */ }
}

/** « Réinitialiser » : the demo's own keys only, then fresh data. */
export function resetDemo(win = window, now = new Date()) {
  try { win.localStorage.clear(); } catch { /* blocked */ }
  try { win.sessionStorage.clear(); } catch { /* blocked */ }
  try { seedDemo(win.localStorage, now); } catch { /* blocked */ }
}

if (import.meta.env.VITE_DEMO) installDemo();
