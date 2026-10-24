import crypto from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { env } from "./env.js";

let _sql;

export function getDb() {
  if (!_sql) {
    _sql = neon(env("NEON_DATABASE_URL"));
  }
  return _sql;
}

// SYNC_API_KEY is OUR OWN credential — a random string we invent, guarding our
// own endpoints — and nothing to do with Neon, which issues account-level API
// keys of its own. It was called NEON_API_KEY until 2026-08-15, which read as a
// Neon platform credential and inflated its apparent blast radius. This one
// check is the whole server-side boundary: the six sync-* functions and the
// coach edge function all pass through it.
export function authorizeToken(authHeader) {
  const token = (authHeader || "").replace("Bearer ", "").trim();
  const expected = env("SYNC_API_KEY");
  if (token.length === 0 || typeof expected !== "string") return false;
  // Constant-time compare, as login.js does. node:crypto is available in the
  // Deno edge runtime too; timingSafeEqual throws on unequal lengths, so the
  // length check has to come first.
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function authorize(event) {
  if (authorizeToken(event.headers.authorization)) return null;
  return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
}

export function ok(data) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  };
}

export function err(message, status = 500) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: message }),
  };
}
