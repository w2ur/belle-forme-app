import { useEffect, useState } from "react";
import { stepValue } from "../lib/setInput.js";
import { formatRepsWithUnit } from "../lib/stats.js";
import { Icons } from "./icons.jsx";

/**
 * One set. Pre-filled with the planned numbers so the common case is a single
 * tap on ✓ — but what gets stored is whatever is in these inputs, which is the
 * whole reason séance mode exists.
 *
 * Steppers rather than a keyboard: mid-set, ±1 beats typing. Direct entry is
 * still available by tapping the number.
 */
export default function SetRow({ index, planned, recorded, isCurrent, metric, onValidate }) {
  const [reps, setReps] = useState(recorded?.reps || planned.reps || "");
  const [weight, setWeight] = useState(
    recorded?.weight || (planned.weight > 0 ? String(planned.weight) : "")
  );
  const [justValidated, setJustValidated] = useState(false);

  // When the cursor arrives, re-seed from the plan — the previous set's edits
  // must not leak into this one.
  useEffect(() => {
    if (isCurrent && !recorded?.done) {
      setReps(planned.reps || "");
      setWeight(planned.weight > 0 ? String(planned.weight) : "");
    }
  }, [isCurrent, planned.reps, planned.weight, recorded?.done]);

  // A hold steps in 5-second bites: ±1 on a 45-second plank is six taps to a
  // meaningful change, and the progression the coach actually prescribes moves
  // in fives (20s → 25s → 30s, observed across the whole 16/08 transcript).
  const isHold = metric === "seconds";

  const step = (setter, value, delta) => setter(stepValue(value, delta));

  if (recorded?.done) {
    return (
      <div className="flex items-center gap-3 py-2 seance-control text-muted">
        <span className="text-accent"><Icons.Check /></span>
        <span className="w-20">Série {index + 1}</span>
        <span className="font-mono tabular-nums">
          {/* The unit has to survive validation: the row says "Secondes" while
              she edits it, and used to drop back to a bare number the instant
              she pressed ✓. */}
          {formatRepsWithUnit(recorded.reps, metric)} × {recorded.weight || "—"}
        </span>
      </div>
    );
  }

  if (!isCurrent) {
    return (
      <div className="flex items-center gap-3 py-2 seance-control text-muted-dark">
        <span className="w-5" />
        <span className="w-20">Série {index + 1}</span>
        <span>—</span>
      </div>
    );
  }

  return (
    <div className={`rounded-xl border border-accent bg-card p-3 ${justValidated ? "motion-validate" : ""}`}>
      <div className="mb-2 seance-control font-semibold text-gray-800">Série {index + 1}</div>
      <div className="flex flex-wrap items-center gap-4">
        <Stepper
          label={isHold ? "Secondes" : "Reps"}
          value={reps}
          onChange={setReps}
          onStep={(d) => step(setReps, reps, d)}
          stepBy={isHold ? 5 : 1}
        />
        <Stepper label="kg" value={weight} onChange={setWeight} onStep={(d) => step(setWeight, weight, d)} stepBy={0.5} />
        <button
          onClick={() => {
            setJustValidated(true);
            onValidate({ reps, weight });
          }}
          className="ml-auto flex min-h-[56px] min-w-[56px] cursor-pointer items-center justify-center
                     rounded-xl border-none bg-accent px-6 text-white elev-raised"
          aria-label={`Valider la série ${index + 1}`}
        >
          <Icons.Check />
        </button>
      </div>
    </div>
  );
}

function Stepper({ label, value, onChange, onStep, stepBy }) {
  return (
    <div>
      <div className="mb-1 text-sm text-muted">{label}</div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onStep(-stepBy)}
          aria-label={`${label} moins ${stepBy}`}
          className="h-11 w-11 cursor-pointer rounded-lg border border-border-light bg-card text-xl text-accent"
        >
          −
        </button>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode="decimal"
          aria-label={label}
          className="w-20 rounded-lg border border-border-light bg-card py-1 text-center seance-figure text-gray-800"
        />
        <button
          onClick={() => onStep(stepBy)}
          aria-label={`${label} plus ${stepBy}`}
          className="h-11 w-11 cursor-pointer rounded-lg border border-border-light bg-card text-xl text-accent"
        >
          +
        </button>
      </div>
    </div>
  );
}
