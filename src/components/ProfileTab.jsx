import { useState } from "react";
import { getSyncClient } from "../lib/sync.js";
import { toEditDraft, fromEditDraft, filledProfileFields } from "../lib/profileForm.js";
import { needsProfileSetup } from "../lib/persona.js";
import { generateEquipmentLines, EQUIPMENT_VOCABULARY, EQUIPMENT_LABELS_FR, CYCLE_LENGTH_RANGE_DAYS } from "../constants/index.js";

const FIELDS = [
  ["name", "Prénom", "text"],
  ["age", "Âge", "number"],
  ["height", "Taille (cm)", "number"],
  ["weight", "Poids (kg)", "number"],
  ["experience", "Expérience", "text"],
  ["frequency", "Fréquence", "text"],
  ["goals", "Objectifs", "text"],
  ["priorities", "Priorités", "text"],
];

const INFO_ROWS = [
  ["Expérience", "experience"],
  ["Fréquence", "frequency"],
  ["Équipement", "equipment"],
  ["Objectifs", "goals"],
  ["Priorités", "priorities"],
  ["Notes pour le coach", "coachNotes"],
  ["Suivi du cycle", "cycle"],
];

const INPUT_CLASS = "w-full px-3.5 py-3 rounded-[10px] border border-border-light bg-card text-gray-800 text-[15px] box-border";
const LABEL_CLASS = "block text-muted text-[13px] mb-1.5";

function infoValue(data, key) {
  if (key === "equipment") return generateEquipmentLines(data.inventory).join(", ");
  if (key === "cycle") return data.cycle?.enabled ? `Cycle de ${data.cycle.lengthDays} jours` : "";
  return data[key];
}

