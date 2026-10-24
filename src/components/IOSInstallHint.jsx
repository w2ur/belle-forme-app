import { useState, useEffect } from 'react';

const STORAGE_KEY = 'belle-forme-ios-hint-dismissed';

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function isInStandaloneMode() {
  return window.matchMedia('(display-mode: standalone)').matches
    || navigator.standalone === true;
}

export default function IOSInstallHint() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (
      isIOS()
      && !isInStandaloneMode()
      && !localStorage.getItem(STORAGE_KEY)
    ) {
      setVisible(true);
    }
  }, []);

  const dismiss = () => {
    localStorage.setItem(STORAGE_KEY, '1');
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div
      role="complementary"
      aria-label="Astuce d'installation"
      className="fixed bottom-20 left-4 right-4 z-50 bg-card border border-border rounded-2xl elev-overlay px-4 py-3 flex items-start gap-3 max-w-[480px] mx-auto"
    >
      <div className="flex-1 text-sm text-gray-800">
        <p className="font-semibold mb-0.5">Installer Belle Forme</p>
        <p className="text-muted text-xs">
          Appuyez sur{' '}
          <span aria-label="partager" className="inline-block align-middle text-accent font-bold">⬆</span>
          {' '}puis &laquo;&nbsp;Sur l&apos;écran d&apos;accueil&nbsp;&raquo; pour accéder hors ligne.
        </p>
      </div>
      <button
        onClick={dismiss}
        aria-label="Fermer"
        className="text-muted cursor-pointer text-base leading-none mt-0.5 shrink-0"
      >
        ✕
      </button>
    </div>
  );
}
