import { describe, it, expect } from "vitest";
import {
  buildCatalogViews,
  requireCatalog,
  isUsableCatalog,
  findBlacklistEntry,
  canonicalExerciseName,
  describeExercise,
  validateCatalogDoc,
  checkCatalogQuality,
  applyRename,
  APPLIED_OPS_LIMIT,
  usableCatalogViews,
} from "./catalog.js";
import { BILATERAL_HAND_IMPLEMENTS, STARTER_INVENTORY } from "../constants/equipment.js";
import { TEST_INVENTORY } from "../constants/testInventory.js";

const DOC = {
  version: 1,
  exercises: [
    {
      name: "Squat", group: "Lower Body", description: "d", formCues: "f", intent: "i",
      implementTypes: ["dumbbell", "dual_bar_symmetric"], equipmentNeeds: ["bar"],
      perSide: false, barHeight: null,
      ceiling: { maxKg: 17, unit: "per_hand" }, active: true, inactiveReason: null, replacedBy: null,
    },
    {
      name: "Pompes", group: "Upper Body", description: "d", formCues: "f", intent: "i",
      implementTypes: ["bodyweight"], equipmentNeeds: [],
      perSide: false, barHeight: null,
      ceiling: null, active: true, inactiveReason: null, replacedBy: null,
    },
    {
      name: "Sit-up", group: "Core", description: "d", formCues: "f", intent: "i",
      implementTypes: ["bodyweight"], equipmentNeeds: [],
      perSide: false, barHeight: null, ceiling: null,
      active: false, inactiveReason: "Flexion vertébrale", replacedBy: "Dead bug",
    },
    {
      name: "Burpees", group: "Full Body", description: "d", formCues: "f", intent: "i",
      implementTypes: ["bodyweight"], equipmentNeeds: [],
      perSide: false, barHeight: null, ceiling: null,
      active: false, inactiveReason: null, replacedBy: null,
    },
  ],
  aliases: { "Développé couché": "Développé couché au sol" },
};

describe("buildCatalogViews — the inventory rides with the catalog", () => {
  it("carries the inventory it was built with, so every validator handed the catalog is handed the equipment", () => {
    const views = buildCatalogViews(DOC, TEST_INVENTORY);
    expect(views.inventory.dumbbellOptionsKg).toEqual([...TEST_INVENTORY.dumbbellOptionsKg]);
    expect(views.inventory.isStarter).toBe(false);
  });

  it("falls back to the starter inventory when none was given, and says so", () => {
    for (const views of [buildCatalogViews(DOC), buildCatalogViews(DOC, null), buildCatalogViews(null)]) {
      expect(views.inventory.isStarter).toBe(true);
      expect(views.inventory.dumbbellOptionsKg).toEqual([...STARTER_INVENTORY.dumbbellOptionsKg]);
    }
  });

  it("never throws on a damaged inventory document", () => {
    expect(() => buildCatalogViews(DOC, { dumbbellOptionsKg: "oops", owned: 7 })).not.toThrow();
  });
});

