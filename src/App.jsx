import { lazy, Suspense, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import useSessionData from "./hooks/useSessionData.js";
import useActiveSession from "./hooks/useActiveSession.js";
import { sessionForCoach } from "./lib/activeSession.js";
import { navigate, scrollOnScreenChange } from "./lib/navigation.js";
import useCoachChat from "./hooks/useCoachChat.js";
import PasswordGate, { isAuthenticated, SYNC_KEY_STORAGE } from "./components/PasswordGate.jsx";
import BottomNav from "./components/BottomNav.jsx";
import SideRail from "./components/SideRail.jsx";
import Timer from "./components/Timer.jsx";
import SessionList from "./components/SessionList.jsx";
import SessionForm from "./components/SessionForm.jsx";
import SessionDetail from "./components/SessionDetail.jsx";
import ProfileTab from "./components/ProfileTab.jsx";
import { needsProfileSetup } from "./lib/persona.js";
import CoachTab from "./components/CoachTab.jsx";
import WeeklyPlan from "./components/WeeklyPlan.jsx";
import SeanceMode from "./components/SeanceMode.jsx";
import SeanceCoachPanel from "./components/SeanceCoachPanel.jsx";
import ResumeCard from "./components/ResumeCard.jsx";
import { Icons } from "./components/icons.jsx";
import { resetSyncClient, shouldForgetKey } from "./lib/sync.js";
import { generateId, today } from "./lib/helpers.js";
import { draftFromPlanned } from "./lib/plannedSession.js";
import { computePRs } from "./lib/stats.js";
import SyncIndicator, { SyncCounts } from "./components/SyncIndicator.jsx";
import PWAUpdateToast from "./components/PWAUpdateToast.jsx";
import IOSInstallHint from "./components/IOSInstallHint.jsx";

// Lazy, like `SeanceSummary`: the lexique and its form are the largest UI in
// the app and only one tab needs them, and the entry chunk had reached Vite's
// 500 kB warning, which this repo does not tolerate. The service worker
// precaches the chunk like any other build output, so the tab opens offline.
const ExercisesTab = lazy(() => import("./components/ExercisesTab.jsx"));

export default function App() {
  const [authed, setAuthed] = useState(isAuthenticated());
  const [authReason, setAuthReason] = useState(null);

  // Bumped to remount the shell on a key another tab already replaced.
  const [shellKey, setShellKey] = useState(0);

  // A 401 means the stored key was rotated or revoked. Only the key goes:
  // sessions, plan, profile, catalog and the outbox stay in localStorage, and
  // the outbox drains once a correct password brings a new key. Unless the
  // stored key is no longer the one refused — another tab logged in since —
  // in which case it stays, and the shell remounts on it instead.
  const handleAuthLost = useCallback((err) => {
    let stored = null;
    try { stored = localStorage.getItem(SYNC_KEY_STORAGE); } catch { /* storage unavailable */ }
    // The key the refused request sent, not the one the client holds now.
    const used = err?.key ?? null;
    resetSyncClient();
    if (stored && !shouldForgetKey({ stored, used })) {
      setShellKey((k) => k + 1);
      return;
    }
    try { localStorage.removeItem(SYNC_KEY_STORAGE); } catch { /* storage unavailable */ }
    setAuthReason("rotated");
    setAuthed(false);
  }, []);

  if (!authed) {
    return <PasswordGate reason={authReason} onSuccess={() => { setAuthReason(null); setAuthed(true); }} />;
  }

  return <AppShell key={shellKey} onAuthLost={handleAuthLost} />;
}

function AppShell({ onAuthLost }) {
  const {
    sessions, profile, setProfile,
    allExerciseNames, saveSession, deleteSession, duplicateSession,
    plan, savePlan,
    catalog, catalogDoc, saveCatalog, catalogNotice, dismissCatalogNotice,
    syncStatus, pendingCount, parkedCount, retryParked, retrying,
  } = useSessionData({ onAuthLost });
  const syncProps = { status: syncStatus, pendingCount, parkedCount, onRetryParked: retryParked, retrying };

  // A new install has no profile yet: open on it, where the setup form is.
  const [tab, setTab] = useState(() => (needsProfileSetup(profile) ? "profile" : "session"));
  const [view, setView] = useState("list");
  const [selectedSession, setSelectedSession] = useState(null);
  const [editSession, setEditSession] = useState(null);
  const [templateSession, setTemplateSession] = useState(null);
  const [filterText, setFilterText] = useState("");
  const [timerOpen, setTimerOpen] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(null);
  const [timerAutoStart, setTimerAutoStart] = useState(false);

  // Whether the séance SCREEN is showing. `seance.state` is whether a séance
  // EXISTS. Quitting closes the screen and keeps the draft; only Terminer or
  // Abandonner clears it — so gating the render on `seance.state` alone would
  // make the quit button do nothing.
  const [seanceOpen, setSeanceOpen] = useState(false);

  // Every screen change opens at its top, and a tap on the tab she is on leaves
  // the page alone (`scrollOnScreenChange`, pure and tested). Applied before
  // paint so the new screen never flashes at the old offset.
  const screenRef = useRef({ tab, view, seanceOpen });
  useLayoutEffect(() => {
    const next = { tab, view, seanceOpen };
    const target = scrollOnScreenChange(screenRef.current, next);
    screenRef.current = next;
    if (target !== null) window.scrollTo(0, target);
  }, [tab, view, seanceOpen]);

  // Changing tab closes the séance screen; a tap on the current tab does not (`navigate`).
  const navigateTab = (next) => {
    const after = navigate({ tab, next, seanceOpen });
    setSeanceOpen(after.seanceOpen);
    setTab(after.tab);
  };

  // Whether the Exercices panel's add/edit form is open. While it is, `BottomNav`
  // unmounts entirely and `SideRail` hides its navigation buttons (but stays
  // mounted, see `SideRail`'s doc comment) — the panel used to be a
  // `fixed inset-0` overlay sitting above both, which physically blocked a
  // stray tap from discarding a half-filled form. `ExercisesTab` reports this
  // via `onEditingChange`, including on its own unmount, so leaving the
  // Exercices tab (which can only happen through the now-hidden nav, or the
  // form's own Annuler/submit) can never leave this stuck at `true`.
  const [exerciseFormOpen, setExerciseFormOpen] = useState(false);

  const seance = useActiveSession((session) => {
    saveSession(session);
    setSeanceOpen(false);
    setView("list");
  });
  const prs = useMemo(() => computePRs(sessions), [sessions]);

  // Owned here rather than inside CoachTab / SeanceCoachPanel: those two mount
  // and unmount as she navigates, and a reply still streaming was abandoned the
  // moment she left the tab. The séance is passed whenever a draft exists, not
  // only while its screen is up: navigating to the Coach tab closes the screen
  // (below xl), and the coach must still see the workout she is in the middle of.
  const chat = useCoachChat({
    sessions,
    profile,
    plan,
    activeSession: sessionForCoach(seance.state, seanceOpen),
    onAuthLost,
  });

  const handleSaveSession = (data) => {
    saveSession(data);
    setView("list");
    setEditSession(null);
    setTemplateSession(null);
  };

  const handleDeleteSession = (id) => {
    deleteSession(id);
    setSelectedSession(null);
    setView("list");
  };

  const handleDuplicateSession = (session) => {
    const copy = duplicateSession(session);
    setEditSession(copy);
    setTemplateSession(null);
    setView("edit");
  };

  // Enters mode séance: a real running workout, recorded set by set.
  const handleStartPlannedSession = (plannedSession) => {
    // The resume card sits directly above these buttons, so starting a second
    // séance is one misclick away — and it would discard every validated set of
    // the first without a word.
    if (
      seance.hasDraft &&
      !confirm("Une séance est déjà en cours. La remplacer ? Ce qui y est validé sera perdu.")
    ) return;
    seance.start(plannedSession, plan?.weekStart ?? null);
    setSeanceOpen(true);
    setTab("session");
  };

  // Opens the planned session in the form, pre-filled. It is NOT saved until
  // The user presses Enregistrer — see plannedSession.js for why that matters.
  const handleNotePlannedSession = (plannedSession) => {
    setTemplateSession(draftFromPlanned(plannedSession, { id: generateId(), date: today() }));
    setEditSession(null);
    setTab("session");
    setView("edit");
  };

  const handleOpenTimer = (seconds) => {
    setTimerSeconds(seconds || null);
    setTimerAutoStart(true);
    setTimerOpen(true);
  };

  return (
    <div className="min-h-dvh bg-primary font-sans lg:pl-[88px]">
      {/* Always mounted — see the doc comment on `SideRail` for why hiding it
          entirely (as BottomNav still is, below `lg`) used to break both
          `lg:pl-[88px]` and the sync indicator. */}
      <SideRail
        tab={tab}
        setTab={navigateTab}
        onSessionTab={() => setView("list")}
        onTimer={() => { setTimerAutoStart(false); setTimerOpen(true); }}
        sync={syncProps}
        hideNavigation={exerciseFormOpen}
      />

      {/* Compact header — the rail carries this identity at lg and above */}
      <div className="mx-auto w-full max-w-[480px] sm:max-w-2xl lg:hidden">
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <div className="flex items-center gap-2">
            <h1 className="m-0 font-serif text-2xl font-bold tracking-tight text-gray-800">
              Belle <span className="text-accent">Forme</span>
            </h1>
            <SyncIndicator status={syncStatus} />
          </div>
          <button
            onClick={() => { setTimerAutoStart(false); setTimerOpen(true); }}
            className="flex min-h-[44px] cursor-pointer items-center gap-1.5 rounded-[10px] border border-border-light
                       bg-card px-3.5 py-2 text-[13px] font-semibold text-accent"
          >
            <Icons.Clock /> Timer
          </button>
        </div>
        {/* The outbox on a line of its own: beside the title it squeezed
            « Belle Forme » onto two lines at phone width. */}
        <div className="px-5 pb-1 empty:hidden">
          <SyncCounts {...syncProps} />
        </div>
        <div className="flex justify-center py-1 text-gold">
          <Icons.ArtDecoDivider />
        </div>
      </div>

      {/* `pb-[100px]` reserves space for `BottomNav`, which is hidden below
          `lg` while the exercise form is open — so the padding must go with
          it, or it leaves dead space with nothing docked below it. */}
      <main className={`mx-auto w-full max-w-[480px] px-5 pt-4 ${exerciseFormOpen ? "" : "pb-[100px]"}
                       sm:max-w-2xl
                       lg:max-w-none lg:px-10 lg:pt-8 lg:pb-10`}>
        {seanceOpen && seance.state ? (
          <SeanceMode
            state={seance.state}
            prs={prs}
            onValidate={seance.validate}
            onLeave={seance.leave}
            onSkip={seance.skip}
            onBack={seance.goBack}
            onMove={seance.move}
            onFinish={() => {
              if (confirm("Terminer la séance ? Elle sera enregistrée telle quelle.")) seance.finish();
            }}
            onToggleItem={seance.toggleItem}
            onQuit={() => {
              if (confirm("Quitter la séance ? Elle sera gardée pour plus tard.")) {
                // Marked on the draft, so the coach stops treating it as live.
                seance.quit();
                setSeanceOpen(false);
              }
            }}
            coachPanel={<SeanceCoachPanel chat={chat} catalog={catalog} />}
            catalog={catalog}
          />
        ) : (
        <>
        {tab === "session" && (
          <>
            {view === "list" && (
              <>
                {/* "Resuming" is purely reopening the screen — the state never
                    left, which is why the two flags are separate. */}
                {seance.hasDraft && !seanceOpen && (
                  <ResumeCard
                    state={seance.state}
                    onResume={() => { seance.resume(); setSeanceOpen(true); }}
                    onAbandon={seance.abandon}
                  />
                )}
                <WeeklyPlan
                  plan={plan}
                  sessions={sessions}
                  onStartSession={handleStartPlannedSession}
                  onNoteSession={handleNotePlannedSession}
                  onTimer={handleOpenTimer}
                  catalog={catalog}
                />
                <SessionList
                  sessions={sessions}
                  filterText={filterText}
                  setFilterText={setFilterText}
                  onNew={() => { setEditSession(null); setTemplateSession(null); setView("new"); }}
                  onSelect={s => { setSelectedSession(s); setView("detail"); }}
                  onDuplicate={handleDuplicateSession}
                />
              </>
            )}
            {view === "new" && (
              <>
                <h2 className="text-gray-800 text-xl font-bold mb-5">Nouvelle séance</h2>
                <SessionForm
                  onSave={handleSaveSession}
                  onCancel={() => setView("list")}
                  allExerciseNames={allExerciseNames}
                  catalog={catalog}
                />
              </>
            )}
            {view === "edit" && (editSession || templateSession) && (
              <>
                <h2 className="text-gray-800 text-xl font-bold mb-5">
                  {editSession ? "Modifier la séance" : "Enregistrer la séance"}
                </h2>
                <SessionForm
                  session={editSession || templateSession}
                  onSave={handleSaveSession}
                  onCancel={() => { setEditSession(null); setTemplateSession(null); setView("list"); }}
                  allExerciseNames={allExerciseNames}
                  catalog={catalog}
                />
              </>
            )}
            {view === "detail" && selectedSession && (
              <SessionDetail
                session={selectedSession}
                onClose={() => { setSelectedSession(null); setView("list"); }}
                onEdit={() => { setEditSession(selectedSession); setTemplateSession(null); setView("edit"); }}
                onDelete={handleDeleteSession}
              />
            )}
          </>
        )}

        {tab === "profile" && (
          // Keyed on the setup state so the form closes by itself once the
          // profile has a name, whether the user saved it or a pull delivered it.
          <ProfileTab
            key={needsProfileSetup(profile) ? "setup" : "ready"}
            profile={profile}
            onSave={setProfile}
            onAuthLost={onAuthLost}
          />
        )}

        {tab === "coach" && (
          <CoachTab
            chat={chat}
            onPlanImport={savePlan}
            catalog={catalog}
          />
        )}

        {tab === "exercises" && (
          <Suspense fallback={null}>
            <ExercisesTab
              catalog={catalog}
              catalogDoc={catalogDoc}
              saveCatalog={saveCatalog}
              catalogNotice={catalogNotice}
              onDismissNotice={dismissCatalogNotice}
              sessions={sessions}
              plan={plan}
              activeSession={seance.state}
              onEditingChange={setExerciseFormOpen}
            />
          </Suspense>
        )}
        </>
        )}
      </main>

      {/* Bottom nav — hidden while the exercise form is open, see exerciseFormOpen above */}
      {!exerciseFormOpen && (
        <BottomNav tab={tab} setTab={navigateTab} onSessionTab={() => setView("list")} />
      )}

      {/* Timer overlay */}
      <Timer isVisible={timerOpen} onClose={() => setTimerOpen(false)} initialSeconds={timerSeconds} autoStart={timerAutoStart} />

      {/* PWA overlays */}
      <PWAUpdateToast />
      <IOSInstallHint />
    </div>
  );
}
