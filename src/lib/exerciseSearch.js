/**
 * Narrowing the exercise list for the « Exercices » panel. Pure, no React.
 *
 * It lives in `src/lib/` rather than inside the component for the reason
 * everything else here does: components are not tested in this repo, and the
 * dangerous failure of a filter is not that it finds too little but that it
 * silently matches everything — which reads exactly like no filter at all.
 */

/**
 * Lowercases and strips diacritics, so `developpe` finds « Développé couché au
 * sol ». The user types on an iPad and does not reach for accents.
 *
 * @param {unknown} s
 * @returns {string}
 */
export function foldForSearch(s) {
  if (typeof s !== "string") return "";
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/**
 * Filters the grouped catalog by name and by activation status.
 *
 * `muscleGroups` is a NULL-PROTOTYPE object — `buildCatalogViews` builds it
 * that way because its keys are document data the user types — so it is read with
 * `Object.entries`, never with `for...in` or an inherited `hasOwnProperty`.
 *
 * A group left with no matching name is DROPPED rather than returned empty:
 * the panel renders a heading per pair, and a heading over nothing reads as a
 * rendering bug.
 *
 * @param {object} args
 * @param {object|null} args.muscleGroups - `catalog.muscleGroups`.
 * @param {Map<string, object>} args.entriesByName - raw document entries by name.
 * @param {string} args.query - free text; empty means no narrowing.
 * @param {"all"|"active"|"inactive"} args.status
 * @returns {Array<[string, string[]]>}
 */
export function filterExerciseGroups({ muscleGroups, entriesByName, query, status }) {
  if (!muscleGroups || typeof muscleGroups !== "object") return [];

  const needle = foldForSearch(typeof query === "string" ? query.trim() : "");
  const out = [];

  for (const [group, names] of Object.entries(muscleGroups)) {
    if (!Array.isArray(names)) continue;

    const kept = names.filter((name) => {
      if (needle && !foldForSearch(name).includes(needle)) return false;
      if (status === "all") return true;
      // A name with no document entry is treated as ACTIVE: the views and the
      // document are two shapes of one dataset, and a name present in one but
      // not the other is a bug elsewhere — hiding it here would conceal it.
      const inactive = entriesByName?.get(name)?.active === false;
      return status === "inactive" ? inactive : !inactive;
    });

    if (kept.length) out.push([group, kept]);
  }

  return out;
}