describe("buildCatalogViews", () => {
  it("groups exercises in document order", () => {
    const v = buildCatalogViews(DOC);
    expect(v.muscleGroups["Lower Body"]).toEqual(["Squat"]);
    expect(v.muscleGroups["Upper Body"]).toEqual(["Pompes"]);
    expect(v.allExercises).toEqual(["Squat", "Pompes", "Sit-up", "Burpees"]);
  });

  it("derives bilateral from the implement set rather than storing it", () => {
    const v = buildCatalogViews(DOC);
    expect(v.descriptions["Squat"].bilateral).toBe(true);
    expect(v.descriptions["Pompes"].bilateral).toBe(false);
    expect(DOC.exercises[0]).not.toHaveProperty("bilateral");
  });

  // Regression: cc12bd4 — sameSet compared implementTypes positionally, so
  // the bilateral pair stored in reversed order was silently classified
  // bilateral: false. bilateral decides whether a weight reads as per-hand
  // or total, ambiguous by a factor of two.
  it("derives bilateral regardless of implement order", () => {
    const reversed = {
      ...DOC,
      exercises: [
        {
          ...DOC.exercises[0],
          name: "Squat inversé",
          implementTypes: [...BILATERAL_HAND_IMPLEMENTS].reverse(),
        },
      ],
    };
    const v = buildCatalogViews(reversed);
    expect(v.descriptions["Squat inversé"].bilateral).toBe(true);
  });

  it("builds ceilings only from entries that declare one", () => {
    const v = buildCatalogViews(DOC);
    expect(v.ceilings).toEqual({ Squat: { maxKg: 17, unit: "per_hand" } });
  });

  // §2bis.1: the reason IS the signal. Deactivated WITH a reason is told to the
  // coach; deactivated WITHOUT one is simply absent from the catalog.
  it("blacklists only deactivated exercises that carry a reason", () => {
    const v = buildCatalogViews(DOC);
    expect(v.blacklist.map((e) => e.name)).toEqual(["Sit-up"]);
  });

  it("keeps every deactivated exercise in allExercises so history still renders", () => {
    const v = buildCatalogViews(DOC);
    expect(v.allExercises).toContain("Sit-up");
    expect(v.allExercises).toContain("Burpees");
  });

  it("passes aliases through", () => {
    expect(buildCatalogViews(DOC).aliases).toEqual({ "Développé couché": "Développé couché au sol" });
  });

  it("never throws on a malformed document", () => {
    expect(() => buildCatalogViews(null)).not.toThrow();
    expect(buildCatalogViews({}).allExercises).toEqual([]);
  });

  // The invariant above was already false, and slice 2 makes it reachable: the
  // moment the user can author a group name, `__proto__` is a value she can type.
  // `muscleGroups[ex.group] ??= []` on a plain `{}` reads Object.prototype for
  // that key — not nullish, so nothing is assigned — and `.push` on it threw
  // `TypeError: muscleGroups[ex.group].push is not a function`.
  //
  // `descriptions` and `ceilings` are keyed on `ex.name` and had the WORSE half
  // of the same bug: `obj["__proto__"] = {...}` does not throw, it reassigns the
  // object's prototype, so the entry silently vanished while the name stayed in
  // `allExercises` — a catalog that looks fine and answers every lookup with
  // undefined.
  it.each(["__proto__", "constructor", "toString"])(
    "treats %s as an ordinary group name rather than a prototype key",
    (hostile) => {
      const doc = { exercises: [{ name: "Squat", group: hostile, implementTypes: ["bodyweight"] }] };
      expect(() => buildCatalogViews(doc)).not.toThrow();

      const v = buildCatalogViews(doc);
      expect(v.muscleGroups[hostile]).toEqual(["Squat"]);
      expect(v.allExercises).toEqual(["Squat"]);
      expect(Object.keys(v.muscleGroups)).toEqual([hostile]);
    }
  );

  it.each(["__proto__", "constructor", "toString"])(
    "treats %s as an ordinary exercise NAME rather than a prototype key",
    (hostile) => {
      const doc = {
        exercises: [
          {
            name: hostile,
            group: "Core",
            implementTypes: ["bodyweight"],
            ceiling: { maxKg: 4, unit: "total" },
          },
        ],
      };
      expect(() => buildCatalogViews(doc)).not.toThrow();

      const v = buildCatalogViews(doc);
      expect(v.allExercises).toEqual([hostile]);

      // Asserted as an OWN, ENUMERABLE property rather than with a bracket
      // read, because a bracket read passes for the wrong reason: `__proto__`'s
      // setter stores the object on the prototype and its getter hands the same
      // object back, so `v.descriptions[hostile]` looked perfectly healthy while
      // `Object.keys` was empty, the prototype was hijacked and
      // `JSON.stringify` produced `{}`. The views cross a JSON boundary in
      // production, so "survives a round-trip" is the property that matters.
      expect(Object.keys(v.descriptions)).toEqual([hostile]);
      expect(Object.keys(v.ceilings)).toEqual([hostile]);
      expect(JSON.parse(JSON.stringify(v.descriptions))[hostile].implementTypes).toEqual([
        "bodyweight",
      ]);
      expect(v.descriptions[hostile].implementTypes).toEqual(["bodyweight"]);
      expect(v.ceilings[hostile]).toEqual({ maxKg: 4, unit: "total" });
    }
  );
});

