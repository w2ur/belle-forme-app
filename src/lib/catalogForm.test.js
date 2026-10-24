import { describe, it, expect } from "vitest";
import {
  GROUP_CHOICES,
  IMPLEMENT_CHOICES,
  EQUIPMENT_CHOICES,
  blankExercise,
  implementChoiceOf,
  upsertExercise,
  setExerciseActive,
  stampDeactivation,
  deleteExercise,
  applyCatalogOps,
  groupLabel,
} from "./catalogForm.js";

import { validateCatalogDoc, applyRename, APPLIED_OPS_LIMIT, KNOWN_GROUPS } from "./catalog.js";
import { EQUIPMENT_VOCABULARY, EQUIPMENT_LABELS_FR } from "../constants/equipment.js";
import seed from "../data/catalogSeed.json";

describe("groupLabel", () => {
  it("shows every known group in French", () => {
    expect(GROUP_CHOICES.map(groupLabel)).toEqual(
      ["Haut du corps", "Bas du corps", "Corps entier", "Gainage", "Cardio"],
    );
  });

  // validateCatalogDoc rejects an unknown group at write time, so this is a guard
  // for a document that predates that rule, not a path the form can produce.
  it("returns a key it has no label for unchanged, never undefined", () => {
    expect(groupLabel("Mobilité")).toBe("Mobilité");
  });

  // GROUP_CHOICES IS the validator's list (one array, not a copy), so a sort or
  // a push through the form-side name would change what validateCatalogDoc
  // accepts. Frozen, it throws instead.
  it("shares one frozen list with the validator", () => {
    expect(GROUP_CHOICES).toBe(KNOWN_GROUPS);
    expect(Object.isFrozen(GROUP_CHOICES)).toBe(true);
  });

  it("never returns an inherited Object property", () => {
    expect(groupLabel("constructor")).toBe("constructor");
    expect(groupLabel("__proto__")).toBe("__proto__");
  });
});

const ENTRY = {
  ...blankExercise(),
  name: "Rowing",
  group: "Upper Body",
  description: "Un haltère dans chaque main, tirer vers les hanches",
  formCues: "Dos plat",
  intent: "Le tirage horizontal",
  implementTypes: ["dumbbell", "dual_bar_symmetric"],
  equipmentNeeds: ["dumbbell"],
};
const docOf = (...exercises) => ({ version: 1, exercises, aliases: {} });

describe("the form's vocabulary", () => {
  // The form must not be able to offer something the validator refuses. The
  // other direction — a set the load model gained that nobody wired into a
  // radio — is caught by the seed round-trip below, which is the stronger of
  // the two because it runs over all 70 live entries.
  it("offers only implement sets validateCatalogDoc accepts", () => {
    for (const choice of IMPLEMENT_CHOICES) {
      const doc = docOf({ ...ENTRY, implementTypes: [...choice.implementTypes], description: "", formCues: "" });
      expect(validateCatalogDoc(doc), choice.id).toEqual([]);
    }
  });

  it("offers every group the validator accepts, and the seed only uses those", () => {
    for (const group of GROUP_CHOICES) {
      expect(validateCatalogDoc(docOf({ ...ENTRY, group })), group).toEqual([]);
    }
    expect([...new Set(seed.exercises.map((ex) => ex.group))].sort()).toEqual([...GROUP_CHOICES].sort());
  });

  it("offers every equipment token, with its French name", () => {
    expect(EQUIPMENT_CHOICES.map((c) => c.token)).toEqual(EQUIPMENT_VOCABULARY);
    for (const { token, label } of EQUIPMENT_CHOICES) {
      expect(label, token).toBe(EQUIPMENT_LABELS_FR[token]);
    }
  });

  it("starts a new exercise on a document the validator accepts once named", () => {
    expect(validateCatalogDoc(docOf({ ...blankExercise(), name: "Nouveau" }))).toEqual([]);
  });

  // The 70 live entries are the real test of the reverse mapping: if any of
  // them has a set no radio produces, the form cannot open it for editing.
  it("maps every entry in the live catalog back onto one of the seven radios", () => {
    for (const ex of seed.exercises) {
      expect(implementChoiceOf(ex.implementTypes), ex.name).not.toBeNull();
    }
  });

  it("returns null for a set no radio produces", () => {
    expect(implementChoiceOf(["dumbbell", "elastic"])).toBeNull();
    expect(implementChoiceOf([])).toBeNull();
  });
});

