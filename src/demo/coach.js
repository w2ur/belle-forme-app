/**
 * The demo's coach: scripted, offline, and labelled as such.
 *
 * It is a drop-in for the two coach methods of the sync client
 * (`sendCoachMessage`, `fetchCoachHistory`), so `useCoachChat` streams, settles
 * and renders its replies through exactly the code the real coach goes through —
 * the same reader loop, `finalizeStream`, the end marker, the bubbles, the
 * PlanCard. Nothing goes on the network.
 *
 * The answers follow the real coach's register (`coachPrompt.js`): tutoiement,
 * direct and warm, no headings or bold labels, a closed question answered short,
 * an open one in a paragraph or two; nutrition stays general and the medical
 * referral is the same one the real coach makes. Where a number appears it is
 * read from the visitor's demo data, so it stays true after she logs a séance.
 */
import { STREAM_END_MARKER } from "../lib/coachStream.js";
import { computeLoadStreaks } from "../lib/stats.js";
import { CLEAN_SESSIONS_BEFORE_LOAD_INCREASE } from "../constants/index.js";
import { buildInventoryViews } from "../constants/equipment.js";
import { buildPlanPayload, mondayOf, isoDate, addDays, DEMO_PERSONA_NAME } from "./fixtures.js";

export const DEMO_COACH_LABEL = "Coach simulé — réponses préécrites";

export const DEMO_OPENING =
  `Salut ${DEMO_PERSONA_NAME} ! Ici, je suis un coach simulé : choisis une des questions proposées et je te réponds à partir de tes données de démo.`;

export const DEMO_FALLBACK =
  "Dans cette démo, je ne réponds qu'aux questions proposées au-dessus du champ. Dans l'app, le vrai coach lit tes séances et te répond sur ce que tu lui écris.";

const kg = (n) => `${String(n).replace(".", ",")} kg`;
const load = (n, weightType) => (weightType === "per_hand" ? `${kg(n)}/main` : kg(n));

