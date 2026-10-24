# Self-hosting Belle Forme

- [English](#english)
- [Français](#français)

---

## English

This guide sets up **your own** copy of Belle Forme: your own Netlify site, your own Neon database, your own AI keys. Nobody else hosts or sees your data, and nobody runs a shared instance you can sign up to. You pay your own providers directly.

Belle Forme is built for **one person per instance**: one passphrase, one profile, one training history. The interface, the exercise catalog and the coach all speak **French**.

### Contents

1. [What you are deploying](#1-what-you-are-deploying)
2. [Prerequisites](#2-prerequisites)
3. [Create the database (Neon)](#3-create-the-database-neon)
4. [Choose the passphrase and the sync key](#4-choose-the-passphrase-and-the-sync-key)
5. [Create the AI keys, with spend limits](#5-create-the-ai-keys-with-spend-limits)
6. [Deploy on Netlify](#6-deploy-on-netlify)
7. [Environment variables reference](#7-environment-variables-reference)
8. [First run: the profile](#8-first-run-the-profile)
9. [What the AI costs (estimate)](#9-what-the-ai-costs-estimate)
10. [Backups](#10-backups)
11. [Updating to a new release](#11-updating-to-a-new-release)
12. [Local development](#12-local-development)

### 1. What you are deploying

| Part | Where it runs | Code |
|---|---|---|
| The app (React single-page app, installable PWA) | Netlify, static files from `dist/` | `src/` |
| Sign-in and sync API (7 Node functions: `login`, `sync-sessions`, `sync-plan`, `sync-profile`, `sync-pull`, `sync-export`, `sync-catalog`) | Netlify Functions, reached at `/api/*` | `netlify/functions/` |
| The coach chat (1 streaming function) | Netlify **Edge** Functions, at `/api/coach-chat` | `netlify/edge-functions/coach-chat.js` |
| All data (sessions, plans, profile, settings, exercise catalog, coach transcript and notebook, usage metrics, failed-login log) | Neon Postgres | `netlify/functions/lib/schema.sql` |
| The coach's models | Anthropic API first, Mistral API as fallback | `netlify/functions/lib/providers.js` |

There are **no scheduled and no background functions**. Server code runs in two runtimes: Node (the regular functions) and Deno (the edge function). Every secret is read through `netlify/functions/lib/env.js`, which works in both.

The browser bundle contains **no secret**: no key and not even the passphrase hash. Every value in [section 7](#7-environment-variables-reference) is server-side only.

### 2. Prerequisites

1. **Node.js 24.** The repository does not pin a version in a `.nvmrc` or in `package.json` `engines`; its CI (`.github/workflows/ci.yml`) runs on Node 24, so that is the tested version. `scripts/seed-catalog.mjs` uses JSON import attributes, which need a recent Node.
2. **Git**, and a copy of this repository in a Git host that Netlify can deploy from (for example your own fork on GitHub).
3. **A Neon account** (Postgres). The database is small (JSONB documents, a few tables). Check Neon's current free-tier limits.
4. **A Netlify account.** New Netlify accounts are on a **credit-based plan**: each production deploy and function usage (regular and edge functions) consumes credits, and running out of credits **pauses the site** until the next cycle or until you add credits. Check Netlify's current pricing before you start. Every push to the deployed branch is a production deploy.
5. **An Anthropic API key**, created inside a dedicated workspace (see [section 5](#5-create-the-ai-keys-with-spend-limits)). Anthropic serves the coach's first two rungs: `claude-sonnet-5-5`, then `claude-opus-5-5`.
6. **A Mistral API key** (see [section 5](#5-create-the-ai-keys-with-spend-limits)). Mistral serves the coach's last two rungs, `mistral-large-4` then `mistral-medium-2604`, used only when both Claude rungs fail or time out.
7. Optional: **`psql` and `pg_dump`** (PostgreSQL client tools) for applying the schema from a terminal and for backups.

How the providers are used: the coach walks a fixed ladder of models, best first, and moves to the next rung when one fails. If `ANTHROPIC_API_KEY` is missing or wrong, both Claude rungs fail and the coach answers from Mistral. If `MISTRAL_API_KEY` is missing, the coach still works as long as Anthropic answers, but has no fallback. With neither key, the Coach tab opens but the chat returns an error. The rest of the app (sessions, plan, profile, catalog) does not use either provider.

Your data goes where the code sends it: profile, sessions, plan, catalog and the coach's notebook and transcript are sent to Anthropic (US company) on each coach message, and to Mistral (EU company) when the fallback answers. Read each provider's data-use terms for API traffic before you enter personal health data.

### 3. Create the database (Neon)

1. In the Neon console, create a project and a database.
2. Copy two connection strings from the Neon dashboard:
   - the one the app will use, for `NEON_DATABASE_URL`. The app connects with `@neondatabase/serverless` over HTTP, so either the pooled or the direct string works;
   - the **direct** (non-pooled) string, for `pg_dump` in [section 10](#10-backups).
3. Apply the schema. Either paste the whole content of `netlify/functions/lib/schema.sql` into the Neon SQL editor and run it, or from a terminal:

   ```bash
   psql "<your Neon connection string>" -f netlify/functions/lib/schema.sql
   ```

   It creates the tables `sessions`, `plans`, `profile`, `settings`, `coach_messages`, `coach_usage`, `coach_notebook`, `catalog` and `login_attempts`, plus the `catalog_set_updated_at` trigger. **Do not skip the trigger**: it stamps `catalog.updated_at` on every write, and that timestamp is the cache key the coach uses to rebuild its prompt. Without it the coach keeps describing the old catalog after you edit an exercise.

   The file is safe to run more than once (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS`).
4. Seed the exercise catalog, **once**:

   ```bash
   npm ci
   NEON_DATABASE_URL='<your Neon connection string>' node scripts/seed-catalog.mjs
   ```

   Expected output: `catalog seeded: 70 exercises`. It inserts `src/data/catalogSeed.json` only into an **empty** catalog table (`ON CONFLICT (id) DO NOTHING`). Run on a database that already has a catalog, it writes nothing and prints `catalog already present (N exercises): left untouched`. After this, the catalog lives in Neon and you edit it from the app (Exercices tab); the JSON file no longer describes it.

   The coach refuses to answer if the catalog row is missing or empty, so this step is required.

### 4. Choose the passphrase and the sync key

There are two independent secrets.

**The passphrase** is what you type at the app's sign-in screen. The server never stores it: you store its SHA-256 hash in `APP_PASSWORD_HASH`. On sign-in, `/api/login` hashes the submitted passphrase and compares it to that hash in constant time.

1. Choose a **long** passphrase: five or more random words, or 20+ random characters. The hash is a plain, unsalted SHA-256, which is fast to compute, so the length of the passphrase is what makes it hard to guess.
2. Compute its hash without leaving it in your shell history:

   ```bash
   read -rs PASS && printf '%s' "$PASS" | shasum -a 256 | cut -d' ' -f1; unset PASS
   ```

   (On Linux, `sha256sum` instead of `shasum -a 256`.) Type the passphrase, press Enter. The output is 64 lowercase hex characters: that is `APP_PASSWORD_HASH`. Use `printf '%s'`, not `echo`: a trailing newline changes the hash.

**The sync key** (`SYNC_API_KEY`) is a random string you invent; no provider issues it. After a correct passphrase, `/api/login` returns it to the browser, which keeps it in `localStorage` and sends it as a Bearer token to every `sync-*` function and to the coach. Generate it with:

```bash
openssl rand -hex 32
```

Rotating either secret is independent of the other. Changing `SYNC_API_KEY` sends every device back to the sign-in screen once; local data and unsent writes are kept and sent after the next sign-in.

**Login throttle** (`netlify/functions/lib/loginThrottle.js`): after **5** wrong passphrases from one client address within **15 minutes**, that address gets HTTP 429 (`Retry-After: 900`) until the window empties, even with the correct passphrase. The sign-in screen then shows its generic server message, « Le rideau est coincé (serveur). Réessaie. » The address is the one Netlify's edge reports; IPv6 addresses are grouped by /64. A correct passphrase clears the address's count. The throttle uses the `login_attempts` table; if that table is missing or the database errors, sign-in still works without the throttle (and logs it). The throttle slows guessing; it does not replace a long passphrase.

**If the passphrase leaks**, whoever has it can read and change all your data and send coach messages billed to your AI accounts. Change `APP_PASSWORD_HASH` **and** `SYNC_API_KEY`, then redeploy. The spend limits in the next section are the only cap on what a leaked passphrase can cost you.

### 5. Create the AI keys, with spend limits

**Anthropic**

1. In the Anthropic Console, create a **workspace** dedicated to this app.
2. Set a **monthly spend limit** on that workspace, at a level you accept losing (see [section 9](#9-what-the-ai-costs-estimate) for orders of magnitude).
3. Create the API key **from inside that workspace**. This matters for the code, not only for billing: per the comments in `.env.example`, an organization-level key gets a 400 on every request, both Claude rungs fail together, and the coach silently answers from Mistral instead.

**Mistral**

1. In Mistral's console, create an API key used only by this app, so you can revoke it alone.
2. Set a spending limit or budget on the account if Mistral's billing settings offer one. Check Mistral's current pricing and billing options.

These two limits are the **only protection** against runaway AI spend: the app has no per-day quota of its own, and anyone holding your passphrase can send coach messages.

### 6. Deploy on Netlify

1. In Netlify, add a new site from your Git repository. `netlify.toml` already sets the build: command `npm run build`, publish directory `dist`, functions in `netlify/functions`, edge functions in `netlify/edge-functions`, and the `/api/*` redirect.
2. Before the first deploy, or right after it, add the five environment variables of [section 7](#7-environment-variables-reference) in the site's settings (Site configuration → Environment variables).
3. **Scopes:** the variables are read by both function types: the Node functions (`login`, `sync-*`) and the edge function (`coach-chat`, which reads `NEON_DATABASE_URL`, `SYNC_API_KEY`, `ANTHROPIC_API_KEY` and `MISTRAL_API_KEY`). Keep Netlify's default "all scopes", or at least include the **Functions** scope, so both runtimes see them. None of them is needed by the build itself.
4. If Netlify's default Node version is not 24, set `NODE_VERSION=24` in the same environment variables.
5. Trigger a deploy (Deploys → Trigger deploy) after any change to environment variables: running functions do not pick up new values otherwise.
6. Optional: attach your own domain, for example `https://coach.example.com`, in the site's domain settings.
7. Open the site, type your passphrase, and continue with [section 8](#8-first-run-the-profile).

Check: a wrong passphrase shows « Raté, darling. Réessaie. »; « Le rideau est coincé (serveur). Réessaie. » on a correct one usually means `APP_PASSWORD_HASH` or `SYNC_API_KEY` is not set (the function answers 500 « Auth not configured »), or that this address hit the login throttle (429, see [section 4](#4-choose-the-passphrase-and-the-sync-key)).

### 7. Environment variables reference

All five are server-side only, listed in `.env.example`. Never add a `VITE_`-prefixed variable: Vite inlines those into the public bundle.

| Variable | What it is | Where it comes from | Read by |
|---|---|---|---|
| `APP_PASSWORD_HASH` | SHA-256 (64 lowercase hex characters) of your passphrase | You compute it ([section 4](#4-choose-the-passphrase-and-the-sync-key)) | `login` |
| `SYNC_API_KEY` | Random Bearer credential the browser receives after sign-in | You invent it: `openssl rand -hex 32` | `login`, every `sync-*` function, `coach-chat` |
| `NEON_DATABASE_URL` | Postgres connection string, `postgresql://user:password@host/dbname` | Neon dashboard ([section 3](#3-create-the-database-neon)) | every function, `coach-chat`, `scripts/seed-catalog.mjs` |
| `ANTHROPIC_API_KEY` | Anthropic API key for the coach's Claude rungs | Anthropic Console, created inside a workspace ([section 5](#5-create-the-ai-keys-with-spend-limits)) | `coach-chat` |
| `MISTRAL_API_KEY` | Mistral API key for the fallback rungs | Mistral console ([section 5](#5-create-the-ai-keys-with-spend-limits)) | `coach-chat` |

`SYNC_API_KEY` is your own credential, not a Neon key; nothing at Neon needs to change when you rotate it.

### 8. First run: the profile

The app starts with an empty profile (`DEFAULT_PROFILE`). As long as the profile has no first name, the app opens on the **Profil** tab, in its edit form, with a « Bienvenue » card. The form (`src/components/ProfileTab.jsx`) asks, in French:

1. **Prénom** (first name, required, up to 40 characters).
2. **Âge**, **Taille (cm)**, **Poids (kg)**, **Expérience**, **Fréquence**, **Objectifs**, **Priorités**: optional free fields the coach reads.
3. **« Le coach s'adresse à toi au »**: the grammatical gender the coach uses for you, *féminin (elle)* or *masculin (il)*. Required.
4. **Notes pour le coach**: free text, up to 4,000 characters (your preferences, constraints, what you no longer want to do). It goes into the coach's prompt.
5. **« Adapter les séances à mon cycle menstruel »**: off by default. When ticked, it asks for the cycle length in days (21 to 40, default 28). The coach then always **asks** where you are in your cycle; the app never stores the current cycle day and never deduces it from dates.
6. **Matériel** (equipment), from which the coach's loads and the app's accepted loads are derived:
   - adjustable dumbbells, per hand (kg), e.g. `2, 4, 6, 8`;
   - number of loadable bars, and the empty weight of one bar (kg);
   - plates as `weight x count`, e.g. `5x4, 2x4`;
   - ankle weight (kg);
   - « Ce que tu as chez toi », a checklist: bench, gym machine, pulley, kettlebell, rack, hip band, upper-body band anchored high, chair, ankle weights, dumbbells, loadable bars, pull-up bar.

   Until you save, the form is pre-filled with an example inventory (`STARTER_INVENTORY`: dumbbells 2–12 kg, two 2.5 kg bars, plates, an ankle weight, a pull-up bar, hip bands, a chair). It is an example to edit, not a default about you.
7. Press **Sauvegarder**. The profile syncs to Neon; the coach rebuilds its prompt from it.

Then: the **Coach** tab chats; its « Plan » button is the only action that produces a weekly programme, which you import with « Importer ce programme ». The **Exercices** tab edits the catalog. **Profil → Export SQL (urgence)** downloads a full SQL backup.

### 9. What the AI costs (estimate)

**This is an estimate, not a measurement.** Real cost depends on how often you write, how long the replies are and how long the history gets. After a few weeks, measure your own numbers (see the query below).

List prices used (Anthropic, per million tokens, as of October 2026; check Anthropic's pricing page):

| Model | Input | 1-hour cache write | Cache read | Output |
|---|---|---|---|---|
| `claude-sonnet-5-5` (rung 1, normally answers) | $2.00 | $4.00 | $0.20 | $10.00 |
| `claude-opus-5-5` (rung 2, only if rung 1 fails) | $4.00 | $8.00 | $0.20 | $20.00 |

Mistral prices are not included: Mistral answers only when both Claude rungs fail. Check Mistral's pricing page.

What the code sends on each coach message (from `coach-chat.js`, `coachPrompt.js`, `anthropic.js`):

- a system prompt of about 31,000 characters with the seeded catalog (measured by building it from `catalogSeed.json`), estimated at **8,000–10,000 tokens** for French text;
- up to 40 past messages (the last 12 verbatim, older coach replies cut to 600 characters), the coach's notebook, and an export of your sessions, plan and profile; assumed **~15,000 tokens** together once you have some history;
- prompt caching with a **1-hour** TTL on the system prompt and on the history, so within a session most input is billed at the cache-read rate;
- reasoning effort `medium`: thinking is billed as output. Chat replies are capped at 16,384 output tokens.

Assumptions per message: ~25,000 input tokens, of which ~20,000 read from cache and ~5,000 new; ~1,500 output tokens including thinking. The first message of each session (more than an hour after the last one) writes the cache instead of reading it. A « Plan » request is assumed to cost ~$0.15 (long structured output).

| Usage (all answered by Sonnet 5.5) | Estimated cost |
|---|---|
| 3 messages/day in one session, 1 plan/week | about **$5/month** |
| 10 messages/day in two sessions, 1 plan/week | about **$13–15/month** |
| Same 10/day with no cache hits at all (worst case) | about **$20/month** |

Per message: ~$0.03 when the cache is warm, ~$0.10 for the first message of a session. If Opus 5.5 answers instead (rung 1 down), double the figures for those messages.

To measure your real usage, run in the Neon SQL editor:

```sql
SELECT date_trunc('month', created_at) AS month, model, mode,
       count(*) AS requests,
       sum(prompt_tokens) AS input_tokens,
       sum(cached_tokens) AS cache_read_tokens,
       sum(completion_tokens) AS output_tokens
FROM coach_usage
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;
```

`prompt_tokens` includes cache reads and cache writes; `cached_tokens` counts cache reads only. The table holds counts and timings, never message content.

### 10. Backups

**Full database dump** (recommended, on a schedule you choose). Use the **direct** (non-pooled) Neon connection string:

```bash
pg_dump -Fc "<direct Neon connection string>" -f belle-forme-$(date +%F).dump
```

Restore into an empty database with `pg_restore`:

```bash
pg_restore --no-owner -d "<direct connection string of the target database>" belle-forme-YYYY-MM-DD.dump
```

Use a `pg_dump` whose major version is at least the Neon server's Postgres version.

**In-app export**: Profil → « Export SQL (urgence) » downloads `belle-forme-backup-<date>.sql`. It covers sessions, plans, profile, settings, catalog, the coach's notebook and transcript (not `coach_usage` or `login_attempts`). It starts with `TRUNCATE` of those tables and runs in one transaction: running it in the Neon SQL editor **replaces** the current content of those tables with the backup.

Backups contain personal health data. Store them like any other private document.

### 11. Updating to a new release

The public repository receives one commit per release; its message lists the changes since the previous release.

1. Pull the new release into your copy (for example, sync your fork).
2. **Before** deploying the new code, re-run the whole `netlify/functions/lib/schema.sql` against your database (Neon SQL editor or `psql -f`). There is no migration framework: schema changes are made by adding idempotent statements to this file (`CREATE … IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`). Re-running it on an up-to-date database changes nothing. Apply it first because new code can write to a column that only the new schema has; a missing column makes that write fail.
3. Read the release message for any one-off script in `scripts/` to run against an existing database. Such scripts so far (for example `scripts/migrate-catalog-metric.mjs`) state at their top whether they are needed and how to run them, with a dry run by default. A database seeded from the current `catalogSeed.json` does not need `migrate-catalog-metric.mjs`: the seed already contains what it adds.
4. **Do not** re-run `scripts/seed-catalog.mjs` to "update" the catalog: it only seeds an empty table, and your catalog is now your own data.
5. Push or deploy. After deploying, each open copy of the app offers to update (a toast from the service worker).

### 12. Local development

```bash
npm ci
npm run dev        # Vite dev server, http://localhost:5173
npm test           # Vitest, once
npm run lint       # ESLint
npm run build      # production build into dist/
npm run preview    # serve the production build
```

`npm run dev` serves **only the front end**. The repository has no script that runs the Netlify functions locally, and the sign-in screen calls `/api/login`, so under `npm run dev` alone you cannot get past the sign-in screen. To run the functions and the edge function locally, use the Netlify CLI (`netlify dev`, not a dependency of this repository) with the variables of [section 7](#7-environment-variables-reference) in a local `.env` (copy `.env.example`; `.env` is gitignored). Point `NEON_DATABASE_URL` at a separate development database or a Neon branch, not at your real data.

The tests need no network and no secrets: they run against a synthetic profile and an in-memory Postgres (PGlite).

---

## Français

Ce guide met en place **ta propre** copie de Belle Forme : ton site Netlify, ta base Neon, tes clés d'IA. Personne d'autre n'héberge ni ne voit tes données, et il n'existe aucune instance partagée à laquelle s'inscrire. Tu paies directement tes propres fournisseurs.

Belle Forme est conçue pour **une personne par instance** : une phrase de passe, un profil, un historique d'entraînement. L'interface, le catalogue d'exercices et le coach sont **en français**.

### Sommaire

1. [Ce que tu déploies](#1-ce-que-tu-déploies)
2. [Prérequis](#2-prérequis)
3. [Créer la base de données (Neon)](#3-créer-la-base-de-données-neon)
4. [Choisir la phrase de passe et la clé de sync](#4-choisir-la-phrase-de-passe-et-la-clé-de-sync)
5. [Créer les clés d'IA, avec des plafonds de dépense](#5-créer-les-clés-dia-avec-des-plafonds-de-dépense)
6. [Déployer sur Netlify](#6-déployer-sur-netlify)
7. [Référence des variables d'environnement](#7-référence-des-variables-denvironnement)
8. [Premier lancement : le profil](#8-premier-lancement--le-profil)
9. [Ce que coûte l'IA (estimation)](#9-ce-que-coûte-lia-estimation)
10. [Sauvegardes](#10-sauvegardes)
11. [Passer à une nouvelle version](#11-passer-à-une-nouvelle-version)
12. [Développement en local](#12-développement-en-local)

### 1. Ce que tu déploies

| Élément | Où il tourne | Code |
|---|---|---|
| L'app (application React monopage, PWA installable) | Netlify, fichiers statiques de `dist/` | `src/` |
| Connexion et API de sync (7 fonctions Node : `login`, `sync-sessions`, `sync-plan`, `sync-profile`, `sync-pull`, `sync-export`, `sync-catalog`) | Netlify Functions, sous `/api/*` | `netlify/functions/` |
| Le chat du coach (1 fonction en streaming) | Netlify **Edge** Functions, sous `/api/coach-chat` | `netlify/edge-functions/coach-chat.js` |
| Toutes les données (séances, programmes, profil, réglages, catalogue d'exercices, transcript et carnet du coach, métriques d'usage, journal des connexions ratées) | Neon Postgres | `netlify/functions/lib/schema.sql` |
| Les modèles du coach | API Anthropic d'abord, API Mistral en repli | `netlify/functions/lib/providers.js` |

Il n'y a **aucune fonction planifiée ni d'arrière-plan**. Le code serveur tourne dans deux environnements : Node (les fonctions classiques) et Deno (la fonction edge). Chaque secret est lu par `netlify/functions/lib/env.js`, qui marche dans les deux.

Le bundle envoyé au navigateur ne contient **aucun secret** : ni clé, ni même le hash de la phrase de passe. Toutes les valeurs de la [section 7](#7-référence-des-variables-denvironnement) restent côté serveur.

### 2. Prérequis

1. **Node.js 24.** Le dépôt ne fixe pas de version dans un `.nvmrc` ni dans `engines` de `package.json` ; sa CI (`.github/workflows/ci.yml`) tourne sous Node 24, c'est donc la version testée. `scripts/seed-catalog.mjs` utilise les attributs d'import JSON, qui demandent un Node récent.
2. **Git**, et une copie de ce dépôt chez un hébergeur Git depuis lequel Netlify peut déployer (par exemple ton propre fork sur GitHub).
3. **Un compte Neon** (Postgres). La base est petite (documents JSONB, quelques tables). Vérifie les limites actuelles de l'offre gratuite de Neon.
4. **Un compte Netlify.** Les nouveaux comptes Netlify sont sur une **offre à crédits** : chaque déploiement de production et l'usage des fonctions (classiques et edge) consomment des crédits, et quand il n'en reste plus, **le site est mis en pause** jusqu'au cycle suivant ou jusqu'à l'ajout de crédits. Vérifie la grille tarifaire actuelle de Netlify avant de commencer. Chaque push sur la branche déployée est un déploiement de production.
5. **Une clé API Anthropic**, créée dans un espace de travail dédié (voir la [section 5](#5-créer-les-clés-dia-avec-des-plafonds-de-dépense)). Anthropic sert les deux premiers échelons du coach : `claude-sonnet-5-5`, puis `claude-opus-5-5`.
6. **Une clé API Mistral** (voir la [section 5](#5-créer-les-clés-dia-avec-des-plafonds-de-dépense)). Mistral sert les deux derniers échelons, `mistral-large-4` puis `mistral-medium-2604`, utilisés seulement quand les deux échelons Claude échouent ou dépassent leur délai.
7. Facultatif : **`psql` et `pg_dump`** (outils clients PostgreSQL) pour appliquer le schéma depuis un terminal et pour les sauvegardes.

Comment les fournisseurs sont utilisés : le coach parcourt une échelle fixe de modèles, du meilleur au suivant, et passe à l'échelon suivant quand l'un échoue. Si `ANTHROPIC_API_KEY` manque ou est fausse, les deux échelons Claude échouent et le coach répond avec Mistral. Si `MISTRAL_API_KEY` manque, le coach marche tant qu'Anthropic répond, mais sans repli. Sans aucune des deux, l'onglet Coach s'ouvre mais le chat renvoie une erreur. Le reste de l'app (séances, programme, profil, catalogue) n'utilise aucun des deux.

Tes données vont là où le code les envoie : profil, séances, programme, catalogue, carnet et transcript du coach partent chez Anthropic (entreprise américaine) à chaque message au coach, et chez Mistral (entreprise européenne) quand le repli répond. Lis les conditions d'utilisation des données API de chaque fournisseur avant d'y mettre des données de santé.

### 3. Créer la base de données (Neon)

1. Dans la console Neon, crée un projet et une base.
2. Copie deux chaînes de connexion depuis le tableau de bord Neon :
   - celle que l'app utilisera, pour `NEON_DATABASE_URL`. L'app se connecte avec `@neondatabase/serverless` en HTTP, donc la chaîne poolée comme la directe conviennent ;
   - la chaîne **directe** (non poolée), pour `pg_dump` à la [section 10](#10-sauvegardes).
3. Applique le schéma. Soit tu colles tout le contenu de `netlify/functions/lib/schema.sql` dans l'éditeur SQL de Neon et tu l'exécutes, soit depuis un terminal :

   ```bash
   psql "<ta chaîne de connexion Neon>" -f netlify/functions/lib/schema.sql
   ```

   Il crée les tables `sessions`, `plans`, `profile`, `settings`, `coach_messages`, `coach_usage`, `coach_notebook`, `catalog` et `login_attempts`, ainsi que le trigger `catalog_set_updated_at`. **Ne saute pas le trigger** : il horodate `catalog.updated_at` à chaque écriture, et cet horodatage est la clé de cache avec laquelle le coach reconstruit son prompt. Sans lui, le coach continue de décrire l'ancien catalogue après la modification d'un exercice.

   Le fichier peut être exécuté plusieurs fois sans risque (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS`).
4. Peuple le catalogue d'exercices, **une seule fois** :

   ```bash
   npm ci
   NEON_DATABASE_URL='<ta chaîne de connexion Neon>' node scripts/seed-catalog.mjs
   ```

   Sortie attendue : `catalog seeded: 70 exercises`. Le script n'insère `src/data/catalogSeed.json` que dans une table catalogue **vide** (`ON CONFLICT (id) DO NOTHING`). Sur une base qui a déjà un catalogue, il n'écrit rien et affiche `catalog already present (N exercises): left untouched`. Ensuite, le catalogue vit dans Neon et se modifie depuis l'app (onglet Exercices) ; le fichier JSON ne le décrit plus.

   Le coach refuse de répondre si la ligne du catalogue manque ou est vide : cette étape est obligatoire.

### 4. Choisir la phrase de passe et la clé de sync

Il y a deux secrets indépendants.

**La phrase de passe** est ce que tu tapes sur l'écran de connexion de l'app. Le serveur ne la stocke jamais : tu stockes son hash SHA-256 dans `APP_PASSWORD_HASH`. À la connexion, `/api/login` calcule le hash de la phrase reçue et le compare à celui-ci en temps constant.

1. Choisis une phrase de passe **longue** : cinq mots aléatoires ou plus, ou plus de 20 caractères aléatoires. Le hash est un SHA-256 simple, sans sel, rapide à calculer : c'est la longueur de la phrase qui la rend difficile à deviner.
2. Calcule son hash sans la laisser dans l'historique du shell :

   ```bash
   read -rs PASS && printf '%s' "$PASS" | shasum -a 256 | cut -d' ' -f1; unset PASS
   ```

   (Sous Linux, `sha256sum` au lieu de `shasum -a 256`.) Tape la phrase, puis Entrée. La sortie fait 64 caractères hexadécimaux en minuscules : c'est `APP_PASSWORD_HASH`. Utilise `printf '%s'`, pas `echo` : un retour à la ligne final change le hash.

**La clé de sync** (`SYNC_API_KEY`) est une chaîne aléatoire que tu inventes ; aucun fournisseur ne la délivre. Après une phrase de passe correcte, `/api/login` la renvoie au navigateur, qui la garde dans le `localStorage` et l'envoie en jeton Bearer à chaque fonction `sync-*` et au coach. Pour la générer :

```bash
openssl rand -hex 32
```

Changer l'un des deux secrets ne touche pas à l'autre. Changer `SYNC_API_KEY` renvoie chaque appareil une fois à l'écran de connexion ; les données locales et les écritures en attente sont gardées et partent après la reconnexion.

**Limitation des tentatives** (`netlify/functions/lib/loginThrottle.js`) : après **5** phrases de passe fausses depuis une même adresse en **15 minutes**, cette adresse reçoit une erreur HTTP 429 (`Retry-After: 900`) jusqu'à ce que la fenêtre se vide, même avec la bonne phrase. L'écran de connexion affiche alors son message générique d'erreur serveur, « Le rideau est coincé (serveur). Réessaie. » L'adresse est celle que rapporte l'edge de Netlify ; les adresses IPv6 sont regroupées par /64. Une phrase correcte remet le compteur de l'adresse à zéro. La limitation utilise la table `login_attempts` ; si la table manque ou si la base renvoie une erreur, la connexion marche quand même, sans limitation (et le journal le signale). Elle ralentit les essais ; elle ne remplace pas une phrase longue.

**Si la phrase de passe fuit**, la personne qui l'a peut lire et modifier toutes tes données et envoyer des messages au coach facturés sur tes comptes d'IA. Change `APP_PASSWORD_HASH` **et** `SYNC_API_KEY`, puis redéploie. Les plafonds de dépense de la section suivante sont la seule limite à ce qu'une phrase fuitée peut te coûter.

### 5. Créer les clés d'IA, avec des plafonds de dépense

**Anthropic**

1. Dans la console Anthropic, crée un **espace de travail** (workspace) dédié à cette app.
2. Fixe une **limite de dépense mensuelle** sur cet espace de travail, à un niveau que tu acceptes de perdre (ordres de grandeur à la [section 9](#9-ce-que-coûte-lia-estimation)).
3. Crée la clé API **depuis cet espace de travail**. Ça compte pour le code, pas seulement pour la facturation : d'après les commentaires de `.env.example`, une clé créée au niveau de l'organisation reçoit une erreur 400 à chaque requête, les deux échelons Claude tombent ensemble, et le coach répond alors en silence avec Mistral.

**Mistral**

1. Dans la console Mistral, crée une clé API réservée à cette app, pour pouvoir la révoquer seule.
2. Fixe une limite ou un budget de dépense sur le compte si les réglages de facturation de Mistral le proposent. Vérifie la grille tarifaire et les options de facturation actuelles de Mistral.

Ces deux plafonds sont la **seule protection** contre une dépense d'IA qui s'emballe : l'app n'a pas de quota journalier à elle, et quiconque détient ta phrase de passe peut écrire au coach.

### 6. Déployer sur Netlify

1. Dans Netlify, ajoute un nouveau site depuis ton dépôt Git. `netlify.toml` règle déjà le build : commande `npm run build`, dossier publié `dist`, fonctions dans `netlify/functions`, fonctions edge dans `netlify/edge-functions`, et la redirection `/api/*`.
2. Avant le premier déploiement, ou juste après, ajoute les cinq variables d'environnement de la [section 7](#7-référence-des-variables-denvironnement) dans les réglages du site (Site configuration → Environment variables).
3. **Portées (scopes)** : les variables sont lues par les deux types de fonctions : les fonctions Node (`login`, `sync-*`) et la fonction edge (`coach-chat`, qui lit `NEON_DATABASE_URL`, `SYNC_API_KEY`, `ANTHROPIC_API_KEY` et `MISTRAL_API_KEY`). Garde la portée par défaut de Netlify (« all scopes »), ou au minimum inclus la portée **Functions**, pour que les deux environnements les voient. Le build lui-même n'en a besoin d'aucune.
4. Si la version de Node par défaut de Netlify n'est pas la 24, ajoute `NODE_VERSION=24` dans ces mêmes variables.
5. Relance un déploiement (Deploys → Trigger deploy) après toute modification des variables : sinon les fonctions en place ne voient pas les nouvelles valeurs.
6. Facultatif : rattache ton propre domaine, par exemple `https://coach.example.com`, dans les réglages de domaine du site.
7. Ouvre le site, tape ta phrase de passe, et passe à la [section 8](#8-premier-lancement--le-profil).

Vérification : une phrase fausse affiche « Raté, darling. Réessaie. » ; « Le rideau est coincé (serveur). Réessaie. » avec la bonne phrase signifie le plus souvent que `APP_PASSWORD_HASH` ou `SYNC_API_KEY` n'est pas définie (la fonction répond 500 « Auth not configured »), ou que cette adresse a atteint la limite de tentatives (429, voir la [section 4](#4-choisir-la-phrase-de-passe-et-la-clé-de-sync)).

### 7. Référence des variables d'environnement

Les cinq sont uniquement côté serveur et listées dans `.env.example`. N'ajoute jamais de variable préfixée `VITE_` : Vite les recopie dans le bundle public.

| Variable | Ce que c'est | D'où elle vient | Lue par |
|---|---|---|---|
| `APP_PASSWORD_HASH` | SHA-256 (64 caractères hexadécimaux en minuscules) de ta phrase de passe | Tu la calcules ([section 4](#4-choisir-la-phrase-de-passe-et-la-clé-de-sync)) | `login` |
| `SYNC_API_KEY` | Identifiant Bearer aléatoire que le navigateur reçoit après la connexion | Tu l'inventes : `openssl rand -hex 32` | `login`, chaque fonction `sync-*`, `coach-chat` |
| `NEON_DATABASE_URL` | Chaîne de connexion Postgres, `postgresql://user:password@host/dbname` | Tableau de bord Neon ([section 3](#3-créer-la-base-de-données-neon)) | chaque fonction, `coach-chat`, `scripts/seed-catalog.mjs` |
| `ANTHROPIC_API_KEY` | Clé API Anthropic pour les échelons Claude du coach | Console Anthropic, créée dans un espace de travail ([section 5](#5-créer-les-clés-dia-avec-des-plafonds-de-dépense)) | `coach-chat` |
| `MISTRAL_API_KEY` | Clé API Mistral pour les échelons de repli | Console Mistral ([section 5](#5-créer-les-clés-dia-avec-des-plafonds-de-dépense)) | `coach-chat` |

`SYNC_API_KEY` est ton propre identifiant, pas une clé Neon : rien ne change chez Neon quand tu la fais tourner.

### 8. Premier lancement : le profil

L'app démarre avec un profil vide (`DEFAULT_PROFILE`). Tant que le profil n'a pas de prénom, l'app s'ouvre sur l'onglet **Profil**, dans son formulaire, avec une carte « Bienvenue ». Le formulaire (`src/components/ProfileTab.jsx`) demande :

1. **Prénom** (obligatoire, 40 caractères au plus).
2. **Âge**, **Taille (cm)**, **Poids (kg)**, **Expérience**, **Fréquence**, **Objectifs**, **Priorités** : champs libres facultatifs, lus par le coach.
3. **« Le coach s'adresse à toi au »** : l'accord grammatical que le coach utilise pour toi, *féminin (elle)* ou *masculin (il)*. Obligatoire.
4. **Notes pour le coach** : texte libre, 4 000 caractères au plus (tes goûts, tes contraintes, ce que tu ne veux plus faire). Il entre dans le prompt du coach.
5. **« Adapter les séances à mon cycle menstruel »** : décoché par défaut. Coché, il demande la durée du cycle en jours (21 à 40, 28 par défaut). Le coach **demande** alors toujours où tu en es dans ton cycle ; l'app ne stocke jamais le jour du cycle et ne le déduit jamais des dates.
6. **Matériel**, dont sont dérivées les charges que propose le coach et celles que l'app accepte :
   - haltères réglables, par main (kg), par exemple `2, 4, 6, 8` ;
   - nombre de barres chargeables, et poids d'une barre à vide (kg) ;
   - disques au format `poids x quantité`, par exemple `5x4, 2x4` ;
   - lest de cheville (kg) ;
   - « Ce que tu as chez toi », une liste à cocher : banc, machine de salle, poulie, kettlebell, rack, élastique de hanches, élastique haut du corps accroché en hauteur, chaise, lests de cheville, haltères, barres chargeables, barre de traction.

   Tant que tu n'as pas enregistré, le formulaire est prérempli avec un inventaire d'exemple (`STARTER_INVENTORY` : haltères de 2 à 12 kg, deux barres de 2,5 kg, des disques, un lest de cheville, une barre de traction, des élastiques de hanches, une chaise). C'est un exemple à modifier, pas une hypothèse sur toi.
7. Appuie sur **Sauvegarder**. Le profil se synchronise vers Neon ; le coach reconstruit son prompt à partir de lui.

Ensuite : l'onglet **Coach** sert à discuter ; son bouton « Plan » est la seule action qui produit un programme de la semaine, que tu importes avec « Importer ce programme ». L'onglet **Exercices** modifie le catalogue. **Profil → Export SQL (urgence)** télécharge une sauvegarde SQL complète.

### 9. Ce que coûte l'IA (estimation)

**C'est une estimation, pas une mesure.** Le coût réel dépend de la fréquence de tes messages, de la longueur des réponses et de la taille de l'historique. Après quelques semaines, mesure tes propres chiffres (requête ci-dessous).

Prix catalogue utilisés (Anthropic, par million de tokens, en octobre 2026 ; vérifie la page de tarifs d'Anthropic) :

| Modèle | Entrée | Écriture cache 1 h | Lecture cache | Sortie |
|---|---|---|---|---|
| `claude-sonnet-5-5` (échelon 1, répond normalement) | 2,00 $ | 4,00 $ | 0,20 $ | 10,00 $ |
| `claude-opus-5-5` (échelon 2, seulement si l'échelon 1 échoue) | 4,00 $ | 8,00 $ | 0,20 $ | 20,00 $ |

Les prix de Mistral ne sont pas inclus : Mistral ne répond que quand les deux échelons Claude échouent. Vérifie la page de tarifs de Mistral.

Ce que le code envoie à chaque message au coach (d'après `coach-chat.js`, `coachPrompt.js`, `anthropic.js`) :

- un prompt système d'environ 31 000 caractères avec le catalogue de départ (mesuré en le construisant à partir de `catalogSeed.json`), estimé à **8 000 à 10 000 tokens** pour du texte français ;
- jusqu'à 40 messages passés (les 12 derniers en entier, les anciennes réponses du coach coupées à 600 caractères), le carnet du coach, et un export de tes séances, de ton programme et de ton profil ; supposés faire **environ 15 000 tokens** ensemble une fois qu'il y a un peu d'historique ;
- un cache de prompt d'une durée de **1 heure** sur le prompt système et sur l'historique : au sein d'une séance de discussion, l'essentiel de l'entrée est facturé au tarif de lecture du cache ;
- un effort de raisonnement `medium` : la réflexion est facturée comme de la sortie. Les réponses de chat sont plafonnées à 16 384 tokens de sortie.

Hypothèses par message : environ 25 000 tokens d'entrée, dont environ 20 000 lus dans le cache et 5 000 nouveaux ; environ 1 500 tokens de sortie, réflexion comprise. Le premier message de chaque séance de discussion (plus d'une heure après le précédent) écrit le cache au lieu de le lire. Une demande « Plan » est supposée coûter environ 0,15 $ (longue sortie structurée).

| Usage (toujours servi par Sonnet 5.5) | Coût estimé |
|---|---|
| 3 messages/jour en une séance, 1 programme/semaine | environ **5 $/mois** |
| 10 messages/jour en deux séances, 1 programme/semaine | environ **13 à 15 $/mois** |
| Les mêmes 10/jour sans aucun accès au cache (pire cas) | environ **20 $/mois** |

Par message : environ 0,03 $ quand le cache est chaud, environ 0,10 $ pour le premier message d'une séance. Si c'est Opus 5.5 qui répond (échelon 1 en panne), double les chiffres pour ces messages.

Pour mesurer ton usage réel, exécute dans l'éditeur SQL de Neon :

```sql
SELECT date_trunc('month', created_at) AS month, model, mode,
       count(*) AS requests,
       sum(prompt_tokens) AS input_tokens,
       sum(cached_tokens) AS cache_read_tokens,
       sum(completion_tokens) AS output_tokens
FROM coach_usage
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;
```

`prompt_tokens` inclut les lectures et les écritures de cache ; `cached_tokens` ne compte que les lectures. La table contient des compteurs et des durées, jamais le contenu des messages.

### 10. Sauvegardes

**Dump complet de la base** (recommandé, au rythme que tu choisis). Utilise la chaîne de connexion Neon **directe** (non poolée) :

```bash
pg_dump -Fc "<chaîne de connexion Neon directe>" -f belle-forme-$(date +%F).dump
```

Restauration dans une base vide avec `pg_restore` :

```bash
pg_restore --no-owner -d "<chaîne de connexion directe de la base cible>" belle-forme-AAAA-MM-JJ.dump
```

Utilise un `pg_dump` dont la version majeure est au moins celle du Postgres du serveur Neon.

**Export depuis l'app** : Profil → « Export SQL (urgence) » télécharge `belle-forme-backup-<date>.sql`. Il couvre séances, programmes, profil, réglages, catalogue, carnet et transcript du coach (pas `coach_usage` ni `login_attempts`). Il commence par un `TRUNCATE` de ces tables et s'exécute en une transaction : l'exécuter dans l'éditeur SQL de Neon **remplace** le contenu actuel de ces tables par la sauvegarde.

Les sauvegardes contiennent des données de santé personnelles. Range-les comme n'importe quel document privé.

### 11. Passer à une nouvelle version

Le dépôt public reçoit un commit par version ; son message liste les changements depuis la version précédente.

1. Récupère la nouvelle version dans ta copie (par exemple, synchronise ton fork).
2. **Avant** de déployer le nouveau code, réexécute tout `netlify/functions/lib/schema.sql` sur ta base (éditeur SQL de Neon ou `psql -f`). Il n'y a pas d'outil de migration : les changements de schéma sont faits en ajoutant à ce fichier des instructions idempotentes (`CREATE … IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`). Le réexécuter sur une base à jour ne change rien. Applique-le d'abord, parce que le nouveau code peut écrire dans une colonne que seul le nouveau schéma contient ; une colonne absente fait échouer cette écriture.
3. Lis le message de la version pour repérer un éventuel script ponctuel de `scripts/` à lancer sur une base existante. Les scripts de ce type existants (par exemple `scripts/migrate-catalog-metric.mjs`) indiquent en tête s'ils sont nécessaires et comment les lancer, avec un essai à blanc par défaut. Une base peuplée à partir du `catalogSeed.json` actuel n'a pas besoin de `migrate-catalog-metric.mjs` : le catalogue de départ contient déjà ce qu'il ajoute.
4. **Ne relance pas** `scripts/seed-catalog.mjs` pour « mettre à jour » le catalogue : il ne peuple qu'une table vide, et ton catalogue est désormais tes propres données.
5. Pousse ou déploie. Après le déploiement, chaque copie ouverte de l'app propose de se mettre à jour (un message du service worker).

### 12. Développement en local

```bash
npm ci
npm run dev        # serveur de dev Vite, http://localhost:5173
npm test           # Vitest, une fois
npm run lint       # ESLint
npm run build      # build de production dans dist/
npm run preview    # sert le build de production
```

`npm run dev` ne sert **que le front**. Le dépôt n'a aucun script qui lance les fonctions Netlify en local, et l'écran de connexion appelle `/api/login` : avec `npm run dev` seul, tu ne passes pas l'écran de connexion. Pour lancer les fonctions et la fonction edge en local, utilise la CLI Netlify (`netlify dev`, qui n'est pas une dépendance de ce dépôt) avec les variables de la [section 7](#7-référence-des-variables-denvironnement) dans un `.env` local (copie `.env.example` ; `.env` est ignoré par git). Fais pointer `NEON_DATABASE_URL` vers une base de développement séparée ou une branche Neon, pas vers tes vraies données.

Les tests n'ont besoin ni de réseau ni de secret : ils tournent sur un profil synthétique et un Postgres en mémoire (PGlite).
