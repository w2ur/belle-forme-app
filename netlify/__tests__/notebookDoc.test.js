import { describe, it, expect } from "vitest";
import {
  NOTEBOOK_MAX_LINES,
  applyNotebookOps,
  notebookLines,
  parseNotebookOps,
  renderNotebookForPrompt,
} from "../functions/lib/notebookDoc.js";

/** The shape production actually stores, bullets and all. */
const STORED = [
  "- Décision (05/03) : charge bas du corps maintenue à 2×12 kg — sa demande.",
  "- Objectif (12/03) : dix pompes d'affilée.",
  "- Rendez-vous le 03/03, terminé.",
].join("\n");

/** One turn, end to end: previous notebook + emitted block → new notebook. */
function turn(previous, block) {
  return applyNotebookOps(previous, parseNotebookOps(block));
}

describe("notebookLines", () => {
  it("strips the bullets the old wholesale path wrote, without a migration", () => {
    expect(notebookLines(STORED)[1]).toBe("Objectif (12/03) : dix pompes d'affilée.");
  });

  it("drops blank lines and survives a non-string", () => {
    expect(notebookLines("a\n\n  \nb")).toEqual(["a", "b"]);
    expect(notebookLines(null)).toEqual([]);
  });
});

describe("renderNotebookForPrompt", () => {
  // The numbers ARE the addresses a `- n` operation refers to. Quoting a line
  // back for removal would need fuzzy matching, and a model does not reproduce
  // a line byte for byte — that is what retired the plan-format header and
  // forced the exercise-name enum.
  it("numbers the lines from 1", () => {
    expect(renderNotebookForPrompt(STORED)).toMatch(/^1\. Décision \(05\/03\)/);
    expect(renderNotebookForPrompt(STORED)).toMatch(/\n3\. Rendez-vous le 03\/03/);
  });

  it("renders an empty notebook as an empty string", () => {
    expect(renderNotebookForPrompt("")).toBe("");
  });
});

describe("parseNotebookOps", () => {
  it("reads adds and removals", () => {
    const ops = parseNotebookOps("+ Objectif (20/03) : handstand.\n- 3");
    expect(ops.adds).toEqual(["Objectif (20/03) : handstand."]);
    expect(ops.removes).toEqual([3]);
  });

  it("does not mistake a content line beginning with a dash for a removal", () => {
    const ops = parseNotebookOps("- Décision (20/03) : on ne monte pas les fentes.");
    expect(ops.removes).toEqual([]);
    expect(ops.adds).toEqual(["Décision (20/03) : on ne monte pas les fentes."]);
  });

  // Tolerant in ONE direction. A model ignoring the format must be harmless,
  // never destructive — and an add can never delete.
  it("treats an unmarked line as an add and reports it as loose", () => {
    const ops = parseNotebookOps("Objectif : handstand.");
    expect(ops.adds).toEqual(["Objectif : handstand."]);
    expect(ops.looseAdds).toEqual(["Objectif : handstand."]);
  });

  /**
   * Regression: a removal carrying a justification was parsed as an ADD.
   *
   * Production 2026-08-30 banked `- 1 (ligne sur le gainage planche doublé en
   * séance 5)`. `REMOVE` was anchored on the end of the line, so the operation
   * fell through to the loose branch: line 1 survived AND the justification was
   * appended to her notebook as a fact of its own. That string was still in the
   * live document the next day.
   */
  it("reads a removal that carries a justification in parentheses", () => {
    const ops = parseNotebookOps("- 1 (ligne sur le gainage planche doublé en séance 5)");
    expect(ops.removes).toEqual([1]);
    expect(ops.adds).toEqual([]);
    expect(ops.looseAdds).toEqual([]);
  });

  it.each([
    ["a colon", "- 2 : événement passé"],
    ["an em dash", "- 2 — événement passé"],
    ["an en dash", "- 2 – événement passé"],
  ])("reads a removal justified after %s", (_label, block) => {
    expect(parseNotebookOps(block).removes).toEqual([2]);
  });

  /**
   * The false-positive guard, and the reason the separator list is closed. The
   * old wholesale style wrote every fact as `- texte`, so a fact opening on a
   * number is a shape this parser really receives. Reading it as a removal
   * would delete a line nobody asked to delete — the one direction this module
   * must never be tolerant in.
   */
  it.each([
    "- 3 séries de squat à 15 kg, c'est son maximum",
    "- 40s de gainage planche tenues le 10/03",
    "- 2 kg pris en 8 mois de programme",
  ])("never reads a fact opening on a number as a removal: %s", (block) => {
    const ops = parseNotebookOps(block);
    expect(ops.removes).toEqual([]);
    expect(ops.adds).toHaveLength(1);
  });

  /**
   * Regression: the SECOND shape production produced on 2026-08-30, one turn
   * after the justified removal above — the model tried to withdraw its own bad
   * line by number and the digits landed in the notebook as line 25, reading
   * simply « 24 ».
   *
   * Deliberately discarded rather than read as a removal: a bare number is what
   * a model writes when it has lost the syntax, and letting it delete is the one
   * direction this parser must never be tolerant in.
   */
  it.each(["24", "24.", "3)"])("discards a loose line that is only a number: %s", (block) => {
    const ops = parseNotebookOps(block);
    expect(ops.removes).toEqual([]);
    expect(ops.adds).toEqual([]);
    expect(ops.discarded).toEqual([block]);
  });

  it("keeps a fact that merely begins with a number", () => {
    const ops = parseNotebookOps("40s de gainage planche tenues le 10/03");
    expect(ops.discarded).toEqual([]);
    expect(ops.adds).toHaveLength(1);
  });
});

