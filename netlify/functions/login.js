import crypto from "node:crypto";
import { ok, err, getDb } from "./lib/db.js";
import { env } from "./lib/env.js";
import {
  MAX_FAILED_ATTEMPTS, WINDOW_MINUTES, clientIp, beginAttempt, dropAttempt, clearFailures,
} from "./lib/loginThrottle.js";

/**
 * Runs one throttle query and answers `fallback` if the database refuses it.
 * The throttle is a brake on guessing, not the boundary (the passphrase is), so
 * an instance that has not applied the `login_attempts` table yet, or whose
 * database blinks, still lets its owner in — and says so in the log.
 */
async function throttleStep(run, fallback) {
  try {
    return await run(getDb());
  } catch (e) {
    console.error("login: throttle unavailable, continuing without it:", e?.message);
    return fallback;
  }
}

// Server-side password gate. The browser sends the access password; we hash it
// and compare to APP_PASSWORD_HASH — a SERVER-ONLY env var that is never shipped
// in the client bundle. On a match we hand back the sync credential so the
// client can call the sync-* functions. This keeps the two secrets separate:
// the password gate and the API key stay independent and only meet here, on the
// server. Nothing sensitive is embedded in the downloaded JavaScript.
export async function handler(event) {
  if (event.httpMethod !== "POST") return err("Method not allowed", 405);

  const expected = env("APP_PASSWORD_HASH");
  const apiKey = env("SYNC_API_KEY");
  if (!expected || !apiKey) return err("Auth not configured", 500);

  let password;
  try {
    password = JSON.parse(event.body || "{}").password;
  } catch {
    return err("Invalid request body", 400);
  }
  if (typeof password !== "string" || password.length === 0) {
    return err("Password required", 400);
  }

  // Recorded BEFORE the compare (so a locked address learns nothing about
  // whether the password it sent was right) and before any verdict, so that a
  // parallel burst cannot read "under the limit" N times: see loginThrottle.js.
  const ip = clientIp(event.headers);
  const attempt = await throttleStep((sql) => beginAttempt(sql, ip), null);
  if (attempt && attempt.count > MAX_FAILED_ATTEMPTS) {
    await throttleStep((sql) => dropAttempt(sql, attempt.id), null);
    return {
      ...err("Trop de tentatives. Réessaie dans quelques minutes.", 429),
      headers: { "Content-Type": "application/json", "Retry-After": String(WINDOW_MINUTES * 60) },
    };
  }

  const hash = crypto.createHash("sha256").update(password).digest("hex");
  // Constant-time comparison so response timing can't reveal how much of the
  // hash matched.
  const a = Buffer.from(hash);
  const b = Buffer.from(expected);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  // A wrong password keeps the row already written: that row IS the failure record.
  if (!match) return err("Unauthorized", 401);

  if (attempt) await throttleStep((sql) => clearFailures(sql, ip), null);
  return ok({ key: apiKey });
}
