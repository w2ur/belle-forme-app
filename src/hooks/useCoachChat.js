import { useCallback, useEffect, useRef, useState } from "react";
import { getSyncClient } from "../lib/sync.js";
import { generateExport } from "../lib/planExport.js";
import { finalizeStream, stripEchoedAnnotation, stripKeepalive } from "../lib/coachStream.js";
import { buildCorrectionRequest, summarizeRejectedPlan } from "../lib/planValidation.js";
import { PLAN_BUTTON_LABEL } from "../lib/planButtonLabel.js";
import { loadDraft, saveDraft, draftToKeep } from "../lib/coachDraft.js";
import {
  canSend, OPENING_LINE, historyAction, errorAfterHistory, errorAfterHistoryFailure,
  historyStaleAfterFailure, refreshAfterSend,
} from "../lib/coachChatState.js";

/**
 * Cleans a turn coming BACK from the server.
 *
 * Read-path only, on the same ruling that governed the legacy plan blocks
 * (2026-08-11): the 25 replies already banked with an echoed date stamp are NOT
 * rewritten in Neon. Stripping on read fixes her scrollback on the very next
 * load, covers rows that do not exist yet, and destroys nothing she read. The
 * stamp was never meant for her — and the time in it is wrong anyway, since the
 * model copies the PRECEDING turn's stamp rather than its own.
 *
 * Assistant turns only. A user turn is her own words and is never annotated.
 */
function cleanStoredTurn(m) {
  if (m?.role !== "assistant" || typeof m.content !== "string") return m;
  const content = stripEchoedAnnotation(m.content);
  return content === m.content ? m : { ...m, content };
}
const SEND_ERROR = "Message non envoyé. Ton texte est revenu dans le champ, réessaie.";
/**
 * The same failure, for a message the APP composed. `SEND_ERROR` promises her
 * text is back in the composer, which is true for something she typed and a lie
 * for a one-tap request: the override path deliberately never touches the
 * draft, so there would be nothing there to retry. It also has to say where to
 * start again, because the notice carrying the error list is already gone by
 * the time this fires.
 */
const CORRECTION_ERROR =
  "La demande de correction n'est pas partie. Réimporte le programme refusé pour réessayer.";
/**
 * The third case, and it exists because the emit request stopped being her
 * draft. `SEND_ERROR` promises her text is back in the composer; on this path
 * she typed nothing, the request was `PLAN_REQUEST`, and the composer is
 * deliberately left exactly as she left it — so that promise would be a lie in
 * both directions. Like `CORRECTION_ERROR` it has to say where to start again,
 * since there is nothing to retry from in the field.
 */
const PLAN_ERROR = `Le programme n'a pas été généré. Appuie de nouveau sur « ${PLAN_BUTTON_LABEL} » pour réessayer.`;
/**
 * What the programme button actually says in the transcript. It has to read like
 * something the user said, because that is what the coach sees and what she sees on
 * reload — a button press with no message would leave a reply answering nothing.
 */
const PLAN_REQUEST = "Prépare-moi mon programme de la semaine.";
/**
 * Shown when the reply stopped before the coach was done. Distinct from
 * SEND_ERROR because the situation is the opposite one: the exchange DID happen
 * and is banked server-side, so the offer is to reload it, not to resend.
 */
const CUT_ERROR = "Réponse interrompue. Recharge la conversation pour voir ce qui a été enregistré.";

/**
 * Local mirror of the transcript. The server is the source of truth, but it is
 * reachable over a connection that visibly is not always there, and the whole
 * conversation used to hang on a single GET succeeding at mount: one blip
 * replaced every message with an error bubble. The cache is what makes a failed
 * refresh a banner instead of an erasure.
 */
