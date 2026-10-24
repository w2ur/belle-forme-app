import { describe, it, expect } from "vitest";
import {
  cleanVisibleReply,
  finalizeStream,
  stripEchoedAnnotation,
  stripNotebookAnnouncement,
  STREAM_END_MARKER,
  STREAM_ERROR_MARKER,
  STREAM_KEEPALIVE_MARKER,
  stripKeepalive,
  TRUNCATION_NOTE,
} from "./coachStream.js";

describe("finalizeStream", () => {
  it("accepts a reply that carries the end marker, and strips it", () => {
    const { text, interrupted } = finalizeStream(`Voilà ta séance.${STREAM_END_MARKER}`);
    expect(text).toBe("Voilà ta séance.");
    expect(interrupted).toBe(false);
    expect(text).not.toContain(STREAM_END_MARKER);
  });

  // Regression: user feedback 2026-08-02 — replies cut mid-sentence with nothing
  // to say so. Netlify kills a streamed invocation at 10 s, and from the client
  // that is byte-for-byte a normal end of stream. Without the marker there is no
  // way to tell a finished answer from a decapitated one.
  it("treats a stream that ends without the marker as interrupted, and says so", () => {
    const { text, interrupted } = finalizeStream("On évite d'épaissir la taille, donc (on");
    expect(interrupted).toBe(true);
    expect(text).toContain(TRUNCATION_NOTE.trim());
  });

  it("does not stack a second note when the server already added one", () => {
    const cut = `Séance 1 — Jambes${TRUNCATION_NOTE}`;
    const { text, interrupted } = finalizeStream(cut);
    expect(interrupted).toBe(true);
    expect(text.match(/Réponse coupée/g)).toHaveLength(1);
  });

  it("leaves a marked-then-completed reply exactly as the server wrote it", () => {
    const raw = `Séance 1 — Jambes${TRUNCATION_NOTE}${STREAM_END_MARKER}`;
    const { text, interrupted } = finalizeStream(raw);
    // The server knew it was truncated and said so; the marker means it finished
    // its own work, so the client must not add a verdict of its own on top.
    expect(interrupted).toBe(false);
    expect(text.match(/Réponse coupée/g)).toHaveLength(1);
  });

  it("reports nothing at all as interrupted with no text to show", () => {
    expect(finalizeStream("")).toEqual({ text: "", interrupted: true });
    expect(finalizeStream("   ")).toEqual({ text: "", interrupted: true });
    expect(finalizeStream(undefined)).toEqual({ text: "", interrupted: true });
  });

  // The 502 is gone: the Response is returned before the model is called, so a
  // status can no longer be set by the time the ladder is known to have failed.
  // Total failure therefore has to arrive in-band, and this marker is the
  // client's only evidence of it.
  it("reports a total provider failure with nothing to render", () => {
    const { text, interrupted, failed } = finalizeStream(STREAM_ERROR_MARKER);
    expect(failed).toBe(true);
    expect(text).toBe("");
    // NOT "interrupted": nothing was banked server-side, so the right offer is
    // to resend her question, not to reload a transcript that does not have it.
    expect(interrupted).toBe(false);
  });

  it("keeps failure and a clean end on distinct control characters", () => {
    expect(STREAM_ERROR_MARKER).toHaveLength(1);
    expect(STREAM_ERROR_MARKER.charCodeAt(0)).toBeLessThan(0x20);
    expect(STREAM_ERROR_MARKER).not.toBe(STREAM_END_MARKER);
  });

  // The marker is protocol. If it ever renders, it is a bug — but an invisible
  // one, which is why a control character was chosen over a word.
  it("uses a control character that cannot collide with anything the model writes", () => {
    expect(STREAM_END_MARKER).toHaveLength(1);
    expect(STREAM_END_MARKER.charCodeAt(0)).toBeLessThan(0x20);
  });
});

