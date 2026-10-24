import { useRegisterSW } from 'virtual:pwa-register/react';
import { checkForSwUpdate } from '../lib/swUpdate.js';

export default function PWAUpdateToast() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered(r) {
      // A resident PWA only checks for a new service worker on navigation;
      // an installed app can stay open for days, so poll and re-check on focus.
      if (!r) return;
      // Offline, update() rejects; a failed check is simply retried next time.
      const check = () => { checkForSwUpdate(r, navigator.onLine); };
      setInterval(check, 60 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    },
    onRegisterError() {},
  });

  if (!needRefresh) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-gray-800 text-white px-4 py-3 rounded-2xl elev-overlay text-sm font-semibold max-w-[calc(100vw-2rem)]"
    >
      <span>Nouvelle version disponible</span>
      <button
        onClick={() => updateServiceWorker(true)}
        className="bg-accent text-white px-3 py-1 rounded-xl text-xs font-bold cursor-pointer min-h-[44px]"
      >
        Mettre à jour
      </button>
      <button
        onClick={() => setNeedRefresh(false)}
        aria-label="Ignorer"
        className="text-white cursor-pointer text-base leading-none min-h-[44px] min-w-[44px]"
      >
        ✕
      </button>
    </div>
  );
}
