import { useEffect, useMemo, useRef, useState } from "react";
import ExerciseForm from "./ExerciseForm.jsx";
import { checkCatalogQuality } from "../lib/catalog.js";
import { blankExercise, stampDeactivation, applyCatalogOps, groupLabel } from "../lib/catalogForm.js";
import { filterExerciseGroups } from "../lib/exerciseSearch.js";
import { exerciseUsage, deleteVerdict } from "../lib/catalogUsage.js";
import { today } from "../lib/helpers.js";
import { Icons } from "./icons.jsx";

/**
 * The Exercices tab — its own top-level panel, and, since slice 2, the only
 * place the catalog is edited.
 *
 * It used to render as a block after `CoachConversation` inside a fixed-height
 * flex column with no `overflow` — so it sat past the container's height with
 * nothing able to scroll to it, and read as removed. The user asked for it back on
 * 2026-08-05; it had never left, it was just unreachable. It then became an
 * overlay sheet rather than a scrollable page, because the alternative —
 * giving the outer container `overflow-y-auto` and the conversation a fixed
 * height — nested two scroll regions on a touch device, worse than the bug it
 * fixed.
 *
 * That constraint no longer binds: promoted to its own tab, this is a page
 * with only its own document scroll, so there is nothing left to nest. The
 * reasoning stays here rather than being deleted, because it is real and
 * would come straight back if this were ever re-nested inside another
 * scrolling container (the Coach tab, say).
 *
 * The exercises come from the catalog document, not from build-time constants,
 * so before the first pull there is nothing to list. The empty state stays
 * INSIDE the panel rather than replacing it. Editing is hidden in that state
 * too: without a document there is nothing to edit, and saving one built from
 * nothing would replace the live catalog with a single exercise.
 *
 * The list renders from `catalog` (the derived views, which own the grouping)
 * while the editor writes `catalogDoc` (the document, which owns the fields
 * the views drop — `active`, the reason, the ceiling). Two shapes of the same
 * data, each read for what it is authoritative about.
 *
 * `sessions`, `plan` and `activeSession` feed `exerciseUsage`/`deleteVerdict`
 * — a deleted name loses its ceiling, and a name with no ceiling is one the
 * coach may prescribe an unbounded load on, so a used exercise must never be
 * deletable, only deactivatable. `activeSession` is the fourth place a name
 * lives, and the one a plan replacement does not clear: quitting a séance
 * keeps the draft (resumable from `ResumeCard`), so it can name an exercise
 * that has since fallen out of both `sessions` and `plan`.
 *
 * @param {object|null} catalog - `buildCatalogViews` result, null before the first pull.
 * @param {object|null} catalogDoc - the raw document.
 * @param {(ops: object|object[]) => string[]} saveCatalog - applies edit
 *   operations (`applyCatalogOps`), returns blocking errors.
 * @param {string|null} [catalogNotice] - why an earlier edit could not be
 *   applied on the server, or null.
 * @param {() => void} [onDismissNotice]
 * @param {Array|null} sessions - recorded sessions, for `exerciseUsage`.
 * @param {object|null} plan - the stored weekly plan, for `exerciseUsage`.
 * @param {object|null} [activeSession] - the running séance draft
 *   (`useActiveSession`'s `state`), for `exerciseUsage` — the fourth place a
 *   name can live, and the one a plan replacement does not clear.
 * @param {(open: boolean) => void} [onEditingChange] - called whenever the
 *   add/edit form opens or closes, so `App.jsx` can hide the navigation while
 *   it is open — a stray tap used to unmount this panel and silently discard
 *   a half-filled form.
 */