// The notebook itself is captured correctly — `createNotebookSplitter` takes
// everything from `<<<NOTEBOOK>>>` onwards, and `coach_notebook` was written at
// 09:43:26 for the reply banked at 09:43:09. What leaks is the LABEL the model
// writes just before the sentinel, which is ordinary visible text by the time
// the sentinel arrives and is long gone down the wire. Measured on the live
// transcript 2026-08-16: all five replies from 2026-08-14 end on a dangling
// `---` + « **Carnet mis à jour** : » with nothing after it, and 13 replies
// overall carry some form of it. The splitter's own markdown fallback cannot
// see these — it matches `#` headings, and 0 of 67 assistant replies have ever
// used one.
describe("stripNotebookAnnouncement", () => {
  it("removes a trailing carnet label and the rule above it", () => {
    const reply = "On reprend le Pull lundi.\n\n---\n**Carnet mis à jour** :";
    expect(stripNotebookAnnouncement(reply)).toBe("On reprend le Pull lundi.");
  });

  it("removes the other wording production produced", () => {
    const reply = "Bien joué.\n\n---\n**Mise à jour du carnet (privé) :**";
    expect(stripNotebookAnnouncement(reply)).toBe("Bien joué.");
  });

  // False-positive guards. Each one fails against a specific loosening of the
  // rule, which is what makes them evidence: this text IS shown to the user, so an
  // over-eager match eats something she was meant to read.
  it("keeps a carnet mentioned mid-reply", () => {
    const reply = "Je note dans mon carnet que tu préfères les fentes arrière.\n\nÀ lundi.";
    expect(stripNotebookAnnouncement(reply)).toBe(reply);
  });

  it("keeps a trailing line that merely contains the word", () => {
    // Not start-anchored, so it is a sentence rather than a label.
    const reply = "À lundi.\n\nJe garde ça dans mon carnet.";
    expect(stripNotebookAnnouncement(reply)).toBe(reply);
  });

  it("keeps a rule that is not followed by a label", () => {
    const reply = "Point 1.\n\n---\n\nPoint 2.";
    expect(stripNotebookAnnouncement(reply)).toBe(reply);
  });

  it("does not reach past the last line", () => {
    // The label is not trailing: real coaching follows it, and it survives.
    const reply = "Carnet mis à jour :\n\nEt maintenant, la séance de demain.";
    expect(stripNotebookAnnouncement(reply)).toBe(reply);
  });

  it("survives an empty or absent reply", () => {
    expect(stripNotebookAnnouncement("")).toBe("");
    expect(stripNotebookAnnouncement(undefined)).toBe("");
  });
});

describe("finalizeStream drops the notebook announcement", () => {
  it("cleans a settled reply so the bubble matches what is stored", () => {
    const raw = `On reprend lundi.\n\n---\n**Carnet mis à jour** :${STREAM_END_MARKER}`;
    expect(finalizeStream(raw).text).toBe("On reprend lundi.");
  });

  // A cut reply is a different event and keeps its own marker. The label may
  // well be absent there — the model never got that far.
  it("still reports a cut reply as cut", () => {
    const { text, interrupted } = finalizeStream("On reprend lun");
    expect(interrupted).toBe(true);
    expect(text).toContain(TRUNCATION_NOTE.trim());
  });
});

/**
 * Regression: production, measured 2026-08-30 — 25 of the 46 assistant replies
 * banked since the 2026-08-24 stamping change OPEN on a bracketed date line the
 * model copied out of its own annotated history. Reply #380 (17:27) is labelled
 * « [dim. 30 août, 20:10] », #332 (18:49) is labelled 18:47: the model copies the
 * PRECEDING turn's stamp, so the time it shows the user is always wrong.
 */
