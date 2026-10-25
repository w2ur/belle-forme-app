import { timeoutSignal } from "./timeoutSignal.js";

/**
 * The credential was refused. Not the entry's fault and not transient: the
 * outbox stops and keeps everything, and the app returns to the password gate.
 * It carries `status: 401`, so `classify` maps it to "auth" with no special case,
 * and `key`, the key the refused request SENT (`shouldForgetKey`).
 */
export class SyncAuthError extends Error {
  constructor(message, key = null) {
    super(message);
    this.name = "SyncAuthError";
    this.status = 401;
    this.key = key;
  }
}

/**
 * How long one sync request may take, response body included, before it is
 * abandoned as a transient failure.
 *
 * Without it a request that never answers (a captive portal, a radio that
 * drops mid-response) never settles: the drain awaiting it holds the
 * single-flight flag and the cross-tab lock for good, and nothing syncs again
 * in any tab until every one of them is closed. Twenty seconds is several
 * times a slow cold start of a Netlify function, and well under the hook's
 * 30 s retry.
 */
export const REQUEST_TIMEOUT_MS = 20000;

/**
 * The error for a response that is not ok: a `SyncAuthError` on 401, so
 * every caller can send the app back to the gate the same way, and otherwise
 * an Error carrying the status.
 */
function failure(label, status, key) {
  if (status === 401) return new SyncAuthError(`${label} failed with status 401`, key);
  return Object.assign(new Error(`${label} failed with status ${status}`), { status });
}

export function createSyncClient(baseUrl, apiKey, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  async function request(path, options = {}) {
    // Throw on failure (HTTP error or network error) rather than returning
    // null: callers rely on the thrown error to mark the sync as failed and
    // engage the outbox. Swallowing failures previously reported a failed
    // push as "synced" and could permanently drop the unsynced session.
    const { signal, clear } = timeoutSignal(timeoutMs);
    try {
      return await send(path, options, signal);
    } catch (err) {
      // Abandoned, not answered: no status, so the outbox reads it as
      // transient and retries, exactly like a network failure.
      if (signal.aborted && err?.status == null) {
        throw new Error(`Sync request "${path}" timed out after ${timeoutMs} ms`, { cause: err });
      }
      throw err;
    } finally {
      clear();
    }
  }

  async function send(path, options, signal) {
    const res = await fetch(`${baseUrl}/api/${path}`, {
      headers,
      ...options,
      signal,
    });
    if (!res.ok) {
      // The status travels on the error: the outbox retries a 5xx, parks any
      // other 4xx, and stops on a 401. A network failure throws from fetch
      // itself, with no status, and is treated as transient.
      const err = failure(`Sync request "${path}"`, res.status, apiKey);
      // A 409 is a stale base, and its body is the server's current state —
      // what the caller rebases onto. Any other body stays unread.
      if (res.status === 409) err.body = await res.json().catch(() => null);
      throw err;
    }
    return await res.json();
  }

  return {
    async upsertSession(session) {
      const { id, date, name, ...rest } = session;
      return request("sync-sessions", {
        method: "POST",
        body: JSON.stringify({
          action: "upsert",
          session: { id, date, name, data: rest },
        }),
      });
    },

    async deleteSession(id) {
      return request("sync-sessions", {
        method: "POST",
        body: JSON.stringify({ action: "delete", id }),
      });
    },

    async pushPlan(plan) {
      if (!plan) return null;
      const { weekStart, weekEnd, raw, ...rest } = plan;
      return request("sync-plan", {
        method: "POST",
        body: JSON.stringify({
          plan: { week_start: weekStart, week_end: weekEnd, data: rest, raw },
        }),
      });
    },

    async pushProfile(profile, settings) {
      return request("sync-profile", {
        method: "POST",
        body: JSON.stringify({ profile, settings }),
      });
    },

    async pullAll() {
      return request("sync-pull", { method: "GET" });
    },

    // Whole-document write, PUT rather than POST: the row IS the document, so
    // re-sending it after a network blip cannot append or duplicate anything.
    // `baseUpdatedAt` is the version the document was built on; a stale one
    // is refused with 409 and the current row (`err.body`). Sent as `null`
    // rather than dropped, because a body without the key is the legacy shape.
    async pushCatalog({ doc, baseUpdatedAt }) {
      return request("sync-catalog", {
        method: "PUT",
        body: JSON.stringify({ doc, baseUpdatedAt: baseUpdatedAt ?? null }),
      });
    },

    async downloadExport() {
      // Authenticated SQL export. Uses the client's own Bearer header so no
      // credential is read from the bundle at the call site.
      const res = await fetch(`${baseUrl}/api/sync-export`, { headers });
      // A 401 is the same SyncAuthError as everywhere else, so the export
      // button sends her back to the gate rather than toasting a failure.
      if (!res.ok) throw failure("Sync export", res.status, apiKey);
      return res.text();
    },

    // `mode` decides which system prompt the server builds, and so whether the
    // model is shown the FITTRACK PLAN format at all. Chat is the default:
    // everything except the explicit « Mon programme de la semaine » request is
    // daily coaching.
    async sendCoachMessage({ message, exportContext, mode = "chat" }) {
      // Raw fetch (not request()) because the response is a text stream, not JSON.
      const res = await fetch(`${baseUrl}/api/coach-chat`, {
        method: "POST",
        // Announces that this bundle strips STREAM_KEEPALIVE_MARKER, so the
        // server may tick it on a buffered plan-emit. The PWA is
        // `registerType: 'prompt'`: an older bundle on her iPad keeps running
        // until she accepts the update, and that bundle would render a
        // keepalive-prefixed payload as text. The server sends the byte only
        // to a client that asks for it.
        headers: { ...headers, "X-Coach-Stream": "keepalive" },
        body: JSON.stringify({ message, exportContext, mode }),
      });
      if (!res.ok) throw failure("Coach request", res.status, apiKey);
      return res;
    },

    async fetchCoachHistory() {
      return request("coach-chat", { method: "GET" });
    },
  };
}

let _client;

/** Forgets the cached client, so the next `getSyncClient` re-reads the stored key. */
export function resetSyncClient() {
  _client = undefined;
}

/**
 * Whether a 401 should delete the stored key. Only when the stored key IS the
 * one that was refused: the key lives in localStorage, shared by every tab,
 * and a tab still running on a rotated key would otherwise delete the fresh
 * one another tab just stored at login, sending every tab back to the gate.
 * With no record of the key that failed (`used` null) it goes, as before.
 *
 * `used` is the refused REQUEST's key (`SyncAuthError.key`), never the key
 * this tab's client holds now: a request sent before the shell remounted on a
 * fresh key answers 401 after it, and read off the current client, the fresh
 * key looked like the refused one and was deleted.
 */
export function shouldForgetKey({ stored, used }) {
  if (used == null) return true;
  return stored === used;
}

export function getSyncClient() {
  // The demo never syncs: no client, so the app runs in its local-only mode.
  if (import.meta.env.VITE_DEMO) return null;
  if (_client) return _client;
  // The credential is the Neon key returned by /api/login and stored at unlock,
  // never a build-time secret embedded in the bundle. Not logged in yet means
  // no client (local-only mode), exactly as before.
  const apiKey = localStorage.getItem("fittrack_sync_key");
  if (!apiKey) return null;
  _client = createSyncClient("", apiKey);
  return _client;
}
