import { neon, neonConfig } from "@neondatabase/serverless";
import { env } from "./env.js";

/**
 * The one place a Neon HTTP client is built — db.js and the write scripts.
 *
 * `NEON_HTTP_ENDPOINT` points the driver at a Neon-compatible HTTP proxy in
 * front of a plain Postgres (the self-hosted Docker setup); unset, the driver
 * talks to Neon exactly as before. A string endpoint is used as is, so it must
 * be the full URL, path included (e.g. `http://neon-proxy:4444/sql`).
 *
 * `neonConfig` is module-global, so this sets it for every client in the
 * process — which is what a process talking to one database wants.
 */
export function applyNeonEndpoint(read = env, config = neonConfig) {
  const endpoint = read("NEON_HTTP_ENDPOINT");
  if (typeof endpoint === "string" && endpoint.trim()) {
    config.fetchEndpoint = endpoint.trim();
  }
  return config;
}

/** `neon(url)`, after honouring `NEON_HTTP_ENDPOINT`. */
export function neonSql(url, read = env) {
  applyNeonEndpoint(read);
  return neon(url);
}
