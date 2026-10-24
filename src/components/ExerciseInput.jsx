import { useState, useEffect, useRef } from "react";
import { getExerciseGroup } from "../lib/helpers.js";

/**
 * `catalog` is a `buildCatalogViews` result, or null before the first pull —
 * passed straight through to `getExerciseGroup` for the group badge next to
 * each suggestion. `allExercises` still drives the suggestion list itself, so
 * the picker keeps working with no catalog at all; only the badge degrades.
 */
export default function ExerciseInput({ value, onChange, allExercises, catalog }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const ref = useRef(null);

  const suggestions = allExercises
    .filter(e => e.toLowerCase().includes((filter || value).toLowerCase()))
    .slice(0, 8);

  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div ref={ref} className="relative flex-1">
      <input
        value={value}
        onChange={e => { onChange(e.target.value); setFilter(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="Nom de l'exercice"
        className="w-full px-3 py-2.5 rounded-[10px] border border-border-light bg-card text-gray-800 text-base box-border"
      />
      {open && suggestions.length > 0 && (
        <div className="absolute top-full left-0 right-0 z-[100] bg-surface rounded-[10px] border border-border-light max-h-[200px] overflow-y-auto mt-1 elev-overlay">
          {suggestions.map(s => (
            <div
              key={s}
              onClick={() => { onChange(s); setOpen(false); }}
              className="px-3.5 py-2.5 cursor-pointer text-gray-600 text-sm border-b border-border hover:bg-border-light transition-colors"
            >
              <span className="text-muted text-[11px] mr-2">{getExerciseGroup(s, catalog)}</span>{s}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
