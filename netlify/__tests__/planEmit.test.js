import { describe, it, expect } from "vitest";
import { splitPlanPayload } from "../functions/lib/planEmit.js";
import { isPlanPayload } from "../../src/lib/planFromJson.js";

const NOTE = "Camille a mal au genou droit depuis mardi.";

const plan = (extra = {}) => ({
  weekStart: "2026-08-10",
  weekEnd: "2026-08-16",
  coachNotes: "Belle semaine, on garde le rythme.",
  sessions: [{ name: "Haut du corps", warmup: [], exercises: [], cooldown: [] }],
  notebook: NOTE,
  ...extra,
});

describe("splitPlanPayload", () => {
  it("takes the notebook out and hands back a payload that is still a plan", () => {
    const { payload, notebook } = splitPlanPayload(JSON.stringify(plan()));

    expect(notebook).toBe(NOTE);
    expect(payload).not.toContain("genou droit");
    expect(isPlanPayload(payload)).toBe(true);
    const parsed = JSON.parse(payload);
    expect(parsed).not.toHaveProperty("notebook");
    // The control: the rest of the payload really did travel, so the assertion
    // above is not passing because nothing came back at all.
    expect(parsed.coachNotes).toBe("Belle semaine, on garde le rythme.");
    expect(parsed.sessions).toHaveLength(1);
  });

  it("tolerates whitespace around the object", () => {
    const { payload, notebook } = splitPlanPayload(`\n  ${JSON.stringify(plan())}\n`);
    expect(notebook).toBe(NOTE);
    expect(isPlanPayload(payload)).toBe(true);
  });

  // The disclosed residual this closes: a reply that put prose in front of the
  // JSON used to reach ReactMarkdown whole — notebook included. Whatever is
  // emitted here is re-serialised from a PARSED object with the field deleted,
  // so nothing outside that object can travel, prose included.
  it("recovers the object when the model wrapped it in prose, and drops the prose", () => {
    const { payload, notebook } = splitPlanPayload(
      `Voici ton programme !\n\n${JSON.stringify(plan())}\n\nBonne séance.`
    );
    expect(notebook).toBe(NOTE);
    expect(payload).not.toContain("genou droit");
    expect(payload).not.toContain("Bonne séance");
    expect(isPlanPayload(payload)).toBe(true);
  });

  it("reports nothing usable for a payload cut mid-object", () => {
    const cut = JSON.stringify(plan()).slice(0, 60);
    expect(splitPlanPayload(cut)).toEqual({ payload: null, notebook: null });
  });

  it("reports nothing usable for prose that is not a payload at all", () => {
    expect(splitPlanPayload("Je te propose trois séances cette semaine.")).toEqual({
      payload: null,
      notebook: null,
    });
  });

  it("reports nothing usable for valid JSON that is not a plan", () => {
    expect(splitPlanPayload(JSON.stringify({ notebook: NOTE }))).toEqual({
      payload: null,
      notebook: null,
    });
  });

  it("reports nothing usable for an empty or absent buffer", () => {
    expect(splitPlanPayload("")).toEqual({ payload: null, notebook: null });
    expect(splitPlanPayload(null)).toEqual({ payload: null, notebook: null });
  });

  // saveNotebook overwrites wholesale: an empty string would erase real memory.
  it("reports no notebook when the field is missing or blank", () => {
    expect(splitPlanPayload(JSON.stringify(plan({ notebook: "   " }))).notebook).toBeNull();
    const { notebook: missing, payload } = splitPlanPayload(
      JSON.stringify({ ...plan(), notebook: undefined })
    );
    expect(missing).toBeNull();
    expect(isPlanPayload(payload)).toBe(true);
  });

  it("never lets a non-string notebook field through as a notebook", () => {
    const { payload, notebook } = splitPlanPayload(JSON.stringify(plan({ notebook: { secret: NOTE } })));
    expect(notebook).toBeNull();
    // ...and the field is gone from the payload regardless of its type.
    expect(payload).not.toContain("genou droit");
    expect(JSON.parse(payload)).not.toHaveProperty("notebook");
  });
});
