import HeroPhoto from "./HeroPhoto.jsx";
import { useState } from "react";

// The access password is verified SERVER-SIDE by the /api/login function, which
// returns the Neon sync credential on success. Nothing sensitive — neither the
// password hash nor the API key — is embedded in the client bundle. The returned
// key is stored here and read by the sync client (src/lib/sync.js).
export const SYNC_KEY_STORAGE = "fittrack_sync_key";

export function isAuthenticated() {
  // Authenticated once the sync credential from a successful login is stored.
  return !!localStorage.getItem(SYNC_KEY_STORAGE);
}

export default function PasswordGate({ onSuccess, reason = null }) {
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [checking, setChecking] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErrorMsg("");
    setChecking(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        const { key } = await res.json();
        localStorage.setItem(SYNC_KEY_STORAGE, key);
        onSuccess();
      } else if (res.status === 401) {
        setErrorMsg("Raté, darling. Réessaie.");
        setPassword("");
      } else {
        setErrorMsg("Le rideau est coincé (serveur). Réessaie.");
      }
    } catch {
      setErrorMsg("Pas de réseau, chérie. Réessaie.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="min-h-screen bg-primary flex items-center justify-center px-6">
      <div className="w-full max-w-[320px] text-center">
        <HeroPhoto name="entrance" className="mb-4 mx-auto" />
        <h1 className="text-3xl font-bold text-gray-800 mb-2 tracking-tight font-serif">
          Belle <span className="text-accent">Forme</span>
        </h1>
        <p className="text-muted text-sm mb-8">Le mot de passe, chérie. On n'entre pas au Gaslight comme ça.</p>

        {reason === "rotated" && (
          <p role="status" className="text-muted-dark text-sm mb-4">La clé a changé, retape le mot de passe.</p>
        )}

        <form onSubmit={handleSubmit}>
          <label htmlFor="gate-password" className="block text-left text-muted text-sm mb-1.5">Mot de passe</label>
          <input
            id="gate-password"
            type="password"
            value={password}
            onChange={e => { setPassword(e.target.value); setErrorMsg(""); }}
            autoComplete="current-password"
            autoFocus
            className={`w-full px-4 py-3 rounded-xl border bg-card text-gray-800 text-base text-center box-border mb-4 ${
              errorMsg ? "border-danger" : "border-border-light"
            }`}
          />
          {errorMsg && (
            <p className="text-danger text-sm mb-4">{errorMsg}</p>
          )}
          <button
            type="submit"
            disabled={!password || checking}
            className={`w-full py-3 rounded-xl border-none text-base font-semibold ${
              password && !checking
                ? "bg-accent text-white cursor-pointer"
                : "bg-border-light text-muted cursor-default"
            }`}
          >
            {checking ? "..." : "Entrer en scène"}
          </button>
        </form>
      </div>
    </div>
  );
}
