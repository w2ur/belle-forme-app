import { describe, it, expect } from "vitest";
import { exerciseUsage, deleteVerdict } from "./catalogUsage.js";

const SESSIONS = [
  { id: "a", exercises: [{ name: "Squat" }, { name: "Fentes" }] },
  { id: "b", exercises: [{ name: "Squat" }] },
];

const PLAN = {
  sessions: [
    { name: "Bas du corps", exercises: [{ name: "Soulevé de terre roumain" }] },
  ],
};

const DOC = {
  exercises: [{ name: "Squat" }, { name: "Fentes" }, { name: "Dips sur chaise" }],
  aliases: { Dips: "Dips sur chaise" },
};

const ACTIVE_SESSION = { id: "draft", exercises: [{ name: "Tirage vertical élastique" }] };

const CONTEXT = { sessions: SESSIONS, plan: PLAN, doc: DOC, activeSession: ACTIVE_SESSION };

describe("exerciseUsage", () => {
  it("counts the sessions an exercise appears in", () => {
    expect(exerciseUsage("Squat", CONTEXT).sessionCount).toBe(2);
  });

  it("counts a session once however many times the name appears in it", () => {
    const twice = [{ id: "a", exercises: [{ name: "Squat" }, { name: "Squat" }] }];
    expect(exerciseUsage("Squat", { ...CONTEXT, sessions: twice }).sessionCount).toBe(1);
  });

  it("reports zero for a name used nowhere", () => {
    expect(exerciseUsage("Test", CONTEXT)).toEqual({
      sessionCount: 0,
      inPlan: false,
      inActiveSession: false,
      aliasedFrom: [],
    });
  });

  it("detects the name in the stored plan", () => {
    expect(exerciseUsage("Soulevé de terre roumain", CONTEXT).inPlan).toBe(true);
  });

  it("lists the retired names that alias onto it", () => {
    expect(exerciseUsage("Dips sur chaise", CONTEXT).aliasedFrom).toEqual(["Dips"]);
  });

  // Regression: cfd327b — her history keeps an exercise's old name until a rename
  // is confirmed, while the lexique already shows the new one. Counted by raw
  // name, the renamed entry read as unused and could be deleted, taking with
  // it the alias that links every one of those sessions to it.
  it("counts sessions still under a name that aliases onto it", () => {
    const doc = { exercises: [{ name: "Squat goblet" }], aliases: { Squat: "Squat goblet" } };
    const usage = exerciseUsage("Squat goblet", { sessions: SESSIONS, plan: PLAN, doc, activeSession: null });
    expect(usage.sessionCount).toBe(2);
    expect(deleteVerdict(usage, { totalExercises: 70 }).deletable).toBe(false);
  });

  it("reports session use and plan use together, not just the first", () => {
    const both = { ...CONTEXT, plan: { sessions: [{ exercises: [{ name: "Squat" }] }] } };
    const usage = exerciseUsage("Squat", both);
    expect(usage.sessionCount).toBe(2);
    expect(usage.inPlan).toBe(true);
  });

  // The fourth place a name lives: the running séance draft `useActiveSession`
  // owns. It survives a plan replacement (quitting keeps the draft, and
  // importing a new week only rewrites `plan`), so it needs its own signal
  // rather than piggybacking on `inPlan`.
  it("detects the name in the active séance draft", () => {
    expect(exerciseUsage("Tirage vertical élastique", CONTEXT).inActiveSession).toBe(true);
  });

  it("reports false when there is no active séance", () => {
    expect(exerciseUsage("Tirage vertical élastique", { ...CONTEXT, activeSession: null }).inActiveSession).toBe(false);
  });

  it("never throws on malformed input", () => {
    expect(exerciseUsage("Squat", { sessions: null, plan: null, doc: null, activeSession: null })).toEqual({
      sessionCount: 0,
      inPlan: false,
      inActiveSession: false,
      aliasedFrom: [],
    });
    expect(exerciseUsage("Squat", {})).toEqual({
      sessionCount: 0,
      inPlan: false,
      inActiveSession: false,
      aliasedFrom: [],
    });
    const ragged = {
      sessions: [null, { exercises: null }, { exercises: [null] }],
      plan: { sessions: null },
      doc: { aliases: null },
      activeSession: { exercises: null },
    };
    expect(exerciseUsage("Squat", ragged).sessionCount).toBe(0);
    expect(exerciseUsage("Squat", ragged).inActiveSession).toBe(false);
    // A malformed draft shaped like a string or a number, not just a ragged object.
    expect(exerciseUsage("Squat", { ...ragged, activeSession: "not an object" }).inActiveSession).toBe(false);
  });
});

