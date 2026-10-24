import { Icons } from "./icons.jsx";

/** A séance survived a reload or a closed tab. It is the first thing she sees. */
export default function ResumeCard({ state, onResume, onAbandon }) {
  const position = Math.min(state.cursor.exercise + 1, state.exercises.length);
  return (
    <div className="mb-5 flex flex-wrap items-center gap-3 rounded-[14px] border border-accent bg-accent/10 p-4 elev-raised">
      {/* Full row on a phone: sharing it with two buttons squeezed the label to
          about 60px, so "Séance en cours" wrapped onto three lines. */}
      <div className="w-full min-w-0 sm:w-auto sm:flex-1">
        <p className="m-0 font-serif text-base font-semibold text-gray-800">Séance en cours</p>
        <p className="m-0 text-sm text-muted">
          {state.name} — exercice {position}/{state.exercises.length}
        </p>
      </div>
      <button onClick={onResume}
              className="flex min-h-[44px] cursor-pointer items-center gap-1.5 rounded-xl border-none bg-accent px-4 text-sm font-semibold text-white">
        <Icons.Play /> Reprendre
      </button>
      <button onClick={() => { if (confirm("Abandonner cette séance ? Ce qui est validé sera perdu.")) onAbandon(); }}
              className="min-h-[44px] cursor-pointer rounded-xl border border-border-light bg-transparent px-4 text-sm font-semibold text-muted">
        Abandonner
      </button>
    </div>
  );
}
