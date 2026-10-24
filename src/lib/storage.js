function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
    return true;
  } catch (e) {
    console.error("Storage error:", e);
    return false;
  }
}

export const storage = {
  loadSessions: (fallback) => load("sessions", fallback),
  saveSessions: (sessions) => save("sessions", sessions),
  loadProfile: (fallback) => load("profile", fallback),
  saveProfile: (profile) => save("profile", profile),
  loadSettings: (fallback) => load("settings", fallback),
  saveSettings: (settings) => save("settings", settings),
  loadPlan: () => load("currentPlan", null),
  savePlan: (plan) => save("currentPlan", plan),
  // The exercise catalog as the SERVER last confirmed it: `{ doc, updatedAt }`,
  // where `updatedAt` is the row's version — the base the catalog PUT is
  // checked against. Mirrored because the lexique, the manual picker and plan
  // validation all have to work in a séance with no signal. Edits not yet
  // confirmed are NOT in it: they are operations in the outbox, replayed on
  // top of it (`useSessionData`). Stored RAW (the document, not the derived
  // views) because the views are cheap to rebuild.
  //
  // A mirror written before the version existed is the bare document; it
  // reads back with `updatedAt: null`, so its first push is refused as stale
  // and replayed onto the server's copy instead of overwriting it.
  loadCatalog: () => {
    const raw = load("catalog", null);
    if (!raw || typeof raw !== "object") return null;
    if (Object.hasOwn(raw, "doc")) return { doc: raw.doc ?? null, updatedAt: raw.updatedAt ?? null };
    return { doc: raw, updatedAt: null };
  },
  saveCatalog: ({ doc, updatedAt }) => save("catalog", { doc, updatedAt: updatedAt ?? null }),
  // The catalog operations this device saw confirmed, as `{ t, names }`
  // (`logConfirmedOps`, catalogSync.js): what a parked, older edit is checked
  // against when « Réessayer » puts it back in the queue.
  loadConfirmedCatalogOps: () => load("catalogConfirmedOps", []),
  saveConfirmedCatalogOps: (log) => save("catalogConfirmedOps", log),
  // The running séance. Written through on every mutation because iPad Safari
  // kills backgrounded tabs, and a workout lost mid-set is not recoverable.
  loadActiveSession: () => load("activeSession", null),
  saveActiveSession: (state) => save("activeSession", state),
  // The sync outbox (src/lib/outbox.js): every write not yet confirmed by Neon.
  // Persisted because it is the only copy of a write made offline, and iPad
  // Safari kills backgrounded tabs.
  loadOutbox: () => load("outbox", { queue: [], parked: [] }),
  // Returns false when the write failed (quota, private mode), so the outbox
  // store knows storage is now BEHIND its own copy (`createOutboxStore`).
  saveOutbox: (outbox) => save("outbox", outbox),
  // The outbox as storage holds it right now, for a read-modify-write: null
  // when there is none, undefined when storage could not be read at all —
  // two different answers, since "nothing queued" must not be mistaken for
  // "could not look".
  readOutbox: () => {
    try {
      const raw = localStorage.getItem("outbox");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return undefined;
    }
  },
  clearActiveSession: () => {
    try { localStorage.removeItem("activeSession"); } catch { /* quota/private mode — nothing to clear */ }
  },
};