export default function ProfileTab({ profile, onSave, onAuthLost }) {
  // A profile with no name is a new install: open straight on the form.
  const setup = needsProfileSetup(profile);
  const [editing, setEditing] = useState(setup);
  const [draft, setDraft] = useState(() => (setup ? toEditDraft(profile) : null));
  const [errors, setErrors] = useState([]);
  const data = profile;
  const [toast, setToast] = useState(null);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  if (!editing) {
    return (
      <div>
        {/* Profile header */}
        <div className="bg-gradient-to-br from-[#D6EBFF] to-nav rounded-2xl p-6 mb-5 text-center elev-card">
          <div className="w-[72px] h-[72px] rounded-full bg-accent flex items-center justify-center mx-auto mb-3 text-[28px] text-white font-bold">
            {data.name?.[0] || "?"}
          </div>
          <h2 className="text-gray-800 text-[22px] font-bold m-0">{data.name}</h2>
          <p className="text-muted text-sm mt-1 mb-0">
            {filledProfileFields(data, {
              age: (v) => `${v} ans`, height: (v) => `${v} cm`, weight: (v) => `${v} kg`,
            }).join(" • ")}
          </p>
        </div>

        {/* Info rows */}
        {INFO_ROWS.map(([label, key]) => (infoValue(data, key) ? (
          <div key={label} className="bg-card rounded-xl px-4 py-3.5 mb-2 border border-border elev-card">
            <div className="text-muted text-xs mb-1">{label}</div>
            <div className="text-gray-600 text-sm whitespace-pre-line">{infoValue(data, key)}</div>
          </div>
        ) : null))}

        <button
          onClick={() => { setDraft(toEditDraft(profile)); setErrors([]); setEditing(true); }}
          className="w-full py-3.5 rounded-xl border border-border-light bg-transparent text-accent text-[15px] font-semibold cursor-pointer mt-4"
        >
          Modifier le profil
        </button>

        {/* Avancé */}
        <div className="mt-6 pt-6 border-t border-border">
          <h3 className="text-muted text-xs font-semibold mb-3">Avancé</h3>
          <button
            onClick={async () => {
              const client = getSyncClient();
              if (!client) {
                showToast("Synchronisation non configurée");
                return;
              }
              try {
                const sql = await client.downloadExport();
                const blob = new Blob([sql], { type: "application/sql" });
                const blobUrl = URL.createObjectURL(blob);
                const date = new Date().toISOString().split("T")[0];
                const a = document.createElement("a");
                a.href = blobUrl;
                a.download = `belle-forme-backup-${date}.sql`;
                a.click();
                URL.revokeObjectURL(blobUrl);
                showToast("Export SQL téléchargé.");
              } catch (err) {
                // The key was rotated: back to the gate, like any sync 401.
                if (err?.status === 401) {
                  onAuthLost?.(err);
                  return;
                }
                showToast("Impossible d'exporter.");
              }
            }}
            className="w-full py-3 rounded-xl border border-border-light bg-transparent text-gray-600 text-sm font-semibold cursor-pointer"
          >
            Export SQL (urgence)
          </button>
        </div>

        {/* Toast */}
        {toast && (
          <div className="fixed top-20 left-1/2 -translate-x-1/2 bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-semibold elev-overlay z-50">
            {toast}
          </div>
        )}
      </div>
    );
  }

  const set = (patch) => setDraft({ ...draft, ...patch });
  const setInventory = (patch) => set({ inventoryDraft: { ...draft.inventoryDraft, ...patch } });
  const toggleOwned = (token) => {
    const owned = draft.inventoryDraft.owned;
    setInventory({ owned: owned.includes(token) ? owned.filter((t) => t !== token) : [...owned, token] });
  };

  return (
    <div>
      {setup && (
        <div className="bg-card rounded-xl px-4 py-3.5 mb-5 border border-border elev-card">
          <div className="text-gray-800 text-[15px] font-semibold mb-1">Bienvenue</div>
          <div className="text-muted text-sm">
            Commence par ton profil : ton prénom, l'accord du coach, et le matériel dont tu disposes.
            Le coach s'appuie dessus pour tes charges et tes séances.
          </div>
        </div>
      )}
      {FIELDS.map(([key, label, type]) => (
        <div key={key} className="mb-4">
          <label htmlFor={`profile-${key}`} className={LABEL_CLASS}>{label}</label>
          <input
            id={`profile-${key}`}
            type={type}
            value={draft?.[key] ?? ""}
            onChange={e => set({ [key]: e.target.value })}
            className={INPUT_CLASS}
          />
        </div>
      ))}

      <div className="mb-4">
        <label htmlFor="profile-gender" className={LABEL_CLASS}>Le coach s'adresse à toi au</label>
        <select
          id="profile-gender"
          value={draft?.gender ?? ""}
          onChange={e => set({ gender: e.target.value })}
          className={INPUT_CLASS}
        >
          <option value="">— choisir —</option>
          <option value="f">féminin (elle)</option>
          <option value="m">masculin (il)</option>
        </select>
      </div>

      <div className="mb-4">
        <label htmlFor="profile-coachNotes" className={LABEL_CLASS}>
          Notes pour le coach (tes goûts, tes contraintes, ce que tu ne supportes plus)
        </label>
        <textarea
          id="profile-coachNotes"
          rows={4}
          value={draft?.coachNotes ?? ""}
          onChange={e => set({ coachNotes: e.target.value })}
          className={INPUT_CLASS}
        />
      </div>

      <div className="mb-4">
        <label className="flex items-center gap-2 text-gray-800 text-[15px]">
          <input
            type="checkbox"
            checked={draft?.cycleEnabled === true}
            onChange={e => set({ cycleEnabled: e.target.checked })}
          />
          Adapter les séances à mon cycle menstruel
        </label>
        {draft?.cycleEnabled && (
          <div className="mt-3">
            <label htmlFor="profile-cycleLengthDays" className={LABEL_CLASS}>
              Durée du cycle (jours, {CYCLE_LENGTH_RANGE_DAYS.min} à {CYCLE_LENGTH_RANGE_DAYS.max})
            </label>
            <input
              id="profile-cycleLengthDays"
              type="number"
              value={draft.cycleLengthDays}
              onChange={e => set({ cycleLengthDays: e.target.value })}
              className={INPUT_CLASS}
            />
            <div className="text-muted text-xs mt-1.5">
              Le coach te demande toujours où tu en es dans ton cycle : il ne le devine jamais.
            </div>
          </div>
        )}
      </div>

      <h3 className="text-muted text-xs font-semibold mt-6 mb-3">Matériel</h3>
      <div className="text-muted text-xs mb-3">
        Les charges proposées par le coach, et celles que l'app accepte, viennent de cette liste.
      </div>
      {[
        ["dumbbells", "Haltères réglables, par main (kg)", "2, 4, 6, 8"],
        ["barCount", "Barres chargeables (nombre)", "2"],
        ["barEmptyKg", "Poids d'une barre à vide (kg)", "2,5"],
        ["plates", "Disques (poids x quantité)", "5x4, 2x4"],
        ["ankleWeightKg", "Lest de cheville (kg)", "1,5"],
      ].map(([key, label, placeholder]) => (
        <div key={key} className="mb-4">
          <label htmlFor={`inventory-${key}`} className={LABEL_CLASS}>{label}</label>
          <input
            id={`inventory-${key}`}
            type="text"
            inputMode="decimal"
            placeholder={placeholder}
            value={draft?.inventoryDraft?.[key] ?? ""}
            onChange={e => setInventory({ [key]: e.target.value })}
            className={INPUT_CLASS}
          />
        </div>
      ))}
      <fieldset className="mb-4 border-0 p-0 m-0">
        <legend className={LABEL_CLASS}>Ce que tu as chez toi</legend>
        {EQUIPMENT_VOCABULARY.map((token) => (
          <label key={token} className="flex items-center gap-2 text-gray-800 text-[15px] mb-1.5">
            <input
              type="checkbox"
              checked={draft?.inventoryDraft?.owned?.includes(token) === true}
              onChange={() => toggleOwned(token)}
            />
            {EQUIPMENT_LABELS_FR[token]}
          </label>
        ))}
      </fieldset>

      {errors.length > 0 && (
        <ul role="alert" className="text-danger text-sm mb-4 pl-5 list-disc">
          {errors.map((message) => <li key={message}>{message}</li>)}
        </ul>
      )}
      <div className="flex gap-3">
        {!setup && (
          <button
            onClick={() => { setDraft(null); setErrors([]); setEditing(false); }}
            className="flex-1 py-3.5 rounded-xl border border-border-light bg-transparent text-muted text-[15px] cursor-pointer"
          >
            Annuler
          </button>
        )}
        <button
          onClick={() => {
            const result = fromEditDraft(draft);
            setErrors(result.errors);
            if (!result.profile) return;
            onSave(result.profile);
            setDraft(null);
            setEditing(false);
          }}
          className="flex-[2] py-3.5 rounded-xl border-none bg-accent text-white text-[15px] font-semibold cursor-pointer"
        >
          Sauvegarder
        </button>
      </div>
    </div>
  );
}
