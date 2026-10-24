/**
 * The ± stepper arithmetic behind a set's reps and weight inputs.
 *
 * Pure and tested rather than inlined in `SetRow`, because a recorded value is
 * not always a bare number. A naive `Number("45s") + 1` is `NaN`, and tapping +
 * on a plank would have written "NaN" into the record.
 *
 * Since 2026-08-23 the PLAN no longer carries a unit — a hold arrives as `"45"`
 * with `metric: "seconds"` beside it. This still handles a suffix, because two
 * sources of it survive: a session recorded before that change, and anything
 * The user types into the box herself.
 */

/**
 * A value this function must not touch: anything whose trailing part still
 * contains a digit. `"30-40min"` (a real cardio prescription the coach emits)
 * and `"10-12"` (a rep range) are ranges, not "a number with a unit" — the old
 * regex matched their leading digits, threw the rest away, and turned
 * `"10-12"` into `"1"` on the first tap. There is no sensible ± on a range, so
 * the honest answer is to leave it alone.
 */
const RANGE_OR_UNSTEPPABLE = /\d[^\d.,]+\d/;

export function stepValue(value, delta, { min = 0 } = {}) {
  const raw = String(value ?? "");
  if (RANGE_OR_UNSTEPPABLE.test(raw)) return raw;

  // Numeric prefix, the spacing as written, then whatever trailing unit came
  // with it ("45 s" -> 45 + " " + "s"). The separator is CAPTURED rather than
  // swallowed: rebuilding without it silently rewrote "30 s" as "31s", which
  // is a value she did not type appearing in her own record.
  const [, digits = "", gap = "", unit = ""] =
    raw.match(/^\s*(\d*[.,]?\d*)(\s*)(\D*?)\s*$/) ?? [];

  const base = Number(String(digits).replace(",", "."));
  const stepped = (Number.isFinite(base) ? base : 0) + delta;
  // Halves, not thirds: the plates and the dumbbell increments are 0.5 kg.
  return `${Math.max(min, Math.round(stepped * 2) / 2)}${gap}${unit}`;
}
