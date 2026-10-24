import { describe, it, expect } from "vitest";
import {
  annotateHistory,
  SESSION_GAP_HOURS,
  ORPHAN_NOTE,
  LEGACY_PLAN_MARKER,
} from "../functions/lib/historyView.js";
import {
  ANNOTATION_LINE,
  OLDER_ASSISTANT_CHARS,
  stripReplyScaffolding,
} from "../functions/lib/coachPrompt.js";
import { ECHOED_ANNOTATION } from "../../src/lib/coachStream.js";
import { isPlanPayload } from "../../src/lib/planFromJson.js";

/**
 * The turn's text with the annotation lines `annotateHistory` prepends removed.
 *
 * The collapse tests below are about `collapsePlan`, not about stamping, and
 * both roles carry a stamp since 2026-08-24. Comparing the whole string would
 * make every one of them a test of the stamp format as well.
 */
const body = (content) => content.replace(/^(?:\[[^\n]*\]\n)+/, "");

/** Rows as coachDb hands them over: role, content, created_at. */
const at = (role, content, iso) => ({ role, content, created_at: iso });

describe("annotateHistory", () => {
  it("stamps BOTH roles — hers inline, the coach's on its own line", () => {
    const out = annotateHistory([
      at("user", "Combien de séries ?", "2026-08-04T17:12:00Z"),
      at("assistant", "Quatre.", "2026-08-04T17:12:30Z"),
    ]);
    // Not an exact string: ICU output varies by version. What matters is that the
    // day and the hour are both there, in French, in front of the words.
    expect(out[0].content).toMatch(/^\[.*ao[ûu]t.*\].*Combien de séries \?$/s);
    expect(out[0].content).toContain("Combien de séries ?");
    expect(out[1].content).toMatch(/^\[.*ao[ûu]t.*\]\nQuatre\.$/s);
  });

  it("dates the coach's own words so it cannot re-read them as today's", () => {
    // Regression: a live failure. The coach wrote « le rendez-vous de demain »;
    // days later that sentence was still in the 40-message window with no date
    // on it, so « demain » read as tomorrow and the user had to ask repeatedly to
    // drop the subject. The stamp is the only thing that dates a relative word
    // inside a reply.
    const [turn] = annotateHistory([
      at("assistant", "Le rendez-vous de demain : reste légère.", "2026-03-03T15:16:00Z"),
    ]);
    expect(turn.content).toMatch(/^\[[^\n]*mars[^\n]*\]\n/);
    expect(turn.content).toContain("Le rendez-vous de demain");
  });

  it("puts the coach's stamp on its own line so the scaffolding strip still sees line one", () => {
    // The two passes compose: annotateHistory runs first, stripReplyScaffolding
    // over its output. An INLINE stamp would make « **Réponse courte :** » no
    // longer the first line, ANSWER_LABEL would stop matching, and every
    // self-announcing opener would survive into the model's context — undoing a
    // measured fix with nothing failing. Pinned here as well as in
    // coachPrompt.test.js because the guard only works if both halves hold.
    const [turn] = annotateHistory([
      at("assistant", "**Réponse courte :**\nOui.", "2026-08-04T17:12:30Z"),
    ]);
    expect(stripReplyScaffolding(turn.content)).toMatch(/^\[[^\n]*\]\nOui\.$/);
  });

  it("uses Europe/Paris, not the runtime's UTC", () => {
    // 17:12 UTC in August is 19:12 in Paris. The edge runtime is UTC, so without
    // an explicit zone every stamp would be two hours early and a late-evening
    // exchange would be dated to the wrong day.
    const [turn] = annotateHistory([at("user", "x", "2026-08-04T17:12:00Z")]);
    expect(turn.content).toContain("19");
    expect(turn.content).not.toContain("17:12");
  });

  it("marks a new conversation when the gap exceeds the threshold", () => {
    // The gap is measured from the PREVIOUS turn — the reply — not from Q1, so
    // the reply is stamped at the same instant to make the three days exact.
    const out = annotateHistory([
      at("user", "Q1", "2026-08-01T10:00:00Z"),
      at("assistant", "R1", "2026-08-01T10:00:00Z"),
      at("user", "Q2", "2026-08-04T10:00:00Z"),
    ]);
    expect(out[2].content).toContain("nouvelle conversation");
    expect(out[2].content).toContain("3 jours plus tard");
    // No break where there was no gap.
    expect(out[1].content).not.toContain("nouvelle conversation");
  });

  it("does not mark a break below the threshold", () => {
    const out = annotateHistory([
      at("user", "Q1", "2026-08-04T10:00:00Z"),
      at("assistant", "R1", "2026-08-04T10:01:00Z"),
      at("user", "Q2", `2026-08-04T${String(10 + SESSION_GAP_HOURS - 1).padStart(2, "0")}:00:00Z`),
    ]);
    expect(out.map((m) => m.content).join("\n")).not.toContain("nouvelle conversation");
  });

  it("annotates a question no reply ever followed", () => {
    const out = annotateHistory([
      at("user", "Q1", "2026-08-04T10:00:00Z"),
      at("user", "Q2", "2026-08-04T10:05:00Z"),
      at("assistant", "R2", "2026-08-04T10:06:00Z"),
    ]);
    expect(out[0].content).toContain(ORPHAN_NOTE);
    expect(out[1].content).not.toContain(ORPHAN_NOTE);
    expect(out[2].content).not.toContain(ORPHAN_NOTE);
  });

  it("annotates a trailing question, which is by definition unanswered", () => {
    // history is loaded BEFORE her current message is banked, so a trailing user
    // turn is the exact turn the old merge branch used to concatenate into.
    const out = annotateHistory([
      at("assistant", "R0", "2026-08-04T10:00:00Z"),
      at("user", "Q1", "2026-08-04T10:05:00Z"),
    ]);
    expect(out[1].content).toContain(ORPHAN_NOTE);
  });

  it("survives rows with no timestamp rather than dropping them", () => {
    const out = annotateHistory([
      { role: "user", content: "Q1" },
      { role: "assistant", content: "R1" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].content).toContain("Q1");
    expect(out[1].content).toBe("R1");
  });

  it("returns an empty array for junk input", () => {
    expect(annotateHistory(null)).toEqual([]);
    expect(annotateHistory(undefined)).toEqual([]);
  });
});

const planJson = JSON.stringify({
  weekStart: "2026-08-11", weekEnd: "2026-08-17", coachNotes: "", notebook: "",
  sessions: [
    { name: "Bas du corps", warmup: [], exercises: [], cooldown: [] },
    { name: "Haut du corps", warmup: [], exercises: [], cooldown: [] },
  ],
});

describe("plan payload collapse", () => {
  it("replaces a stored plan payload with a one-line marker", () => {
    const out = annotateHistory([
      { role: "user", content: "mon programme ?", created_at: "2026-08-11T09:00:00Z" },
      { role: "assistant", content: planJson, created_at: "2026-08-11T09:00:10Z" },
    ]);
    expect(out[1].content).not.toContain("weekStart");
    expect(out[1].content).toMatch(/programme émis/i);
    expect(out[1].content).toMatch(/2 séances/);
    expect(out[1].content).toMatch(/11\/08/);
  });

  it("leaves an ordinary prose reply completely untouched", () => {
    const prose = "Le donkey kick isole mieux les fessiers que le pont fessier.";
    const out = annotateHistory([
      { role: "user", content: "pourquoi ?", created_at: "2026-08-11T09:00:00Z" },
      { role: "assistant", content: prose, created_at: "2026-08-11T09:00:10Z" },
    ]);
    expect(body(out[1].content)).toBe(prose);
  });

  it("never collapses a USER turn, however JSON-shaped", () => {
    const out = annotateHistory([
      { role: "user", content: planJson, created_at: "2026-08-11T09:00:00Z" },
    ]);
    expect(out[0].content).toContain("weekStart");
  });

  it("preserves count, order and every role", () => {
    const input = [
      { role: "user", content: "a", created_at: "2026-08-11T09:00:00Z" },
      { role: "assistant", content: planJson, created_at: "2026-08-11T09:00:10Z" },
      { role: "user", content: "b", created_at: "2026-08-11T09:01:00Z" },
    ];
    const out = annotateHistory(input);
    expect(out).toHaveLength(3);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("agrees with the predicate the client uses to show the import button", () => {
    expect(isPlanPayload(planJson)).toBe(true);
  });

  it("agrees the plural for a zero-session plan", () => {
    const zeroPlan = JSON.stringify({ weekStart: "2026-08-11", sessions: [] });
    const out = annotateHistory([
      { role: "assistant", content: zeroPlan, created_at: "2026-08-11T09:00:00Z" },
    ]);
    expect(out[0].content).toMatch(/0 séances/);
    expect(out[0].content).not.toMatch(/0 séance[^s]/);
  });

  describe("a plan-emit reply truncated mid-stream", () => {
    // coach-chat.js appends TRUNCATION_NOTE (plain French text) straight onto
    // the raw JSON when a plan-emit reply is cut — never valid JSON, and
    // isPlanPayload correctly says no to it. Without a dedicated case this
    // fragment used to pass through untouched, leaking raw plan-schema syntax
    // (field names, punctuation) into the model-facing history.
    const truncationNote = "\n\n_(Réponse coupée avant la fin — demande-moi la suite.)_";

    it("collapses a cut-off plan JSON fragment to a marker that invents no count", () => {
      const fragment = '{"weekStart":"2026-08-11","weekEnd":"2026-08-17","sessions":[{"name":"Bas du' + truncationNote;
      const out = annotateHistory([
        { role: "assistant", content: fragment, created_at: "2026-08-11T09:00:00Z" },
      ]);
      expect(out[0].content).not.toContain("weekStart");
      expect(out[0].content).not.toContain("Bas du");
      expect(out[0].content).toMatch(/programme émis/i);
      expect(out[0].content).toMatch(/coup[ée]e/i);
      // No invented session count: the marker must carry no digit.
      expect(body(out[0].content)).not.toMatch(/\d/);
    });

    it("collapses a bare truncated JSON fragment with no trailing note too", () => {
      const fragment = '{"weekStart":"2026-08-11","sessions":[{"name":"Bas du corps","exer';
      const out = annotateHistory([
        { role: "assistant", content: fragment, created_at: "2026-08-11T09:00:00Z" },
      ]);
      expect(out[0].content).not.toContain("weekStart");
      expect(out[0].content).toMatch(/programme émis/i);
    });

    it("never collapses a truncated-looking USER turn", () => {
      const fragment = '{"weekStart":"2026-08-11","sessions":[{"name":"Bas du';
      const out = annotateHistory([
        { role: "user", content: fragment, created_at: "2026-08-11T09:00:00Z" },
      ]);
      expect(out[0].content).toContain("weekStart");
    });
  });

  describe("false-positive guard: prose is never mistaken for a truncated plan", () => {
    it("leaves prose that merely contains a brace mid-string untouched", () => {
      const prose = "On peut noter ça comme { 3 x 12 } dans ton carnet si tu veux.";
      const out = annotateHistory([
        { role: "assistant", content: prose, created_at: "2026-08-11T09:00:00Z" },
      ]);
      expect(body(out[0].content)).toBe(prose);
    });

    it("leaves prose explaining JSON, which does not start with a brace, untouched", () => {
      const prose = 'Le format ressemble à ceci : {"exemple": true}, tu vois le principe ?';
      const out = annotateHistory([
        { role: "assistant", content: prose, created_at: "2026-08-11T09:00:00Z" },
      ]);
      expect(body(out[0].content)).toBe(prose);
    });

    it("leaves content starting with { that parses as valid (non-plan) JSON untouched", () => {
      // Starts with "{" but is well-formed JSON with no `sessions` array —
      // isPlanPayload already says no, and the fragment heuristic must not
      // second-guess a payload that parsed fine.
      const validNonPlanJson = '{"foo":"bar"}';
      const out = annotateHistory([
        { role: "assistant", content: validNonPlanJson, created_at: "2026-08-11T09:00:00Z" },
      ]);
      expect(body(out[0].content)).toBe(validNonPlanJson);
    });

    it("leaves an empty object untouched", () => {
      const out = annotateHistory([
        { role: "assistant", content: "{}", created_at: "2026-08-11T09:00:00Z" },
      ]);
      expect(body(out[0].content)).toBe("{}");
    });
  });

  // The branch that was missing until 2026-08-11. `collapsePlan` recognised only
  // the NEW format, so every schema-backed plan was reduced to one line while
  // every `=== FITTRACK PLAN ===` block reached the model whole — leaving the
  // 40-message window with zero examples of the format the coach must use and N
  // examples of the one it must not. That is why relapses came back in the OLD
  // dialect specifically, and why they did not decay: each relapse re-entered
  // the window at the front and re-taught the format.
  describe("the legacy === FITTRACK PLAN === format", () => {
    const legacyBlock = [
      "=== FITTRACK PLAN ===",
      "Semaine : 11/08 → 17/08",
      "Séance 1 | Bas du corps",
      "Squat gobelet | 4x10 | 17kg | total",
      "Fentes bulgares | 3x12 | 11kg | /main",
      "=== FIN ===",
    ].join("\n");

    it("collapses a bare legacy block to a marker carrying none of the syntax", () => {
      const out = annotateHistory([
        { role: "assistant", content: legacyBlock, created_at: "2026-08-11T09:00:00Z" },
      ]);
      expect(body(out[0].content)).toBe(LEGACY_PLAN_MARKER);
      expect(out[0].content).not.toContain("FITTRACK");
      expect(out[0].content).not.toContain("Semaine :");
      expect(out[0].content).not.toContain("Squat gobelet");
    });

    it("keeps the prose before the block and drops the block", () => {
      const prose = "Je te propose une semaine un peu plus légère sur le bas du corps.";
      const out = annotateHistory([
        { role: "assistant", content: `${prose}\n\n${legacyBlock}`, created_at: "2026-08-11T09:00:00Z" },
      ]);
      expect(body(out[0].content)).toBe(`${prose}\n${LEGACY_PLAN_MARKER}`);
      expect(out[0].content).not.toContain("FITTRACK");
    });

    it("survives the 600-char abridge as a marker rather than a format specimen", () => {
      // budgetHistory keeps the first OLDER_ASSISTANT_CHARS of an older reply.
      // On an uncollapsed block that is exactly the header plus the first
      // exercise lines — the syntax, with the coaching cut off. Collapsing
      // first (annotateHistory runs before budgetHistory) is what prevents it.
      const long = `${legacyBlock}\n${"Reste bien gainée sur chaque répétition. ".repeat(40)}`;
      const [turn] = annotateHistory([
        { role: "assistant", content: long, created_at: "2026-08-11T09:00:00Z" },
      ]);
      expect(turn.content.slice(0, OLDER_ASSISTANT_CHARS)).not.toContain("FITTRACK");
    });

    it("never collapses a USER turn that quotes the old format", () => {
      // She pasted a plan at the coach once. Her words are never rewritten.
      const out = annotateHistory([
        { role: "user", content: legacyBlock, created_at: "2026-08-11T09:00:00Z" },
      ]);
      expect(out[0].content).toContain("FITTRACK PLAN");
    });

    // Regression: found against the real transcript, not by inspection — 22 of
    // 23 stored blocks used the bare header and this one decorated it. The model
    // embellishing a format it was told to reproduce verbatim is the same
    // failure that retired the text format; matching by shape rather than by
    // literal is what survives it.
    it("collapses a header the model decorated with a parenthetical", () => {
      const real = "=== FITTRACK PLAN (option 1 : pont fessier optimisé) ===\nSemaine : 10/08 → 16/08";
      const out = annotateHistory([
        { role: "assistant", content: real, created_at: "2026-08-11T09:00:00Z" },
      ]);
      expect(body(out[0].content)).toBe(LEGACY_PLAN_MARKER);
    });

    it("collapses a block whose header carries stray spacing", () => {
      const spaced = "  ===  FITTRACK PLAN  ===  \nSemaine : 11/08 → 17/08";
      const out = annotateHistory([
        { role: "assistant", content: spaced, created_at: "2026-08-11T09:00:00Z" },
      ]);
      expect(body(out[0].content)).toBe(LEGACY_PLAN_MARKER);
    });

    // The guard, and the reason the header is anchored to a line of its own
    // rather than matched anywhere. Loosen the anchor and this reply loses
    // everything from "===" onward — an explanation the user asked for, eaten.
    it("leaves a reply that merely MENTIONS the old format untouched", () => {
      const prose =
        "L'ancien format === FITTRACK PLAN === n'existe plus : l'API m'impose maintenant un schéma, "
        + "donc je n'écris plus aucune syntaxe moi-même et je ne peux plus le casser.";
      const out = annotateHistory([
        { role: "assistant", content: prose, created_at: "2026-08-11T09:00:00Z" },
      ]);
      expect(body(out[0].content)).toBe(prose);
    });

    it("agrees with the pattern the client uses to spot the same blocks", () => {
      // CoachConversation matches these to render them read-only. The two ends
      // must agree on what a legacy block IS, or one collapses what the other
      // still displays as live.
      expect(/===\s*FITTRACK PLAN\s*===[\s\S]*/.test(legacyBlock)).toBe(true);
    });
  });
});

/**
 * Regression: production, measured 2026-08-30. Since the 2026-08-24 change every
 * assistant turn in the window opens on a bracketed date line, and the model
 * learned to write one itself — 25 of the 46 replies banked since. That is the
 * `collapsePlan` selection effect one level down: twelve verbatim specimens in
 * history beat a rule in the prompt, which this repo has already lost once.
 *
 * The read path is where it is closed, so rows already in Neon stop teaching it
 * on the very next request and nothing is rewritten.
 */
describe("annotateHistory removes a stamp the MODEL wrote", () => {
  const at = (iso) => new Date(iso);

  it("strips an echoed stamp instead of stacking a second one in front of it", () => {
    const [turn] = annotateHistory([
      {
        role: "assistant",
        content: "[mer. 26 août, 18:47]\nPour les abdos, fais…",
        created_at: at("2026-08-26T16:49:00Z"),
      },
    ]);
    // Exactly one stamp — ours — and it is followed by the coach's real words.
    expect(turn.content.match(/\[[^\n[\]]*\d{1,2}:\d{2}\]/g)).toHaveLength(1);
    expect(turn.content).toMatch(/\]\nPour les abdos, fais…$/);
    expect(turn.content).not.toContain("18:47");
  });

  it("leaves a bracketed line that is not an annotation alone", () => {
    const [turn] = annotateHistory([
      {
        role: "assistant",
        content: "[à tester aujourd'hui]\n5 reps.",
        created_at: at("2026-08-26T16:49:00Z"),
      },
    ]);
    expect(turn.content).toContain("[à tester aujourd'hui]");
  });

  it("never touches a user turn, whatever it looks like", () => {
    const content = "[mer. 26 août, 18:47] c'est quoi ce truc ?";
    const [turn] = annotateHistory([
      { role: "user", content, created_at: at("2026-08-26T16:49:00Z") },
    ]);
    expect(turn.content).toContain(content);
  });
});

/**
 * The stamp shape exists in two modules and cannot be shared: `coachPrompt.js`
 * is the edge bundle and imports nothing from `src/`, by design. Same idiom as
 * PLAN_BUTTON_LABEL — duplicated by necessity, pinned equal by a test, because
 * two wordings of one rule is exactly what drifts.
 */
describe("annotation-line parity between coachPrompt and coachStream", () => {
  const SPECIMENS = [
    "[dim. 30 août, 17:15]",
    "[mer. 26 août, 18:47]",
    "[— nouvelle conversation, 3 jours plus tard —]",
    "[— nouvelle conversation, le lendemain —]",
    "[à tester aujourd'hui]",
    "[restée sans réponse — n'y reviens pas sauf si la question est reposée]",
    "Le 30 août à 17:15 tu as fait ta séance.",
    "",
  ];

  it.each(SPECIMENS)("agrees on %j", (line) => {
    expect(ECHOED_ANNOTATION.test(line)).toBe(ANNOTATION_LINE.test(line));
  });
});
