import { describe, it, expect } from "vitest";
import { evaluatePlanImport } from "../lib/planValidation.js";
import { validateProfile } from "../lib/profileDoc.js";
import { buildDemoData, buildPlanPayload, buildHistory, demoCatalogViews, mondayOf, DEMO_PROFILE, DEMO_PERSONA_NAME } from "./fixtures.js";

const NOW = new Date(2026, 9, 25, 12); // a Sunday

describe("demo fixtures", () => {
  it("the programme imports through the real validator with no error and no warning", () => {
    const verdict = evaluatePlanImport(buildPlanPayload(mondayOf(NOW)), demoCatalogViews());
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings).toEqual([]);
    expect(verdict.shouldImport).toBe(true);
  });

  it("the stored plan is the current week", () => {
    const { currentPlan } = buildDemoData(NOW);
    expect(currentPlan.weekStart).toBe("2026-10-19");
    expect(currentPlan.weekEnd).toBe("2026-10-25");
    expect(currentPlan.sessions).toHaveLength(3);
  });

  it("about six weeks of history, all before today, every exercise from the catalog", () => {
    const sessions = buildHistory(NOW);
    expect(sessions.length).toBeGreaterThanOrEqual(18);
    expect(sessions.every((s) => s.date < "2026-10-25")).toBe(true);
    expect(sessions[0].date).toBe("2026-09-07");
    const names = new Set(demoCatalogViews().allExercises);
    for (const s of sessions) for (const e of s.exercises) expect(names.has(e.name), e.name).toBe(true);
    expect(new Set(sessions.map((s) => s.id)).size).toBe(sessions.length);
  });

  it("a Monday visitor sees no session for the current week yet", () => {
    const monday = new Date(2026, 9, 19, 9);
    expect(buildHistory(monday).every((s) => s.date < "2026-10-19")).toBe(true);
  });

  it("the profile is valid and the persona is invented", () => {
    expect(validateProfile(DEMO_PROFILE).ok).toBe(true);
    expect(DEMO_PERSONA_NAME).toBe("Nora");
  });
});
