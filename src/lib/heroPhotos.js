/**
 * The decorative photos (login, session list, end of séance).
 *
 * They are optional: a deployment that has no `public/hero/` folder — the
 * public build ships none, the stills are licensed to one deployment — shows
 * the same screens without them. `vite.config.js` decides at build time whether
 * the folder exists and bakes the answer in as `__HERO_PHOTOS__`, so a build
 * without photos never requests a file it does not have (a request answered by
 * the SPA fallback would not even fail cleanly, it would hand back HTML).
 */

/** Where the photos live under `public/`. */
export const HERO_PHOTO_DIR = "/hero";

/**
 * The URL of the named photo, or null when this build has none.
 *
 * @param {string} name - file name without extension, e.g. "entrance".
 * @param {boolean} available - `__HERO_PHOTOS__`, passed in so the rule is testable.
 * @returns {string|null}
 */
export function heroPhotoSrc(name, available) {
  if (!available || typeof name !== "string" || !/^[a-z0-9-]+$/.test(name)) return null;
  return `${HERO_PHOTO_DIR}/${name}.jpg`;
}

/** True when this build was made with a `public/hero/` folder. */
export const HERO_PHOTOS_AVAILABLE = typeof __HERO_PHOTOS__ !== "undefined" && __HERO_PHOTOS__ === true;
