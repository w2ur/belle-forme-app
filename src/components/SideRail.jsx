import { Icons } from "./icons.jsx";
import SyncIndicator from "./SyncIndicator.jsx";

/**
 * The large-screen navigation. Two destinations only — Séance and Coach —
 * with Exercices, Timer and Profil demoted to a separated secondary group at
 * the foot. Hidden below `lg`, where BottomNav takes over; exactly one of the
 * two is ever visible.
 *
 * **The rail itself always mounts; `hideNavigation` only hides its buttons.**
 * It used to unmount entirely while the Exercices add/edit form was open —
 * the same stray-tap protection `BottomNav` gets below `lg` — but that took
 * `lg:pl-[88px]` out of sync (the layout kept reserving the gutter for a rail
 * that was gone) and, worse, took `SyncIndicator` with it: it renders inside
 * the rail, and nowhere else at `lg` and above, so the sync state disappeared
 * for the exact duration of an edit — the one moment a write is actually in
 * flight. Hiding only the two navigation groups keeps the marquee, divider
 * and `SyncIndicator` on screen and `lg:pl-[88px]` correct, while still
 * making a stray tap land on nothing.
 */
const DESTINATIONS = [
  { id: "session", icon: Icons.Dumbbell, label: "Séance" },
  { id: "coach", icon: Icons.Bot, label: "Coach" },
];

export default function SideRail({ tab, setTab, onSessionTab, onTimer, sync, hideNavigation }) {
  return (
    <nav
      aria-label="Navigation principale"
      className="hidden lg:flex fixed left-0 top-0 z-40 h-dvh w-[88px] flex-col items-center
                 border-r border-border bg-nav
                 pt-[max(env(safe-area-inset-top),1.5rem)]
                 pb-[max(env(safe-area-inset-bottom),1.5rem)]
                 pl-[env(safe-area-inset-left)]"
    >
      {/* Marquee */}
      <div className="flex flex-col items-center">
        <span
          className="font-serif text-[15px] font-bold tracking-[0.28em] text-gray-800 select-none
                     [writing-mode:vertical-rl]"
        >
          BELLE FORME
        </span>
        {/* Decorative divider only, not text — `text-gold` here sets currentColor on the SVG
            ornament, which contrast.test.js's guard explicitly allow-lists for this file. */}
        <span className="mt-3 text-gold">
          <Icons.ArtDecoDivider />
        </span>
        <span className="mt-2">
          <SyncIndicator {...sync} stacked />
        </span>
      </div>

      {!hideNavigation && (
        <>
          {/* Primary destinations */}
          <div className="mt-8 flex w-full flex-col items-center gap-1">
            {DESTINATIONS.map((d) => {
              const active = tab === d.id;
              return (
                <button
                  key={d.id}
                  onClick={() => {
                    setTab(d.id);
                    if (d.id === "session" && onSessionTab) onSessionTab();
                  }}
                  aria-current={active ? "page" : undefined}
                  className={`flex w-[72px] cursor-pointer flex-col items-center gap-1 rounded-xl border-none
                              py-3 text-[12px] transition-colors ${
                                active
                                  ? "bg-card font-semibold text-accent"
                                  : "bg-transparent font-normal text-muted"
                              }`}
                >
                  <d.icon />
                  {d.label}
                </button>
              );
            })}
          </div>

          {/* Secondary group, spatially separated from the destinations above */}
          <div className="mt-auto flex w-full flex-col items-center gap-1 border-t border-border pt-4">
            <button
              onClick={() => setTab("exercises")}
              aria-current={tab === "exercises" ? "page" : undefined}
              className={`flex w-[72px] cursor-pointer flex-col items-center gap-1 rounded-xl border-none
                          py-3 text-[12px] ${
                            tab === "exercises"
                              ? "bg-card font-semibold text-accent"
                              : "bg-transparent text-muted"
                          }`}
            >
              <Icons.Book />
              Exercices
            </button>
            <button
              onClick={onTimer}
              className="flex w-[72px] cursor-pointer flex-col items-center gap-1 rounded-xl border-none
                         bg-transparent py-3 text-[12px] text-muted"
            >
              <Icons.Clock />
              Timer
            </button>
            <button
              onClick={() => setTab("profile")}
              aria-current={tab === "profile" ? "page" : undefined}
              className={`flex w-[72px] cursor-pointer flex-col items-center gap-1 rounded-xl border-none
                          py-3 text-[12px] ${
                            tab === "profile"
                              ? "bg-card font-semibold text-accent"
                              : "bg-transparent text-muted"
                          }`}
            >
              <Icons.User />
              Profil
            </button>
          </div>
        </>
      )}
    </nav>
  );
}
