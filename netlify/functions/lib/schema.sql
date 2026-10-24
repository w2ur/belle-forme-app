CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  date DATE NOT NULL,
  name TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plans (
  id SERIAL PRIMARY KEY,
  week_start DATE,
  week_end DATE,
  data JSONB NOT NULL,
  raw TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS profile (
  id INTEGER PRIMARY KEY DEFAULT 1,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coach_messages (
  id         SERIAL PRIMARY KEY,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- One row per coach request that reached a model. Counts and metadata ONLY —
-- never message content, which already lives in coach_messages and has no
-- business being duplicated into an analytics table.
--
-- This exists because the cost question cannot be answered from assumptions:
-- monthly spend is dominated by how often the user actually writes and how long the
-- replies run, and both were being guessed. Netlify's function logs are
-- effectively real-time with short retention, so "look at it next week" needs a
-- table, not a console line.
--
-- NULL vs 0 is load-bearing on cached_tokens: NULL means the provider reported
-- nothing, 0 means it reported no cache hit. See normalizeUsage in sse.js.
CREATE TABLE IF NOT EXISTS coach_usage (
  id                SERIAL PRIMARY KEY,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  model             TEXT,
  models_skipped    INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER,
  cached_tokens     INTEGER,
  completion_tokens INTEGER,
  -- Characters of withheld reasoning (typed `thinking` blocks), counted by the
  -- SSE parser. completion_tokens INCLUDES reasoning on a thinking model, so
  -- without this a long answer and a long think are one number. 0 = a model
  -- that sent no thinking; NULL = a row written before the column existed.
  thinking_chars    INTEGER,
  finish_reason     TEXT,
  -- Milliseconds from the moment the request entered the handler. Three points,
  -- because "the coach is slow" has three possible addresses and the token
  -- counts cannot tell them apart:
  --   headers_ms — our own overhead (auth, the two Neon reads) plus everything
  --                the model does before it answers: prefill of the whole
  --                prompt, then the hidden reasoning tokens.
  --   ttft_ms    — the same, plus the wait for the first VISIBLE character.
  --                This is the number the user actually experiences.
  --   total_ms   — through to the end of the stream.
  -- headers_ms vs ttft_ms separates "the model is thinking" from "the model is
  -- writing"; total_ms - ttft_ms is the streaming rate.
  --
  -- NULL is meaningful here exactly as it is on cached_tokens: a reply that
  -- produced no visible text has no ttft_ms, and recording that as 0 would pull
  -- the average toward zero using the failures.
  headers_ms        INTEGER,
  ttft_ms           INTEGER,
  total_ms          INTEGER,
  -- "discussion" | "plan" | "plan-emit". Which request kind produced this row —
  -- without it, a chat answer and a whole generated week share one
  -- completion_tokens distribution and neither can be read.
  mode              TEXT
);

-- This file is applied by hand in the Neon SQL console (see README), and every
-- CREATE above is IF NOT EXISTS — which upgrades nothing on a database that
-- already has the table. The three duration columns were added on 2026-08-02,
-- after coach_usage had been live since 2026-08-01, so an existing install needs
-- them grafted on explicitly. Without this the INSERT fails, recordUsage
-- swallows its own error by design, and the instrumentation is silently dead —
-- which is the exact failure the timing work exists to end.
-- Re-running the whole file stays safe: ADD COLUMN IF NOT EXISTS is a no-op the
-- second time.
ALTER TABLE coach_usage ADD COLUMN IF NOT EXISTS headers_ms INTEGER;
ALTER TABLE coach_usage ADD COLUMN IF NOT EXISTS ttft_ms    INTEGER;
ALTER TABLE coach_usage ADD COLUMN IF NOT EXISTS total_ms   INTEGER;

-- Added 2026-08-10 for a rung-1 retry that was DELETED on 2026-09-30 (it
-- doubled the wait on a dead rung: 15 s timeout + 15 s retry + Medium), so
-- every row since is 0. Kept for the rows before: a retry of the SAME rung is
-- invisible in models_skipped, which counts skipped rungs, so a successful
-- rung-1 retry wrote 0 there, identical to a clean first attempt.
ALTER TABLE coach_usage ADD COLUMN IF NOT EXISTS rung_retries INTEGER NOT NULL DEFAULT 0;

-- Added 2026-08-16, to make reply LENGTH readable. Without it every metric on
-- this table mixes three request kinds that answer at wildly different sizes:
-- a `plan-emit` payload is long by design, a chat answer should not be, and
-- both landed in one completion_tokens distribution. The median since
-- 2026-08-07 was 769 tokens across all of them, which is the number the
-- brevity work has to be measured against — and it cannot be split after the
-- fact, because nothing else in the row says which kind of request it was.
-- The same conflation already blurs ttft_ms, where the emit path buffers the
-- whole payload before sending a byte (see the buffered-emit note in
-- the `belle-forme-coach` skill).
ALTER TABLE coach_usage ADD COLUMN IF NOT EXISTS mode TEXT;

-- Added 2026-10-01. zai-glm-5-3 (rung 1 at the time) reasons on every request and its
-- reasoning is billed inside completion_tokens, so a reply's length and its
-- thinking could no longer be told apart from the table. MUST be applied before
-- the code that writes it is deployed — recordUsage names the column, a missing
-- column fails the INSERT, and the row is lost (silently, by design: the user's
-- answer is never at stake, the instrumentation is).
ALTER TABLE coach_usage ADD COLUMN IF NOT EXISTS thinking_chars INTEGER;

CREATE TABLE IF NOT EXISTS coach_notebook (
  id         INTEGER PRIMARY KEY DEFAULT 1,
  content    TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- The exercise catalog. One row, one JSONB document, whole-document writes —
-- there is no merge layer and no bundled runtime fallback, by owner ruling
-- (2026-08-11): without Neon the coach cannot bank a message, read its notebook
-- or load its history, so a stale catalog would prop up an exchange that
-- vanishes anyway. A failed read is an error we debug, not a state we paper over.
CREATE TABLE IF NOT EXISTS catalog (
  id         INTEGER PRIMARY KEY DEFAULT 1,
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- `catalog.updated_at` is not a decoration: it is the CACHE KEY the coach's edge
-- function uses to decide whether to rebuild its three system prompts
-- (`buildPromptCache`, coach-chat.js). A stale value there does not fail — the
-- isolate goes on serving the previous prompts while reading the new document,
-- and the coach describes a catalog that no longer exists. `DEFAULT NOW()`
-- covers the INSERT and nothing else, so an UPDATE that forgets
-- `updated_at = NOW()` freezes the key permanently. `scripts/seed-catalog.mjs`
-- sets it explicitly; from slice 2 an editor writes this row too, and a
-- convention that has to be remembered at every call site is one that will be
-- forgotten at one of them.
--
-- Re-runnable like everything else in this file (it is applied by hand against a
-- live database): CREATE OR REPLACE for the function, DROP ... IF EXISTS before
-- the trigger.
CREATE OR REPLACE FUNCTION catalog_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS catalog_set_updated_at ON catalog;
CREATE TRIGGER catalog_set_updated_at
  BEFORE UPDATE ON catalog
  FOR EACH ROW EXECUTE FUNCTION catalog_touch_updated_at();

-- Failed logins, per client address, for the throttle in login.js
-- (netlify/functions/lib/loginThrottle.js). Rows older than a day are swept on
-- every failure; nothing here is personal data beyond an address that is
-- already in the host's own logs.
CREATE TABLE IF NOT EXISTS login_attempts (
  id         SERIAL PRIMARY KEY,
  ip         TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS login_attempts_ip_created_idx ON login_attempts (ip, created_at);
