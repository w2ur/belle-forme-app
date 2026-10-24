import { useState, useEffect, useRef } from "react";
import { TIMER_PRESETS } from "../constants/index.js";
import { Icons } from "./icons.jsx";
import { remainingSeconds, secondsToStart } from "../lib/countdown.js";

// One AudioContext per Timer, created on the Start tap (a context created
// outside a user gesture starts suspended on iOS, and iOS caps how many exist).
function ensureAudio(audioRef) {
  try {
    if (!audioRef.current) {
      audioRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    audioRef.current.resume?.();
  } catch { /* no audio: vibration and the visual state remain */ }
}

function ring(audioRef) {
  try {
    // Auto-started timers have no Start tap: create lazily, best effort.
    ensureAudio(audioRef);
    const ctx = audioRef.current;
    if (!ctx) return;
    [0, 200, 400].forEach(delay => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      osc.type = "sine";
      gain.gain.value = 0.3;
      osc.start(ctx.currentTime + delay / 1000);
      osc.stop(ctx.currentTime + delay / 1000 + 0.15);
    });
  } catch { /* silent */ }
}

export default function Timer({ isVisible, onClose, initialSeconds, autoStart }) {
  const [selectedTime, setSelectedTime] = useState(90);
  const [customTime, setCustomTime] = useState("");
  const [timeLeft, setTimeLeft] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const intervalRef = useRef(null);
  const endAtRef = useRef(0);
  const audioRef = useRef(null);
  const wakeLockRef = useRef(null);

  const acquireWakeLock = async () => {
    if (!("wakeLock" in navigator)) return;
    try {
      wakeLockRef.current = await navigator.wakeLock.request("screen");
    } catch {
      // Wake Lock refused (e.g. low battery) — silent degradation
    }
  };

  const releaseWakeLock = () => {
    if (wakeLockRef.current) {
      wakeLockRef.current.release();
      wakeLockRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      releaseWakeLock();
      try { audioRef.current?.close(); } catch { /* already closed */ }
      audioRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (initialSeconds && initialSeconds > 0) {
      setSelectedTime(initialSeconds);
      if (autoStart) {
        endAtRef.current = Date.now() + initialSeconds * 1000;
        setTimeLeft(initialSeconds);
        setIsRunning(true);
      } else {
        setTimeLeft(null);
        setIsRunning(false);
      }
    }
  }, [initialSeconds, autoStart]);

  useEffect(() => {
    if (isRunning) {
      acquireWakeLock();
    } else {
      releaseWakeLock();
    }
  }, [isRunning]);

  useEffect(() => {
    if (!isRunning) return;
    const tick = () => {
      const left = remainingSeconds(endAtRef.current, Date.now());
      setTimeLeft(left);
      if (left <= 0) {
        clearInterval(intervalRef.current);
        setIsRunning(false);
        ring(audioRef);
        try { navigator.vibrate?.([200, 100, 200, 100, 200]); } catch { /* unsupported */ }
      }
    };
    tick();
    intervalRef.current = setInterval(tick, 250);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(intervalRef.current);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [isRunning]);

  // Where the last press and release on the sheet's backdrop landed (see the
  // backdrop's onClick).
  const backdropPressRef = useRef({ down: false, up: false });

  // Escape closes the sheet, and the page behind does not scroll while it is up.
  // Closing only hides it: a running countdown keeps endAtRef and rings as before.
  // onClose is read through a ref because App passes a fresh arrow every render,
  // which would otherwise re-subscribe this effect on each one. The body lock is
  // best-effort on iOS Safari, which still lets a touch scroll the page behind.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!isVisible) return;
    const onKey = (e) => { if (e.key === "Escape") onCloseRef.current(); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [isVisible]);

  const start = () => {
    ensureAudio(audioRef);
    const t = secondsToStart(timeLeft, selectedTime);
    endAtRef.current = Date.now() + t * 1000;
    setTimeLeft(t);
    setIsRunning(true);
  };
  const pause = () => setIsRunning(false);
  const reset = () => { setIsRunning(false); setTimeLeft(null); };

  const displayTime = timeLeft ?? selectedTime;
  const mins = Math.floor(displayTime / 60);
  const secs = displayTime % 60;
  const progress = timeLeft !== null ? (timeLeft / selectedTime) * 100 : 100;
  const circumference = 2 * Math.PI * 88;

  if (!isVisible) return null;

  return (
    // Closes only when the press AND the release are on the backdrop. A drag
    // between the sheet and the backdrop, in either direction, fires its click
    // on the backdrop (their common ancestor), so the click target alone cannot
    // tell; each end is recorded, and both are cleared on every click.
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/30"
      // Each primary press starts a fresh record, so a sequence that never
      // produced a click (a right-click) cannot leave stale flags behind.
      onPointerDown={(e) => {
        backdropPressRef.current = { down: e.button === 0 && e.target === e.currentTarget, up: false };
      }}
      onPointerCancel={() => { backdropPressRef.current = { down: false, up: false }; }}
      onPointerUp={(e) => { backdropPressRef.current.up = e.target === e.currentTarget; }}
      onClick={() => {
        const { down, up } = backdropPressRef.current;
        backdropPressRef.current = { down: false, up: false };
        if (down && up) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="Minuteur de repos" className="w-full max-w-[480px] sm:max-w-2xl lg:max-w-3xl max-h-[100dvh] overflow-y-auto rounded-t-3xl bg-nav px-6 pt-8 pb-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-semibold text-gray-800 font-serif">Pause, darling</h3>
          <button onClick={onClose} aria-label="Fermer le minuteur" className="p-1 text-muted cursor-pointer min-h-[44px] min-w-[44px] flex items-center justify-center">
            <Icons.X />
          </button>
        </div>

        {/* Timer display */}
        <div className="relative text-center mx-auto mb-8" style={{ width: 200, height: 200 }}>
          <svg viewBox="0 0 200 200" width="200" height="200">
            {/* currentColor driven by a text utility, not a raw var(): Tailwind
                v4 only emits an @theme token a utility class references, so a
                bare var() here would depend on some other component keeping
                that token alive. */}
            <circle cx="100" cy="100" r="88" fill="none" className="text-border" stroke="currentColor" strokeWidth="6" />
            <circle
              cx="100" cy="100" r="88" fill="none"
              stroke="currentColor"
              strokeWidth="6"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - progress / 100)}
              strokeLinecap="round"
              className={`origin-center -rotate-90 transition-[stroke-dashoffset] duration-300 ${
                timeLeft === 0 ? "text-danger" : "text-accent"
              }`}
            />
          </svg>
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
            <span className={`text-[44px] font-bold font-mono tabular-nums ${timeLeft === 0 ? "text-danger" : "text-gray-800"}`}>
              {String(mins).padStart(2, "0")}:{String(secs).padStart(2, "0")}
            </span>
          </div>
        </div>

        {/* Presets */}
        <div className="flex flex-wrap gap-2 justify-center mb-6">
          {TIMER_PRESETS.map(p => (
            <button
              key={p.seconds}
              onClick={() => { setSelectedTime(p.seconds); setTimeLeft(null); setIsRunning(false); }}
              className={`min-h-[44px] px-4 py-2 rounded-xl text-sm font-semibold transition-all cursor-pointer ${
                selectedTime === p.seconds
                  ? "bg-accent text-white"
                  : "bg-border text-muted"
              }`}
            >
              {p.label}
            </button>
          ))}
          <input
            type="number"
            placeholder="Perso"
            aria-label="Durée personnalisée, en secondes"
            min="5"
            max="600"
            value={customTime}
            onChange={e => {
              setCustomTime(e.target.value);
              const v = parseInt(e.target.value);
              if (v > 0) { setSelectedTime(v); setTimeLeft(null); setIsRunning(false); }
            }}
            className="min-h-[44px] w-[72px] px-2.5 py-2 rounded-xl border border-border-light bg-border text-gray-800 text-sm text-center"
          />
        </div>

        {/* Controls */}
        <div className="flex gap-4 justify-center">
          <button
            onClick={reset}
            aria-label="Réinitialiser"
            className="w-[52px] h-[52px] rounded-full border border-border-light bg-border text-muted flex items-center justify-center cursor-pointer"
          >
            <Icons.Reset />
          </button>
          <button
            onClick={isRunning ? pause : start}
            className={`w-16 h-16 rounded-full border-none text-white flex items-center justify-center cursor-pointer shadow-[0_4px_20px_var(--color-accent-glow)] ${
              timeLeft === 0 ? "bg-danger" : "bg-accent"
            }`}
          >
            {isRunning ? <Icons.Pause /> : <Icons.Play />}
          </button>
          <div className="w-[52px]" />
        </div>
      </div>
    </div>
  );
}
