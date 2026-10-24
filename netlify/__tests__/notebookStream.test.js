import { describe, it, expect } from "vitest";
import { createNotebookSplitter } from "../functions/lib/notebookStream.js";

function run(chunks) {
  const s = createNotebookSplitter();
  let out = "";
  for (const c of chunks) out += s.push(c);
  out += s.end();
  return { out, notebook: s.notebook() };
}

describe("createNotebookSplitter", () => {
  it("passes through text with no notebook block", () => {
    const r = run(["Bravo ", "chérie !"]);
    expect(r.out).toBe("Bravo chérie !");
    expect(r.notebook).toBeNull();
  });

  it("hides the notebook block and captures its body (single chunk)", () => {
    const r = run(["Bravo !<<<NOTEBOOK>>>Camille préfère le matin.<<<END>>>"]);
    expect(r.out).toBe("Bravo !");
    expect(r.notebook).toBe("Camille préfère le matin.");
  });

  it("detects a sentinel split across chunks", () => {
    const r = run(["Bravo !<<<NOTE", "BOOK>>>note<<<END>>>"]);
    expect(r.out).toBe("Bravo !");
    expect(r.notebook).toBe("note");
  });

  // Regression: user feedback 2026-08-01 — "some answers are not complete". The
  // splitter latched into the notebook phase on the first sentinel and never
  // left, so everything the model said after <<<END>>> was thrown away. The
  // prompt asks for the block last, but a model that closes it and keeps
  // talking is not misbehaving — and on screen the loss reads as a truncation.
  it("resumes visible output after <<<END>>>", () => {
    const r = run(["Salut<<<NOTEBOOK>>>x<<<END>>> et bonne séance !"]);
    expect(r.out).toBe("Salut et bonne séance !");
    expect(r.notebook).toBe("x");
  });

  it("resumes when the block closes in a later chunk", () => {
    const r = run(["Salut<<<NOTEBOOK>>>note", " suite<<<E", "ND>>>fin"]);
    expect(r.out).toBe("Salutfin");
    expect(r.notebook).toBe("note suite");
  });

  // The worst case for the old code: a model that opens with the block loses
  // its ENTIRE answer, because nothing ever left the notebook phase.
  it("keeps the answer when the block comes first", () => {
    const r = run(["<<<NOTEBOOK>>>mémo<<<END>>>Voici ton programme."]);
    expect(r.out).toBe("Voici ton programme.");
    expect(r.notebook).toBe("mémo");
  });

  // Regression: user feedback 2026-08-01 — saveNotebook overwrites wholesale, so
  // reporting a half-streamed block would wipe real memory with the fragment of
  // a reply that got cut off. Truncation is precisely when that happened.
  it("reports no notebook when the block never closes", () => {
    const r = run(["Salut<<<NOTEBOOK>>>moitié de mémo"]);
    expect(r.out).toBe("Salut");
    expect(r.notebook).toBeNull();
  });

  it("keeps the last block when the model emits more than one", () => {
    const r = run(["a<<<NOTEBOOK>>>premier<<<END>>>b<<<NOTEBOOK>>>second<<<END>>>c"]);
    expect(r.out).toBe("abc");
    expect(r.notebook).toBe("second");
  });

  it("reports where the notebook came from", () => {
    const s = createNotebookSplitter();
    s.push("a<<<NOTEBOOK>>>x<<<END>>>");
    s.end();
    expect(s.notebookSource()).toBe("sentinel");
  });
});