describe("deleteVerdict", () => {
  const CLEAN = { sessionCount: 0, inPlan: false, inActiveSession: false, aliasedFrom: [] };

  it("allows deleting an exercise used nowhere", () => {
    expect(deleteVerdict(CLEAN, { totalExercises: 70 })).toEqual({
      deletable: true,
      reason: null,
    });
  });

  it("refuses when sessions reference it, and says how many", () => {
    const verdict = deleteVerdict({ ...CLEAN, sessionCount: 12 }, { totalExercises: 70 });
    expect(verdict.deletable).toBe(false);
    expect(verdict.reason).toContain("12");
    expect(verdict.reason).toContain("Désactiver");
  });

  it("uses the singular for a single session", () => {
    const verdict = deleteVerdict({ ...CLEAN, sessionCount: 1 }, { totalExercises: 70 });
    expect(verdict.reason).toContain("1 séance ");
    expect(verdict.reason).not.toContain("séances");
  });

  it("refuses when the current plan references it", () => {
    const verdict = deleteVerdict({ ...CLEAN, inPlan: true }, { totalExercises: 70 });
    expect(verdict.deletable).toBe(false);
    expect(verdict.reason).toContain("programme");
  });

  // Owner ruling: a rename writes a permanent alias whether or not the entry
  // was ever used, so refusing on `aliasedFrom` alone made a renamed,
  // never-used entry undeletable forever — exactly the case this feature was
  // built for. `deleteExercise` drops the dangling alias when it deletes.
  it("allows deleting an aliased-but-otherwise-unused exercise", () => {
    const verdict = deleteVerdict({ ...CLEAN, aliasedFrom: ["Squt"] }, { totalExercises: 70 });
    expect(verdict).toEqual({ deletable: true, reason: null });
  });

  it("refuses when it is in the active séance draft, and names the draft", () => {
    const verdict = deleteVerdict({ ...CLEAN, inActiveSession: true }, { totalExercises: 70 });
    expect(verdict.deletable).toBe(false);
    expect(verdict.reason).toContain("séance en cours");
  });

  it("checks the active séance AFTER sessions and the plan", () => {
    const verdict = deleteVerdict(
      { sessionCount: 3, inPlan: false, inActiveSession: true, aliasedFrom: [] },
      { totalExercises: 70 }
    );
    expect(verdict.reason).toContain("3");
  });

  it("refuses to delete the last exercise in the catalog", () => {
    const verdict = deleteVerdict(CLEAN, { totalExercises: 1 });
    expect(verdict.deletable).toBe(false);
    expect(verdict.reason).toContain("dernier");
  });

  it("reports session use first when several reasons apply", () => {
    const verdict = deleteVerdict(
      { sessionCount: 3, inPlan: true, aliasedFrom: ["Dips"] },
      { totalExercises: 70 }
    );
    expect(verdict.deletable).toBe(false);
    expect(verdict.reason).toContain("3");
  });

  it("never throws on malformed input", () => {
    expect(deleteVerdict(null, {}).deletable).toBe(false);
    expect(deleteVerdict(undefined, undefined).deletable).toBe(false);
  });
});
