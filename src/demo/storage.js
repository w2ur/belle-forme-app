/**
 * The demo's storage, fenced off from the real app's.
 *
 * The demo is served from the SAME origin as the owner's real app (/demo/ on
 * the production site), so it shares localStorage and sessionStorage with it:
 * read unprefixed, the demo would open on her real sessions and sync key, and
 * « Réinitialiser » would erase them. Every key the demo touches is therefore
 * prefixed, through one wrapper installed in place of `window.localStorage` and
 * `window.sessionStorage` before any app module runs (`install.js`). The app
 * code is unchanged and cannot reach a real key: there is no other path to
 * storage than these two globals.
 */
export const DEMO_PREFIX = "belle-forme-demo:";

/** A Storage-shaped view of `backing` that only ever sees `prefix`-ed keys. */
const NAMESPACED = Symbol("belle-forme-demo-storage");

export function namespacedStorage(backing, prefix = DEMO_PREFIX) {
  const own = () => {
    const keys = [];
    for (let i = 0; i < backing.length; i++) {
      const k = backing.key(i);
      if (k != null && k.startsWith(prefix)) keys.push(k);
    }
    return keys;
  };
  return {
    [NAMESPACED]: true,
    getItem: (key) => backing.getItem(prefix + String(key)),
    setItem: (key, value) => backing.setItem(prefix + String(key), String(value)),
    removeItem: (key) => backing.removeItem(prefix + String(key)),
    // Clears the demo's keys only — never the real app's.
    clear: () => { for (const k of own()) backing.removeItem(k); },
    key: (i) => own()[i]?.slice(prefix.length) ?? null,
    get length() { return own().length; },
  };
}

/**
 * Puts the namespaced view in place of `target[name]` (a Window's own,
 * configurable `localStorage` / `sessionStorage` accessor) and returns the real
 * Storage, or null when there is none to wrap (blocked storage).
 */
export function installNamespacedStorage(target, name, prefix = DEMO_PREFIX) {
  let real;
  try { real = target[name]; } catch { return null; }
  if (!real) return null;
  if (real[NAMESPACED]) return real; // already fenced (a second install on the same page)
  Object.defineProperty(target, name, { configurable: true, enumerable: true, value: namespacedStorage(real, prefix) });
  return real;
}