/**
 * Bumped from `fittrack_coach_transcript` on 2026-08-11 to PURGE the old copy,
 * not to change the format — the shape is identical.
 *
 * The previous key held up to 200 messages mirrored from real production use,
 * over weeks where the notebook sentinel was dead and every reply ended on a
 * visible `### Carnet mis à jour (privé)` markdown section instead — that bug
 * is real, predates this branch, and is what her device actually has on it.
 * (The JSON `plan-emit` payload format, and its own separate notebook-field
 * leak, are new on THIS branch, which has never deployed — the field-strip fix
 * landed before the branch did, so no un-stripped payload was ever persisted
 * anywhere for a real device to mirror. Naming it here would misattribute a
 * design-time-only risk to production data.) The server no longer emits either
 * shape, but nothing rewrites what is already on her device, and `localStorage`
 * is not a cache that expires. A new key orphans the old value on the next
 * load, which is the only purge available from here.
 *
 * A future bump for the same reason is legitimate; a bump to "fix" a rendering
 * bug is not — it throws away her offline transcript.
 */
const CACHE_KEY = "fittrack_coach_transcript_v2";
/**
 * Actively deleted rather than merely orphaned. A new key alone stops the stale
 * copy being READ, which is not the same as it being gone: the point of this
 * bump is that private notes are sitting on her device, and an unreferenced
 * `localStorage` entry sits there for good.
 */
const LEGACY_CACHE_KEYS = ["fittrack_coach_transcript"];

function purgeLegacyCache() {
  for (const key of LEGACY_CACHE_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Private mode or a locked store — the purge is best-effort, and nothing
      // downstream reads these keys any more either way.
    }
  }
}
const CACHE_LIMIT = 200; // matches the server's own history page size
const HISTORY_RETRIES = 2;

// Persisted because iPad Safari kills backgrounded tabs, and being dropped back
// to Discussion mid-plan-conversation reads as the app losing her place.
const MODE_KEY = "fittrack_coach_mode";

