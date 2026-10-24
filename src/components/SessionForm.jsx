import { useState } from "react";
import { generateId, today } from "../lib/helpers.js";
import { Icons } from "./icons.jsx";
import { describeExercise } from "../lib/catalog.js";
import ExerciseInput from "./ExerciseInput.jsx";

function emptySession() {
  return {
    id: generateId(),
    date: today(),
    name: "",
    exercises: [{ name: "", sets: [{ reps: "", weight: "", notes: "" }] }],
    duration_minutes: "",
    general_notes: "",
  };
}

/**
 * `catalog` is a `buildCatalogViews` result, or null before the first pull. It
 * only decorates the form — the « par côté » badge and the charge label — so a
 * null catalog costs two hints, never the ability to record a séance.
 * `allExerciseNames` still carries every name she has recorded before, so the
 * picker keeps working too.
 */
export default function SessionForm({ session, onSave, onCancel, allExerciseNames, catalog }) {
  const [data, setData] = useState(session || emptySession());

  const updateExercise = (i, field, val) => {
    const ex = [...data.exercises];
    ex[i] = { ...ex[i], [field]: val };
    // Naming the exercise is what decides whether its sets are repetitions or
    // seconds, so the unit is stamped here rather than read from the catalog
    // whenever the record is displayed. Same rule as everywhere else: absent
    // means repetitions, so only "seconds" is written.
    // Guarded on the catalog being USABLE. `describeExercise` resolves the
    // alias and returns null without a catalog, but the `delete` below must not
    // run in either case: it would silently demote a 25-second hold, seeded
    // correctly by `draftFromPlanned`, into 25 repetitions the moment she
    // retyped the name.
    if (field === "name" && catalog) {
      const metric = describeExercise(val, catalog)?.metric;
      if (metric === "seconds") ex[i].metric = "seconds";
      else delete ex[i].metric;
    }
    setData({ ...data, exercises: ex });
  };

  const updateSet = (ei, si, field, val) => {
    const ex = [...data.exercises];
    const sets = [...ex[ei].sets];
    sets[si] = { ...sets[si], [field]: val };
    ex[ei] = { ...ex[ei], sets };
    setData({ ...data, exercises: ex });
  };

  const addSet = (ei) => {
    const ex = [...data.exercises];
    const lastSet = ex[ei].sets[ex[ei].sets.length - 1];
    ex[ei] = { ...ex[ei], sets: [...ex[ei].sets, { reps: lastSet?.reps || "", weight: lastSet?.weight || "", notes: "" }] };
    setData({ ...data, exercises: ex });
  };

  const removeSet = (ei, si) => {
    const ex = [...data.exercises];
    ex[ei] = { ...ex[ei], sets: ex[ei].sets.filter((_, j) => j !== si) };
    setData({ ...data, exercises: ex });
  };

  const addExercise = () => {
    setData({ ...data, exercises: [...data.exercises, { name: "", sets: [{ reps: "", weight: "", notes: "" }] }] });
  };

  const removeExercise = (i) => {
    setData({ ...data, exercises: data.exercises.filter((_, j) => j !== i) });
  };

  const canSave = data.name.trim() && data.date && data.exercises.some(e => e.name.trim());

  return (
    <div>
      {/* Date */}
      <div className="mb-5">
        <label className="block text-muted text-[13px] mb-1.5">Date</label>
        <input
          type="date"
          value={data.date}
          onChange={e => setData({ ...data, date: e.target.value })}
          className="w-full px-3.5 py-3 rounded-[10px] border border-border-light bg-card text-gray-800 text-base box-border"
        />
      </div>

      {/* Session name */}
      <div className="mb-5">
        <label className="block text-muted text-[13px] mb-1.5">Nom de la séance</label>
        <input
          value={data.name}
          onChange={e => setData({ ...data, name: e.target.value })}
          placeholder="Ex : Haut du corps, Jambes, Corps entier…"
          className="w-full px-3.5 py-3 rounded-[10px] border border-border-light bg-card text-gray-800 text-base box-border"
        />
      </div>

      {/* Exercises */}
      {data.exercises.map((ex, ei) => (
        <div key={ei} className="bg-card rounded-[14px] p-4 mb-4 border border-border elev-card">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-accent font-bold text-sm min-w-[24px]">#{ei + 1}</span>
            <ExerciseInput value={ex.name} onChange={v => updateExercise(ei, "name", v)} allExercises={allExerciseNames} catalog={catalog} />
            {(() => {
              // Through `describeExercise`, like the metric write above and
              // unlike the raw key read this used to do: a retired name got
              // `undefined` and lost its badge silently.
              const info = describeExercise(ex.name, catalog);
              return (info && typeof info !== "string" && info.perSide)
                ? <span className="text-[10px] bg-surface text-muted px-1.5 py-0.5 rounded whitespace-nowrap">par côté</span>
                : null;
            })()}
            {data.exercises.length > 1 && (
              <button onClick={() => removeExercise(ei)} aria-label="Retirer l'exercice" className="bg-transparent border-none text-muted-dark cursor-pointer p-1.5 rounded-lg flex items-center justify-center min-h-[44px] min-w-[44px]">
                <Icons.Trash />
              </button>
            )}
          </div>

          {/* Sets header */}
          <div className="flex gap-2 mb-1.5 pl-8">
            <span className="flex-1 text-[11px] text-muted-dark">
              {ex.metric === "seconds" ? "Secondes" : "Reps"}
            </span>
            <span className="flex-1 text-[11px] text-muted-dark">
              {(() => {
                if (ex.weightType === "per_hand") return "Charge/main (kg)";
                if (ex.weightType === "total") return "Charge totale (kg)";
                const info = describeExercise(ex.name, catalog);
                if (info && typeof info !== "string" && info.bilateral) return "Charge/main (kg)";
                return "Charge (kg)";
              })()}
            </span>
            <span className="w-7" />
          </div>

          {/* Sets */}
          {ex.sets.map((set, si) => (
            <div key={si} className="flex items-center gap-2 mb-1.5">
              <span className="text-xs text-muted-darker w-6 text-right font-mono">{si + 1}</span>
              {/* NOT type="number". `draftFromPlanned` seeds this from the
                  plan, and a held exercise seeded "45s" — which a number input
                  rejects outright, so the box rendered EMPTY and she could not
                  type it back. That is the whole « Noter » path for any hold.
                  `inputMode="decimal"` keeps the numeric keypad on iPad. */}
              <input
                type="text"
                inputMode="decimal"
                value={set.reps}
                onChange={e => updateSet(ei, si, "reps", e.target.value)}
                placeholder={ex.metric === "seconds" ? "30" : "10"}
                className="flex-1 min-w-0 px-2.5 py-2 rounded-lg border border-border-light bg-card text-gray-800 text-base text-center font-mono box-border"
              />
              <input
                type="number"
                value={set.weight}
                onChange={e => updateSet(ei, si, "weight", e.target.value)}
                placeholder="0"
                step="0.5"
                className="flex-1 min-w-0 px-2.5 py-2 rounded-lg border border-border-light bg-card text-gray-800 text-base text-center font-mono box-border"
              />
              {ex.sets.length > 1 ? (
                <button onClick={() => removeSet(ei, si)} aria-label="Retirer la série" className="bg-transparent border-none text-muted-dark cursor-pointer p-1 rounded-lg flex items-center justify-center min-h-[44px] min-w-[44px]">
                  <Icons.X />
                </button>
              ) : <div className="min-w-[44px]" />}
            </div>
          ))}

          <button onClick={() => addSet(ei)} className="flex items-center gap-1.5 bg-transparent border-none text-accent text-[13px] cursor-pointer mt-2 ml-8 min-h-[44px]">
            <Icons.Plus /> Ajouter une série
          </button>
        </div>
      ))}

      {/* Add exercise */}
      <button onClick={addExercise} className="flex items-center justify-center gap-2 w-full py-3.5 rounded-xl border-2 border-dashed border-border-light bg-transparent text-accent text-[15px] font-semibold cursor-pointer mb-5">
        <Icons.Plus /> Ajouter un exercice
      </button>

      {/* Duration */}
      <div className="mb-5">
        <label className="block text-muted text-[13px] mb-1.5">Durée (min)</label>
        <input
          type="number"
          value={data.duration_minutes}
          onChange={e => setData({ ...data, duration_minutes: e.target.value })}
          placeholder="55"
          className="w-full px-3.5 py-3 rounded-[10px] border border-border-light bg-card text-gray-800 text-base box-border"
        />
      </div>

      {/* Notes */}
      <div className="mb-5">
        <label className="block text-muted text-[13px] mb-1.5">Notes générales</label>
        <textarea
          value={data.general_notes}
          onChange={e => setData({ ...data, general_notes: e.target.value })}
          placeholder="Sensations, énergie, remarques..."
          rows={2}
          className="w-full px-3.5 py-3 rounded-[10px] border border-border-light bg-card text-gray-800 text-base box-border resize-y"
        />
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <button onClick={onCancel} className="flex-1 py-3.5 rounded-xl border border-border-light bg-transparent text-muted text-[15px] font-semibold cursor-pointer">
          Annuler
        </button>
        <button
          onClick={() => canSave && onSave(data)}
          disabled={!canSave}
          className={`flex-[2] py-3.5 rounded-xl border-none text-[15px] font-semibold ${
            canSave
              ? "bg-accent text-white cursor-pointer shadow-[0_4px_16px_var(--color-accent-glow)]"
              : "bg-border-light text-muted-dark cursor-default"
          }`}
        >
          <span className="flex items-center justify-center gap-2">
            <Icons.Check /> Enregistrer
          </span>
        </button>
      </div>
    </div>
  );
}