describe("upsertExercise", () => {
  it("appends a new exercise at the end, leaving the reading order alone", () => {
    const doc = docOf({ ...ENTRY, name: "Squat" });
    const next = upsertExercise(doc, ENTRY, null);
    expect(next.exercises.map((e) => e.name)).toEqual(["Squat", "Rowing"]);
  });

  it("replaces an edited exercise in place", () => {
    const doc = docOf({ ...ENTRY, name: "Squat" }, ENTRY);
    const next = upsertExercise(doc, { ...ENTRY, intent: "revu" }, "Rowing");
    expect(next.exercises.map((e) => e.name)).toEqual(["Squat", "Rowing"]);
    expect(next.exercises[1].intent).toBe("revu");
  });

  it("never mutates the input", () => {
    const doc = docOf(ENTRY);
    const before = JSON.stringify(doc);
    upsertExercise(doc, { ...ENTRY, intent: "revu" }, "Rowing");
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("keeps everything else on the document", () => {
    const doc = { ...docOf(ENTRY), forbiddenNames: [{ name: "Hip thrust" }], aliases: { A: "Rowing" } };
    const next = upsertExercise(doc, ENTRY, "Rowing");
    expect(next.forbiddenNames).toEqual(doc.forbiddenNames);
    expect(next.aliases).toEqual(doc.aliases);
  });
});

describe("setExerciseActive", () => {
  it("stamps the date when deactivating", () => {
    const next = setExerciseActive(docOf(ENTRY), "Rowing", false, "2026-08-14");
    expect(next.exercises[0].active).toBe(false);
    expect(next.exercises[0].deactivatedAt).toBe("2026-08-14");
  });

  it("keeps the original date when deactivating something already dated", () => {
    const doc = docOf({ ...ENTRY, active: false, deactivatedAt: "2026-07-26" });
    const next = setExerciseActive(doc, "Rowing", false, "2026-08-14");
    expect(next.exercises[0].deactivatedAt).toBe("2026-07-26");
  });

  // A live exercise carrying « pourquoi c'est désactivé » is exactly the kind
  // of contradiction the lexique exists to remove — and the coach reads that
  // reason off the blacklist.
  it("clears the reason, the replacement and the date when reactivating", () => {
    const doc = docOf({
      ...ENTRY, active: false, inactiveReason: "Douleur", replacedBy: "Autre", deactivatedAt: "2026-07-26",
    });
    const next = setExerciseActive(doc, "Rowing", true, "2026-08-14");
    expect(next.exercises[0]).toMatchObject({
      active: true, inactiveReason: null, replacedBy: null, deactivatedAt: null,
    });
  });

  it("leaves other exercises untouched and never mutates the input", () => {
    const doc = docOf(ENTRY, { ...ENTRY, name: "Squat" });
    const before = JSON.stringify(doc);
    const next = setExerciseActive(doc, "Rowing", false, "2026-08-14");
    expect(next.exercises[1]).toEqual(doc.exercises[1]);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe("upsertExercise — an add never replaces", () => {
  // Regression: 687dac8 — `target = originalName ?? entry.name` made an ADD
  // with a taken name overwrite the live entry. Reproduced against the real
  // seed: adding « Squat » left 70 entries with the real Squat reduced to a
  // bodyweight exercise with no ceiling, and `validateCatalogDoc` returned []
  // because the duplicate had been merged away rather than created. It reached
  // localStorage and Neon with nothing to undo it, and a lost ceiling is a
  // guardrail regression: the coach may then prescribe an unbounded load.
  it("appends rather than overwriting when the name is already taken", () => {
    const existing = { ...ENTRY, ceiling: { maxKg: 11, unit: "total" }, intent: "l'original" };
    const doc = docOf(existing);
    const next = upsertExercise(doc, { ...blankExercise(), name: "Rowing" }, null);

    expect(next.exercises).toHaveLength(2);
    expect(next.exercises[0]).toEqual(existing);
  });

  it("leaves the collision for validateCatalogDoc to refuse, with the name in the message", () => {
    const next = upsertExercise(docOf(ENTRY), { ...blankExercise(), name: "Rowing" }, null);
    expect(validateCatalogDoc(next).join(" ")).toMatch(/« Rowing » est déjà dans le catalogue/);
  });

  // Regression: ba3ba7f — an add replayed after a lost PUT response appended a
  // duplicate of itself, which failed validation and parked the edit.
  it("is a no-op when the identical entry is already there, whatever the key order", () => {
    const doc = docOf(Object.fromEntries(Object.entries(ENTRY).reverse()));
    expect(upsertExercise(doc, ENTRY, null)).toBe(doc);
    expect(upsertExercise(doc, { ...ENTRY, extra: undefined }, null)).toBe(doc);
  });

  // Regression: 266c67f — an edit (originalName set) of an exercise no longer in the
  // document was silently turned into an add, resurrecting a deletion.
  it("throws on an edit whose exercise is no longer there, never re-adding it", () => {
    expect(() => upsertExercise(docOf({ ...ENTRY, name: "Squat" }), ENTRY, "Rowing")).toThrow(/Rowing/);
  });

  it("still appends a DIFFERENT entry under a taken name", () => {
    const next = upsertExercise(docOf(ENTRY), { ...ENTRY, intent: "autre" }, null);
    expect(next.exercises).toHaveLength(2);
  });

  it("still replaces on an edit, which is the only thing originalName is for", () => {
    const next = upsertExercise(docOf(ENTRY), { ...ENTRY, intent: "revu" }, "Rowing");
    expect(next.exercises).toHaveLength(1);
    expect(next.exercises[0].intent).toBe("revu");
  });
});

describe("stampDeactivation", () => {
  // The form's « Actif » toggle and the list's « Désactiver » button are the
  // same state transition; they used to write different documents, and the
  // form's was the lossy one — `buildCatalogViews` puts that date on the
  // blacklist the coach reads.
  it("dates a deactivation that has no date", () => {
    expect(stampDeactivation({ ...ENTRY, active: false }, "2026-08-14").deactivatedAt).toBe("2026-08-14");
  });

  it("keeps a date that is already there", () => {
    const dated = { ...ENTRY, active: false, deactivatedAt: "2026-07-26" };
    expect(stampDeactivation(dated, "2026-08-14").deactivatedAt).toBe("2026-07-26");
  });

  it("leaves an active exercise exactly as it was", () => {
    const active = { ...ENTRY, active: true };
    expect(stampDeactivation(active, "2026-08-14")).toBe(active);
  });

  it("agrees with setExerciseActive, which is the whole point", () => {
    const viaList = setExerciseActive(docOf(ENTRY), "Rowing", false, "2026-08-14").exercises[0];
    const viaForm = stampDeactivation({ ...ENTRY, active: false }, "2026-08-14");
    expect(viaForm.deactivatedAt).toBe(viaList.deactivatedAt);
  });
});

describe("deleteExercise", () => {
  const DOC = {
    version: 3,
    exercises: [{ name: "Squat" }, { name: "Test" }, { name: "Fentes" }],
    aliases: { Dips: "Dips sur chaise" },
  };

  it("removes the named entry", () => {
    const next = deleteExercise(DOC, "Test");
    expect(next.exercises.map((e) => e.name)).toEqual(["Squat", "Fentes"]);
  });

  it("leaves every other field of the document alone", () => {
    const next = deleteExercise(DOC, "Test");
    expect(next.version).toBe(3);
    expect(next.aliases).toEqual({ Dips: "Dips sur chaise" });
  });

  it("does not mutate its input", () => {
    const before = JSON.stringify(DOC);
    deleteExercise(DOC, "Test");
    expect(JSON.stringify(DOC)).toBe(before);
  });

  it("is a no-op for a name that is not there", () => {
    expect(deleteExercise(DOC, "Introuvable").exercises).toHaveLength(3);
  });

  it("never throws on a malformed document", () => {
    expect(deleteExercise(null, "Test").exercises).toEqual([]);
    expect(deleteExercise({ exercises: null }, "Test").exercises).toEqual([]);
  });

  // Belt and suspenders: `deleteVerdict` refuses the last exercise, and
  // `validateCatalogDoc` refuses the document that would result. Neither is the
  // only guard.
  it("leaves a document validateCatalogDoc refuses when it empties the catalog", () => {
    const next = deleteExercise({ exercises: [{ name: "Seul" }] }, "Seul");
    expect(validateCatalogDoc(next)).toEqual([
      "Le catalogue ne contient aucun exercice — impossible d'enregistrer.",
    ]);
  });

  // `deleteVerdict` no longer refuses a delete just because an alias points at
  // the name — a renamed, never-used entry must be deletable. So this function
  // has to drop the alias itself, or the resulting document points at an
  // exercise that no longer exists.
  it("drops every alias pointing at the deleted name, and passes validateCatalogDoc", () => {
    const doc = {
      version: 3,
      exercises: [
        { ...blankExercise(), name: "Squat" },
        { ...blankExercise(), name: "Dips sur chaise" },
      ],
      aliases: { Dips: "Dips sur chaise", Squt: "Squat" },
    };
    const next = deleteExercise(doc, "Dips sur chaise");
    expect(next.exercises.map((e) => e.name)).toEqual(["Squat"]);
    expect(next.aliases).toEqual({ Squt: "Squat" });
    expect(validateCatalogDoc(next)).toEqual([]);
  });
});

describe("applyCatalogOps", () => {
  const A = { ...ENTRY, name: "A" };
  const B = { ...ENTRY, name: "B" };
  const C = { ...ENTRY, name: "C" };

  it("replays operations exactly as calling the functions by hand", () => {
    const doc = docOf(A, B);
    const ops = [
      { op: "setExerciseActive", args: ["A", false, "2026-09-30"] },
      { op: "deleteExercise", args: ["B"] },
    ];
    expect(applyCatalogOps(doc, ops)).toEqual(
      deleteExercise(setExerciseActive(doc, "A", false, "2026-09-30"), "B")
    );
  });

  it("replays upserts and renames through the same functions", () => {
    const doc = docOf(A);
    const renamed = { ...A, name: "A2", formCues: "Nouveau" };
    const ops = [
      { op: "applyRename", args: ["A", "A2"] },
      { op: "upsertExercise", args: [renamed, "A2"] },
      { op: "upsertExercise", args: [B, null] },
    ];
    expect(applyCatalogOps(doc, ops)).toEqual(
      upsertExercise(upsertExercise(applyRename(doc, "A", "A2"), renamed, "A2"), B, null)
    );
  });

  // Regression: B6 (2026-09-30 review) — the catalog PUT stored whatever
  // document arrived, so a stale device toggling one exercise erased every
  // exercise added elsewhere since. Replaying the EDIT onto the server's
  // document keeps them.
  it("keeps an exercise added elsewhere when a stale toggle is replayed", () => {
    const stale = docOf(A, B);
    const server = docOf(A, B, C);
    const op = { op: "setExerciseActive", args: ["A", false, "2026-09-30"] };
    const next = applyCatalogOps(server, [op]);
    expect(next.exercises.map((e) => e.name)).toEqual(["A", "B", "C"]);
    expect(next.exercises[0].active).toBe(false);
    // The stale document alone is what used to be sent, and it has no C.
    expect(applyCatalogOps(stale, [op]).exercises.map((e) => e.name)).toEqual(["A", "B"]);
  });

  it("is the identity for an empty list, and never mutates its input", () => {
    const doc = docOf(A, B);
    const copy = JSON.parse(JSON.stringify(doc));
    expect(applyCatalogOps(doc, [])).toBe(doc);
    applyCatalogOps(doc, [{ op: "deleteExercise", args: ["A"] }]);
    expect(doc).toEqual(copy);
  });

  it("throws on an unknown operation", () => {
    expect(() => applyCatalogOps(docOf(A), [{ op: "dropTable", args: [] }])).toThrow(/dropTable/);
  });

  // The outbox persists operations as JSON, so a replay after a reload must
  // build the same document as the replay before it.
  it("gives the same document after a JSON round-trip of the operations", () => {
    const ops = [
      { op: "upsertExercise", args: [C, null] },
      { op: "setExerciseActive", args: ["A", false, "2026-09-30"] },
    ];
    const doc = docOf(A, B);
    expect(applyCatalogOps(doc, JSON.parse(JSON.stringify(ops)))).toEqual(applyCatalogOps(doc, ops));
  });
});

describe("applyCatalogOps — idempotent by operation id", () => {
  const off = (id, name) => ({ id, op: "setExerciseActive", args: [name, false, "2026-10-01"] });
  const on = (id, name) => ({ id, op: "setExerciseActive", args: [name, true, "2026-10-01"] });

  it("records the ids it applied, in order, on the document", () => {
    const doc = applyCatalogOps(docOf(ENTRY), [off("1", "Rowing"), on("2", "Rowing")]);
    expect(doc.appliedOps).toEqual(["1", "2"]);
    expect(validateCatalogDoc(doc)).toEqual([]);
  });

  it("skips an operation the document already lists", () => {
    const once = applyCatalogOps(docOf(ENTRY), [off("1", "Rowing")]);
    const reactivated = applyCatalogOps(once, [on("2", "Rowing")]);
    // Replaying "1" must not deactivate it again over "2".
    const replayed = applyCatalogOps(reactivated, [off("1", "Rowing")]);
    expect(replayed).toBe(reactivated);
    expect(replayed.exercises[0].active).toBe(true);
  });

  it("always applies an operation with no id, and records nothing for it", () => {
    const doc = docOf(ENTRY);
    const next = applyCatalogOps(doc, [{ op: "setExerciseActive", args: ["Rowing", false, "2026-10-01"] }]);
    expect(next.exercises[0].active).toBe(false);
    expect(next).not.toHaveProperty("appliedOps");
  });

  it("keeps only the most recent APPLIED_OPS_LIMIT ids", () => {
    const ops = Array.from({ length: APPLIED_OPS_LIMIT + 5 }, (_, i) => (i % 2 ? on : off)(`op${i}`, "Rowing"));
    let doc = docOf(ENTRY);
    for (const o of ops) doc = applyCatalogOps(doc, [o]);
    expect(doc.appliedOps).toHaveLength(APPLIED_OPS_LIMIT);
    expect(doc.appliedOps.at(-1)).toBe(`op${APPLIED_OPS_LIMIT + 4}`);
    expect(doc.appliedOps[0]).toBe("op5");
    expect(validateCatalogDoc(doc)).toEqual([]);
  });
});