function readCache() {
  // Runs on the hook's first render, which is the earliest point this module
  // executes and before anything can be shown from the old copy.
  purgeLegacyCache();
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeCache(messages) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(messages.slice(-CACHE_LIMIT)));
  } catch {
    // Quota or private mode — the cache is an optimisation, never a requirement.
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Owns the coach conversation: history, the streaming send, and the draft.
 *
 * Mounted ONCE, in App.jsx, and handed to both surfaces (the Coach destination
 * and the séance panel). It used to be called inside each component, which made
 * leaving the Coach tab unmount the hook and abandon an in-flight reply —
 * ordinary behaviour on an iPad, and it cost her the whole exchange.
 *
 * One coach, one server-side transcript (`coach_messages`); forking it would
 * split her memory.
 */
export default function useCoachChat({ sessions, profile, plan, activeSession = null, onAuthLost }) {
  const client = getSyncClient();
  // A 401 here means the same thing as on the sync line: the stored key was
  // rotated. It goes back to the gate (`App.jsx`), not into a « réessaie »
  // banner that no retry can ever clear.
  const authLostRef = useRef(onAuthLost);
  authLostRef.current = onAuthLost;
  // False once the shell has unmounted. A send settles long after it left; a
  // 401 arriving after the shell already went to the gate (or remounted on a
  // fresh key) must not send the app there again.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [messages, setMessages] = useState(readCache);
  // The list as last rendered, for the 401 path below, which must write the
  // cache itself: the hook unmounts before the cache effect could run.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  // Seeded from, and written through to, sessionStorage: a 401 unmounts this
  // hook on its way to the gate, and her draft must be there when it remounts.
  const [draft, setDraft] = useState(loadDraft);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => { saveDraft(draft); }, [draft]);
  const [streaming, setStreaming] = useState(null);
  // Wire mode of the request in flight; picks the waiting-line copy.
  const [streamingMode, setStreamingMode] = useState(null);
  const [busy, setBusy] = useState(false);
  // Read synchronously by send(): the `busy` state is a stale closure value for
  // a second tap in the same frame, and the history effect needs the live flag.
  const busyRef = useRef(false);
  // Moves when a send starts AND when it ends; a history GET captures it when
  // issued, so its snapshot can be recognised as older than the screen.
  const sendGenRef = useRef(0);
  // True while the thread may be missing turns from elsewhere: a GET result was
  // ignored, or a failed refresh was hidden behind a send's error. A send's end
  // re-fetches once (`refreshAfterSend`); `lastSendCutRef` says whether it ended cut.
  const historyStaleRef = useRef(false);
  const lastSendCutRef = useRef(false);
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [mode, setModeState] = useState(() => {
    try {
      return localStorage.getItem(MODE_KEY) === "plan" ? "plan" : "discussion";
    } catch {
      return "discussion";
    }
  });
  const setMode = useCallback((next) => {
    setModeState(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // Private mode — the persisted mode is an optimisation, never a requirement.
    }
  }, []);

  // send() reads the freshest data without being re-created on every edit —
  // a changing identity would restart effects that depend on it.
  const dataRef = useRef(null);
  dataRef.current = { sessions, profile, plan, activeSession };

  useEffect(() => {
    if (messages.length) writeCache(messages);
  }, [messages]);

  useEffect(() => {
    if (!client) return undefined;
    let cancelled = false;

    (async () => {
      for (let attempt = 0; attempt <= HISTORY_RETRIES; attempt++) {
        try {
          const issuedGen = sendGenRef.current;
          const data = await client.fetchCoachHistory();
          if (cancelled) return;
          // Decided NOW, at resolve time. A snapshot that a send may postdate
          // is ignored, not merged: replacing would erase a question still in
          // flight or shorten a reply she already read (see `historyAction`).
          const action = historyAction({ issuedGen, gen: sendGenRef.current, busy: busyRef.current });
          if (action === "apply") {
            const fresh = data.messages?.length
              ? data.messages.map(cleanStoredTurn)
              : [{ role: "assistant", content: OPENING_LINE }];
            setMessages(fresh);
            historyStaleRef.current = false;
          } else {
            historyStaleRef.current = true;
            // The send this result raced may already have ended (its finally
            // ran before the flag was set): then refresh now, on the same rule.
            if (!busyRef.current && refreshAfterSend({ stale: true, cut: lastSendCutRef.current })) {
              historyStaleRef.current = false;
              setReloadKey((k) => k + 1);
            }
          }
          setError((e) => errorAfterHistory(e, action));
          return;
        } catch (err) {
          if (cancelled) return;
          if (err?.status === 401) {
            authLostRef.current?.(err);
            return;
          }
          if (attempt < HISTORY_RETRIES) await wait(500 * 2 ** attempt);
        }
      }
      if (cancelled) return;
      // The conversation is NOT replaced. Whatever the cache holds stays on
      // screen; the failure is reported beside it, not in place of it.
      setMessages((m) => (m.length ? m : [{ role: "assistant", content: OPENING_LINE }]));
      setError((e) => {
        // Idempotent, so safe in an updater React may run twice.
        if (historyStaleAfterFailure(e)) historyStaleRef.current = true;
        return errorAfterHistoryFailure(e);
      });
    })();

    return () => { cancelled = true; };
  }, [client, reloadKey]);

  // « Réessayer » sits on the banner itself, so pressing it answers that banner:
  // it goes now. A successful refresh clears only its OWN error (see
  // `errorAfterHistory`), so without this a cut-reply banner would outlive the
  // reload it asked for.
  const reload = useCallback(() => {
    setError(null);
    setReloadKey((k) => k + 1);
  }, []);

  /**
   * TWO PATHS NEVER TOUCH THE DRAFT, and for the same reason.
   *
   * `override` is a message the APP composed rather than one the user typed — today
   * only the correction request. She may have half a question sitting in the
   * composer, and a one-tap button that silently eats it would be worse than
   * the rejection it is fixing. The override also skips `PLAN_REQUEST`, since
   * it is already a full request.
   *
   * `plan-emit` is now the second such path. It used to send `draft.trim()`
   * whenever the composer held anything — « her own words win » — and clear it.
   * Measured on 2026-08-16: « Plan importable » was sitting in the composer, the
   * « Plan » button turned it into the plan request, and the emit took 36 s. It
   * did no harm that time, but the shape is wrong. A button with one job should
   * send one message; one whose payload depends on invisible composer state is
   * not predictable, and the cost of the surprise is a half-typed question
   * becoming a 33-53 s plan generation and vanishing from the composer with it.
   *
   * The repo already ruled on exactly this shape once: `PLAN_BUTTON_LABEL` was a
   * function returning one of two labels for a byte-identical request, which
   * "bought nothing and guaranteed that failure" and was pinned to one string.
   * The payload gets the same treatment. Steering a plan is what « Mon
   * programme » mode is for — she talks to the coach first, then presses the
   * button, and the conversation is in the history the emit reads.
   */
  async function send(wireMode = mode, override = null) {
    // The emit request is FIXED. Everywhere else, her words are the message.
    const message = override || (wireMode === "plan-emit" ? PLAN_REQUEST : draft.trim());
    if (!canSend({ message, busy: busyRef.current, client })) return;
    busyRef.current = true;
    sendGenRef.current++;

    // Identity, not position: it is how the question is taken back off screen
    // if the request never reached a model.
    const question = { role: "user", content: message };
    // Consumed only when the draft IS the message — see the two paths above.
    const consumesDraft = !override && wireMode !== "plan-emit";
    if (consumesDraft) setDraft("");
    setError(null);
    setMessages((m) => [...m, question]);
    setBusy(true);
    setStreaming("");
    setStreamingMode(wireMode);

    let acc = "";
    let cut = false;
    try {
      const { sessions: s, profile: p, plan: pl, activeSession: a } = dataRef.current;
      const res = await client.sendCoachMessage({
        message,
        exportContext: generateExport(s, p, pl, a),
        mode: wireMode,
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // The plan-emit keepalive byte is dropped per CHUNK, before it ever
        // joins `acc`: it is a single ASCII byte, so it cannot straddle a
        // chunk boundary and cannot be in the decoder's final flush below,
        // and stripping the accumulated text instead would rescan the whole
        // reply on every chunk. It would otherwise sit in front of the `{`
        // that tells the bubble it is a plan. finalizeStream strips it too —
        // one extra O(n) pass, kept because that function is the shared
        // judgement of a raw stream and must stay correct for a reader that
        // did not strip.
        // Only the plan-emit path ever carries the byte, so a chat reply is not scanned for it.
        const chunk = dec.decode(value, { stream: true });
        acc += wireMode === "plan-emit" ? stripKeepalive(chunk) : chunk;
        // An echoed annotation line is the FIRST thing on the wire, so unlike
        // the notebook label it can be held back before it is ever painted:
        // `partial` keeps a bracket-opening first line off screen until its
        // newline settles the question. `acc` itself stays raw otherwise —
        // finalizeStream needs the untouched bytes to read the end and error
        // markers.
        setStreaming(stripEchoedAnnotation(acc, { partial: true }));
      }
      // Flush: a multi-byte character straddling the final chunk boundary stays
      // buffered otherwise, and French accents make that a regular occurrence.
      acc += dec.decode();
      // A stream can end cleanly and still be incomplete: when the platform
      // kills the invocation mid-reply, the read loop here simply reports done.
      // The end marker is the only thing that separates the two, and this is
      // where it is consumed — nothing downstream should ever see it.
      const { text, interrupted, failed } = finalizeStream(acc);
      // No model on the ladder accepted the request. This used to arrive as a
      // 502 and be caught below; the server now returns its Response before it
      // calls the model, so there is no status left to carry it and the verdict
      // comes in-band. Handled explicitly rather than falling through the
      // `!text` throw, because the two mean different things and only one of
      // them means "the server banked nothing".
      if (failed) throw new Error("no model answered");
      if (!text) throw new Error("empty reply");
      setMessages((m) => [...m, { role: "assistant", content: text }]);
      // Kept on screen rather than reloaded automatically: what arrived here is
      // never shorter than the server's last checkpoint, so a silent refresh
      // could only take text away from her. The banner offers it instead.
      if (interrupted) {
        cut = true;
        setError(CUT_ERROR);
      }
    } catch (err) {
      if (err?.status === 401) {
        // Nothing reached a model. Back to the gate, which unmounts this hook:
        // her question is written to sessionStorage first, so it is back in
        // the composer once the new key is in. Written directly — a state
        // update would never reach the effect before the unmount. The cache
        // too, or the remount reads the question back as a SENT bubble while
        // the composer also holds it.
        writeCache(messagesRef.current.filter((x) => x !== question));
        setMessages((m) => m.filter((x) => x !== question));
        saveDraft(draftToKeep({ draft: draftRef.current, message, consumesDraft }));
        if (mounted.current) authLostRef.current?.(err);
        return;
      }
      const { text: partial } = finalizeStream(acc);
      if (partial) {
        // Partial reply: the server banked the same text, so keeping it on
        // screen matches what she will find here after a reload.
        setMessages((m) => [...m, { role: "assistant", content: partial }]);
        cut = true;
        setError(CUT_ERROR);
      } else {
        // Nothing arrived, so no model accepted the request and the server
        // holds nothing either. Take the question back rather than show one
        // that would vanish on the next load, and give her the text back.
        setMessages((m) => m.filter((x) => x !== question));
        // Only her own words go back to the composer. Putting an app-composed
        // request there would hand her a wall of validator errors to edit or
        // delete, for a message she never wrote — or, since the emit request
        // became fixed, `PLAN_REQUEST` — so the banner must not promise it
        // either. The three cases are the three kinds of message: hers, the
        // correction the app composed, and the plan button's fixed request.
        if (consumesDraft) setDraft((d) => d || message);
        setError(
          override ? CORRECTION_ERROR : consumesDraft ? SEND_ERROR : PLAN_ERROR
        );
      }
    } finally {
      setStreaming(null);
      setStreamingMode(null);
      busyRef.current = false;
      sendGenRef.current++;
      setBusy(false);
      lastSendCutRef.current = cut;
      if (refreshAfterSend({ stale: historyStaleRef.current, cut })) {
        historyStaleRef.current = false;
        setReloadKey((k) => k + 1);
      }
    }
  }

  return {
    messages, streaming, streamingMode, busy, draft, setDraft,
    mode, setMode,
    // Ordinary sends always carry the CURRENT mode and never the emit mode, so a
    // typed message can never produce a programme.
    send: () => send(mode),
    // Fixed to "discussion" regardless of the shared `mode` state. The ONLY
    // caller is SeanceCoachPanel: `mode` is one shared value across both
    // surfaces (Coach tab + séance panel), and `setMode` persists to
    // localStorage on purpose, so the panel must never read `mode` through
    // `send()` — doing so would let whatever she last toggled in the Coach
    // tab leak into a séance send, and on a phone the panel isn't even
    // visible while that happens (`hidden xl:flex`).
    sendDiscussion: () => send("discussion"),
    // The ONLY path to a schema-backed request. Deliberately absent from
    // SeanceCoachPanel: you do not rebuild a week mid-workout.
    requestPlanUpdate: () => send("plan-emit"),
    /**
     * Hands the import's own rejection back to the coach, as one ordinary
     * plan-emit request — errors AND a digest of the plan they refer to.
     *
     * The digest is not decoration. `collapsePlan` rewrites the payload to
     * `[programme émis : N séances, …]` before history reaches the model, and
     * `generateExport` ships the CURRENT stored plan, which is the previous
     * week since a rejected plan is never imported. Sending the errors alone
     * asked the coach to fix a séance it could not read, so the only move left
     * to it was to regenerate the week from scratch.
     *
     * One tap, one request, no retry loop: she reads the result before
     * deciding anything. Firing it automatically was ruled out for the same
     * reason the single-tap plan chip was retired — a ~20 s schema request
     * must never happen without a deliberate gesture.
     *
     * Sends nothing when there is nothing to relay (`buildCorrectionRequest`
     * returns null), rather than asking the coach to fix an empty list.
     */
    requestPlanCorrection: (errors, rejectedPayload = null) => {
      const message = buildCorrectionRequest(errors, summarizeRejectedPlan(rejectedPayload));
      if (!message) return;
      return send("plan-emit", message);
    },
    error, dismissError: () => setError(null), reload,
    hasClient: !!client,
  };
}
