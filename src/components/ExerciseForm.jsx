import { useState } from "react";
import {
  GROUP_CHOICES,
  IMPLEMENT_CHOICES,
  EQUIPMENT_CHOICES,
  BAR_HEIGHT_CHOICES,
  METRIC_CHOICES,
  implementChoiceOf,
  groupLabel,
} from "../lib/catalogForm.js";

/**
 * The guided add/edit form for one catalog exercise.
 *
 * Controlled inputs over a local draft, committed by `onSubmit`. It decides
 * nothing: the draft → document edit lives in `catalogForm.js` and the verdict
 * in `catalog.js`, both pure and both tested. This renders fields and hands
 * back an entry.
 *
 * Blocking errors from a refused save are rendered by `ExercisesTab`, above
 * whichever view is showing, rather than here: « Désactiver » runs from the
 * LIST, so errors that lived in this component were invisible on exactly the
 * path that had no other feedback.
 *
 * @param {object|null} entry - the exercise to edit, or a blank one to add.
 * @param {string|null} originalName - what it was called when the form opened.
 */
export default function ExerciseForm({ entry, originalName, onSubmit, onCancel }) {
  const [draft, setDraft] = useState(entry);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  const choice = implementChoiceOf(draft.implementTypes);
  const needsBar = (draft.equipmentNeeds ?? []).includes("pullup_bar");
  const isRename = Boolean(originalName) && draft.name.trim() !== originalName;

  const toggleEquipment = (token) => {
    const has = (draft.equipmentNeeds ?? []).includes(token);
    const next = has
      ? draft.equipmentNeeds.filter((t) => t !== token)
      : [...(draft.equipmentNeeds ?? []), token];
    // Un-ticking the pull-up bar takes the height with it. Otherwise the
    // document keeps a height for a bar it no longer needs, which the
    // validator refuses — with a message about a field she can no longer see.
    set({ equipmentNeeds: next, barHeight: next.includes("pullup_bar") ? draft.barHeight : null });
  };

  const submit = () => {
    onSubmit({ ...draft, name: draft.name.trim() });
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-4 elev-raised">
      <Field label="Nom">
        <input
          type="text"
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
          className="w-full box-border rounded-[10px] border border-border-light bg-card px-3.5 py-3 text-[15px] text-gray-800"
        />
      </Field>

      {/* Renaming is permanent and she is the only person who can weigh it, so
          it is said plainly rather than prevented. An exercise name is the key
          for her whole history — the alias is what keeps the history attached,
          and it can never be taken back out. */}
      {isRename && (
        <p className="-mt-3 mb-5 rounded-xl border border-gold/40 bg-gold/10 px-3 py-2 text-xs text-muted">
          Renommer un exercice crée un alias permanent. L'historique suit, mais l'ancien nom
          « {originalName} » reste réservé pour toujours.
        </p>
      )}

      <Field label="Groupe">
        <select
          value={draft.group}
          onChange={(e) => set({ group: e.target.value })}
          className="w-full box-border rounded-[10px] border border-border-light bg-card px-3.5 py-3 text-[15px] text-gray-800"
        >
          {GROUP_CHOICES.map((g) => <option key={g} value={g}>{groupLabel(g)}</option>)}
        </select>
      </Field>

      <Field label="Définition" hint="Ce que le mouvement est, en une phrase.">
        <textarea
          rows={2}
          value={draft.description}
          onChange={(e) => set({ description: e.target.value })}
          className="w-full box-border resize-y rounded-[10px] border border-border-light bg-card px-3.5 py-3 text-[15px] text-gray-800"
        />
      </Field>

      {/* `intent` is the one field the coach never sees (owner ruling,
          2026-08-11): it is editorial rationale for the user, and injecting it cost
          +2 632 tokens on every single request. The hint says so, because a
          field whose audience is invisible gets written for the wrong reader. */}
      <Field label="À quoi ça sert" hint="Pour toi seulement — le coach ne lit pas cette ligne.">
        <textarea
          rows={2}
          value={draft.intent}
          onChange={(e) => set({ intent: e.target.value })}
          className="w-full box-border resize-y rounded-[10px] border border-border-light bg-card px-3.5 py-3 text-[15px] text-gray-800"
        />
      </Field>

      <Field label="Conseils d'exécution">
        <textarea
          rows={2}
          value={draft.formCues}
          onChange={(e) => set({ formCues: e.target.value })}
          className="w-full box-border resize-y rounded-[10px] border border-border-light bg-card px-3.5 py-3 text-[15px] text-gray-800"
        />
      </Field>

      {/* Seven radios, never a set of ticks: this decides whether a weight is
          read as per-hand or as a total, which is ambiguous by a factor of two,
          so a hand-composed combination is not something the form can produce. */}
      <Field label="Comment ça se charge">
        <div className="space-y-1.5">
          {IMPLEMENT_CHOICES.map((c) => (
            <label key={c.id} className="flex min-h-[36px] items-center gap-2.5 text-sm text-gray-800">
              <input
                type="radio"
                name="implement"
                checked={choice?.id === c.id}
                onChange={() => set({ implementTypes: [...c.implementTypes] })}
                className="accent-accent"
              />
              {c.label}
            </label>
          ))}
        </div>
      </Field>

      <Field label="Matériel nécessaire">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          {EQUIPMENT_CHOICES.map(({ token, label }) => (
            <label key={token} className="flex min-h-[36px] items-center gap-2.5 text-sm text-gray-800">
              <input
                type="checkbox"
                checked={(draft.equipmentNeeds ?? []).includes(token)}
                onChange={() => toggleEquipment(token)}
                className="accent-accent"
              />
              {label}
            </label>
          ))}
        </div>
      </Field>

      {/* Two radios for the same reason there are seven above: the unit used to
          live inside the `reps` string as a suffix the coach wrote, and a bare
          `45` meant either 45 repetitions or 45 seconds depending on prose. */}
      <Field label="Comment on compte une série">
        <div className="space-y-1.5">
          {METRIC_CHOICES.map((c) => (
            <label key={c.id} className="flex min-h-[36px] items-center gap-2.5 text-sm text-gray-800">
              <input
                type="radio"
                name="metric"
                checked={(draft.metric ?? "reps") === c.id}
                onChange={() => set({ metric: c.id })}
                className="accent-accent"
              />
              {c.label}
            </label>
          ))}
        </div>
        <div className="mt-2">
          <Toggle
            checked={Boolean(draft.perSide)}
            onChange={(perSide) => set({ perSide })}
            label="Comptées par côté"
          />
        </div>
      </Field>

      <Field label="Charge maximale" hint="Un plafond que le coach ne dépassera jamais.">
        <Toggle
          checked={Boolean(draft.ceiling)}
          onChange={(on) => set({ ceiling: on ? { maxKg: 10, unit: "total" } : null })}
          label="Plafonner la charge"
        />
        {draft.ceiling && (
          <div className="mt-2 flex items-center gap-2">
            <input
              type="number"
              inputMode="decimal"
              step="0.5"
              value={draft.ceiling.maxKg}
              onChange={(e) => set({ ceiling: { ...draft.ceiling, maxKg: Number(e.target.value) } })}
              className="w-24 box-border rounded-[10px] border border-border-light bg-card px-3 py-2.5 text-center font-mono text-[15px] text-gray-800"
            />
            <span className="text-sm text-muted">kg</span>
            {[["total", "au total"], ["per_hand", "par main"]].map(([unit, label]) => (
              <label key={unit} className="flex min-h-[36px] items-center gap-1.5 text-sm text-gray-800">
                <input
                  type="radio"
                  name="ceiling-unit"
                  checked={draft.ceiling.unit === unit}
                  onChange={() => set({ ceiling: { ...draft.ceiling, unit } })}
                  className="accent-accent"
                />
                {label}
              </label>
            ))}
          </div>
        )}
      </Field>

      {/* Only when the bar is ticked. A height without a bar is refused by the
          validator, so offering it would be offering a rejection. */}
      {needsBar && (
        <Field label="Hauteur de barre" hint="La barre est réglée à une seule hauteur par séance.">
          <div className="space-y-1.5">
            {BAR_HEIGHT_CHOICES.map(({ value, label }) => (
              <label key={value} className="flex min-h-[36px] items-center gap-2.5 text-sm text-gray-800">
                <input
                  type="radio"
                  name="bar-height"
                  checked={draft.barHeight === value}
                  onChange={() => set({ barHeight: value })}
                  className="accent-accent"
                />
                {label}
              </label>
            ))}
          </div>
        </Field>
      )}

      {/* Deactivating never deletes: the exercise stays in the lexique and in
          the manual picker so she can still log it by hand, and every session
          that recorded it still renders. The reason is what the coach is told;
          without one the exercise is simply absent from its catalog. */}
      <Field label="Disponibilité">
        <Toggle
          checked={draft.active !== false}
          onChange={(active) =>
            set(active
              ? { active: true, inactiveReason: null, replacedBy: null, deactivatedAt: null }
              : { active: false })
          }
          label="Actif"
        />
        {draft.active === false && (
          <div className="mt-2 space-y-2">
            <input
              type="text"
              placeholder="Pourquoi (le coach le lit)"
              value={draft.inactiveReason ?? ""}
              onChange={(e) => set({ inactiveReason: e.target.value || null })}
              className="w-full box-border rounded-[10px] border border-border-light bg-card px-3.5 py-2.5 text-sm text-gray-800"
            />
            <input
              type="text"
              placeholder="Remplacé par (facultatif)"
              value={draft.replacedBy ?? ""}
              onChange={(e) => set({ replacedBy: e.target.value || null })}
              className="w-full box-border rounded-[10px] border border-border-light bg-card px-3.5 py-2.5 text-sm text-gray-800"
            />
          </div>
        )}
      </Field>

      <div className="flex gap-3">
        <button
          onClick={onCancel}
          className="flex-1 rounded-xl border border-border-light bg-transparent py-3.5 text-[15px] text-muted"
        >
          Annuler
        </button>
        <button
          onClick={submit}
          className="flex-[2] rounded-xl border-none bg-accent py-3.5 text-[15px] font-semibold text-white"
        >
          Enregistrer
        </button>
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div className="mb-5">
      <label className="mb-1.5 block text-[13px] text-muted">{label}</label>
      {hint && <p className="mb-1.5 text-[11px] text-muted-darker">{hint}</p>}
      {children}
    </div>
  );
}

/**
 * A checkbox that reads as a switch. Deliberately a real `<input>` rather than
 * a styled div: the app has no component library and a keyboard-reachable,
 * screen-reader-labelled control for free beats a bespoke one that looks
 * slightly better.
 */
function Toggle({ checked, onChange, label }) {
  return (
    <label className="flex min-h-[36px] items-center gap-2.5 text-sm text-gray-800">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-accent"
      />
      {label}
    </label>
  );
}