describe("buildCatalogViews — forbiddenNames", () => {
  const FORBIDDEN = {
    ...DOC,
    forbiddenNames: [
      {
        name: "Hip thrust",
        reason: "Nécessite un banc",
        replacedBy: "Pont fessier / pont unilatéral",
        date: "2026-07-26",
      },
    ],
  };

  it("folds them into the blacklist, with their reason and replacement", () => {
    const v = buildCatalogViews(FORBIDDEN);
    expect(v.blacklist).toContainEqual({
      name: "Hip thrust",
      reason: "Nécessite un banc",
      replacedBy: "Pont fessier / pont unilatéral",
      date: "2026-07-26",
    });
  });

  it("keeps the deactivated exercises on the blacklist beside them", () => {
    const v = buildCatalogViews(FORBIDDEN);
    expect(v.blacklist.map((e) => e.name).sort()).toEqual(["Hip thrust", "Sit-up"]);
  });

  // The invariant: forbidden AND not an exercise. A leak here reaches the user's
  // lexique and her manual picker, offering an exercise she is forbidden to do.
  it("keeps them OUT of muscleGroups, allExercises, descriptions and ceilings", () => {
    const v = buildCatalogViews(FORBIDDEN);
    expect(v.allExercises).not.toContain("Hip thrust");
    expect(v.descriptions).not.toHaveProperty("Hip thrust");
    expect(v.ceilings).not.toHaveProperty("Hip thrust");
    expect(Object.values(v.muscleGroups).flat()).not.toContain("Hip thrust");
    // And nothing else moved: the exercise views are byte-identical to the same
    // document without the field.
    const without = buildCatalogViews(DOC);
    expect(v.muscleGroups).toEqual(without.muscleGroups);
    expect(v.allExercises).toEqual(without.allExercises);
    expect(v.descriptions).toEqual(without.descriptions);
    expect(v.ceilings).toEqual(without.ceilings);
  });

  it("tolerates the field being absent, null, or holding malformed entries", () => {
    expect(() => buildCatalogViews(DOC)).not.toThrow();
    expect(buildCatalogViews(DOC).blacklist.map((e) => e.name)).toEqual(["Sit-up"]);

    expect(buildCatalogViews({ ...DOC, forbiddenNames: null }).blacklist.map((e) => e.name)).toEqual([
      "Sit-up",
    ]);
    expect(
      buildCatalogViews({ ...DOC, forbiddenNames: [null, {}, { name: 42 }] }).blacklist.map((e) => e.name)
    ).toEqual(["Sit-up"]);
  });

  it("defaults a missing reason/replacedBy/date rather than emitting undefined", () => {
    const v = buildCatalogViews({ ...DOC, forbiddenNames: [{ name: "Truc interdit" }] });
    expect(v.blacklist).toContainEqual({
      name: "Truc interdit",
      reason: "",
      replacedBy: null,
      date: null,
    });
  });
});

describe("requireCatalog", () => {
  it("returns the catalog it was given", () => {
    const v = buildCatalogViews(DOC);
    expect(requireCatalog(v, "test")).toBe(v);
  });

  it("names the caller, so a missing argument points at its own call site", () => {
    expect(() => requireCatalog(undefined, "isLoadValid")).toThrow(/isLoadValid/);
    expect(() => requireCatalog(undefined, "isLoadValid")).toThrow(/catalog/i);
  });

  it.each([[undefined], [null], [{}], [{ exercises: [] }], [{ descriptions: null }]])(
    "rejects %p, which is not a views object",
    (notACatalog) => {
      expect(() => requireCatalog(notACatalog, "test")).toThrow(/catalog/i);
    }
  );
});

describe("isUsableCatalog", () => {
  it("accepts a real catalog", () => {
    expect(isUsableCatalog(buildCatalogViews(DOC))).toBe(true);
  });

  it.each([[undefined], [null], [{}], [{ descriptions: null }]])(
    "rejects %p, exactly as requireCatalog does",
    (notACatalog) => {
      expect(isUsableCatalog(notACatalog)).toBe(false);
    }
  );

  // THE CASE THIS FUNCTION EXISTS FOR. `buildCatalogViews(null)` returns
  // `descriptions: {}` — truthy — so an EMPTY catalog sails through
  // `requireCatalog`. A Neon read that comes back with nothing then produces one
  // « exercice « Squat » introuvable dans le catalogue. Vérifie l'orthographe… »
  // per exercise, telling the user to correct a name that is perfectly correct.
  // The `requireCatalog` half of each case is the control: without it, these
  // would pass against a guard that had never been strengthened.
  it.each([
    ["a null document", null],
    ["an empty document", {}],
    ["a document with an empty exercise list", { exercises: [] }],
    ["a document carrying only forbidden names", {
      exercises: [],
      forbiddenNames: [{ name: "Hip thrust", reason: "Nécessite un banc" }],
    }],
  ])("rejects the views built from %s, which requireCatalog accepts", (_label, doc) => {
    const views = buildCatalogViews(doc);
    expect(() => requireCatalog(views, "test")).not.toThrow();
    expect(isUsableCatalog(views)).toBe(false);
  });

  it("rejects a views object whose exercises were emptied after the fact", () => {
    expect(isUsableCatalog({ ...buildCatalogViews(DOC), allExercises: [] })).toBe(false);
  });
});

