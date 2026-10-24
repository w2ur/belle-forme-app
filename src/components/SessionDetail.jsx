import { formatDate } from "../lib/helpers.js";
import { formatRecordedLoad, formatRepsWithUnit, formatVolume, sessionVolume } from "../lib/stats.js";
import { Icons } from "./icons.jsx";

export default function SessionDetail({ session, onClose, onEdit, onDelete }) {
  const totalVolume = sessionVolume(session);

  return (
    <div>
      <button onClick={onClose} className="bg-transparent border-none text-accent text-sm cursor-pointer mb-4 flex items-center gap-1">
        ← Retour
      </button>

      <div className="flex justify-between items-start mb-5">
        <div>
          <h2 className="text-gray-800 text-[22px] font-bold m-0">{session.name}</h2>
          <p className="text-muted text-sm mt-1 mb-0">
            {formatDate(session.date)} {session.duration_minutes && `• ${session.duration_minutes} min`}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={onEdit} aria-label="Modifier la séance" className="bg-transparent border-none text-accent cursor-pointer p-1.5 rounded-lg flex items-center justify-center min-h-[44px] min-w-[44px]">
            <Icons.Edit />
          </button>
          <button
            onClick={() => { if (confirm("Supprimer cette séance, darling ?")) onDelete(session.id); }}
            aria-label="Supprimer la séance"
            className="bg-transparent border-none text-danger cursor-pointer p-1.5 rounded-lg flex items-center justify-center min-h-[44px] min-w-[44px]"
          >
            <Icons.Trash />
          </button>
        </div>
      </div>

      {/* Summary stats */}
      <div className="bg-gradient-to-br from-[#D6EBFF] to-nav rounded-[14px] p-4 mb-5 flex gap-5 elev-card">
        <div>
          <div className="text-muted text-xs">Exercices</div>
          <div className="text-gray-800 text-xl font-bold font-mono">{session.exercises.length}</div>
        </div>
        <div>
          <div className="text-muted text-xs">Séries</div>
          <div className="text-gray-800 text-xl font-bold font-mono">
            {session.exercises.reduce((s, e) => s + e.sets.length, 0)}
          </div>
        </div>
        <div>
          <div className="text-muted text-xs">Volume total</div>
          <div className="text-accent text-xl font-bold font-mono">{formatVolume(totalVolume)}</div>
        </div>
      </div>

      {/* Exercise details */}
      {session.exercises.map((ex, i) => (
        <div key={i} className="bg-card rounded-[14px] p-4 mb-3 border border-border elev-card">
          <div className="text-gray-800 text-base font-semibold mb-2.5">{ex.name}</div>
          {ex.sets.map((set, si) => (
            <div
              key={si}
              className={`flex items-center gap-3 py-1.5 ${si < ex.sets.length - 1 ? "border-b border-border" : ""}`}
            >
              <span className="text-muted-darker text-[13px] w-6 font-mono">{si + 1}</span>
              <span className="text-gray-600 text-[15px] font-mono">
                {ex.metric === "seconds" ? formatRepsWithUnit(set.reps, ex.metric) : `${set.reps} reps`}
              </span>
              {formatRecordedLoad(set.weight, ex.weightType) && (
                <span className="text-accent text-[15px] font-semibold font-mono">{formatRecordedLoad(set.weight, ex.weightType)}</span>
              )}
              {set.notes && <span className="text-muted text-xs italic">{set.notes}</span>}
            </div>
          ))}
        </div>
      ))}

      {/* General notes */}
      {session.general_notes && (
        <div className="bg-card rounded-[14px] p-4 border border-border elev-card">
          <div className="text-muted text-[13px] mb-1.5">Notes</div>
          <div className="text-gray-600 text-sm">{session.general_notes}</div>
        </div>
      )}
    </div>
  );
}
