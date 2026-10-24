import { Icons } from "./icons.jsx";

const TABS = [
  { id: "session", icon: Icons.Dumbbell, label: "Séance" },
  { id: "coach", icon: Icons.Bot, label: "Coach" },
  { id: "exercises", icon: Icons.Book, label: "Exercices" },
  { id: "profile", icon: Icons.User, label: "Profil" },
];

export default function BottomNav({ tab, setTab, onSessionTab }) {
  return (
    <nav
      aria-label="Navigation principale"
      className="lg:hidden fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[480px] sm:max-w-2xl bg-nav border-t border-border flex z-40 pb-[env(safe-area-inset-bottom,12px)] pt-2 elev-raised-up"
    >
      {TABS.map(t => (
        <button
          key={t.id}
          onClick={() => {
            setTab(t.id);
            if (t.id === "session" && onSessionTab) onSessionTab();
          }}
          aria-current={tab === t.id ? "page" : undefined}
          className={`flex-1 flex flex-col items-center gap-[3px] py-2 bg-transparent border-none cursor-pointer text-[11px] transition-colors ${
            tab === t.id ? "text-accent font-semibold" : "text-muted-darker"
          }`}
        >
          <t.icon />
          {t.label}
        </button>
      ))}
    </nav>
  );
}
