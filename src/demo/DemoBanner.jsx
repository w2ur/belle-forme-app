import { resetDemo } from "./install.js";

/**
 * The demo's standing disclosure. Always on screen, above the app, so no
 * screenshot of the demo can pass for someone's real data.
 */
export default function DemoBanner() {
  const reset = () => {
    if (!confirm("Réinitialiser la démo ? Tes modifications seront effacées et les données fictives remises à zéro.")) return;
    resetDemo();
    window.location.reload();
  };
  return (
    // Below lg a compact 40px band that scrolls away with the page; sticky only
    // at lg, where there is height to spare.
    <aside aria-label="Démo" className="bg-accent text-white lg:sticky lg:top-0 lg:z-40">
      <div className="mx-auto flex h-10 max-w-[480px] items-center justify-between gap-3 px-5 sm:max-w-2xl lg:h-auto lg:max-w-none lg:px-10 lg:py-1.5">
        <p className="m-0 text-xs font-semibold lg:text-sm">Démo — données fictives</p>
        {/* A 26px box below lg, with the hit area stretched past 44px by the
            ::after; the global accent focus ring would vanish on the accent
            band, hence the white one. */}
        <button
          onClick={reset}
          className="relative z-10 cursor-pointer rounded-lg border border-white/50 bg-transparent px-2.5 py-1 text-xs font-semibold text-white
                     after:absolute after:inset-x-0 after:-top-[10px] after:-bottom-[12px] after:content-['']
                     focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white
                     lg:min-h-[44px] lg:px-3 lg:py-0 lg:text-sm lg:after:hidden"
        >
          Réinitialiser
        </button>
      </div>
    </aside>
  );
}
