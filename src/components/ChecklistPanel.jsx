import { Icons } from "./icons.jsx";

/**
 * Échauffement and retour au calme as first-class steps. They used to be
 * buried behind a "Détail" toggle in the plan card, which is where a warmup
 * goes to be ignored.
 */
export default function ChecklistPanel({ title, items, onToggle }) {
  if (!items.length) return null;
  return (
    <section className="mb-4">
      <h3 className="mb-2 font-serif text-sm font-semibold uppercase tracking-wide text-gold-text">{title}</h3>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={i}>
            <button
              onClick={() => onToggle(i)}
              aria-pressed={item.done}
              className="flex w-full min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border-none
                         bg-transparent px-2 text-left seance-control"
            >
              <span className={item.done ? "text-accent" : "text-muted-dark"}>
                {item.done ? <Icons.Check /> : <span className="block h-5 w-5 rounded border border-border-light" />}
              </span>
              <span className={item.done ? "text-muted line-through" : "text-gray-800"}>{item.name}</span>
              {item.detail && <span className="ml-auto font-mono text-muted">{item.detail}</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