// Regression: production, weeks of replies ending on a VISIBLE
// `### **Carnet mis à jour (privé)**` section instead of the sentinel. The
// splitter never entered its notebook phase, so `saveNotebook` was never called
// — the coach had no long-term memory at all — and the user read the notes written
// about her.
describe("trailing Carnet fallback", () => {
  it("captures a trailing Carnet section the model wrote as markdown", () => {
    const s = createNotebookSplitter();
    const visible = s.push("Le donkey kick isole mieux.\n\n### Carnet mis à jour (privé)\n- Pont fessier supprimé.");
    expect(s.end()).toBe("");
    expect(visible).not.toMatch(/Carnet mis à jour/);
    expect(s.notebook()).toMatch(/Pont fessier supprimé/);
    expect(s.notebookSource()).toBe("heading");
  });

  it("captures the exact production heading, bold and all, across chunks", () => {
    const r = run([
      "Beau travail cette semaine.\n\n#### **Carnet mis ", "à jour (privé)**\n",
      "- Camille a mal au genou droit.\n", "- On reste à 15 kg/main.",
    ]);
    expect(r.out).toBe("Beau travail cette semaine.\n\n");
    expect(r.notebook).toBe("- Camille a mal au genou droit.\n- On reste à 15 kg/main.");
  });

  // FALSE-POSITIVE GUARDS. Loosening matching without these is how a validator
  // starts eating legitimate content — same lesson as warmup/cooldown names.
  it("leaves a mid-answer mention of a carnet alone", () => {
    const r = run(["Je garde ça dans mon carnet, et voici pourquoi : c'est utile."]);
    expect(r.out).toBe("Je garde ça dans mon carnet, et voici pourquoi : c'est utile.");
    expect(r.notebook).toBeNull();
  });

  it("leaves a Carnet heading alone when prose follows it", () => {
    const r = run(["### Carnet\nnote\n\n## Et pour ta séance\nfais ceci."]);
    expect(r.out).toBe("### Carnet\nnote\n\n## Et pour ta séance\nfais ceci.");
    expect(r.notebook).toBeNull();
  });

  // A HEADING is the only thing that releases the hold. Unheaded prose after a
  // Carnet heading is captured with the section and never shown — pinned here
  // because it is the shape the "prose follows" guard does NOT cover, and
  // because it is a real cost rather than an accident: markdown gives no other
  // signal that a section ended. It runs the same way as the sentinel-collision
  // ruling above — text the model filed under a private heading is hidden, since
  // hiding costs her something she is not meant to read and showing reproduces
  // the incident. Widening this to "release on a blank line" would put the
  // production form (`### Carnet mis à jour (privé)` + a bulleted list) back on
  // her screen the first time the model left a blank line in its notes.
  it("captures unheaded prose that follows a Carnet heading, rather than showing it", () => {
    const r = run(["Voilà.\n\n### Carnet\n- note\n\nEt pour ta séance, fais ceci."]);
    expect(r.out).toBe("Voilà.\n\n");
    expect(r.notebook).toBe("- note\n\nEt pour ta séance, fais ceci.");
  });

  it("leaves a heading that merely starts with the same letters alone", () => {
    const r = run(["## Carnaval de séries\ntrois blocs de dix."]);
    expect(r.out).toBe("## Carnaval de séries\ntrois blocs de dix.");
    expect(r.notebook).toBeNull();
  });

  it("leaves an ordinary trailing heading alone", () => {
    const r = run(["Voilà.\n\n### Pour la semaine prochaine\nOn augmente le squat."]);
    expect(r.out).toBe("Voilà.\n\n### Pour la semaine prochaine\nOn augmente le squat.");
    expect(r.notebook).toBeNull();
  });

  it("leaves a Carnet word that is not at the start of a line alone", () => {
    const r = run(["Voilà.\n\nJe note dans le ### Carnet privé quelque chose."]);
    expect(r.out).toBe("Voilà.\n\nJe note dans le ### Carnet privé quelque chose.");
    expect(r.notebook).toBeNull();
  });

  // The same guard, but across a chunk boundary — which is the only place it can
  // actually fail. Within one chunk the scanner consumes a whole line at a time,
  // so a mid-line `#` is never even examined and the line-start rule looks
  // redundant; SSE deltas land mid-line constantly, and there the rule is the
  // only thing between her sentence and a suppressed paragraph. The split is
  // arranged so the second forwarded chunk begins exactly on the `#`.
  it("leaves a mid-line Carnet heading alone when the chunk boundary falls on it", () => {
    const r = run(["Je note dans le ### Carnet pr", "ivé quelque chose sur ta séance."]);
    expect(r.out).toBe("Je note dans le ### Carnet privé quelque chose sur ta séance.");
    expect(r.notebook).toBeNull();
  });

  it("still prefers the sentinel when both are present", () => {
    const r = run(["Texte.<<<NOTEBOOK>>>vraie note<<<END>>>\n### Carnet\n- bruit"]);
    // The sentinel wins the CAPTURE: a block that closed proved itself.
    expect(r.notebook).toBe("vraie note");
    // ...but the heading section is still hidden rather than released as text.
    // Releasing it was the original reading and it was wrong in the one
    // direction that matters: the transcript holds weeks of heading-form
    // replies, so a model emitting both is plausible, and that branch printed
    // the private notes on her screen — the exact incident this closes.
    expect(r.out).not.toContain("Carnet");
    expect(r.out).not.toContain("bruit");
    expect(r.out).toBe("Texte.\n");
  });

  // Regression: (pending) — the `\b` in CARNET_HEADING. The Carnaval guard above
  // does NOT prove it: "Carnaval" fails on the literal, not on the boundary.
  // Removing `\b` is a distinct loosening and needs its own control.
  it("leaves a heading whose word merely starts with Carnet alone", () => {
    const r = run(["Voilà.\n\n### Carnets de la semaine\n- lundi\n- mardi"]);
    expect(r.out).toBe("Voilà.\n\n### Carnets de la semaine\n- lundi\n- mardi");
    expect(r.notebook).toBeNull();
  });

  // saveNotebook overwrites wholesale. A markdown heading has no terminator, so
  // the only thing standing between a cut reply and real memory being replaced
  // by a fragment is the caller's truncation check — which needs to be told the
  // capture came from a heading rather than from a block that closed.
  it("marks a heading capture as such so the caller can refuse it on a cut reply", () => {
    const s = createNotebookSplitter();
    s.push("Voilà.\n\n### Carnet\n- moitié de mém");
    s.end();
    expect(s.notebook()).toBe("- moitié de mém");
    expect(s.notebookSource()).toBe("heading");
  });

  it("hides a bare Carnet heading with nothing under it, and banks nothing", () => {
    const r = run(["Voilà.\n\n### Carnet mis à jour (privé)"]);
    expect(r.out).toBe("Voilà.\n\n");
    expect(r.notebook).toBeNull();
  });

  // A heading held while the fallback waited to see what followed is ordinary
  // text. An unterminated sentinel block must not eat the paragraph before it.
  it("still flushes an ordinary held heading when a block never closes", () => {
    const r = run(["## Ta séance\nfais ceci<<<NOTEBOOK>>>coupé"]);
    expect(r.out).toBe("## Ta séance\nfais ceci");
    expect(r.notebook).toBeNull();
  });
});

describe("heldVisible", () => {
  it("is true while visible text sits under the look-ahead, false once released or whitespace", () => {
    const s = createNotebookSplitter();
    expect(s.heldVisible()).toBe(false);
    s.push("  \n");
    expect(s.heldVisible()).toBe(false); // whitespace only
    s.push("Un,");
    expect(s.heldVisible()).toBe(true);
    s.push(" deux, trois, quatre, cinq.");
    expect(s.heldVisible()).toBe(true); // the last 13 chars are always held
    s.end();
    expect(s.heldVisible()).toBe(false);
  });

  it("is true for a `#` line awaiting its newline, false for a held Carnet section and inside a block", () => {
    const a = createNotebookSplitter();
    a.push("Une longue phrase de reponse.\n## Ti");
    expect(a.heldVisible()).toBe(true);
    const b = createNotebookSplitter();
    b.push("Texte assez long pour passer.\n### Carnet\n- note secrete\n");
    expect(b.heldVisible()).toBe(false);
    const c = createNotebookSplitter();
    c.push("<<<NOTEBOOK>>>\n+ note");
    expect(c.heldVisible()).toBe(false);
  });
});