export default function ExercisesTab({ catalog, catalogDoc, saveCatalog, catalogNotice, onDismissNotice, sessions, plan, activeSession, onEditingChange }) {
  // `editing` is `{ entry, originalName }`, or null when the list is showing.
  // `originalName` null means a new exercise.
  const [editing, setEditing] = useState(null);
  const [errors, setErrors] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [expanded, setExpanded] = useState(null); // exercise name, or null
  const [confirmingDelete, setConfirmingDelete] = useState(null); // exercise name, or null
  // The name just flipped by the activation switch, kept visible for this
  // render even if the current filter would otherwise drop it — without this,
  // toggling under `Actifs`/`Désactivés` makes the row vanish on the same tap,
  // which is the wrong reward for finding a control the redesign exists to
  // make more discoverable. Cleared on the next search or filter change, never
  // on a re-toggle, so it never lingers longer than "this render's reaction".
  const [pinnedName, setPinnedName] = useState(null);
  const errorsRef = useRef(null);

  const entriesByName = useMemo(() => {
    const map = new Map();
    for (const ex of catalogDoc?.exercises ?? []) {
      if (ex?.name) map.set(ex.name, ex);
    }
    return map;
  }, [catalogDoc]);

  const canEdit = Boolean(catalog && catalogDoc && saveCatalog);

  // Reports the form's open/closed state upward so `App.jsx` can hide the
  // navigation while it is open. Also fires on unmount — a component that
  // unmounts mid-edit (a rare route, since the nav it would need is hidden,
  // but not an impossible one) must not leave the flag stuck at `true`.
  //
  // Gated on `catalog` too, not just `editing`: the `!catalog` branch below
  // takes precedence over `editing` in the render, so a catalog that goes
  // null mid-edit (a dropped Neon read, say) would otherwise make the form
  // vanish while this effect's own state stayed `editing: {...}` — nothing
  // would re-fire, and the nav would stay hidden with no form left to show.
  useEffect(() => {
    const isEditing = Boolean(editing && catalog);
    onEditingChange?.(isEditing);
    return () => onEditingChange?.(false);
  }, [editing, catalog, onEditingChange]);

  const visibleGroups = useMemo(() => {
    if (!catalog) return [];
    const base = filterExerciseGroups({
      muscleGroups: catalog.muscleGroups,
      entriesByName,
      query,
      status,
    });
    if (!pinnedName || base.some(([, names]) => names.includes(pinnedName))) return base;
    // The toggle just moved this name out of the filtered result — find which
    // group it belongs to (from the UNFILTERED catalog, since that is the
    // only place left it still appears) and put it back for this render.
    // `filterExerciseGroups` itself stays a pure filter with no notion of a
    // pin; this is UI-only, so it lives here rather than there.
    const ownGroup = Object.entries(catalog.muscleGroups ?? {}).find(
      ([, names]) => Array.isArray(names) && names.includes(pinnedName)
    );
    if (!ownGroup) return base;
    const [groupName] = ownGroup;
    const existing = base.findIndex(([g]) => g === groupName);
    if (existing === -1) return [...base, [groupName, [pinnedName]]];
    const merged = [...base];
    merged[existing] = [groupName, [...merged[existing][1], pinnedName]];
    return merged;
  }, [catalog, entriesByName, query, status, pinnedName]);

  // A refused save (or a refused delete, see `removeExercise`) writes into
  // `errors`, but the panel is a full page now — no `max-h-[80dvh]` sheet
  // keeping the banner near the fold — so on a long list the reason can land
  // off-screen while the form or the confirm block stays open at her thumb.
  useEffect(() => {
    if (errors.length > 0) errorsRef.current?.scrollIntoView({ block: "nearest" });
  }, [errors]);

  // Same reason for the conflict notice: it arrives after the push, by which
  // time she may be far down the list.
  const noticeRef = useRef(null);
  useEffect(() => {
    if (catalogNotice) noticeRef.current?.scrollIntoView({ block: "nearest" });
  }, [catalogNotice]);

  function handleQueryChange(value) {
    setQuery(value);
    setExpanded(null);
    setConfirmingDelete(null);
    setPinnedName(null);
  }

  function handleStatusChange(value) {
    setStatus(value);
    setExpanded(null);
    setConfirmingDelete(null);
    setPinnedName(null);
  }

  /**
   * Saves edit OPERATIONS, not a document, and routes the verdict.
   *
   * Operations, because the server refuses a document built on a stale copy
   * and the edit is then replayed onto its current one — which needs the edit,
   * not the document it produced here. The quality warnings read the same
   * replay (`applyCatalogOps`), so what she is told about is what is sent.
   *
   * Blocking errors keep the form open with the list of them; the quality
   * warnings are reported AFTER a successful save, never as a gate. That is
   * the owner ruling of 2026-08-14 made concrete: they are heuristics over
   * French prose, so a false positive must cost her a sentence to read, not an
   * exercise she cannot add. Reporting them on the way out also keeps them
   * quiet while she types, which is when every field is legitimately empty.
   */
  function commit(ops) {
    const refused = saveCatalog(ops);
    if (refused.length) {
      setErrors(refused);
      return false;
    }
    setErrors([]);
    setWarnings(checkCatalogQuality(applyCatalogOps(catalogDoc, Array.isArray(ops) ? ops : [ops])));
    setEditing(null);
    return true;
  }

  function submitEntry(entry) {
    const original = editing.originalName;
    const isRename = Boolean(original) && entry.name !== original;
    // Rename FIRST, in the same save, so the alias and the new name are
    // written together — an exercise name is the primary key for her history,
    // and an unaliased rename splits it in two. `applyRename` rewrites the
    // entry's name in the document, so the upsert then targets the NEW name.
    // Dated here rather than in the form, so the « Actif » toggle and the
    // list's « Désactiver » button write the same document for the same
    // transition — the date is what the coach reads as « depuis quand ». And
    // dated BEFORE the operation is built, so replaying it later is
    // deterministic.
    const upsert = { op: "upsertExercise", args: [stampDeactivation(entry, today()), isRename ? entry.name : original] };
    commit(isRename ? [{ op: "applyRename", args: [original, entry.name] }, upsert] : upsert);
  }

  function toggleActive(name, active) {
    setPinnedName(name);
    commit({ op: "setExerciseActive", args: [name, active, today()] });
  }

  function removeExercise(name) {
    // Only clear the confirmation and collapse the row once the delete
    // actually went through. It used to clear both BEFORE calling `commit`,
    // so a refused delete (the exercise entered the active séance draft a
    // moment ago, say) dismissed the confirm block and collapsed the row in
    // the same tap that produced the refusal — the reason then rendered
    // nowhere the user could see it.
    const ok = commit({ op: "deleteExercise", args: [name] });
    if (ok) {
      setConfirmingDelete(null);
      setExpanded(null);
    }
  }

  return (
    <div>
      <h2 className="text-gray-800 text-xl font-bold mb-5">Exercices</h2>

      {/* Only shown over the LIST — before this task the form replaced
          everything under the `<h2>`, and a search bar pinned above the
          add/edit form types into nothing observable while also implying
          (with the nav now hidden too) that there's a list underneath. */}
      {!editing && (
        <div className="sticky top-0 z-10 -mx-1 mb-3 bg-primary px-1 pt-1 pb-2">
          <div className="relative">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-darker">
              <Icons.Search />
            </span>
            <input
              type="search"
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              placeholder="Chercher un exercice"
              aria-label="Chercher un exercice"
              className="w-full rounded-xl border border-border bg-card py-2.5 pr-3 pl-10 text-[15px] text-gray-800 placeholder:text-muted-darker"
            />
          </div>
          <div className="mt-2 flex gap-1.5">
            {[
              { id: "all", label: "Tous" },
              { id: "active", label: "Actifs" },
              { id: "inactive", label: "Désactivés" },
            ].map((s) => (
              <button
                key={s.id}
                onClick={() => handleStatusChange(s.id)}
                aria-pressed={status === s.id}
                className={`min-h-[44px] rounded-xl px-3 text-[13px] font-semibold ${
                  status === s.id
                    ? "bg-accent text-white"
                    : "border border-border bg-card text-muted"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Rendered HERE rather than inside the form, because « Désactiver »
          runs from the LIST view: errors shown only in the form meant a
          refused deactivation changed nothing and said nothing. One place,
          visible from both views, and it cannot silently regress to being
          reachable from only one. */}
      {errors.length > 0 && (
        <ul
          ref={errorsRef}
          className="mb-3 list-disc space-y-1 rounded-xl border border-danger/30 bg-danger/10 py-2.5 pr-3 pl-7 text-xs text-danger"
        >
          {errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}

      {/* An edit the server's newer document could not take. It is kept,
          parked — « Réessayer » on the sync indicator replays it onto
          whatever the server holds then — and the list below already shows
          the server's document. */}
      {catalogNotice && (
        <div ref={noticeRef} role="status" className="mb-3 scroll-mt-32 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5">
          <p className="text-xs text-danger">{catalogNotice}</p>
          <button
            onClick={onDismissNotice}
            className="mt-1 min-h-[44px] text-xs font-semibold text-accent"
          >
            Compris
          </button>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="mb-3 rounded-xl border border-gold/40 bg-gold/10 px-3 py-2.5">
          <p className="text-xs font-semibold text-gold-text">Enregistré. Deux ou trois choses à relire :</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs text-muted">
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
          <button
            onClick={() => setWarnings([])}
            className="mt-2 text-xs font-semibold text-accent"
          >
            Compris
          </button>
        </div>
      )}

      {!catalog ? (
        <p className="px-1 py-6 text-center text-sm text-muted">
          Chargement du catalogue…
        </p>
      ) : editing ? (
        <ExerciseForm
          entry={editing.entry}
          originalName={editing.originalName}
          onSubmit={submitEntry}
          onCancel={() => { setEditing(null); setErrors([]); }}
        />
      ) : (
      <div className="space-y-3">
        {canEdit && (
          <button
            onClick={() => { setErrors([]); setWarnings([]); setEditing({ entry: blankExercise(), originalName: null }); }}
            className="w-full rounded-xl border-2 border-dashed border-border-light bg-transparent py-3 text-[15px] font-semibold text-accent"
          >
            + Ajouter un exercice
          </button>
        )}

        {visibleGroups.map(([group, exercises]) => (
          <div key={group}>
            <p className="px-1 text-xs font-semibold text-accent mb-1">{groupLabel(group)}</p>
            <div className="bg-card rounded-xl border border-border divide-y divide-border">
              {exercises.map((name) => {
                const info = catalog.descriptions[name];
                const entry = entriesByName.get(name);
                // A deactivated exercise stays in the list, greyed: it is
                // still in her history and still loggable by hand, so
                // hiding it would make a session that recorded it
                // unexplainable.
                const inactive = entry?.active === false;
                const isOpen = expanded === name;
                // Only computed for the OPEN row — it walks every session,
                // and running it for all ~70 rows on every render (including
                // every search keystroke) is pure waste when only one row's
                // verdict is ever read.
                const usage = isOpen && entry ? exerciseUsage(name, { sessions, plan, doc: catalogDoc, activeSession }) : null;
                const verdict = usage
                  ? deleteVerdict(usage, { totalExercises: catalogDoc?.exercises?.length ?? 0 })
                  : { deletable: false, reason: null };

                return (
                  <div key={name}>
                    <div className="flex items-center gap-2 px-3">
                      <button
                        onClick={() => { setExpanded(isOpen ? null : name); setConfirmingDelete(null); }}
                        aria-expanded={isOpen}
                        className={`flex min-h-[44px] flex-1 items-center gap-2 bg-transparent text-left text-sm font-medium ${inactive ? "text-muted-darker" : "text-gray-800"}`}
                      >
                        <span className="text-muted-darker">
                          {isOpen ? <Icons.ChevronUp /> : <Icons.ChevronDown />}
                        </span>
                        {name}
                      </button>
                      {canEdit && entry && (
                        <button
                          role="switch"
                          aria-checked={!inactive}
                          aria-label={name}
                          onClick={() => toggleActive(name, inactive)}
                          // The 44px minimum is a TOUCH TARGET, not a painted
                          // control: it lives on the button, which is
                          // transparent, while the pill inside is sized like a
                          // switch (48×28 with a 24px knob — wide and short, the
                          // proportion the control is read by). Putting the 44px
                          // on the pill itself made it 44 tall by 52 wide, near
                          // enough square to stop reading as a switch at all.
                          className="flex min-h-[44px] shrink-0 items-center bg-transparent px-1"
                        >
                          <span
                            className={`flex h-7 w-12 items-center rounded-full p-0.5 ${
                              inactive ? "justify-start bg-border-light" : "justify-end bg-accent"
                            }`}
                          >
                            <span className="block h-6 w-6 rounded-full bg-card elev-card" />
                          </span>
                        </button>
                      )}
                    </div>

                    {isOpen && (
                      <div className="px-4 pt-1 pb-3">
                        {info && (
                          <>
                            <p className="text-xs text-muted">{info.description}</p>
                            {info.formCues && <p className="mt-0.5 text-xs text-accent">{info.formCues}</p>}
                            {info.intent && (
                              <p className="mt-0.5 text-xs text-muted-darker italic">{info.intent}</p>
                            )}
                            {info.perSide && (
                              <span className="mt-1 inline-block rounded bg-surface px-1.5 py-0.5 text-[10px] text-muted">
                                par côté
                              </span>
                            )}
                          </>
                        )}
                        {inactive && (
                          <p className="mt-1 text-xs text-danger">
                            Désactivé{entry.inactiveReason ? ` — ${entry.inactiveReason}` : ""}
                            {entry.replacedBy ? ` · à la place : ${entry.replacedBy}` : ""}
                          </p>
                        )}

                        {canEdit && entry && (
                          confirmingDelete === name ? (
                            <div className="mt-3 rounded-xl border border-danger/30 bg-danger/10 p-3">
                              <p className="text-xs text-danger">
                                Supprimer « {name} » définitivement ?
                              </p>
                              <div className="mt-2 flex justify-end gap-3">
                                <button
                                  onClick={() => setConfirmingDelete(null)}
                                  className="min-h-[44px] px-2 text-xs font-semibold text-muted"
                                >
                                  Annuler
                                </button>
                                <button
                                  onClick={() => removeExercise(name)}
                                  className="min-h-[44px] rounded-xl bg-danger px-3 text-xs font-semibold text-white"
                                >
                                  Supprimer
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div className="mt-3 flex justify-end gap-4">
                                <button
                                  onClick={() => { setErrors([]); setWarnings([]); setEditing({ entry, originalName: name }); }}
                                  className="min-h-[44px] px-2 text-xs font-semibold text-accent"
                                >
                                  Modifier
                                </button>
                                {verdict.deletable && (
                                  <button
                                    onClick={() => setConfirmingDelete(name)}
                                    className="min-h-[44px] px-2 text-xs font-semibold text-danger"
                                  >
                                    Supprimer
                                  </button>
                                )}
                              </div>
                              {!verdict.deletable && verdict.reason && (
                                <p className="mt-1 text-right text-[11px] text-muted-darker">
                                  {verdict.reason}
                                </p>
                              )}
                            </>
                          )
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {visibleGroups.length === 0 && (
          <p className="px-1 py-6 text-center text-sm text-muted">
            Aucun exercice ne correspond.
          </p>
        )}
      </div>
      )}
    </div>
  );
}
