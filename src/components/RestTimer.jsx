import { useEffect, useRef, useState } from "react";
import { remainingSeconds } from "../lib/countdown.js";
import { Icons } from "./icons.jsx";

/**
 * Inline rest countdown. Deliberately NOT a modal: she must be able to look at
 * the next set, or talk to the coach, while it runs. The modal `Timer` stays
 * for standalone use outside a séance.
 */
export default function RestTimer({ seconds, onDismiss }) {
  const endAtRef = useRef(0);
  const [left, setLeft] = useState(seconds);

  useEffect(() => {
    endAtRef.current = Date.now() + seconds * 1000;
    setLeft(seconds);
  }, [seconds]);

  // Derived from an end timestamp: iOS throttles background intervals, so a
  // per-tick decrement drifts. Also re-read when the tab comes back.
  useEffect(() => {
    const tick = () => setLeft(remainingSeconds(endAtRef.current, Date.now()));
    tick();
    const id = setInterval(tick, 250);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [seconds]);

  useEffect(() => {
    if (left !== 0) return;
    try { navigator.vibrate?.([200, 100, 200]); } catch { /* unsupported — the visual state is the fallback */ }
  }, [left]);

  const mins = Math.floor(Math.max(0, left) / 60);
  const secs = Math.max(0, left) % 60;

  return (
    <div className={`flex items-center gap-3 rounded-xl border px-4 py-2 ${
      left <= 0 ? "border-accent bg-accent/10" : "border-border bg-surface"
    }`}>
      <span className={left <= 0 ? "text-accent" : "text-muted"}><Icons.Clock /></span>
      <span className="font-mono tabular-nums seance-control text-gray-800">
        {String(mins).padStart(2, "0")}:{String(secs).padStart(2, "0")}
      </span>
      <span className="seance-control text-muted">{left <= 0 ? "C'est reparti, darling" : "repos"}</span>
      <button
        onClick={onDismiss}
        aria-label="Masquer le minuteur de repos"
        className="ml-auto flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center text-muted"
      >
        <Icons.X />
      </button>
    </div>
  );
}
