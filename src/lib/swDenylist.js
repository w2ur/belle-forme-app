/**
 * Navigations the real app's service worker must NOT answer with its cached
 * index.html (`navigateFallbackDenylist`, vite.config.js).
 *
 * Workbox tests each pattern against the URL's pathname PLUS its search string,
 * so an end anchor alone misses `/demo?x=1`: the demo rule accepts `/`, `?` or
 * the end after `demo`, and nothing else (`/demonstration` is the real app's).
 */
export const SW_NAVIGATE_DENYLIST = [
  // Never cache /api/ — localStorage is the offline data layer, and a stale
  // cached pull was once taken for the authoritative cloud state.
  /^\/api\//,
  // /demo/ is a separate app on the same origin.
  /^\/demo(\/|\?|$)/,
];
