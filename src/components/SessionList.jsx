import HeroPhoto from "./HeroPhoto.jsx";
import { Icons } from "./icons.jsx";
import { formatDate } from "../lib/helpers.js";
import { formatVolume, sessionVolume } from "../lib/stats.js";

export default function SessionList({ sessions, filterText, setFilterText, onNew, onSelect, onDuplicate }) {
  const filteredSessions = sessions.filter(s => {
    if (!filterText) return true;
    const ft = filterText.toLowerCase();
    return (
      s.name.toLowerCase().includes(ft) ||
      s.exercises.some(e => e.name.toLowerCase().includes(ft)) ||
      formatDate(s.date).toLowerCase().includes(ft)
    );
  });

  return (
    <>
      <div className="flex gap-2.5 mb-4">
        <div className="flex-1 relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-dark">
            <Icons.Search />
          </span>
          <input
            value={filterText}
            onChange={e => setFilterText(e.target.value)}
            placeholder="Rechercher..."
            className="w-full pl-9 pr-3.5 py-3 rounded-[10px] border border-border-light bg-card text-gray-800 text-[15px] box-border"
          />
        </div>
        <button
          onClick={onNew}
          className="flex items-center gap-1.5 px-4 rounded-[10px] border-none bg-accent text-white text-sm font-semibold cursor-pointer shadow-[0_4px_16px_var(--color-accent-glow)] whitespace-nowrap"
        >
          <Icons.Plus /> Séance
        </button>
      </div>

      {filteredSessions.length === 0 ? (
        <div className="text-center py-15 text-muted-dark">
          {sessions.length === 0 && <HeroPhoto name="warmup" className="mb-4 mx-auto" />}
          <p className="text-base">
            {sessions.length === 0 ? "La scène est vide, chérie" : "Aucun résultat"}
          </p>
          {sessions.length === 0 && (
            <p className="text-sm">Première séance ? Le rideau t'attend.</p>
          )}
        </div>
      ) : (
        filteredSessions
          .sort((a, b) => new Date(b.date) - new Date(a.date))
          .map(s => {
            const totalVol = sessionVolume(s);
            return (
              <div
                key={s.id}
                onClick={() => onSelect(s)}
                className="bg-card rounded-[14px] px-4 py-3.5 mb-2.5 border border-border cursor-pointer transition-colors hover:border-accent elev-card hover:elev-raised"
              >
                {/* One row: « Rejouer » sat alone on a second row, doubling the
                    card's height for one button. It keeps its word: a bare copy
                    glyph reads as "duplicate", and a title tooltip never shows
                    on the iPad. */}
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-gray-800 text-base font-semibold truncate">{s.name}</div>
                    <div className="text-muted text-[13px] mt-0.5">
                      {formatDate(s.date)} • {s.exercises.length} exos • {s.exercises.reduce((n, e) => n + e.sets.length, 0)} séries
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-accent font-bold text-[15px] font-mono">
                      {totalVol > 0 ? formatVolume(totalVol) : "—"}
                    </div>
                    {s.duration_minutes > 0 && (
                      <div className="text-muted-dark text-xs">{s.duration_minutes} min</div>
                    )}
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); onDuplicate(s); }}
                    className="flex shrink-0 items-center justify-center gap-1 rounded-md border border-border-light bg-transparent px-2.5 text-muted text-xs cursor-pointer min-h-[44px]"
                  >
                    <Icons.Copy /> Rejouer
                  </button>
                </div>
              </div>
            );
          })
      )}
    </>
  );
}