describe("stripEchoedAnnotation", () => {
  it("removes a date stamp the model copied onto its own reply", () => {
    expect(stripEchoedAnnotation("[dim. 30 août, 17:15]\nPour les abdos, fais…"))
      .toBe("Pour les abdos, fais…");
  });

  it("removes a session break and a stamp together", () => {
    const echoed = "[— nouvelle conversation, 3 jours plus tard —]\n[mer. 26 août, 18:47]\nSalut.";
    expect(stripEchoedAnnotation(echoed)).toBe("Salut.");
  });

  // False-positive guards. This text IS shown to the user, so the match has to be a
  // whole leading line of the annotation's own shape and nothing looser. Each
  // of these fails against one specific loosening of ECHOED_ANNOTATION.
  it("keeps a date and a time written inside a sentence", () => {
    const prose = "Le 30 août à 17:15 tu as fait ta séance bas du corps.";
    expect(stripEchoedAnnotation(prose)).toBe(prose);
  });

  it("keeps a bracketed line that is not an annotation", () => {
    const prose = "[à tester aujourd'hui]\nUne série de 5 reps.";
    expect(stripEchoedAnnotation(prose)).toBe(prose);
  });

  it("keeps a stamp that is not the FIRST thing in the reply", () => {
    const prose = "Comme je te disais :\n[dim. 30 août, 17:15]\nrepos 90s.";
    expect(stripEchoedAnnotation(prose)).toBe(prose);
  });

  // The live stream. An echoed stamp is the first thing on the wire, which is
  // why this flash is fixable when the notebook label's is not: a first line
  // that opens on `[` is held until its newline decides the question.
  it("holds a bracket-opening first line while it is still streaming", () => {
    expect(stripEchoedAnnotation("[dim. 30 ao", { partial: true })).toBe("");
  });

  it("releases the held line once the newline proves it is not a stamp", () => {
    expect(stripEchoedAnnotation("[à tester]\nUne série.", { partial: true }))
      .toBe("[à tester]\nUne série.");
  });

  it("never holds anything once real text has started", () => {
    expect(stripEchoedAnnotation("Pour les abdos", { partial: true })).toBe("Pour les abdos");
  });
});

describe("cleanVisibleReply", () => {
  it("removes an echoed stamp and a trailing notebook label in one pass", () => {
    const reply = "[dim. 30 août, 17:15]\nRepos 90s entre les séries.\n\n**Carnet mis à jour** :";
    expect(cleanVisibleReply(reply)).toBe("Repos 90s entre les séries.");
  });

  it("leaves an ordinary reply exactly as written", () => {
    const reply = "Oui, 10 par côté.";
    expect(cleanVisibleReply(reply)).toBe(reply);
  });
});

describe("finalizeStream strips an echoed stamp", () => {
  it("on a reply that completed", () => {
    const { text } = finalizeStream(`[dim. 30 août, 17:15]\nOui.${STREAM_END_MARKER}`);
    expect(text).toBe("Oui.");
  });

  it("on a reply that was cut", () => {
    const { text, interrupted } = finalizeStream("[dim. 30 août, 17:15]\nOn reprend lun");
    expect(interrupted).toBe(true);
    expect(text.startsWith("On reprend lun")).toBe(true);
  });
});

// Regression: 5009b6a — 2026-10-06, Large 4 on rung 1 writes at 20-70 tok/s,
// so the buffered plan-emit path carried no bytes for 40-185 s. The server now
// sends STREAM_KEEPALIVE_MARKER every few seconds while it buffers; it is
// protocol, never text, and must be invisible to every judgement made here.
describe("the plan-emit keepalive byte", () => {
  const KA = STREAM_KEEPALIVE_MARKER;

  it("is stripped everywhere it can sit, and nothing else is", () => {
    expect(stripKeepalive(`${KA}${KA}{"a":1}${KA}`)).toBe('{"a":1}');
    expect(stripKeepalive("Oui, 90 s.")).toBe("Oui, 90 s.");
    expect(stripKeepalive(undefined)).toBe("");
  });

  it("does not hide the end marker or decorate a complete payload", () => {
    const { text, interrupted } = finalizeStream(`${KA}${KA}${KA}{"weekStart":"2026-10-07"}${KA}${STREAM_END_MARKER}`);
    expect(text).toBe('{"weekStart":"2026-10-07"}');
    expect(interrupted).toBe(false);
  });

  it("does not hide the error marker either", () => {
    expect(finalizeStream(`${KA}${KA}${STREAM_ERROR_MARKER}`)).toEqual({ text: "", interrupted: false, failed: true });
  });

  it("alone, is a cut stream that produced nothing — never a reply", () => {
    expect(finalizeStream(`${KA}${KA}${KA}`)).toEqual({ text: "", interrupted: true });
  });
});
