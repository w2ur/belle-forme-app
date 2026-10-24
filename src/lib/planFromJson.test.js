import { describe, it, expect } from "vitest";
import { isPlanPayload, planFromJson } from "./planFromJson.js";
import { PLAN_JSON_SCHEMA } from "./planSchema.js";

const validPayload = {
  weekStart: "2026-08-11",
  weekEnd: "2026-08-17",
  coachNotes: "Volume réduit en phase prémenstruelle.",
  notebook: "Donkey kick validé en remplacement du pont fessier.",
  sessions: [
    {
      name: "Bas du corps",
      warmup: [{ name: "Rotations de hanches", detail: "2×10" }],
      exercises: [
        {
          name: "Squat",
          setsCount: 3,
          reps: "12",
          weight: 15,
          weightType: "per_hand",
          restSeconds: 90,
          progressionNote: "tempo 2-1-2",
        },
      ],
      cooldown: [{ name: "Étirement quadriceps", detail: "30s par jambe" }],
    },
  ],
};

describe("isPlanPayload", () => {
  it("accepts a plan object", () => {
    expect(isPlanPayload(validPayload)).toBe(true);
  });

  it("accepts the same plan as a JSON string", () => {
    expect(isPlanPayload(JSON.stringify(validPayload))).toBe(true);
  });

  it("rejects ordinary prose, which is how discussion replies stay untouched", () => {
    expect(isPlanPayload("Le donkey kick isole mieux les fessiers.")).toBe(false);
  });

  it("rejects a legacy FITTRACK text block", () => {
    expect(isPlanPayload("=== FITTRACK PLAN ===\nSemaine : 11/08 → 17/08")).toBe(false);
  });

  it("rejects JSON that is not a plan", () => {
    expect(isPlanPayload(JSON.stringify({ hello: "world" }))).toBe(false);
  });

  it("never offers to import a plan that was cut mid-JSON", () => {
    // The bubble shows an import button on `isPlanPayload` and nothing else, so
    // this is what stands between a killed plan-emit invocation and a half-week
    // reaching her programme. `CoachConversation` renders such a fragment as the
    // truncation treatment instead — see its `cutPlan` branch.
    const cut = '{"weekStart":"2026-08-11","sessions":[{"name":"Bas du co';
    expect(isPlanPayload(cut)).toBe(false);
    expect(planFromJson(cut).plan).toBeNull();
  });

  it("rejects null and non-strings without throwing", () => {
    expect(isPlanPayload(null)).toBe(false);
    expect(isPlanPayload(42)).toBe(false);
    expect(isPlanPayload(undefined)).toBe(false);
  });
});

describe("planFromJson", () => {
  it("synthesises the sets display string WeeklyPlan renders", () => {
    const { plan } = planFromJson(validPayload);
    expect(plan.sessions[0].exercises[0].sets).toBe("3×12");
  });

  it("preserves every field the four consumers read", () => {
    const { plan } = planFromJson(validPayload);
    const ex = plan.sessions[0].exercises[0];
    expect(ex).toMatchObject({
      name: "Squat",
      setsCount: 3,
      reps: "12",
      weight: 15,
      weightType: "per_hand",
      restSeconds: 90,
      progressionNote: "tempo 2-1-2",
    });
  });

  it("keeps warmup and cooldown items as {name, detail}", () => {
    const { plan } = planFromJson(validPayload);
    expect(plan.sessions[0].warmup[0]).toEqual({ name: "Rotations de hanches", detail: "2×10" });
    expect(plan.sessions[0].cooldown[0]).toEqual({ name: "Étirement quadriceps", detail: "30s par jambe" });
  });

  it("never copies the notebook field through — no caller reads plan.notebook", () => {
    // Superseded design: Task 2 had the client persist the notebook, but by
    // Task 9 that moved server-side into splitPlanPayload. Copying it here
    // was the one remaining route it could reach her device through — see
    // the docstring above the `plan` object in planFromJson.js.
    const { plan } = planFromJson(validPayload);
    expect(plan.notebook).toBeUndefined();
    expect(plan).not.toHaveProperty("notebook");
  });

  it("parses a JSON string as readily as an object", () => {
    const { plan } = planFromJson(JSON.stringify(validPayload));
    expect(plan.sessions[0].name).toBe("Bas du corps");
  });

  it("reports a French error instead of throwing on malformed JSON", () => {
    const { plan, errors } = planFromJson("{ not json");
    expect(plan).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/illisible/i);
  });

  it("reports a French error when the payload is not a plan", () => {
    const { plan, errors } = planFromJson({ hello: "world" });
    expect(plan).toBeNull();
    expect(errors[0]).toMatch(/programme/i);
  });

  it("defaults a missing weightType to total rather than dropping the exercise", () => {
    const payload = structuredClone(validPayload);
    delete payload.sessions[0].exercises[0].weightType;
    const { plan } = planFromJson(payload);
    expect(plan.sessions[0].exercises[0].weightType).toBe("total");
  });

  it("never emits an empty sets string, even with a missing setsCount", () => {
    const payload = structuredClone(validPayload);
    delete payload.sessions[0].exercises[0].setsCount;
    const { plan } = planFromJson(payload);
    expect(plan.sessions[0].exercises[0].setsCount).toBe(1);
    expect(plan.sessions[0].exercises[0].sets).toBe("1×12");
  });
});

describe("schema parity", () => {
  it("reads no exercise field the schema does not require", () => {
    const required = PLAN_JSON_SCHEMA
      .properties.sessions.items
      .properties.exercises.items.required;
    // `sets` is derived here, never requested from the model.
    const readByPlanFromJson = [
      "name", "setsCount", "reps", "weight", "weightType", "restSeconds", "progressionNote",
    ];
    for (const field of readByPlanFromJson) {
      expect(required).toContain(field);
    }
  });
});
