# Self-hosting Belle Forme (advanced)

- [English](#english)
- [Français](#français)

Never used a terminal or GitHub? Read [SELF-HOSTING-BEGINNER.md](SELF-HOSTING-BEGINNER.md) instead: it walks through the free GitHub + Netlify + Neon path one click at a time. / Jamais utilisé de terminal ni GitHub ? Lis plutôt [SELF-HOSTING-BEGINNER.md](SELF-HOSTING-BEGINNER.md) : il décrit le chemin gratuit GitHub + Netlify + Neon, clic par clic.

---

## English

This guide is for people who already run servers: it assumes a shell, Git, a Postgres you can reach, and a TLS reverse proxy you know how to configure. It is provider-neutral. The last section shows the Netlify + Neon setup the project was built on.

Belle Forme is built for **one person per instance**: one passphrase, one profile, one training history. The interface, the exercise catalog and the coach all speak **French**. Nobody runs a shared instance: you host your own copy and pay your own providers.

### Contents

1. [What runs](#1-what-runs)
2. [Requirements](#2-requirements)
3. [Environment variables](#3-environment-variables)
4. [Database: schema and catalog](#4-database-schema-and-catalog)
5. [Passphrase, sync key and login throttle](#5-passphrase-sync-key-and-login-throttle)
6. [AI keys, spend limits and what the coach costs](#6-ai-keys-spend-limits-and-what-the-coach-costs)
7. [Shape A: Docker compose behind a reverse proxy](#7-shape-a-docker-compose-behind-a-reverse-proxy)
8. [Shape B: Node under systemd](#8-shape-b-node-under-systemd)
9. [Reverse proxy configuration (Caddy, nginx)](#9-reverse-proxy-configuration-caddy-nginx)
10. [First run: the profile](#10-first-run-the-profile)
11. [Backups](#11-backups)
12. [Updates](#12-updates)
13. [Example: Netlify + Neon](#13-example-netlify--neon)
14. [Local development](#14-local-development)

### 1. What runs

| Part | What it is | Code |
|---|---|---|
| The app | A static React single-page app (installable PWA), built into `dist/`. A second static build, the demo, lands in `dist/demo/` and is served at `/demo/`. | `src/` |
| Sign-in and sync API | 7 Node functions (`login`, `sync-sessions`, `sync-plan`, `sync-profile`, `sync-pull`, `sync-export`, `sync-catalog`), each a Lambda-style `handler(event)`, reached at `/api/<name>` | `netlify/functions/` |
| The coach | 1 streaming function, a Web `(Request) => Response` at `/api/coach-chat`. A reply streams for tens of seconds; a « Plan » request can stay open for minutes (see the timeouts in `netlify/functions/lib/providers.js`) | `netlify/edge-functions/coach-chat.js` |
| All data | Postgres: sessions, plans, profile, settings, exercise catalog, coach transcript and notebook, usage metrics, failed-login log | `netlify/functions/lib/schema.sql` |
| The coach's models | Anthropic API first, Mistral API as fallback (the ladder is `MODEL_LADDER`) | `netlify/functions/lib/providers.js` |

Off Netlify, **`server.mjs` runs all of it in one Node process**, with no dependency beyond what the functions already import. It reproduces `netlify.toml`: the static files with the SPA fallback (and the demo's own fallback under `/demo/`), the three security headers, the `/api/*` mapping, and the coach's stream piped chunk by chunk, never buffered. It is the only supported way to serve the functions off Netlify, because it is what stamps the client address the login throttle trusts ([section 5](#5-passphrase-sync-key-and-login-throttle)).

There are no scheduled or background jobs. The database is reached through `@neondatabase/serverless`, Neon's **HTTP** driver: it speaks HTTP to Neon or to a Neon-compatible proxy, never the Postgres wire protocol directly.

The browser bundle contains **no secret**: no key, not even the passphrase hash. Every variable in [section 3](#3-environment-variables) is server-side only.

### 2. Requirements

- **Node.js 24.** The Dockerfile builds on `node:24-slim` and the CI (`.github/workflows/ci.yml`) runs on Node 24. The repository pins no version in `.nvmrc` or `engines`.
- **Postgres 11 or later**, in one of two forms:
  - **Neon** (any plan): nothing else to run;
  - **any other Postgres, behind a Neon-compatible HTTP proxy.** The functions cannot talk to a plain Postgres on their own. `compose.yaml` runs [local-neon-http-proxy](https://github.com/TimoWilhelm/local-neon-http-proxy) (pinned by digest) in front of `postgres:17`, and that pairing is the one tested end to end (`.github/workflows/docker-smoke.yml`). The proxy is distributed as a container image; this repository ships no way to run it without Docker. The schema itself is plain Postgres; its trigger uses `EXECUTE FUNCTION`, which needs 11+.
- **An HTTPS reverse proxy** (Caddy, nginx, or your platform's) in front of `server.mjs`. The server speaks plain HTTP and listens on `127.0.0.1` by default; the passphrase and the sync key travel in requests, so it must never face a network without TLS.
- **No response timeout around 30 seconds** anywhere on the path. The coach's reply is one long HTTP response: platforms and proxies that cut responses at 30 s (some serverless hosts, some load balancers) break it. The proxy must also **not buffer** the response, or the reply arrives all at once at the end. [Section 9](#9-reverse-proxy-configuration-caddy-nginx) gives working settings.
- Optional: `psql`, `pg_dump`, `pg_restore` (PostgreSQL client tools), for the schema and for backups when you are not using compose.

### 3. Environment variables

All are server-side. `.env.example` lists every one with comments. **Never add a `VITE_`-prefixed variable**: Vite copies those into the public bundle.

| Variable | Required | What it is | Read by |
|---|---|---|---|
| `APP_PASSWORD_HASH` | yes | SHA-256 of your passphrase, 64 lowercase hex characters ([section 5](#5-passphrase-sync-key-and-login-throttle)) | `login` |
| `SYNC_API_KEY` | yes | A random string you invent; `/api/login` hands it to the browser after a correct passphrase, and it is the Bearer token for everything else | `login`, every `sync-*` function, `coach-chat` |
| `NEON_DATABASE_URL` | yes (set by compose under Docker) | Postgres connection string, `postgresql://user:password@host/dbname` | every function, `coach-chat`, `scripts/seed-catalog.mjs` |
| `NEON_HTTP_ENDPOINT` | only with a proxy (set by compose under Docker) | Full URL of the Neon-compatible proxy's SQL endpoint, path included, e.g. `http://neon-proxy:4444/sql`. Unset means "talk to Neon". Every Neon client in the code is built by `netlify/functions/lib/neonClient.js`, which reads it | functions, `coach-chat`, the write scripts |
| `ANTHROPIC_API_KEY` | for the coach | Anthropic key for the coach's first rungs, **created inside a workspace** ([section 6](#6-ai-keys-spend-limits-and-what-the-coach-costs)) | `coach-chat` |
| `MISTRAL_API_KEY` | for the coach's fallback | Mistral key for the last rungs | `coach-chat` |
| `HOST` | no, `server.mjs` only | Interface to listen on, as an **IP address**. Default `127.0.0.1`. A hostname is refused at startup (tcsh exports `HOST` as the machine name). The Docker image sets `0.0.0.0` inside the container | `server.mjs` |
| `PORT` | no | `server.mjs`: port to listen on, 1–65535, default 8888. Under compose: the **host** port the app is published on (default 8888); inside the container the app always listens on 8888 | `server.mjs`, `compose.yaml` |
| `TRUST_PROXY` | when behind a reverse proxy, `server.mjs` only | The reverse proxy's address(es), as IPs or CIDRs separated by commas. Rules below | `server.mjs` |
| `POSTGRES_PASSWORD` | yes under Docker | Password of the bundled Postgres. **Letters and digits only**: compose puts it into connection URLs unescaped | `compose.yaml` |

`server.mjs` checks `HOST`, `PORT` and `TRUST_PROXY` before it listens. A value it cannot read stops it with a one-line message and **exit code 2**, so a typo never leaves it listening somewhere unexpected.

**`TRUST_PROXY` rules.** The login throttle counts wrong passphrases per client address. `server.mjs` takes that address from the TCP connection. Behind a reverse proxy every connection comes from the proxy, so every visitor would share one bucket. Naming the proxy in `TRUST_PROXY` fixes that:

- When a request comes from an address listed in `TRUST_PROXY`, the client address becomes the **last (rightmost)** `X-Forwarded-For` entry, the one your proxy appended. Entries to its left were written by the client and are ignored. A last entry that is not an IP falls back to the connection's address.
- Requests from any other address keep their own connection address, whatever headers they send. Any client-sent `x-nf-*` header is dropped.
- Accepted: single IPs (`127.0.0.1`, `::1`) and CIDRs no broader than `/8` (IPv4) or `/7` (IPv6). An IPv6 entry may not cover the IPv4-mapped block `::ffff:0:0/96`: write an IPv4 proxy in IPv4 form.
- **Refused at startup:** the old value `1` ("trust any peer"), malformed entries, and too-broad prefixes.
- Which value: a proxy on the same machine as `node server.mjs` → `TRUST_PROXY=127.0.0.1`. A proxy on the host in front of the compose stack → `TRUST_PROXY=10.203.0.1`, the stack's network gateway, pinned in `compose.yaml`.

> **Passthrough-proxy warning.** The proxy must **append** the address it sees to `X-Forwarded-For`. A proxy that passes the client's own `X-Forwarded-For` through unchanged (nginx **without** `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` does exactly that) lets every client choose its own throttle bucket by sending the header. Caddy's `reverse_proxy` sets the header correctly by default.

### 4. Database: schema and catalog

**Schema.** `netlify/functions/lib/schema.sql` creates every table plus the `catalog_set_updated_at` trigger. It is idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS`): run it on a new database and again after every update. There is no migration framework; schema changes are idempotent statements added to this file.

- Under compose: nothing to do. The `db-init` service applies it on every `docker compose up`, before the app starts.
- Elsewhere: `psql "<connection string>" -v ON_ERROR_STOP=1 -f netlify/functions/lib/schema.sql`, or paste the file into Neon's SQL Editor and run it.

**Do not skip the trigger.** It stamps `catalog.updated_at` on every write, and that timestamp is the cache key the coach uses to rebuild its prompt. Without it, the coach keeps describing the old catalog after you edit an exercise.

**Catalog seed.** The coach refuses to answer while the catalog row is missing or empty, so a new database needs the starter catalog, `src/data/catalogSeed.json`, once.

- Under compose: nothing to do. The container runs `scripts/seed-catalog.mjs` before every start, and the script writes only into an **empty** catalog table.
- Elsewhere, from a checkout with dependencies installed (`npm ci`):

  ```bash
  node --env-file=/path/to/your.env scripts/seed-catalog.mjs
  ```

  It reads `NEON_DATABASE_URL` and, if set, `NEON_HTTP_ENDPOINT`. Expected output: `catalog seeded: <N> exercises`. On a database that already has a catalog it writes nothing and prints `catalog already present (<N> exercises): left untouched`.
- Without Node (e.g. from Neon's SQL Editor): paste this, putting the full content of `src/data/catalogSeed.json` between the two `$seed$` lines. It stores the same document as the script and, like the script, does nothing when a catalog exists:

  ```sql
  INSERT INTO catalog (id, data) VALUES (1, $seed$
  -- paste the whole content of src/data/catalogSeed.json here
  $seed$::jsonb) ON CONFLICT (id) DO NOTHING;
  ```

  Delete the `-- paste…` line when you paste; a comment inside the quotes would become part of the JSON and fail. Check with `SELECT jsonb_array_length(data->'exercises') FROM catalog;`.

After seeding, the catalog is your data: you edit it in the app (Exercices tab) and the JSON file no longer describes it. **Never re-seed to "update" it.**

### 5. Passphrase, sync key and login throttle

There are two independent secrets.

**The passphrase** is what you type on the sign-in screen. The server stores only its SHA-256, in `APP_PASSWORD_HASH`; `/api/login` hashes what you send (as UTF-8) and compares the two in constant time. The hash is plain and unsalted, which is fast to compute, so **length** is what protects you: five or more random words, or 20+ random characters.

Compute the hash without leaving the passphrase in your shell history:

```bash
read -rs PASS && printf '%s' "$PASS" | shasum -a 256 | cut -d' ' -f1; unset PASS
```

On Linux, `sha256sum` instead of `shasum -a 256`. Type the passphrase, press Enter; the output is 64 lowercase hex characters. Use `printf '%s'`, never `echo`: a trailing newline changes the hash. On Windows (PowerShell):

```powershell
$s = Read-Host -AsSecureString "Passphrase"; $p = [System.Net.NetworkCredential]::new('', $s).Password; -join ([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($p)) | ForEach-Object { $_.ToString('x2') }); Remove-Variable s, p
```

**The sync key** (`SYNC_API_KEY`) is a random string you invent; no provider issues it, and it is not a Neon credential. Generate it with `openssl rand -hex 32`. After a correct passphrase, `/api/login` returns it; the browser keeps it in `localStorage` and sends it as a Bearer token to every `sync-*` function and to the coach.

Rotating one secret does not touch the other. A new `SYNC_API_KEY` sends every device back to the sign-in screen once; local data and unsent writes are kept and sent after the next sign-in.

**If the passphrase leaks**, its holder can read and change all your data and send coach messages billed to your AI accounts. Change `APP_PASSWORD_HASH` **and** `SYNC_API_KEY`, then restart or redeploy.

**Login throttle** (`netlify/functions/lib/loginThrottle.js`). After `MAX_FAILED_ATTEMPTS` wrong passphrases from one client address within `WINDOW_MINUTES` (both constants at the top of that file), the address gets HTTP 429 with a `Retry-After` header until the window empties, even with the right passphrase. The sign-in screen then shows « Trop d'essais, darling. Réessaie dans N min. ». IPv6 addresses are grouped by /64. A correct passphrase clears the address's count. Attempts live in the `login_attempts` table; if that table is missing or the database errors, sign-in still works without the throttle and logs `login: throttle unavailable, continuing without it`. The client address is Netlify's on Netlify, and `server.mjs`'s elsewhere (see `TRUST_PROXY` in [section 3](#3-environment-variables)). The throttle slows guessing; it does not replace a long passphrase.

### 6. AI keys, spend limits and what the coach costs

The coach walks a fixed ladder of models, best first (`MODEL_LADDER` in `netlify/functions/lib/providers.js`): two Claude models on Anthropic, then two Mistral models. It moves down a rung when one fails or times out. Without `ANTHROPIC_API_KEY`, or with a wrong one, the Claude rungs fail and Mistral answers. Without `MISTRAL_API_KEY`, the coach works while Anthropic answers but has no fallback. With neither, the Coach tab opens but the chat returns an error. Nothing else in the app uses either provider.

**Your health data goes to these providers.** On each coach message, the profile, sessions, plan, catalog and the coach's notebook and transcript are sent to Anthropic (a US company), and to Mistral (an EU company) when the fallback answers. Read each provider's terms for API data before you enter personal health data.

**Anthropic.**

1. In the Anthropic Console, create a **workspace** dedicated to this app.
2. Set a **monthly spend limit** on that workspace, at a level you accept losing.
3. Create the API key **from inside that workspace**. This matters to the code, not only to billing: an organization-level key gets a 400 on every request, both Claude rungs fail together, and the coach silently answers from Mistral.

**Mistral.** Create a key used only by this app, so you can revoke it alone, and set a spending limit if Mistral's billing settings offer one.

These limits are the **only cap** on AI spend: the app has no daily quota of its own, and anyone holding your passphrase can send coach messages.

**What the coach costs (estimate).** This is an estimate, not a measurement: real cost depends on how often you write, how long the replies are and how long the history gets. After a few weeks, measure your own numbers with the query below.

List prices used (Anthropic, per million tokens, as of October 2026; check Anthropic's pricing page):

| Model | Input | 1-hour cache write | Cache read | Output |
|---|---|---|---|---|
| `claude-sonnet-5-5` (rung 1, normally answers) | $2.00 | $4.00 | $0.20 | $10.00 |
| `claude-opus-5-5` (rung 2, only if rung 1 fails) | $4.00 | $8.00 | $0.20 | $20.00 |

Mistral prices are not included: Mistral answers only when both Claude rungs fail. Check Mistral's pricing page.

What the code sends on each coach message (from `coach-chat.js`, `coachPrompt.js`, `anthropic.js`):

- a system prompt of about 31,000 characters with the seeded catalog (measured by building it from `catalogSeed.json`), estimated at **8,000–10,000 tokens** for French text;
- the recent conversation (a window of at least `HISTORY_WINDOW` messages, `coach-chat.js`), the most recent `RECENT_VERBATIM` in full and older coach replies cut to `OLDER_ASSISTANT_CHARS` characters (`coachPrompt.js`), plus the coach's notebook and an export of your sessions, plan and profile; assumed **~15,000 tokens** together once you have some history;
- prompt caching with a **1-hour** TTL on the system prompt and on the history, so within a session most input is billed at the cache-read rate;
- reasoning effort `medium` (set per rung in `MODEL_LADDER`): thinking is billed as output. Chat replies are capped at `DEFAULT_MAX_TOKENS` output tokens (`providers.js`).

Assumptions per message: ~25,000 input tokens, of which ~20,000 read from cache and ~5,000 new; ~1,500 output tokens including thinking. The first message of each session (more than an hour after the last one) writes the cache instead of reading it. A « Plan » request is assumed to cost ~$0.15 (long structured output).

| Usage (all answered by Sonnet 5.5) | Estimated cost |
|---|---|
| 3 messages/day in one session, 1 plan/week | about **$5/month** |
| 10 messages/day in two sessions, 1 plan/week | about **$13–15/month** |
| Same 10/day with no cache hits at all (worst case) | about **$20/month** |

Per message: ~$0.03 when the cache is warm, ~$0.10 for the first message of a session. If Opus 5.5 answers instead (rung 1 down), double the figures for those messages.

To measure your real usage:

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

### 7. Shape A: Docker compose behind a reverse proxy

`compose.yaml` runs four services: `postgres` (`postgres:17`, data in the `pgdata` volume), `db-init` (applies `schema.sql`, then exits), `neon-proxy` (the HTTP proxy, pinned by digest, health-checked with a real query) and `app` (this repository's `Dockerfile`: `node:24-slim`, seeds an empty catalog, then runs `server.mjs`). The app is published on the host's **127.0.0.1 only**.

1. Get the code and create `.env`:

   ```bash
   git clone <your copy of this repository> belle-forme && cd belle-forme
   cp .env.example .env
   ```

2. Edit `.env`:
   - set `APP_PASSWORD_HASH`, `SYNC_API_KEY` ([section 5](#5-passphrase-sync-key-and-login-throttle)) and `POSTGRES_PASSWORD` (letters and digits only; uncomment the line);
   - set `ANTHROPIC_API_KEY` and `MISTRAL_API_KEY`, or **delete those lines**: a placeholder left in place is sent to the provider as a key and fails;
   - delete `NEON_DATABASE_URL` and `NEON_HTTP_ENDPOINT`: compose sets both for the app (its values win anyway);
   - uncomment `TRUST_PROXY=10.203.0.1` once a reverse proxy on this host is in front of the app ([section 9](#9-reverse-proxy-configuration-caddy-nginx));
   - optional: `PORT` changes the host port (default 8888).

3. Start it:

   ```bash
   docker compose up -d --build
   docker compose ps
   ```

   Wait until `app` is `healthy` (its health check waits for `GET /api/login` to answer 405, which happens once the functions are loaded). `docker compose logs app` shows `catalog seeded: <N> exercises` on the first start (`catalog already present …` afterwards), then `belle-forme: listening on http://0.0.0.0:8888`.

4. Check from the host:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8888/api/login
   ```

   Expected: `405`. `curl -s -X POST http://127.0.0.1:8888/api/login -H 'Content-Type: application/json' -d '{"password":"wrong"}'` should print `{"error":"Unauthorized"}`; `{"error":"Auth not configured"}` means `APP_PASSWORD_HASH` or `SYNC_API_KEY` is missing.

5. Put the reverse proxy in front ([section 9](#9-reverse-proxy-configuration-caddy-nginx)), set `TRUST_PROXY=10.203.0.1`, and apply with `docker compose up -d`.

The network is pinned to `10.203.0.0/24` with gateway `10.203.0.1`, outside Docker's default pools, so that `TRUST_PROXY` can name one address. If that range collides with one of your networks, change the subnet, the gateway and `TRUST_PROXY` together.

### 8. Shape B: Node under systemd

One Node process, no container. The database is **Neon**, or your own Postgres behind the Neon HTTP proxy (which means running that proxy as a container, see [section 2](#2-requirements)).

1. Install Node 24 system-wide (your distribution's package or NodeSource), so that a system service can run it. `node --version` should print `v24.…`, and `command -v node` gives the path for `ExecStart` below.
2. Get the code and build it:

   ```bash
   sudo git clone <your copy of this repository> /opt/belle-forme
   cd /opt/belle-forme
   sudo npm ci
   sudo npm run build
   ```

   The build writes `dist/` (the app) and `dist/demo/` (the demo).
3. Create a system user and the environment file:

   ```bash
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin belleforme
   sudo install -m 600 -o root -g root /dev/null /etc/belle-forme.env
   sudoedit /etc/belle-forme.env
   ```

   Put one `NAME=value` per line: `APP_PASSWORD_HASH`, `SYNC_API_KEY`, `NEON_DATABASE_URL`, `NEON_HTTP_ENDPOINT` (only with the proxy), `ANTHROPIC_API_KEY`, `MISTRAL_API_KEY`, and `TRUST_PROXY=127.0.0.1` for a reverse proxy on the same machine. Leave `HOST` unset (127.0.0.1). systemd reads this file as root before it drops privileges, so mode 600 is enough.
4. Apply the schema and seed the catalog ([section 4](#4-database-schema-and-catalog)):

   ```bash
   sudo node --env-file=/etc/belle-forme.env scripts/seed-catalog.mjs
   ```

   (after `schema.sql`, applied with `psql` or Neon's SQL Editor).
5. Create `/etc/systemd/system/belle-forme.service`:

   ```ini
   [Unit]
   Description=Belle Forme
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   User=belleforme
   Group=belleforme
   WorkingDirectory=/opt/belle-forme
   EnvironmentFile=/etc/belle-forme.env
   ExecStart=/usr/bin/node server.mjs
   Restart=on-failure
   RestartSec=5
   # Exit code 2 is a configuration error (HOST, PORT, TRUST_PROXY): restarting will not fix it.
   RestartPreventExitStatus=2
   NoNewPrivileges=true
   ProtectSystem=strict
   ProtectHome=true
   PrivateTmp=true

   [Install]
   WantedBy=multi-user.target
   ```

   Replace `/usr/bin/node` with the output of `command -v node` if it differs. The server only reads files, so `ProtectSystem=strict` (read-only file system) fits.
6. Start it and check:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now belle-forme
   systemctl status belle-forme
   journalctl -u belle-forme -n 20
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8888/api/login
   ```

   The journal shows `belle-forme: listening on http://127.0.0.1:8888`; the curl prints `405`. A line starting `belle-forme: HOST must be…`, `PORT must be…` or `TRUST_PROXY must…` is a configuration error (exit code 2, not restarted).
7. Put the reverse proxy in front ([section 9](#9-reverse-proxy-configuration-caddy-nginx)).

### 9. Reverse proxy configuration (Caddy, nginx)

Both snippets proxy everything (app, API, coach) to the app on `127.0.0.1:8888`, which is right for both shapes: under compose the port is published there. `server.mjs` keeps idle connections open longer than either proxy's upstream keep-alive (`KEEP_ALIVE_TIMEOUT_MS` in `server.mjs`), so a reused connection is not closed under the proxy.

**Caddy** (gets and renews the certificate itself):

```caddy
coach.example.com {
	reverse_proxy 127.0.0.1:8888 {
		# Send the coach's reply as it is written, not when it ends.
		flush_interval -1
	}
}
```

Write `127.0.0.1`, not `localhost`: `localhost` may resolve to `::1`, and then the connection does not come from the address in `TRUST_PROXY`. Do not add `encode` (compression) in front of the coach: it buffers. Caddy sets `X-Forwarded-For` itself and applies no response timeout by default.

**nginx** (certificate from your usual tool, e.g. certbot):

```nginx
server {
    listen 443 ssl;
    server_name coach.example.com;
    ssl_certificate     /etc/letsencrypt/live/coach.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/coach.example.com/privkey.pem;

    # server.mjs accepts request bodies up to MAX_BODY_BYTES (server.mjs); nginx's default is 1m.
    client_max_body_size 6m;

    location / {
        proxy_pass http://127.0.0.1:8888;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        # REQUIRED: append the client's address. Without it the throttle trusts what the client sends.
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # The coach streams: no buffering, and room for long silences while a model thinks.
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

`proxy_read_timeout` is the longest silence nginx tolerates between two reads (default 60 s). A chat reply can stay silent while a model thinks and the ladder falls through (`RUNG_HEADER_TIMEOUT_MS`, `FIRST_TEXT_TIMEOUT_MS` in `providers.js`), so keep it well above the default. A « Plan » request sends a keep-alive byte every `EMIT_KEEPALIVE_MS` (`coach-chat.js`) and is not at risk.

**One proxy layer.** The throttle reads the rightmost `X-Forwarded-For` entry, the one your proxy wrote. If a CDN sits in front of your proxy, that entry is the CDN's edge address, so visitors behind one edge share a bucket. Configure your proxy to restore the real client address first (nginx `real_ip`, Caddy `trusted_proxies`).

**Check after setup:** open `https://coach.example.com`, sign in, and open the Coach tab: the reply must appear progressively, not all at once. Try a wrong passphrase: « Raté, darling. Réessaie. ».

### 10. First run: the profile

The app starts with an empty profile. As long as the profile has no first name, it opens on the **Profil** tab, in its edit form, with a « Bienvenue » card. The form (`src/components/ProfileTab.jsx`) asks, in French:

1. **Prénom** (first name, required).
2. **Âge**, **Taille (cm)**, **Poids (kg)**, **Expérience**, **Fréquence**, **Objectifs**, **Priorités**: optional free fields the coach reads.
3. **« Le coach s'adresse à toi au »**: the grammatical gender the coach uses for you, *féminin (elle)* or *masculin (il)*. Required.
4. **Notes pour le coach**: free text (your preferences, constraints, what you no longer want to do). It goes into the coach's prompt.
5. **« Adapter les séances à mon cycle menstruel »**: off by default. When ticked, it asks for the cycle length in days. The coach then always **asks** where you are in your cycle; the app never stores the current cycle day and never deduces it from dates.
6. **Matériel** (equipment), from which the coach's loads and the app's accepted loads are derived: adjustable dumbbells per hand, loadable bars and their empty weight, plates as `weight x count`, ankle weight, and a checklist of what you have at home. Until you save, the form is pre-filled with an example inventory (`STARTER_INVENTORY`): an example to edit, not a default about you.
7. Press **Sauvegarder**. The profile syncs to the database; the coach rebuilds its prompt from it.

Then: the **Coach** tab chats; its « Plan » button is the only action that produces a weekly programme, which you import with « Importer ce programme ». The **Exercices** tab edits the catalog. **Profil → Export SQL (urgence)** downloads a full SQL backup.

### 11. Backups

**Full database dump** (recommended, on a schedule you choose). Use a `pg_dump` whose major version is at least the server's.

- Neon or your own Postgres (with Neon, use the **direct**, non-pooled connection string):

  ```bash
  pg_dump -Fc "<direct connection string>" -f belle-forme-$(date +%F).dump
  pg_restore --no-owner -d "<connection string of an empty target database>" belle-forme-YYYY-MM-DD.dump
  ```

- Under compose (the tools come from the `postgres` container; `-T` keeps the binary stream intact):

  ```bash
  docker compose exec -T postgres pg_dump -U belleforme -d belleforme -Fc > belle-forme-$(date +%F).dump
  docker compose exec -T postgres pg_restore -U belleforme -d belleforme --clean --if-exists --no-owner < belle-forme-YYYY-MM-DD.dump
  ```

  `--clean --if-exists` drops and recreates what the dump contains: the restore **replaces** the current data.

**In-app export**: Profil → « Export SQL (urgence) » downloads `belle-forme-backup-<date>.sql`. It covers sessions, plans, profile, settings, catalog, the coach's notebook and transcript (not `coach_usage` or `login_attempts`). It starts with `TRUNCATE` of those tables and runs in one transaction: running it **replaces** the current content of those tables.

Backups contain personal health data. Store them like any other private document.

### 12. Updates

The public repository receives one commit per release; its message lists the changes and any one-off script to run.

**Always, in this order:** apply the new `schema.sql` **before** the new code runs (new code can write to a column only the new schema has), then deploy. Read the release message for a one-off script in `scripts/` (such scripts say at their top whether you need them, and dry-run by default). **Never** re-run `scripts/seed-catalog.mjs` to "update" the catalog.

- **Shape A (compose):**

  ```bash
  git pull
  docker compose up -d --build
  ```

  `db-init` applies the schema before the app starts, so the order is automatic.
  **Upgrading a stack created before the network was pinned** (`10.203.0.0/24` in `compose.yaml`): run `docker compose down` **once** before `up`. Docker does not move an existing network to a new subnet, and `TRUST_PROXY=10.203.0.1` would name the wrong address. `down` keeps the `pgdata` volume; **never add `-v`**, which deletes the database.

- **Shape B (systemd):**

  ```bash
  cd /opt/belle-forme
  sudo git pull
  psql "<connection string>" -v ON_ERROR_STOP=1 -f netlify/functions/lib/schema.sql
  sudo npm ci
  sudo npm run build
  sudo systemctl restart belle-forme
  ```

After an update, each open copy of the app offers to reload (a message from the service worker).

### 13. Example: Netlify + Neon

This is how the project itself runs. No server to maintain; the coach runs as a Netlify **Edge** Function (Deno), the rest as Netlify Functions (Node). `server.mjs`, `HOST`, `PORT` and `TRUST_PROXY` play no part: `netlify.toml` declares the build (`npm run build`, publish `dist`), the functions directories, the `/api/*` and `/demo/*` rewrites, the SPA fallback and the headers, and Netlify's edge stamps the client address.

1. **Neon:** create a project; copy its connection string (pooled or direct both work over HTTP); apply `schema.sql` and seed the catalog from the SQL Editor ([section 4](#4-database-schema-and-catalog)).
2. **Netlify:** create a project from your Git copy of this repository. In **Project configuration → Environment variables**, add `APP_PASSWORD_HASH`, `SYNC_API_KEY`, `NEON_DATABASE_URL`, `ANTHROPIC_API_KEY`, `MISTRAL_API_KEY`, and `NODE_VERSION=24`. Leave `NEON_HTTP_ENDPOINT` unset. Keep the default scopes (or at least include Functions): both function runtimes read them; the build needs none of them.
3. Redeploy after every variable change; running functions do not see new values otherwise.

Two things to know before you choose it:

- **Netlify's credit-based plans.** Accounts created since 4 September 2025 are on credit-based plans. On the Free plan, production deploys, function compute, requests and bandwidth all consume a monthly credit allowance with a hard limit, and when it runs out **every project on the account is paused** (visitors see « Site not available ») until the allowance resets. Every push to the deployed branch is a production deploy. Check Netlify's current pricing.
- **Neon's Free plan** has per-project storage and compute limits; at the compute limit the database is suspended until the next billing period, and over the storage limit writes are blocked. Check Neon's current pricing.

### 14. Local development

```bash
npm ci
npm run dev        # Vite dev server, http://localhost:5173 (front end only)
npm test           # Vitest, once
npm run lint       # ESLint
npm run build      # production build into dist/ and the demo into dist/demo/
npm start          # server.mjs on 127.0.0.1:8888 (what `node server.mjs` runs)
```

`npm run dev` serves **only the front end**, and the sign-in screen calls `/api/login`, so you cannot get past it under `npm run dev` alone. For the full app, run `npm run build`, then `node --env-file=.env server.mjs` with a local `.env` (copy `.env.example`; `.env` is gitignored). Point `NEON_DATABASE_URL` at a separate development database or a Neon branch, never at your real data. The Netlify CLI (`netlify dev`) also works for local development, never as a host.

The tests need no network and no secrets: they run against a synthetic profile and an in-memory Postgres (PGlite).

---

## Français

Ce guide s'adresse à qui fait déjà tourner des serveurs : il suppose un shell, Git, un Postgres joignable et un reverse proxy TLS que tu sais configurer. Il ne dépend d'aucun fournisseur. La dernière section montre l'installation Netlify + Neon sur laquelle le projet a été construit.

Belle Forme est conçue pour **une personne par instance** : une phrase de passe, un profil, un historique d'entraînement. L'interface, le catalogue d'exercices et le coach sont **en français**. Il n'existe aucune instance partagée : tu héberges ta propre copie et tu paies tes propres fournisseurs.

### Sommaire

1. [Ce qui tourne](#1-ce-qui-tourne)
2. [Prérequis](#2-prérequis)
3. [Variables d'environnement](#3-variables-denvironnement)
4. [Base de données, schéma et catalogue](#4-base-de-données-schéma-et-catalogue)
5. [Phrase de passe, clé de sync et limitation des tentatives](#5-phrase-de-passe-clé-de-sync-et-limitation-des-tentatives)
6. [Clés d'IA, plafonds de dépense et coût du coach](#6-clés-dia-plafonds-de-dépense-et-coût-du-coach)
7. [Forme A, Docker compose derrière un reverse proxy](#7-forme-a-docker-compose-derrière-un-reverse-proxy)
8. [Forme B, Node sous systemd](#8-forme-b-node-sous-systemd)
9. [Configuration du reverse proxy (Caddy, nginx)](#9-configuration-du-reverse-proxy-caddy-nginx)
10. [Premier lancement, le profil](#10-premier-lancement-le-profil)
11. [Sauvegardes](#11-sauvegardes)
12. [Mises à jour](#12-mises-à-jour)
13. [Exemple Netlify + Neon](#13-exemple-netlify--neon)
14. [Développement en local](#14-développement-en-local)

### 1. Ce qui tourne

| Élément | Ce que c'est | Code |
|---|---|---|
| L'app | Une application React monopage statique (PWA installable), construite dans `dist/`. Un second build statique, la démo, atterrit dans `dist/demo/` et est servi sous `/demo/`. | `src/` |
| Connexion et API de sync | 7 fonctions Node (`login`, `sync-sessions`, `sync-plan`, `sync-profile`, `sync-pull`, `sync-export`, `sync-catalog`), chacune un `handler(event)` façon Lambda, sous `/api/<nom>` | `netlify/functions/` |
| Le coach | 1 fonction en streaming, une `(Request) => Response` Web sous `/api/coach-chat`. Une réponse se déroule pendant des dizaines de secondes ; une demande « Plan » peut rester ouverte plusieurs minutes (voir les délais dans `netlify/functions/lib/providers.js`) | `netlify/edge-functions/coach-chat.js` |
| Toutes les données | Postgres : séances, programmes, profil, réglages, catalogue d'exercices, transcript et carnet du coach, métriques d'usage, journal des connexions ratées | `netlify/functions/lib/schema.sql` |
| Les modèles du coach | API Anthropic d'abord, API Mistral en repli (l'échelle est `MODEL_LADDER`) | `netlify/functions/lib/providers.js` |

Hors de Netlify, **`server.mjs` fait tout tourner dans un seul processus Node**, sans autre dépendance que celles des fonctions. Il reproduit `netlify.toml` : les fichiers statiques avec le repli SPA (et le repli propre à la démo sous `/demo/`), les trois en-têtes de sécurité, le routage `/api/*`, et le flux du coach transmis morceau par morceau, jamais mis en tampon. C'est la seule façon prise en charge de servir les fonctions hors de Netlify, parce que c'est lui qui écrit l'adresse client à laquelle se fie la limitation des tentatives ([section 5](#5-phrase-de-passe-clé-de-sync-et-limitation-des-tentatives)).

Il n'y a aucune tâche planifiée ni d'arrière-plan. La base est jointe par `@neondatabase/serverless`, le pilote **HTTP** de Neon : il parle HTTP à Neon ou à un proxy compatible Neon, jamais directement le protocole Postgres.

Le bundle envoyé au navigateur ne contient **aucun secret** : ni clé, ni même le hash de la phrase de passe. Toutes les variables de la [section 3](#3-variables-denvironnement) restent côté serveur.

### 2. Prérequis

- **Node.js 24.** Le Dockerfile construit sur `node:24-slim` et la CI (`.github/workflows/ci.yml`) tourne sous Node 24. Le dépôt ne fixe aucune version dans `.nvmrc` ni dans `engines`.
- **Postgres 11 ou plus récent**, sous l'une de deux formes :
  - **Neon** (n'importe quelle offre) : rien d'autre à faire tourner ;
  - **n'importe quel autre Postgres, derrière un proxy HTTP compatible Neon.** Les fonctions ne savent pas parler seules à un Postgres classique. `compose.yaml` fait tourner [local-neon-http-proxy](https://github.com/TimoWilhelm/local-neon-http-proxy) (épinglé par digest) devant `postgres:17`, et c'est ce couple qui est testé de bout en bout (`.github/workflows/docker-smoke.yml`). Le proxy est distribué en image de conteneur ; ce dépôt ne fournit aucun moyen de le lancer sans Docker. Le schéma lui-même est du Postgres standard ; son trigger utilise `EXECUTE FUNCTION`, qui demande la version 11 ou plus.
- **Un reverse proxy HTTPS** (Caddy, nginx, ou celui de ta plateforme) devant `server.mjs`. Le serveur parle HTTP en clair et écoute par défaut sur `127.0.0.1` ; la phrase de passe et la clé de sync passent dans les requêtes, il ne doit donc jamais faire face à un réseau sans TLS.
- **Aucun délai de réponse autour de 30 secondes** sur le chemin. La réponse du coach est une longue réponse HTTP : les plateformes et proxys qui coupent les réponses à 30 s (certains hébergeurs serverless, certains répartiteurs de charge) la cassent. Le proxy ne doit pas non plus **mettre la réponse en tampon**, sinon elle arrive d'un bloc à la fin. La [section 9](#9-configuration-du-reverse-proxy-caddy-nginx) donne des réglages qui marchent.
- Facultatif : `psql`, `pg_dump`, `pg_restore` (outils clients PostgreSQL), pour le schéma et les sauvegardes hors compose.

### 3. Variables d'environnement

Toutes sont côté serveur. `.env.example` les liste toutes, commentées. **N'ajoute jamais de variable préfixée `VITE_`** : Vite les recopie dans le bundle public.

| Variable | Obligatoire | Ce que c'est | Lue par |
|---|---|---|---|
| `APP_PASSWORD_HASH` | oui | SHA-256 de ta phrase de passe, 64 caractères hexadécimaux en minuscules ([section 5](#5-phrase-de-passe-clé-de-sync-et-limitation-des-tentatives)) | `login` |
| `SYNC_API_KEY` | oui | Une chaîne aléatoire que tu inventes ; `/api/login` la remet au navigateur après une phrase correcte, et c'est le jeton Bearer de tout le reste | `login`, chaque fonction `sync-*`, `coach-chat` |
| `NEON_DATABASE_URL` | oui (fixée par compose sous Docker) | Chaîne de connexion Postgres, `postgresql://user:password@host/dbname` | chaque fonction, `coach-chat`, `scripts/seed-catalog.mjs` |
| `NEON_HTTP_ENDPOINT` | seulement avec un proxy (fixée par compose sous Docker) | URL complète du point d'accès SQL du proxy compatible Neon, chemin compris, par exemple `http://neon-proxy:4444/sql`. Absente, le code parle à Neon. Chaque client Neon du code est construit par `netlify/functions/lib/neonClient.js`, qui la lit | fonctions, `coach-chat`, les scripts d'écriture |
| `ANTHROPIC_API_KEY` | pour le coach | Clé Anthropic des premiers échelons du coach, **créée dans un espace de travail** ([section 6](#6-clés-dia-plafonds-de-dépense-et-coût-du-coach)) | `coach-chat` |
| `MISTRAL_API_KEY` | pour le repli du coach | Clé Mistral des derniers échelons | `coach-chat` |
| `HOST` | non, `server.mjs` seulement | Interface d'écoute, sous forme d'**adresse IP**. Par défaut `127.0.0.1`. Un nom d'hôte est refusé au démarrage (tcsh exporte `HOST` avec le nom de la machine). L'image Docker fixe `0.0.0.0` à l'intérieur du conteneur | `server.mjs` |
| `PORT` | non | `server.mjs` : port d'écoute, de 1 à 65535, 8888 par défaut. Sous compose : le port **de l'hôte** sur lequel l'app est publiée (8888 par défaut) ; dans le conteneur, l'app écoute toujours sur 8888 | `server.mjs`, `compose.yaml` |
| `TRUST_PROXY` | derrière un reverse proxy, `server.mjs` seulement | La ou les adresses du reverse proxy, en IP ou CIDR séparées par des virgules. Règles ci-dessous | `server.mjs` |
| `POSTGRES_PASSWORD` | oui sous Docker | Mot de passe du Postgres fourni. **Lettres et chiffres uniquement** : compose le place tel quel dans des URL de connexion | `compose.yaml` |

`server.mjs` vérifie `HOST`, `PORT` et `TRUST_PROXY` avant d'écouter. Une valeur illisible l'arrête avec un message d'une ligne et le **code de sortie 2** : une faute de frappe ne le laisse jamais écouter là où tu ne l'attends pas.

**Règles de `TRUST_PROXY`.** La limitation des tentatives compte les phrases fausses par adresse client. `server.mjs` prend cette adresse sur la connexion TCP. Derrière un reverse proxy, toutes les connexions viennent du proxy : tous les visiteurs partageraient un seul compteur. Nommer le proxy dans `TRUST_PROXY` règle ça :

- Quand une requête vient d'une adresse listée dans `TRUST_PROXY`, l'adresse client devient la **dernière** entrée (la plus à droite) de `X-Forwarded-For`, celle que ton proxy a ajoutée. Les entrées à sa gauche ont été écrites par le client et sont ignorées. Une dernière entrée qui n'est pas une IP retombe sur l'adresse de la connexion.
- Les requêtes de toute autre adresse gardent l'adresse de leur connexion, quels que soient les en-têtes envoyés. Tout en-tête `x-nf-*` envoyé par un client est supprimé.
- Acceptés : des IP seules (`127.0.0.1`, `::1`) et des CIDR pas plus larges que `/8` (IPv4) ou `/7` (IPv6). Une entrée IPv6 ne peut pas couvrir le bloc IPv4 mappé `::ffff:0:0/96` : écris un proxy IPv4 sous forme IPv4.
- **Refusés au démarrage :** l'ancienne valeur `1` (« faire confiance à tout le monde »), les entrées mal formées et les préfixes trop larges.
- Quelle valeur : un proxy sur la même machine que `node server.mjs` → `TRUST_PROXY=127.0.0.1`. Un proxy sur l'hôte devant la pile compose → `TRUST_PROXY=10.203.0.1`, la passerelle du réseau de la pile, fixée dans `compose.yaml`.

> **Attention aux proxys qui transmettent l'en-tête tel quel.** Le proxy doit **ajouter** l'adresse qu'il voit à `X-Forwarded-For`. Un proxy qui transmet sans y toucher l'en-tête `X-Forwarded-For` envoyé par le client (nginx **sans** `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` fait exactement ça) laisse chaque client choisir son propre compteur en envoyant l'en-tête. Le `reverse_proxy` de Caddy règle l'en-tête correctement par défaut.

### 4. Base de données, schéma et catalogue

**Schéma.** `netlify/functions/lib/schema.sql` crée toutes les tables ainsi que le trigger `catalog_set_updated_at`. Il est idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS`) : exécute-le sur une base neuve, puis après chaque mise à jour. Il n'y a pas d'outil de migration ; les changements de schéma sont des instructions idempotentes ajoutées à ce fichier.

- Sous compose : rien à faire. Le service `db-init` l'applique à chaque `docker compose up`, avant le démarrage de l'app.
- Ailleurs : `psql "<chaîne de connexion>" -v ON_ERROR_STOP=1 -f netlify/functions/lib/schema.sql`, ou colle le fichier dans l'éditeur SQL de Neon et exécute-le.

**Ne saute pas le trigger.** Il horodate `catalog.updated_at` à chaque écriture, et cet horodatage est la clé de cache avec laquelle le coach reconstruit son prompt. Sans lui, le coach continue de décrire l'ancien catalogue après la modification d'un exercice.

**Catalogue de départ.** Le coach refuse de répondre tant que la ligne du catalogue manque ou est vide : une base neuve a donc besoin, une fois, du catalogue de départ `src/data/catalogSeed.json`.

- Sous compose : rien à faire. Le conteneur lance `scripts/seed-catalog.mjs` avant chaque démarrage, et le script n'écrit que dans une table catalogue **vide**.
- Ailleurs, depuis une copie du dépôt avec ses dépendances installées (`npm ci`) :

  ```bash
  node --env-file=/chemin/vers/ton.env scripts/seed-catalog.mjs
  ```

  Il lit `NEON_DATABASE_URL` et, si elle est définie, `NEON_HTTP_ENDPOINT`. Sortie attendue : `catalog seeded: <N> exercises`. Sur une base qui a déjà un catalogue, il n'écrit rien et affiche `catalog already present (<N> exercises): left untouched`.
- Sans Node (par exemple depuis l'éditeur SQL de Neon) : colle ceci, en mettant tout le contenu de `src/data/catalogSeed.json` entre les deux lignes `$seed$`. Le document enregistré est le même que celui du script et, comme le script, la requête ne fait rien quand un catalogue existe déjà :

  ```sql
  INSERT INTO catalog (id, data) VALUES (1, $seed$
  -- paste the whole content of src/data/catalogSeed.json here
  $seed$::jsonb) ON CONFLICT (id) DO NOTHING;
  ```

  Remplace la ligne `-- paste…` par le contenu collé : un commentaire laissé entre les délimiteurs ferait partie du JSON et ferait échouer la requête. Vérifie avec `SELECT jsonb_array_length(data->'exercises') FROM catalog;`.

Une fois peuplé, le catalogue est à toi : tu le modifies dans l'app (onglet Exercices) et le fichier JSON ne le décrit plus. **Ne le repeuple jamais pour le « mettre à jour ».**

### 5. Phrase de passe, clé de sync et limitation des tentatives

Il y a deux secrets indépendants.

**La phrase de passe** est ce que tu tapes sur l'écran de connexion. Le serveur ne stocke que son SHA-256, dans `APP_PASSWORD_HASH` ; `/api/login` calcule le hash de ce que tu envoies (en UTF-8) et compare les deux en temps constant. Le hash est simple, sans sel, donc rapide à calculer : c'est la **longueur** qui te protège. Cinq mots aléatoires ou plus, ou plus de 20 caractères aléatoires.

Calcule le hash sans laisser la phrase dans l'historique du shell :

```bash
read -rs PASS && printf '%s' "$PASS" | shasum -a 256 | cut -d' ' -f1; unset PASS
```

Sous Linux, `sha256sum` au lieu de `shasum -a 256`. Tape la phrase, puis Entrée ; la sortie fait 64 caractères hexadécimaux en minuscules. Utilise `printf '%s'`, jamais `echo` : un retour à la ligne final change le hash. Sous Windows (PowerShell) :

```powershell
$s = Read-Host -AsSecureString "Passphrase"; $p = [System.Net.NetworkCredential]::new('', $s).Password; -join ([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($p)) | ForEach-Object { $_.ToString('x2') }); Remove-Variable s, p
```

**La clé de sync** (`SYNC_API_KEY`) est une chaîne aléatoire que tu inventes ; aucun fournisseur ne la délivre, et ce n'est pas un identifiant Neon. Génère-la avec `openssl rand -hex 32`. Après une phrase correcte, `/api/login` la renvoie ; le navigateur la garde dans le `localStorage` et l'envoie en jeton Bearer à chaque fonction `sync-*` et au coach.

Changer l'un des deux secrets ne touche pas à l'autre. Une nouvelle `SYNC_API_KEY` renvoie chaque appareil une fois à l'écran de connexion ; les données locales et les écritures en attente sont gardées et partent après la reconnexion.

**Si la phrase de passe fuit**, la personne qui l'a peut lire et modifier toutes tes données et envoyer au coach des messages facturés sur tes comptes d'IA. Change `APP_PASSWORD_HASH` **et** `SYNC_API_KEY`, puis redémarre ou redéploie.

**Limitation des tentatives** (`netlify/functions/lib/loginThrottle.js`). Après `MAX_FAILED_ATTEMPTS` phrases fausses depuis une même adresse en `WINDOW_MINUTES` minutes (les deux constantes sont en tête de ce fichier), l'adresse reçoit une erreur HTTP 429 avec un en-tête `Retry-After` jusqu'à ce que la fenêtre se vide, même avec la bonne phrase. L'écran de connexion affiche alors « Trop d'essais, darling. Réessaie dans N min. ». Les adresses IPv6 sont regroupées par /64. Une phrase correcte remet le compteur de l'adresse à zéro. Les tentatives vivent dans la table `login_attempts` ; si la table manque ou si la base renvoie une erreur, la connexion marche quand même, sans limitation, et le journal affiche `login: throttle unavailable, continuing without it`. L'adresse client est celle de Netlify sur Netlify, et celle de `server.mjs` ailleurs (voir `TRUST_PROXY` à la [section 3](#3-variables-denvironnement)). La limitation ralentit les essais ; elle ne remplace pas une phrase longue.

### 6. Clés d'IA, plafonds de dépense et coût du coach

Le coach parcourt une échelle fixe de modèles, du meilleur au suivant (`MODEL_LADDER` dans `netlify/functions/lib/providers.js`) : deux modèles Claude chez Anthropic, puis deux modèles Mistral. Il descend d'un échelon quand l'un échoue ou dépasse son délai. Sans `ANTHROPIC_API_KEY`, ou avec une clé fausse, les échelons Claude échouent et Mistral répond. Sans `MISTRAL_API_KEY`, le coach marche tant qu'Anthropic répond, mais sans repli. Sans aucune des deux, l'onglet Coach s'ouvre mais le chat renvoie une erreur. Rien d'autre dans l'app n'utilise ces fournisseurs.

**Tes données de santé partent chez ces fournisseurs.** À chaque message au coach, le profil, les séances, le programme, le catalogue, le carnet et le transcript du coach sont envoyés à Anthropic (entreprise américaine), et à Mistral (entreprise européenne) quand le repli répond. Lis les conditions de chaque fournisseur sur les données API avant d'y mettre des données de santé.

**Anthropic.**

1. Dans la console Anthropic, crée un **espace de travail** (workspace) dédié à cette app.
2. Fixe une **limite de dépense mensuelle** sur cet espace de travail, à un niveau que tu acceptes de perdre.
3. Crée la clé API **depuis cet espace de travail**. Ça compte pour le code, pas seulement pour la facturation : une clé créée au niveau de l'organisation reçoit une erreur 400 à chaque requête, les deux échelons Claude tombent ensemble, et le coach répond alors en silence avec Mistral.

**Mistral.** Crée une clé réservée à cette app, pour pouvoir la révoquer seule, et fixe une limite de dépense si les réglages de facturation de Mistral le proposent.

Ces plafonds sont la **seule limite** à la dépense d'IA : l'app n'a pas de quota journalier à elle, et quiconque détient ta phrase de passe peut écrire au coach.

**Ce que coûte le coach (estimation).** C'est une estimation, pas une mesure : le coût réel dépend de la fréquence de tes messages, de la longueur des réponses et de la taille de l'historique. Après quelques semaines, mesure tes propres chiffres avec la requête ci-dessous.

Prix catalogue utilisés (Anthropic, par million de tokens, en octobre 2026 ; vérifie la page de tarifs d'Anthropic) :

| Modèle | Entrée | Écriture cache 1 h | Lecture cache | Sortie |
|---|---|---|---|---|
| `claude-sonnet-5-5` (échelon 1, répond normalement) | 2,00 $ | 4,00 $ | 0,20 $ | 10,00 $ |
| `claude-opus-5-5` (échelon 2, seulement si l'échelon 1 échoue) | 4,00 $ | 8,00 $ | 0,20 $ | 20,00 $ |

Les prix de Mistral ne sont pas inclus : Mistral ne répond que quand les deux échelons Claude échouent. Vérifie la page de tarifs de Mistral.

Ce que le code envoie à chaque message au coach (d'après `coach-chat.js`, `coachPrompt.js`, `anthropic.js`) :

- un prompt système d'environ 31 000 caractères avec le catalogue de départ (mesuré en le construisant à partir de `catalogSeed.json`), estimé à **8 000 à 10 000 tokens** pour du texte français ;
- la conversation récente (une fenêtre d'au moins `HISTORY_WINDOW` messages, `coach-chat.js`), les `RECENT_VERBATIM` plus récents en entier et les anciennes réponses du coach coupées à `OLDER_ASSISTANT_CHARS` caractères (`coachPrompt.js`), plus le carnet du coach et un export de tes séances, de ton programme et de ton profil ; supposés faire **environ 15 000 tokens** ensemble une fois qu'il y a un peu d'historique ;
- un cache de prompt d'une durée de **1 heure** sur le prompt système et sur l'historique : au sein d'une séance de discussion, l'essentiel de l'entrée est facturé au tarif de lecture du cache ;
- un effort de raisonnement `medium` (fixé par échelon dans `MODEL_LADDER`) : la réflexion est facturée comme de la sortie. Les réponses de chat sont plafonnées à `DEFAULT_MAX_TOKENS` tokens de sortie (`providers.js`).

Hypothèses par message : environ 25 000 tokens d'entrée, dont environ 20 000 lus dans le cache et 5 000 nouveaux ; environ 1 500 tokens de sortie, réflexion comprise. Le premier message de chaque séance de discussion (plus d'une heure après le précédent) écrit le cache au lieu de le lire. Une demande « Plan » est supposée coûter environ 0,15 $ (longue sortie structurée).

| Usage (toujours servi par Sonnet 5.5) | Coût estimé |
|---|---|
| 3 messages/jour en une séance, 1 programme/semaine | environ **5 $/mois** |
| 10 messages/jour en deux séances, 1 programme/semaine | environ **13 à 15 $/mois** |
| Les mêmes 10/jour sans aucun accès au cache (pire cas) | environ **20 $/mois** |

Par message : environ 0,03 $ quand le cache est chaud, environ 0,10 $ pour le premier message d'une séance. Si c'est Opus 5.5 qui répond (échelon 1 en panne), double les chiffres pour ces messages.

Pour mesurer ton usage réel :

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

`prompt_tokens` inclut les lectures et les écritures de cache ; `cached_tokens` ne compte que les lectures. La table contient des compteurs et des durées, jamais le contenu des messages.

### 7. Forme A, Docker compose derrière un reverse proxy

`compose.yaml` lance quatre services : `postgres` (`postgres:17`, données dans le volume `pgdata`), `db-init` (applique `schema.sql`, puis s'arrête), `neon-proxy` (le proxy HTTP, épinglé par digest, vérifié par une vraie requête) et `app` (le `Dockerfile` de ce dépôt : `node:24-slim`, peuple un catalogue vide, puis lance `server.mjs`). L'app est publiée sur le **127.0.0.1 de l'hôte uniquement**.

1. Récupère le code et crée `.env` :

   ```bash
   git clone <ta copie de ce dépôt> belle-forme && cd belle-forme
   cp .env.example .env
   ```

2. Modifie `.env` :
   - renseigne `APP_PASSWORD_HASH`, `SYNC_API_KEY` ([section 5](#5-phrase-de-passe-clé-de-sync-et-limitation-des-tentatives)) et `POSTGRES_PASSWORD` (lettres et chiffres uniquement ; décommente la ligne) ;
   - renseigne `ANTHROPIC_API_KEY` et `MISTRAL_API_KEY`, ou **supprime ces lignes** : une valeur d'exemple laissée en place est envoyée au fournisseur comme clé et échoue ;
   - supprime `NEON_DATABASE_URL` et `NEON_HTTP_ENDPOINT` : compose fixe les deux pour l'app (ses valeurs l'emportent de toute façon) ;
   - décommente `TRUST_PROXY=10.203.0.1` dès qu'un reverse proxy sur cet hôte est devant l'app ([section 9](#9-configuration-du-reverse-proxy-caddy-nginx)) ;
   - facultatif : `PORT` change le port de l'hôte (8888 par défaut).

3. Lance-la :

   ```bash
   docker compose up -d --build
   docker compose ps
   ```

   Attends que `app` soit `healthy` (sa vérification attend que `GET /api/login` réponde 405, ce qui arrive une fois les fonctions chargées). `docker compose logs app` affiche `catalog seeded: <N> exercises` au premier démarrage (`catalog already present …` ensuite), puis `belle-forme: listening on http://0.0.0.0:8888`.

4. Vérifie depuis l'hôte :

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8888/api/login
   ```

   Attendu : `405`. `curl -s -X POST http://127.0.0.1:8888/api/login -H 'Content-Type: application/json' -d '{"password":"wrong"}'` doit afficher `{"error":"Unauthorized"}` ; `{"error":"Auth not configured"}` signifie que `APP_PASSWORD_HASH` ou `SYNC_API_KEY` manque.

5. Mets le reverse proxy devant ([section 9](#9-configuration-du-reverse-proxy-caddy-nginx)), fixe `TRUST_PROXY=10.203.0.1`, et applique avec `docker compose up -d`.

Le réseau est fixé à `10.203.0.0/24` avec la passerelle `10.203.0.1`, hors des plages par défaut de Docker, pour que `TRUST_PROXY` puisse nommer une seule adresse. Si cette plage entre en collision avec l'un de tes réseaux, change ensemble le sous-réseau, la passerelle et `TRUST_PROXY`.

### 8. Forme B, Node sous systemd

Un seul processus Node, sans conteneur. La base est **Neon**, ou ton propre Postgres derrière le proxy HTTP Neon (ce qui veut dire faire tourner ce proxy en conteneur, voir la [section 2](#2-prérequis)).

1. Installe Node 24 pour tout le système (paquet de ta distribution ou NodeSource), pour qu'un service système puisse le lancer. `node --version` doit afficher `v24.…`, et `command -v node` donne le chemin pour `ExecStart` plus bas.
2. Récupère le code et construis-le :

   ```bash
   sudo git clone <ta copie de ce dépôt> /opt/belle-forme
   cd /opt/belle-forme
   sudo npm ci
   sudo npm run build
   ```

   Le build écrit `dist/` (l'app) et `dist/demo/` (la démo).
3. Crée un utilisateur système et le fichier d'environnement :

   ```bash
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin belleforme
   sudo install -m 600 -o root -g root /dev/null /etc/belle-forme.env
   sudoedit /etc/belle-forme.env
   ```

   Mets un `NOM=valeur` par ligne : `APP_PASSWORD_HASH`, `SYNC_API_KEY`, `NEON_DATABASE_URL`, `NEON_HTTP_ENDPOINT` (seulement avec le proxy), `ANTHROPIC_API_KEY`, `MISTRAL_API_KEY`, et `TRUST_PROXY=127.0.0.1` pour un reverse proxy sur la même machine. Laisse `HOST` non défini (127.0.0.1). systemd lit ce fichier en root avant d'abandonner ses privilèges : le mode 600 suffit.
4. Applique le schéma et peuple le catalogue ([section 4](#4-base-de-données-schéma-et-catalogue)) :

   ```bash
   sudo node --env-file=/etc/belle-forme.env scripts/seed-catalog.mjs
   ```

   (après `schema.sql`, appliqué avec `psql` ou l'éditeur SQL de Neon).
5. Crée `/etc/systemd/system/belle-forme.service` :

   ```ini
   [Unit]
   Description=Belle Forme
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   User=belleforme
   Group=belleforme
   WorkingDirectory=/opt/belle-forme
   EnvironmentFile=/etc/belle-forme.env
   ExecStart=/usr/bin/node server.mjs
   Restart=on-failure
   RestartSec=5
   # Exit code 2 is a configuration error (HOST, PORT, TRUST_PROXY): restarting will not fix it.
   RestartPreventExitStatus=2
   NoNewPrivileges=true
   ProtectSystem=strict
   ProtectHome=true
   PrivateTmp=true

   [Install]
   WantedBy=multi-user.target
   ```

   Remplace `/usr/bin/node` par la sortie de `command -v node` si elle diffère. Le serveur ne fait que lire des fichiers : `ProtectSystem=strict` (système de fichiers en lecture seule) lui convient.
6. Lance-le et vérifie :

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now belle-forme
   systemctl status belle-forme
   journalctl -u belle-forme -n 20
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8888/api/login
   ```

   Le journal affiche `belle-forme: listening on http://127.0.0.1:8888` ; le curl affiche `405`. Une ligne qui commence par `belle-forme: HOST must be…`, `PORT must be…` ou `TRUST_PROXY must…` est une erreur de configuration (code de sortie 2, pas de redémarrage).
7. Mets le reverse proxy devant ([section 9](#9-configuration-du-reverse-proxy-caddy-nginx)).

### 9. Configuration du reverse proxy (Caddy, nginx)

Les deux extraits envoient tout (app, API, coach) vers l'app sur `127.0.0.1:8888`, ce qui convient aux deux formes : sous compose, le port y est publié. `server.mjs` garde les connexions inactives ouvertes plus longtemps que le keep-alive amont de l'un ou l'autre proxy (`KEEP_ALIVE_TIMEOUT_MS` dans `server.mjs`) : une connexion réutilisée n'est pas fermée sous le nez du proxy.

**Caddy** (obtient et renouvelle le certificat lui-même) :

```caddy
coach.example.com {
	reverse_proxy 127.0.0.1:8888 {
		# Send the coach's reply as it is written, not when it ends.
		flush_interval -1
	}
}
```

Écris `127.0.0.1`, pas `localhost` : `localhost` peut se résoudre en `::1`, et la connexion ne vient alors plus de l'adresse de `TRUST_PROXY`. N'ajoute pas `encode` (compression) devant le coach : il met en tampon. Caddy écrit `X-Forwarded-For` lui-même et n'impose aucun délai de réponse par défaut.

**nginx** (certificat obtenu avec ton outil habituel, par exemple certbot) :

```nginx
server {
    listen 443 ssl;
    server_name coach.example.com;
    ssl_certificate     /etc/letsencrypt/live/coach.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/coach.example.com/privkey.pem;

    # server.mjs accepts request bodies up to MAX_BODY_BYTES (server.mjs); nginx's default is 1m.
    client_max_body_size 6m;

    location / {
        proxy_pass http://127.0.0.1:8888;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        # REQUIRED: append the client's address. Without it the throttle trusts what the client sends.
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # The coach streams: no buffering, and room for long silences while a model thinks.
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

`proxy_read_timeout` est le plus long silence que nginx tolère entre deux lectures (60 s par défaut). Une réponse de chat peut rester silencieuse pendant qu'un modèle réfléchit et que l'échelle descend (`RUNG_HEADER_TIMEOUT_MS`, `FIRST_TEXT_TIMEOUT_MS` dans `providers.js`) : garde-le bien au-dessus du défaut. Une demande « Plan » envoie un octet de maintien toutes les `EMIT_KEEPALIVE_MS` (`coach-chat.js`) et ne risque rien.

**Une seule couche de proxy.** La limitation lit l'entrée la plus à droite de `X-Forwarded-For`, celle que ton proxy a écrite. Si un CDN est placé devant ton proxy, cette entrée est l'adresse du point de présence du CDN, et les visiteurs derrière un même point partagent un compteur. Configure d'abord ton proxy pour restaurer la vraie adresse client (`real_ip` pour nginx, `trusted_proxies` pour Caddy).

**Vérification :** ouvre `https://coach.example.com`, connecte-toi et ouvre l'onglet Coach : la réponse doit s'afficher au fur et à mesure, pas d'un bloc. Essaie une phrase fausse : « Raté, darling. Réessaie. ».

### 10. Premier lancement, le profil

L'app démarre avec un profil vide. Tant que le profil n'a pas de prénom, elle s'ouvre sur l'onglet **Profil**, dans son formulaire, avec une carte « Bienvenue ». Le formulaire (`src/components/ProfileTab.jsx`) demande :

1. **Prénom** (obligatoire).
2. **Âge**, **Taille (cm)**, **Poids (kg)**, **Expérience**, **Fréquence**, **Objectifs**, **Priorités** : champs libres facultatifs, lus par le coach.
3. **« Le coach s'adresse à toi au »** : l'accord grammatical que le coach utilise pour toi, *féminin (elle)* ou *masculin (il)*. Obligatoire.
4. **Notes pour le coach** : texte libre (tes goûts, tes contraintes, ce que tu ne veux plus faire). Il entre dans le prompt du coach.
5. **« Adapter les séances à mon cycle menstruel »** : décoché par défaut. Coché, il demande la durée du cycle en jours. Le coach **demande** alors toujours où tu en es dans ton cycle ; l'app ne stocke jamais le jour du cycle et ne le déduit jamais des dates.
6. **Matériel**, dont sont dérivées les charges que propose le coach et celles que l'app accepte : haltères réglables par main, barres chargeables et leur poids à vide, disques au format `poids x quantité`, lest de cheville, et une liste à cocher de ce que tu as chez toi. Tant que tu n'as pas enregistré, le formulaire est prérempli avec un inventaire d'exemple (`STARTER_INVENTORY`) : un exemple à modifier, pas une hypothèse sur toi.
7. Appuie sur **Sauvegarder**. Le profil se synchronise vers la base ; le coach reconstruit son prompt à partir de lui.

Ensuite : l'onglet **Coach** sert à discuter ; son bouton « Plan » est la seule action qui produit un programme de la semaine, que tu importes avec « Importer ce programme ». L'onglet **Exercices** modifie le catalogue. **Profil → Export SQL (urgence)** télécharge une sauvegarde SQL complète.

### 11. Sauvegardes

**Dump complet de la base** (recommandé, au rythme que tu choisis). Utilise un `pg_dump` dont la version majeure est au moins celle du serveur.

- Neon ou ton propre Postgres (avec Neon, utilise la chaîne de connexion **directe**, non poolée) :

  ```bash
  pg_dump -Fc "<chaîne de connexion directe>" -f belle-forme-$(date +%F).dump
  pg_restore --no-owner -d "<chaîne de connexion d'une base cible vide>" belle-forme-AAAA-MM-JJ.dump
  ```

- Sous compose (les outils viennent du conteneur `postgres` ; `-T` garde le flux binaire intact) :

  ```bash
  docker compose exec -T postgres pg_dump -U belleforme -d belleforme -Fc > belle-forme-$(date +%F).dump
  docker compose exec -T postgres pg_restore -U belleforme -d belleforme --clean --if-exists --no-owner < belle-forme-AAAA-MM-JJ.dump
  ```

  `--clean --if-exists` supprime puis recrée ce que contient le dump : la restauration **remplace** les données actuelles.

**Export depuis l'app** : Profil → « Export SQL (urgence) » télécharge `belle-forme-backup-<date>.sql`. Il couvre séances, programmes, profil, réglages, catalogue, carnet et transcript du coach (pas `coach_usage` ni `login_attempts`). Il commence par un `TRUNCATE` de ces tables et s'exécute en une transaction : l'exécuter **remplace** le contenu actuel de ces tables.

Les sauvegardes contiennent des données de santé personnelles. Range-les comme n'importe quel document privé.

### 12. Mises à jour

Le dépôt public reçoit un commit par version ; son message liste les changements et un éventuel script ponctuel à lancer.

**Toujours, dans cet ordre :** applique le nouveau `schema.sql` **avant** que le nouveau code tourne (le nouveau code peut écrire dans une colonne que seul le nouveau schéma contient), puis déploie. Lis le message de la version pour repérer un script ponctuel de `scripts/` (ces scripts indiquent en tête si tu en as besoin, et font un essai à blanc par défaut). **Ne relance jamais** `scripts/seed-catalog.mjs` pour « mettre à jour » le catalogue.

- **Forme A (compose) :**

  ```bash
  git pull
  docker compose up -d --build
  ```

  `db-init` applique le schéma avant le démarrage de l'app : l'ordre est automatique.
  **Mettre à jour une pile créée avant que le réseau soit fixé** (`10.203.0.0/24` dans `compose.yaml`) : lance `docker compose down` **une fois** avant `up`. Docker ne déplace pas un réseau existant vers un nouveau sous-réseau, et `TRUST_PROXY=10.203.0.1` nommerait la mauvaise adresse. `down` garde le volume `pgdata` ; **n'ajoute jamais `-v`**, qui supprime la base.

- **Forme B (systemd) :**

  ```bash
  cd /opt/belle-forme
  sudo git pull
  psql "<chaîne de connexion>" -v ON_ERROR_STOP=1 -f netlify/functions/lib/schema.sql
  sudo npm ci
  sudo npm run build
  sudo systemctl restart belle-forme
  ```

Après une mise à jour, chaque copie ouverte de l'app propose de se recharger (un message du service worker).

### 13. Exemple Netlify + Neon

C'est ainsi que tourne le projet lui-même. Aucun serveur à entretenir ; le coach tourne en Netlify **Edge** Function (Deno), le reste en Netlify Functions (Node). `server.mjs`, `HOST`, `PORT` et `TRUST_PROXY` n'interviennent pas : `netlify.toml` déclare le build (`npm run build`, dossier publié `dist`), les dossiers de fonctions, les réécritures `/api/*` et `/demo/*`, le repli SPA et les en-têtes, et c'est l'edge de Netlify qui écrit l'adresse client.

1. **Neon :** crée un projet ; copie sa chaîne de connexion (poolée ou directe, les deux marchent en HTTP) ; applique `schema.sql` et peuple le catalogue depuis l'éditeur SQL ([section 4](#4-base-de-données-schéma-et-catalogue)).
2. **Netlify :** crée un projet depuis ta copie Git de ce dépôt. Dans **Project configuration → Environment variables**, ajoute `APP_PASSWORD_HASH`, `SYNC_API_KEY`, `NEON_DATABASE_URL`, `ANTHROPIC_API_KEY`, `MISTRAL_API_KEY` et `NODE_VERSION=24`. Laisse `NEON_HTTP_ENDPOINT` non définie. Garde les portées par défaut (ou au moins Functions) : les deux environnements de fonctions les lisent ; le build n'en a besoin d'aucune.
3. Redéploie après chaque modification de variable ; sinon les fonctions en place ne voient pas les nouvelles valeurs.

Deux choses à savoir avant de choisir cette voie :

- **Les offres à crédits de Netlify.** Les comptes créés depuis le 4 septembre 2025 sont sur des offres à crédits. Sur l'offre gratuite, les déploiements de production, le calcul des fonctions, les requêtes et la bande passante consomment une enveloppe mensuelle de crédits plafonnée, et quand elle est épuisée, **tous les projets du compte sont mis en pause** (les visiteurs voient « Site not available ») jusqu'au renouvellement de l'enveloppe. Chaque push sur la branche déployée est un déploiement de production. Vérifie la grille tarifaire actuelle de Netlify.
- **L'offre gratuite de Neon** a des limites de stockage et de calcul par projet ; à la limite de calcul, la base est suspendue jusqu'à la période de facturation suivante, et au-delà de la limite de stockage les écritures sont bloquées. Vérifie la grille tarifaire actuelle de Neon.

### 14. Développement en local

```bash
npm ci
npm run dev        # serveur de dev Vite, http://localhost:5173 (front seulement)
npm test           # Vitest, une fois
npm run lint       # ESLint
npm run build      # build de production dans dist/ et la démo dans dist/demo/
npm start          # server.mjs sur 127.0.0.1:8888 (ce que lance `node server.mjs`)
```

`npm run dev` ne sert **que le front**, et l'écran de connexion appelle `/api/login` : avec `npm run dev` seul, tu ne passes pas l'écran de connexion. Pour l'app complète, lance `npm run build`, puis `node --env-file=.env server.mjs` avec un `.env` local (copie `.env.example` ; `.env` est ignoré par git). Fais pointer `NEON_DATABASE_URL` vers une base de développement séparée ou une branche Neon, jamais vers tes vraies données. La CLI Netlify (`netlify dev`) marche aussi pour le développement local, jamais pour héberger.

Les tests n'ont besoin ni de réseau ni de secret : ils tournent sur un profil synthétique et un Postgres en mémoire (PGlite).