function readJson(store, key, fallback) {
  try {
    const raw = store.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function squatAnswer({ sessions, profile }) {
  const squats = sessions
    .filter((s) => s.exercises?.some((e) => e.name === "Squat" && e.sets?.length))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!squats.length) return "Je ne vois pas encore de squat dans tes séances : note ta prochaine et on en reparle.";
  const top = (s) => Math.max(...s.exercises.find((e) => e.name === "Squat").sets.map((x) => Number(x.weight) || 0));
  const first = top(squats[0]);
  const streak = computeLoadStreaks(sessions).Squat;
  const current = streak?.load ?? top(squats.at(-1));
  const count = streak?.sessions ?? 1;
  const perHand = buildInventoryViews(profile?.inventory).perHandUnion ?? [];
  const next = perHand.find((w) => w > current);
  const opening = first < current
    ? `Bien. Tu es passée de ${load(first, "per_hand")} à ${load(current, "per_hand")} en ${squats.length} séances de squat, et tes ${count} dernières à ${load(current, "per_hand")} sont propres.`
    : `Tu tiens ${load(current, "per_hand")} depuis ${count} séance${count > 1 ? "s" : ""}, toutes propres.`;
  if (count >= CLEAN_SESSIONS_BEFORE_LOAD_INCREASE && next) {
    return `${opening} C'est le signal pour monter : passe à ${load(next, "per_hand")} à la prochaine séance bas du corps, en gardant 4×8. Si la dernière série te coûte plus de deux répétitions de technique, reste à ${load(next, "per_hand")} la semaine suivante avant d'aller plus loin.`;
  }
  const left = CLEAN_SESSIONS_BEFORE_LOAD_INCREASE - count;
  return `${opening} Encore ${left} séance${left > 1 ? "s" : ""} propre${left > 1 ? "s" : ""} à cette charge et tu pourras monter. Garde le même tempo, descente contrôlée, et note si une série devient difficile.`;
}

function nextSessionAnswer({ sessions, plan }) {
  if (!plan?.sessions?.length) return "Tu n'as pas de programme en cours. Passe en « Mon programme » et appuie sur « Plan » pour en recevoir un.";
  const inWeek = sessions.filter((s) => s.date >= plan.weekStart && s.date <= plan.weekEnd).map((s) => s.name);
  const next = plan.sessions.find((p) => !inWeek.includes(p.name));
  if (!next) {
    return "Tu as fait les trois séances de la semaine. Repos ou marche tranquille d'ici lundi ; ensuite, en « Mon programme », appuie sur « Plan » pour la semaine suivante.";
  }
  const lines = next.exercises.map((e) => {
    const unit = e.metric === "seconds" ? " s" : "";
    const weight = Number(e.weight) > 0 ? ` à ${load(e.weight, e.weightType)}` : "";
    return `${e.name} ${e.setsCount}×${e.reps}${unit}${weight}`;
  });
  return `Ta prochaine séance, c'est « ${next.name} » : ${lines.slice(0, -1).join(", ")} et ${lines.at(-1)}. Les charges sont les mêmes que la semaine dernière : vise une exécution propre plutôt que de forcer, et prends le repos indiqué entre les séries. Tu choisis le jour.`;
}

const FATIGUE_ANSWER =
  "Oui, lève un peu le pied, sans tout arrêter. La semaine dernière, tu as écourté le gainage latéral et noté une mauvaise nuit : c'est un signal, pas un échec. Cette semaine, garde les mêmes exercices et les mêmes charges, mais fais une série de moins sur chacun et arrête-toi à deux ou trois répétitions de l'échec. Côté récupération, des heures de coucher régulières, de quoi boire pendant la séance et un repas avec des protéines dans les heures qui suivent aident vraiment. Si la fatigue dure plus de deux semaines, ou vient avec d'autres symptômes, parles-en à un médecin.";

const RDL_ANSWER =
  "Il travaille l'arrière de tes cuisses et tes fessiers, et il t'apprend la charnière de hanche : tu plies aux hanches, dos long, sans en faire un squat. En descendant, tu dois sentir l'étirement derrière les cuisses ; en remontant, les fessiers qui serrent. Si c'est le bas du dos qui travaille, réduis l'amplitude. Il complète ton squat, qui sollicite surtout l'avant des cuisses, et il rend plus facile tout ce qui se ramasse par terre. Dans deux ou trois semaines, tu le verras à deux choses : 12 kg/main te paraîtront plus légers sur tes 3×10, et tu descendras plus bas sans arrondir le dos.";

/** The suggested questions, in the order the chips show them. */
export const DEMO_QUESTIONS = [
  { question: "Comment progresse mon squat ?", answer: squatAnswer },
  { question: "Je fais quoi à ma prochaine séance ?", answer: nextSessionAnswer },
  { question: "Je suis fatiguée cette semaine, je lève le pied ?", answer: () => FATIGUE_ANSWER },
  { question: "À quoi sert le soulevé de terre roumain ?", answer: () => RDL_ANSWER },
];

/** The scripted reply to `message` in `mode`, from the visitor's demo data. */
export function demoReply(message, mode, data, now = new Date()) {
  if (mode === "plan-emit") {
    const next = addDays(mondayOf(now), 7); // by calendar day: a DST change makes a week 167 or 169 hours
    const payload = { ...buildPlanPayload(next), coachNotes: `Programme de démo pour la semaine du ${isoDate(next).slice(8)}/${isoDate(next).slice(5, 7)} : mêmes séances, mêmes charges, le temps de consolider.` };
    delete payload.notebook; // as the real server does: the notebook never travels
    return JSON.stringify(payload);
  }
  const hit = DEMO_QUESTIONS.find((q) => q.question === message.trim());
  return hit ? hit.answer(data) : DEMO_FALLBACK;
}

/** The reply cut into word groups, as a model streams it. */
export function chunksOf(text) {
  return text.match(/\S+\s*/g)?.reduce((out, word, i) => {
    if (i % 2 === 0) out.push(word); else out[out.length - 1] += word;
    return out;
  }, []) ?? [];
}

const TRANSCRIPT_KEY = "demo_coach_transcript";

/**
 * The coach half of a sync client, for the demo. `store` is the namespaced
 * localStorage; `delayMs` returns the pause before each chunk (20–40 ms).
 */
export function createDemoCoachClient({
  store,
  now = () => new Date(),
  delayMs = () => 20 + Math.random() * 20,
}) {
  const transcript = () => readJson(store, TRANSCRIPT_KEY, []);
  const bank = (turns) => {
    try { store.setItem(TRANSCRIPT_KEY, JSON.stringify([...transcript(), ...turns].slice(-200))); } catch { /* quota */ }
  };
  return {
    async fetchCoachHistory() {
      const messages = transcript();
      return { messages: messages.length ? messages : [{ role: "assistant", content: DEMO_OPENING }] };
    },
    async sendCoachMessage({ message, mode = "discussion" }) {
      const data = {
        sessions: readJson(store, "sessions", []),
        plan: readJson(store, "currentPlan", null),
        profile: readJson(store, "profile", null),
      };
      const reply = demoReply(message, mode, data, now());
      bank([{ role: "user", content: message }, { role: "assistant", content: reply }]);
      const enc = new TextEncoder();
      // A plan payload arrives in one piece, as the real buffered emit path sends it.
      const parts = mode === "plan-emit" ? [reply] : chunksOf(reply);
      const body = new ReadableStream({
        async start(controller) {
          for (const part of parts) {
            await new Promise((r) => setTimeout(r, delayMs()));
            controller.enqueue(enc.encode(part));
          }
          controller.enqueue(enc.encode(STREAM_END_MARKER));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    },
  };
}

let demoClient;

/** One client per page, so `useCoachChat`'s effects see a stable identity. */
export function getDemoCoachClient() {
  demoClient ??= createDemoCoachClient({ store: window.localStorage });
  return demoClient;
}