describe("findBlacklistEntry", () => {
  const CATALOG = buildCatalogViews(DOC);

  it("matches the whole name, trimmed, case- and diacritic-insensitively", () => {
    expect(findBlacklistEntry("Sit-up", CATALOG).reason).toBe("Flexion vertébrale");
    expect(findBlacklistEntry("  sit-up  ", CATALOG).reason).toBe("Flexion vertébrale");
  });

  it("does NOT match a substring — that is the loose variant's job, not this one", () => {
    expect(findBlacklistEntry("Sit-up sur ballon", CATALOG)).toBeNull();
  });

  it("returns null for an unlisted name and for non-string input", () => {
    expect(findBlacklistEntry("Squat", CATALOG)).toBeNull();
    expect(findBlacklistEntry(null, CATALOG)).toBeNull();
    expect(findBlacklistEntry(42, CATALOG)).toBeNull();
  });

  it("ignores an exercise deactivated with no reason — absent, never explained", () => {
    expect(findBlacklistEntry("Burpees", CATALOG)).toBeNull();
  });

  it("requires a catalog", () => {
    expect(() => findBlacklistEntry("Sit-up")).toThrow(/catalog/i);
  });
});

describe("canonicalExerciseName", () => {
  const CATALOG = buildCatalogViews(DOC);

  it("resolves a retired name to the current one", () => {
    expect(canonicalExerciseName("Développé couché", CATALOG)).toBe("Développé couché au sol");
  });

  it("is the identity for anything that is not a known alias — never guesses", () => {
    expect(canonicalExerciseName("Squat", CATALOG)).toBe("Squat");
    expect(canonicalExerciseName("Développé couche", CATALOG)).toBe("Développé couche");
  });

  it("passes non-string input straight through", () => {
    expect(canonicalExerciseName(null, CATALOG)).toBeNull();
  });

  it("does not resolve an inherited Object.prototype key", () => {
    // `aliases` comes from JSON, so `constructor`/`toString` are reachable via
    // the prototype chain. A plain `aliases[name]` would return a function here
    // and rename an exercise to `[Function: Object]`.
    expect(canonicalExerciseName("constructor", CATALOG)).toBe("constructor");
  });

  it("requires a catalog", () => {
    expect(() => canonicalExerciseName("Développé couché")).toThrow(/catalog/i);
  });
});

describe("describeExercise", () => {
  // The alias in DOC points at a name DOC does not define, which is exactly the
  // shape `canonicalExerciseName` is tested against but the wrong shape here: a
  // lookup needs the target to exist. This document renames a LIVE entry.
  const RENAMED = { ...DOC, aliases: { "Squat sumo": "Squat" } };
  const CATALOG = buildCatalogViews(RENAMED);

  it("resolves the alias before looking the entry up", () => {
    // The defect this exists for: every display consumer read
    // `catalog.descriptions[name]` on the RAW name. `descriptions` is keyed on
    // current names only, so a retired one returned `undefined` — and a
    // description, a « par côté » badge and a per-hand charge label all
    // disappeared with no way to tell that apart from an exercise that simply
    // has no description. Séance mode showed no form guidance at all.
    expect(describeExercise("Squat sumo", CATALOG)).toBe(CATALOG.descriptions["Squat"]);
  });

  it("returns the entry for a current name", () => {
    expect(describeExercise("Squat", CATALOG).description).toBe("d");
  });

  it("returns null for a name the catalog does not know — never guesses", () => {
    expect(describeExercise("Soulevé de terre", CATALOG)).toBeNull();
  });

  it("returns null rather than throwing without a catalog", () => {
    // The deliberate departure from `requireCatalog`. Every caller is a DISPLAY
    // consumer that legitimately renders before the first Neon pull lands; the
    // answer there is "show nothing yet", not a crash mid-séance.
    expect(describeExercise("Squat", null)).toBeNull();
    expect(describeExercise("Squat", undefined)).toBeNull();
    expect(describeExercise("Squat", {})).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(describeExercise(null, CATALOG)).toBeNull();
    expect(describeExercise(undefined, CATALOG)).toBeNull();
  });

  it("does not return an inherited Object.prototype member", () => {
    // `descriptions` is null-prototype for this reason; pinned here because a
    // future plain-object rewrite would hand `constructor` back as a descriptor
    // and every reader would treat a function as an exercise entry.
    expect(describeExercise("constructor", CATALOG)).toBeNull();
    expect(describeExercise("toString", CATALOG)).toBeNull();
  });
});

/*
 * ---------------------------------------------------------------------------
 * Write-time validation (slice 2)
 * ---------------------------------------------------------------------------
 *
 * Two functions, and the split is a ruling rather than a style choice.
 *
 * `validateCatalogDoc` BLOCKS: everything a consumer would crash on, silently
 * mis-read, or quietly drop. It runs in the form AND in the PUT handler,
 * because a malformed document does not break one screen — it breaks every
 * plan import at once, and the coach's whole exercise list with it.
 *
 * `checkCatalogQuality` WARNS and never blocks: the copy-consistency
 * invariants that until now only guarded the frozen seed fixture
 * (`catalogSeed.test.js`). They are heuristic French text matching, so a false
 * positive is a real possibility, and the cost of the two failure modes is not
 * symmetric — an entry whose prose contradicts its load model is a line the user
 * reads and can fix, while a form that refuses to save is an exercise she
 * cannot add at all. Owner ruling, 2026-08-14.
 */