describe("applyNotebookOps", () => {
  it("reports a discarded bare number and leaves the notebook untouched", () => {
    const { content, warnings } = turn(STORED, "24");
    expect(notebookLines(content)).toEqual(notebookLines(STORED));
    expect(warnings.join(" ")).toContain("24");
  });

  /**
   * Regression: production 2026-08-30. The stored notebook was 495 characters,
   * three lines, all dated that day, holding zero standing decisions — weeks of
   * memory replaced by one `mistral-small-2603` reply (6 of 6 requests that day
   * fell to rung 2). Under the wholesale write, "forgot to repeat a line" and
   * "chose to remove a line" were the same bytes.
   */
  it("keeps every existing line when the model only adds one", () => {
    const { content } = turn(STORED, "+ Objectif (20/03) : handstand, calisthénie (novice).");
    expect(notebookLines(content)).toHaveLength(4);
    expect(content).toContain("2×12 kg");
    expect(content).toContain("handstand");
  });

  it("changes NOTHING on an empty block — the case that used to erase everything", () => {
    const { content } = turn(STORED, "");
    expect(notebookLines(content)).toEqual(notebookLines(STORED));
  });

  it("changes nothing when the block is unparsable noise", () => {
    const { content } = turn(STORED, "   \n\n   ");
    expect(notebookLines(content)).toEqual(notebookLines(STORED));
  });

  it("removes by the number it was shown", () => {
    const { content } = turn(STORED, "- 3");
    expect(content).not.toContain("Rendez-vous");
    expect(notebookLines(content)).toHaveLength(2);
  });

  /**
   * Resolved against the ORIGINAL numbering, all at once. Applying removals one
   * at a time shifts every index after the first, so `- 2` then `- 3` would
   * delete lines 2 and 4 — silently, and only ever with more than one removal
   * in a turn, which is precisely what nobody checks by hand.
   */
  it("resolves several removals against the numbering the model was shown", () => {
    const four = `${STORED}\n- Cardio : tapis en salle, zone 2.`;
    const { content } = turn(four, "- 2\n- 3");
    expect(notebookLines(content)).toEqual([
      "Décision (05/03) : charge bas du corps maintenue à 2×12 kg — sa demande.",
      "Cardio : tapis en salle, zone 2.",
    ]);
  });

  it("warns and keeps the line when a removal is out of range", () => {
    const { content, warnings } = turn(STORED, "- 99");
    expect(notebookLines(content)).toHaveLength(3);
    expect(warnings.join(" ")).toMatch(/out of range: 99/);
  });

  // A model re-emitting the whole notebook the OLD way is the recovery case
  // this de-duplication exists for: every line is an add, every add already
  // exists, so the net effect is exactly the lines that are genuinely new.
  it("is a near no-op when the model re-emits the whole notebook wholesale", () => {
    const wholesale = `${STORED}\n- Objectif (20/03) : handstand.`;
    const { content } = turn(STORED, wholesale);
    expect(notebookLines(content)).toHaveLength(4);
    expect(notebookLines(content).filter((l) => l.includes("2×12 kg"))).toHaveLength(1);
  });

  // Regression: f6f18e4 — the prompt shows lines as « 1. … » but only
  // bullets were stripped on read, so a numbered copy-back never matched the
  // duplicate check.
  it("is a no-op when a numbered line is copied back as an add", () => {
    const stored = "Décision (05/03) : X";
    const { content } = turn(stored, "+ 1. Décision (05/03) : X");
    expect(notebookLines(content)).toEqual(["Décision (05/03) : X"]);
  });

  it("is a no-op when the numbered rendering is fed back wholesale as adds", () => {
    const adds = renderNotebookForPrompt(STORED)
      .split("\n")
      .map((l) => `+ ${l}`)
      .join("\n");
    const { content } = turn(STORED, adds);
    expect(notebookLines(content)).toEqual(notebookLines(STORED));
  });

  it("de-duplicates an add that is already stored, ignoring case", () => {
    const { content } = turn(STORED, "+ rendez-vous le 03/03, terminé.");
    expect(notebookLines(content)).toHaveLength(3);
  });

  // WARN, never truncate. Holding a cap by dropping the oldest line deletes the
  // oldest standing decisions — the ones with no conversation left to recover
  // them, which is the entire reason the notebook exists.
  it("warns past the announced cap and keeps every line", () => {
    const many = Array.from({ length: NOTEBOOK_MAX_LINES }, (_, i) => `fait ${i}`).join("\n");
    const { content, warnings } = turn(many, "+ un fait de plus");
    expect(notebookLines(content)).toHaveLength(NOTEBOOK_MAX_LINES + 1);
    expect(warnings.join(" ")).toMatch(/max annoncé/);
  });

  it("warns loudly when every line was explicitly removed", () => {
    const { content, warnings } = turn(STORED, "- 1\n- 2\n- 3");
    expect(content).toBe("");
    expect(warnings.join(" ")).toMatch(/carnet vidé/);
  });

  it("never throws on a malformed ops object", () => {
    expect(() => applyNotebookOps(STORED, null)).not.toThrow();
    expect(applyNotebookOps(STORED, null).content).toBe(notebookLines(STORED).join("\n"));
  });
});
