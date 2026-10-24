import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', '.netlify']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      // __HERO_PHOTOS__ is baked in by vite.config.js (src/lib/heroPhotos.js).
      globals: { ...globals.browser, __HERO_PHOTOS__: 'readonly' },
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
      // Best-effort audio/vibration fallbacks intentionally swallow errors.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Experimental React Compiler rules (react-hooks v7 recommended set) flag
      // intentional, working patterns: prop-derived one-shot init in Timer and
      // IOSInstallHint, and the self-referential retry scheduler in
      // useSyncStatus (part of the shipped sync-security work). The classic
      // rules-of-hooks and exhaustive-deps checks stay enabled.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/immutability': 'off',
      // PasswordGate.jsx deliberately co-locates auth helpers (isAuthenticated,
      // SYNC_KEY_STORAGE) with the gate component; fast-refresh granularity is a
      // non-issue for this single-user app.
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // Netlify Functions and their tests run on Node, not in the browser.
    files: ['netlify/**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
])