const OK_ENTRY = {
  name: "Rowing", group: "Upper Body",
  description: "Un haltère dans chaque main, tirer vers les hanches",
  formCues: "Dos plat, coudes le long du corps",
  intent: "Le tirage horizontal, pour équilibrer les poussées",
  implementTypes: ["dumbbell", "dual_bar_symmetric"], equipmentNeeds: ["dumbbell"],
  perSide: false, barHeight: null, ceiling: null,
  active: true, inactiveReason: null, replacedBy: null,
};
const docOf = (...exercises) => ({ version: 1, exercises, aliases: {} });

describe("validateCatalogDoc", () => {
  it("accepts a well-formed document", () => {
    expect(validateCatalogDoc(docOf(OK_ENTRY))).toEqual([]);
  });

  // The ids `applyCatalogOps` skips on replay: a malformed list would make a
  // replay apply an edit twice.
  it("accepts a list of applied operation ids, and refuses a malformed or oversized one", () => {
    const withIds = (appliedOps) => ({ ...docOf(OK_ENTRY), appliedOps });
    expect(validateCatalogDoc(withIds(["a", "b"]))).toEqual([]);
    expect(validateCatalogDoc(withIds("a")).join(" ")).toMatch(/journal/);
    expect(validateCatalogDoc(withIds(["a", 3])).join(" ")).toMatch(/journal/);
    expect(validateCatalogDoc(withIds(["a", ""])).join(" ")).toMatch(/journal/);
    const tooMany = Array.from({ length: APPLIED_OPS_LIMIT + 1 }, (_, i) => `id${i}`);
    expect(validateCatalogDoc(withIds(tooMany)).join(" ")).toMatch(/trop long/);
  });

  it.each([
    ["a missing name", { ...OK_ENTRY, name: "  " }, /nom/i],
    ["a missing group", { ...OK_ENTRY, group: undefined }, /groupe/i],
    ["an unknown group", { ...OK_ENTRY, group: "Bras" }, /groupe/i],
    ["a hand-composed implement set", { ...OK_ENTRY, implementTypes: ["dumbbell", "elastic"] }, /charge/i],
    ["an empty implement set", { ...OK_ENTRY, implementTypes: [] }, /charge/i],
    ["an unknown equipment token", { ...OK_ENTRY, equipmentNeeds: ["trampoline"] }, /matériel/i],
    ["a bad ceiling unit", { ...OK_ENTRY, ceiling: { maxKg: 10, unit: "lbs" } }, /plafond/i],
    ["a ceiling with no usable number", { ...OK_ENTRY, ceiling: { maxKg: "onze", unit: "total" } }, /plafond/i],
    ["an unknown bar height", { ...OK_ENTRY, barHeight: "moyenne", equipmentNeeds: ["pullup_bar"] }, /hauteur/i],
    ["a barHeight with no bar", { ...OK_ENTRY, barHeight: "haute" }, /barre de traction/i],
    ["an unknown set unit", { ...OK_ENTRY, metric: "minutes" }, /unité de série/i],
  ])("rejects %s", (_label, entry, pattern) => {
    expect(validateCatalogDoc(docOf(entry)).join(" ")).toMatch(pattern);
  });

  it("rejects a duplicate name", () => {
    expect(validateCatalogDoc(docOf(OK_ENTRY, OK_ENTRY)).join(" ")).toMatch(/déjà/i);
  });

  // Absent is the state of every entry written before the field existed, and
  // of every entry the user never edits. Refusing it would make the whole live
  // catalog unsaveable on the first edit.
  it.each([["absent", undefined], ["reps", "reps"], ["seconds", "seconds"]])(
    "accepts a %s metric",
    (_label, metric) => {
      expect(validateCatalogDoc(docOf({ ...OK_ENTRY, metric }))).toEqual([]);
    }
  );

  // §2bis.1 — absence of a reason is meaningful, not invalid: a deactivated
  // exercise with no reason is filtered from the coach's catalog without being
  // explained to it, which is exactly what `buildCatalogViews` implements.
  it("accepts a deactivated exercise with no reason", () => {
    expect(validateCatalogDoc(docOf({ ...OK_ENTRY, active: false, inactiveReason: null }))).toEqual([]);
  });

  // An empty catalog is the one document that must never be saved. Every
  // downstream verdict inverts under it: the lexique empties, the manual picker
  // empties, and every plan import reports each exercise « introuvable dans le
  // catalogue », telling the user to correct names that are perfectly correct.
  // `isUsableCatalog` already refuses to hand one out on READ; this refuses to
  // let one be written in the first place.
  it("rejects a document with no exercises at all", () => {
    expect(validateCatalogDoc(docOf()).join(" ")).toMatch(/aucun exercice/i);
    expect(validateCatalogDoc(null).join(" ")).toMatch(/aucun exercice/i);
  });

  // Carried from slice 1's review. `buildCatalogViews` pushes forbiddenNames
  // and deactivated exercises into ONE `blacklist` array, so a name in both
  // places lands twice with two reasons that are free to disagree —
  // `findBlacklistEntry` then returns whichever came first.
  it("rejects a forbidden name that is also an exercise", () => {
    const doc = { ...docOf(OK_ENTRY), forbiddenNames: [{ name: "Rowing", reason: "Nécessite un banc" }] };
    expect(validateCatalogDoc(doc).join(" ")).toMatch(/interdit/i);
  });

  it("accepts a forbidden name that is not an exercise", () => {
    const doc = { ...docOf(OK_ENTRY), forbiddenNames: [{ name: "Hip thrust", reason: "Nécessite un banc" }] };
    expect(validateCatalogDoc(doc)).toEqual([]);
  });

  // Aliases are written by the rename path, so they are as editable as any
  // other field. A dangling one is silent: `canonicalExerciseName` rewrites a
  // session's exercise name to something no catalog entry matches, and the
  // import then rejects an exercise the user really does have.
  it("rejects an alias pointing at a name that does not exist", () => {
    const doc = { ...docOf(OK_ENTRY), aliases: { "Tirage": "Rowing horizontal" } };
    expect(validateCatalogDoc(doc).join(" ")).toMatch(/n'existe pas|introuvable/i);
  });

  it("rejects an alias whose old name is still a live exercise", () => {
    const doc = { ...docOf(OK_ENTRY, { ...OK_ENTRY, name: "Tirage" }), aliases: { "Tirage": "Rowing" } };
    expect(validateCatalogDoc(doc).join(" ")).toMatch(/à la fois/i);
  });

  it("accepts a well-formed alias", () => {
    const doc = { ...docOf(OK_ENTRY), aliases: { "Rowing haltères": "Rowing" } };
    expect(validateCatalogDoc(doc)).toEqual([]);
  });

  it("names the offending exercise, so the message is actionable", () => {
    expect(validateCatalogDoc(docOf({ ...OK_ENTRY, group: "Bras" })).join(" ")).toContain("Rowing");
  });

  it("never throws on a malformed document", () => {
    expect(() => validateCatalogDoc(undefined)).not.toThrow();
    expect(() => validateCatalogDoc({ exercises: [null, 42, {}] })).not.toThrow();
    expect(() => validateCatalogDoc({ exercises: [OK_ENTRY], aliases: "nope", forbiddenNames: 7 })).not.toThrow();
  });
});

describe("checkCatalogQuality", () => {
  it("is silent on a coherent entry", () => {
    expect(checkCatalogQuality(docOf(OK_ENTRY))).toEqual([]);
  });

  /**
   * The hold heuristic, pinned from BOTH directions against real seed copy.
   * The positives are the five entries whose description ends on the hold
   * instruction; the negatives are the four a "does `tenir` or `maintenir`
   * appear anywhere" rule would also have caught — every one of them
   * rep-counted, carrying a tempo cue.
   *
   * Each guard was proven by mutation rather than assumed, and they catch
   * different loosenings — none is redundant:
   *
   *   never fires (`/$^/`)                    → all 5 positives
   *   reads formCues, anchor kept             → the Gainage latéral positive,
   *                                             whose real cue « Temps PAR
   *                                             CÔTÉ » pushes the hold word
   *                                             off the end
   *   anchor dropped, field kept              → the anchor negatives
   *   reads formCues AND anchor dropped       → Tapis de course (« ne pas se
   *                                             tenir aux barres ») + anchor
   *   also widens `maintenir la position`
   *     to bare `maintenir`                   → all four cue negatives
   *
   * That last one is the realistic drift: `maintenir` looks like a harmless
   * generalisation and takes three rep-counted exercises with it.
   */
  const HOLD_ENTRY = (over) => ({
    ...OK_ENTRY, implementTypes: ["bodyweight"], equipmentNeeds: [], ...over,
  });

  it.each([
    ["Dead hang", "Suspendue à la barre bras tendus, tenir", ""],
    ["Chaise murale", "Dos plaqué au mur, cuisses parallèles au sol, tenir", ""],
    ["Gainage planche", "Position pompe ou sur les avant-bras, corps droit, tenir", ""],
    ["Gainage latéral", "Sur un avant-bras, de profil, corps droit, tenir", "Temps PAR CÔTÉ"],
    ["Hollow Body", "Bas du dos plaqué au sol, maintenir la position", ""],
  ])("warns when %s counts repetitions", (name, description, formCues) => {
    const warnings = checkCatalogQuality(docOf(HOLD_ENTRY({ name, description, formCues })));
    expect(warnings.join(" ")).toMatch(/maintien.*secondes/i);
  });

  // Guards the FIELD: these carry the word only in `formCues`, verbatim from
  // the seed. Fails the moment the check reads `copy` (description + cues)
  // the way every other check in this function does.
  it.each([
    ["Shrugs", "Un haltère dans chaque main, monter les épaules", "Monter les épaules vers les oreilles, maintenir 1 seconde en haut"],
    ["Pont fessier", "Un haltère sur les hanches, pousser le bassin vers le haut", "Serrer les fessiers en haut, maintenir 1 seconde, ne pas cambrer le dos"],
    ["Bird dog", "À quatre pattes, tendre bras et jambe opposés", "Dos plat et hanches stables, maintenir 2 secondes en extension"],
    ["Tapis de course", "Marche ou course en salle sur tapis roulant", "Ne pas se tenir aux barres, bras balancés naturellement"],
  ])("stays silent on %s, whose cue is a tempo and not a hold", (name, description, formCues) => {
    const warnings = checkCatalogQuality(docOf(HOLD_ENTRY({ name, description, formCues })));
    expect(warnings.join(" ")).not.toMatch(/maintien/i);
  });

  // Guards the ANCHOR: the word appears in the description, but mid-sentence
  // and about something else entirely — « ne pas SE TENIR aux barres » is the
  // negation of a hold. Fails the moment the trailing `$` is dropped.
  it.each([
    ["a description that forbids holding on", "Marche sur tapis roulant, ne pas se tenir aux barres, buste droit"],
    ["a description that holds only briefly", "Monter les épaules, maintenir une seconde en haut, puis relâcher"],
  ])("stays silent on %s", (_label, description) => {
    const warnings = checkCatalogQuality(docOf(HOLD_ENTRY({ name: "Machin", description })));
    expect(warnings.join(" ")).not.toMatch(/maintien/i);
  });

  it("stops warning once the hold is counted in seconds", () => {
    const entry = HOLD_ENTRY({ name: "Dead hang", description: "Suspendue à la barre bras tendus, tenir", metric: "seconds" });
    expect(checkCatalogQuality(docOf(entry)).join(" ")).not.toMatch(/maintien/i);
  });

  it.each([
    [
      "copy that names no implement the exercise can be loaded with",
      { ...OK_ENTRY, description: "Tirer vers les hanches", formCues: "Dos plat" },
      /haltère/i,
    ],
    [
      "copy that names an implement the exercise cannot be loaded with",
      { ...OK_ENTRY, implementTypes: ["ankle_weight"], description: "Un haltère dans chaque main, tirer", formCues: "Dos plat" },
      /haltère/i,
    ],
    [
      "a bodyweight exercise described as carrying a load",
      { ...OK_ENTRY, implementTypes: ["bodyweight"], equipmentNeeds: [], description: "Un haltère dans chaque main", formCues: "Dos plat" },
      /poids du corps/i,
    ],
    [
      "copy naming equipment the entry does not declare",
      { ...OK_ENTRY, formCues: "Dos plat, allongée sur un banc" },
      /banc/i,
    ],
    [
      "a single-implement exercise whose copy describes two",
      { ...OK_ENTRY, implementTypes: ["dumbbell", "single_bar_heavy"] },
      /une seule|un seul/i,
    ],
    [
      "a per-side exercise whose copy never says so",
      { ...OK_ENTRY, perSide: true },
      /par côté/i,
    ],
    [
      "a non-per-side exercise whose copy announces sides",
      { ...OK_ENTRY, formCues: "Dos plat, 10 répétitions par bras" },
      /par côté/i,
    ],
    ["a missing intent", { ...OK_ENTRY, intent: "  " }, /sert/i],
    ["an intent that merely repeats the definition", { ...OK_ENTRY, intent: OK_ENTRY.description }, /répète/i],
    ["a missing definition", { ...OK_ENTRY, description: "" }, /définition/i],
  ])("warns about %s", (_label, entry, pattern) => {
    expect(checkCatalogQuality(docOf(entry)).join(" ")).toMatch(pattern);
  });

  // The load-bearing half of the ruling: a warning is a warning. Nothing here
  // may ever appear in the blocking list, or the form stops being saveable on
  // a heuristic.
  it("never blocks: every quality complaint leaves validateCatalogDoc silent", () => {
    const sloppy = { ...OK_ENTRY, intent: "", description: "", formCues: "" };
    expect(checkCatalogQuality(docOf(sloppy)).length).toBeGreaterThan(0);
    expect(validateCatalogDoc(docOf(sloppy))).toEqual([]);
  });

  it("never throws on a malformed document", () => {
    expect(() => checkCatalogQuality(undefined)).not.toThrow();
    expect(() => checkCatalogQuality({ exercises: [null, 42, {}] })).not.toThrow();
  });
});

describe("applyRename", () => {
  const doc = {
    version: 1,
    exercises: [{ ...OK_ENTRY }, { ...OK_ENTRY, name: "Squat" }],
    aliases: { "Rowing haltères": "Rowing" },
  };

  it("rewrites the name and records the alias in the same document", () => {
    const next = applyRename(doc, "Rowing", "Rowing buste penché");
    expect(next.exercises.map((e) => e.name)).toEqual(["Rowing buste penché", "Squat"]);
    expect(next.aliases["Rowing"]).toBe("Rowing buste penché");
  });

  // `canonicalExerciseName` resolves exactly ONE hop, so an alias left pointing
  // at the retired name would resolve to something no catalog entry matches —
  // and `validateCatalogDoc` would then refuse a perfectly reasonable rename.
  // The live catalog already carries three aliases from 2026-07-26, so a
  // second rename reaches this.
  it("repoints existing aliases that pointed at the old name", () => {
    const next = applyRename(doc, "Rowing", "Rowing buste penché");
    expect(next.aliases["Rowing haltères"]).toBe("Rowing buste penché");
    expect(validateCatalogDoc(next)).toEqual([]);
  });

  it("leaves the document alone when the name did not change", () => {
    expect(applyRename(doc, "Rowing", "Rowing")).toBe(doc);
  });

  it("never mutates the input", () => {
    const before = JSON.stringify(doc);
    applyRename(doc, "Rowing", "Rowing buste penché");
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("refuses an empty new name rather than producing a nameless exercise", () => {
    expect(applyRename(doc, "Rowing", "   ")).toBe(doc);
  });
});

describe("checkCatalogQuality — a bar exercise with no height", () => {
  const barEntry = { ...OK_ENTRY, implementTypes: ["bodyweight"], equipmentNeeds: ["pullup_bar"],
    description: "Suspendue à la barre, tirer", formCues: "Épaules basses" };

  // Not malformed — nothing crashes on it — but invisible to both things that
  // protect her: omitted from the prompt's high/low lists, and skipped by
  // `checkBarHeightRule`, so it can be programmed beside either height with no
  // error. A warning rather than a block, and deliberately no default written
  // for her: guessing « haute » on a low-bar exercise manufactures the false
  // rejections this repo guards hardest against.
  it("warns when the pull-up bar is declared without a height", () => {
    expect(checkCatalogQuality(docOf({ ...barEntry, barHeight: null })).join(" ")).toMatch(/hauteur/i);
  });

  it("is silent once a height is set", () => {
    expect(checkCatalogQuality(docOf({ ...barEntry, barHeight: "haute" }))).toEqual([]);
    expect(checkCatalogQuality(docOf({ ...barEntry, barHeight: "basse" }))).toEqual([]);
  });

  it("is silent for an exercise that needs no bar", () => {
    expect(checkCatalogQuality(docOf({ ...OK_ENTRY, barHeight: null }))).toEqual([]);
  });

  it("still never blocks", () => {
    expect(validateCatalogDoc(docOf({ ...barEntry, barHeight: null }))).toEqual([]);
  });
});

describe("usableCatalogViews", () => {
  it("builds the views against the profile's inventory, which is what the validators then see", () => {
    const views = usableCatalogViews(DOC, TEST_INVENTORY);
    expect(views.inventory.dumbbellOptionsKg).toEqual([...TEST_INVENTORY.dumbbellOptionsKg]);
    expect(views.inventory.isStarter).toBe(false);
    expect(usableCatalogViews(DOC, { ...TEST_INVENTORY, dumbbellOptionsKg: [3] }).inventory.dumbbellOptionsKg).toEqual([3]);
  });

  it("is null without a usable catalog, never an empty views object", () => {
    expect(usableCatalogViews(null, TEST_INVENTORY)).toBeNull();
    expect(usableCatalogViews({ version: 1, exercises: [] }, TEST_INVENTORY)).toBeNull();
  });
});
