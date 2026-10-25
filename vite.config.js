import { defineConfig } from 'vite'
import { configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { SW_NAVIGATE_DENYLIST } from './src/lib/swDenylist.js'

// The decorative photos are optional (see src/lib/heroPhotos.js): a checkout
// without public/hero/ builds the same app, minus the pictures — and minus the
// PWA screenshot that is one of them.
const heroPhotos = existsSync(fileURLToPath(new URL('./public/hero', import.meta.url)))

// The static demo (`npm run build:demo`, also run by `npm run build`): the same
// app with invented data, served at /demo/ beside the real one — see
// src/demo/install.js. `import.meta.env.VITE_DEMO` is a build-time constant, so
// the real bundle carries no demo code and the demo bundle no API client.
export default defineConfig(({ mode }) => {
const demo = mode === 'demo' || process.env.VITE_DEMO === '1'
return {
  base: demo ? '/demo/' : '/',
  define: {
    __HERO_PHOTOS__: JSON.stringify(heroPhotos),
    'import.meta.env.VITE_DEMO': JSON.stringify(demo ? '1' : ''),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // No service worker for the demo: on the same origin it would compete
      // with the real app's, and a visitor has nothing to keep offline.
      disable: demo,
      registerType: 'prompt',
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,jpg,woff2}'],
        // The demo lives in dist/demo/ and is not part of the real app.
        globIgnores: ['demo/**'],
        navigateFallback: '/index.html',
        // Not answered with the cached index.html: /api/ (never cache a pull)
        // and /demo/ (a separate app on this origin). Reasons in swDenylist.js.
        navigateFallbackDenylist: SW_NAVIGATE_DENYLIST,
      },
      manifest: {
        id: '/belle-forme/',
        name: 'Belle Forme',
        short_name: 'BForme',
        description: 'Suivi de séances de musculation et fitness',
        lang: 'fr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        // 'any', not 'portrait': the iPad layout docks the coach beside the
        // séance in landscape. A portrait lock makes that unreachable once
        // the app is installed to the home screen.
        orientation: 'any',
        background_color: '#FAF6F0',
        theme_color: '#FAF6F0',
        categories: ['health', 'fitness'],
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        ...(heroPhotos
          ? {
              screenshots: [
                {
                  src: '/hero/dumbbells.jpg',
                  sizes: '1200x800',
                  type: 'image/jpeg',
                  label: 'Belle Forme — suivi de séances',
                },
              ],
            }
          : {}),
      },
    }),
  ],
  build: {
    ...(demo ? { outDir: 'dist/demo', emptyOutDir: true } : {}),
    rollupOptions: {
      output: {
        // React in its own chunk. The entry chunk sat at the edge of Vite's
        // 500 kB warning, which this repo does not tolerate, and every UI fix
        // pushed it back over — the fix used to be lazy-loading one more
        // component. React changes far less often than the app, so the split
        // also lets the PWA keep that chunk cached across deploys. Both chunks
        // are modulepreloaded in parallel and precached by the service worker.
        // By path, not by package name: the app imports `react-dom/client`,
        // which the `{ react: ['react', 'react-dom'] }` form does not match —
        // it split 11 kB of `react` and left react-dom in the entry.
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react'
        },
      },
    },
  },
  test: {
    // Feature work happens in git worktrees under `.worktrees/<branch>/`, which
    // are full checkouts sitting INSIDE the repo. Vitest's include glob does not
    // read `.gitignore`, so without this the root suite collects both copies of
    // every test file and runs each one twice — measured 2026-08-11: 1586 tests
    // instead of 793.
    //
    // The doubled count is the harmless half. The real cost is that a green run
    // from the root stops meaning "this tree passes" and starts meaning "both
    // trees pass", and a failure has twice as much output to hide in.
    //
    // Spread the defaults rather than replacing them: they carry node_modules,
    // dist and the build-output excludes this project still needs.
    exclude: [...configDefaults.exclude, '**/.worktrees/**'],
    // Several suites boot an in-process Postgres (PGlite). Under a full parallel
    // run the first one can take longer than vitest's 5 s default to start, and
    // the test reads as failed when it was only slow.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
}
})
