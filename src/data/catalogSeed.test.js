/**
 * Data-quality invariants over the exercise catalog.
 *
 * These assertions used to live in `src/constants/index.test.js` and run
 * against `EXERCISE_DESCRIPTIONS` / `ALL_EXERCISES` / `MUSCLE_GROUPS` /
 * `EXERCISE_BLACKLIST`. Those constants are gone — the catalog is a document in
 * Neon now — so the same invariants run here against `buildCatalogViews(seed)`.
 * Nothing about what is asserted changed; only where the data comes from.
 *
 * **This is not the old `src/lib/catalogSeed.test.js`.** That file was the
 * one-shot migration proof (the seed reproduces the constants exactly) and was
 * deleted in the same commit as the constants it compared against — a proof of
 * equality has nothing left to compare once one side is gone. This file asserts
 * the catalog is INTERNALLY CONSISTENT, which stays true and stays checkable.
 *
 * `catalogSeed.json` is the fixture, and it is the honest one: it is the
 * committed copy of the document Neon was seeded with, and the same object
 * `coachPrompt.test.js` and the validator suites build their catalog from. What
 * it CANNOT cover is a document the user has since edited in the app — no test can
 * reach that. Slice 2 (editing) is where these invariants need to become
 * runtime validation on write; until then they guard the day-one catalog and
 * every fixture derived from it.
 *
 * `src/lib/catalog.test.js` is the complement and the two do not overlap: it
 * pins the MECHANICS of `buildCatalogViews` against a small synthetic document,
 * this file pins the CONTENT of the real one.
 */

import { describe, it, expect } from "vitest";
import seed from "./catalogSeed.json";
import { buildCatalogViews } from "../lib/catalogTestkit.js";
import {
  findBlacklistEntry,
  canonicalExerciseName,
  validateCatalogDoc,
  checkCatalogQuality,
} from "../lib/catalog.js";
import {
  IMPLEMENT_TYPES,
  BILATERAL_HAND_IMPLEMENTS,
  SINGLE_HAND_HELD_IMPLEMENTS,
  EQUIPMENT_VOCABULARY,
  deriveLocations,
} from "../constants/equipment.js";

const CATALOG = buildCatalogViews(seed);
const { descriptions: DESCRIPTIONS, allExercises: ALL, muscleGroups: GROUPS, inventory: INVENTORY } = CATALOG;

/**
 * The locations an exercise is allowed in, derived from its own descriptor.
 *
 * This is `getExerciseLocations` (deleted with the constants), reconstructed
 * over the catalog: it was never anything but `deriveLocations` applied to a
 * catalog entry, which is exactly how `coachPromptInputs.js` derives
 * availability in production. An unknown name resolves to `[]` rather than
 * throwing, keeping the old verdict — `planValidation.js` documents relying on
 * it.
 */
function locationsOf(name) {
  const entry = DESCRIPTIONS[name];
  if (!entry) return [];
  return deriveLocations(entry.equipmentNeeds, entry.implementTypes, INVENTORY);
}

describe("catalog implementTypes", () => {
  it("gives every entry a non-empty set of valid implement types", () => {
    for (const [name, entry] of Object.entries(DESCRIPTIONS)) {
      expect(Array.isArray(entry.implementTypes), `${name} implementTypes`).toBe(true);
      expect(entry.implementTypes.length, `${name} implementTypes`).toBeGreaterThan(0);
      for (const type of entry.implementTypes) {
        expect(IMPLEMENT_TYPES, `${name} implement type "${type}"`).toContain(type);
      }
    }
  });

  it("keeps the owner's implement rulings of 2026-07-26", () => {
    // Updated from "the seven fixed load-bearing implementType assignments":
    // an exercise is no longer locked to ONE implement (that model produced
    // four false rejections in production). What is pinned now is the general
    // rule plus every exception the owner ruled on.
    expect(DESCRIPTIONS["Squat"].implementTypes).toEqual(BILATERAL_HAND_IMPLEMENTS);
    expect(DESCRIPTIONS["Soulevé de terre roumain"].implementTypes).toEqual(BILATERAL_HAND_IMPLEMENTS);
    // Held in front / overhead with a single implement: one dumbbell or one loaded bar.
    expect(DESCRIPTIONS["Squat sumo"].implementTypes).toEqual(SINGLE_HAND_HELD_IMPLEMENTS);
    expect(DESCRIPTIONS["Extension triceps"].implementTypes).toEqual(SINGLE_HAND_HELD_IMPLEMENTS);
    // THE exception: only the 11 kg dumbbell balances on the hips, which is
    // why this exercise's ceiling is 11 kg. No bar-only value may be valid here.
    expect(DESCRIPTIONS["Pont fessier"].implementTypes).toEqual(["dumbbell"]);
    expect(DESCRIPTIONS["Donkey kick"].implementTypes).toEqual(["ankle_weight"]);
    expect(DESCRIPTIONS["Pont fessier unilatéral"].implementTypes).toEqual(["ankle_weight"]);
    expect(DESCRIPTIONS["Fire hydrant"].implementTypes).toEqual(["ankle_weight"]);
  });

  it("applies the general rule consistently: bilateral hand-held work takes dumbbells or the two bars", () => {
    // The rule is what keeps this from being 25 independent hand-typed
    // decisions: one implement per hand -> the paired-hand set, exactly.
    //
    // `bilateral` is DERIVED from the implement set by `buildCatalogViews`, so
    // the forward direction is true by construction; the REVERSE direction is
    // the one that still bites, and it is the one that matters — an exercise
    // whose set merely resembles the bilateral pair must not be read as
    // per-hand, which is ambiguous by a factor of two.
    for (const [name, entry] of Object.entries(DESCRIPTIONS)) {
      if (entry.bilateral) {
        expect(entry.implementTypes, `${name} is bilateral`).toEqual(BILATERAL_HAND_IMPLEMENTS);
      } else {
        expect(entry.implementTypes, `${name} is not bilateral`).not.toEqual(BILATERAL_HAND_IMPLEMENTS);
      }
    }
  });
});

describe("catalog copy matches the load model", () => {
  // This copy is rendered in the in-app Lexique. The structured data is
  // authoritative and the prose must follow it: `Squat`, `Squat sumo` and
  // `Soulevé de terre roumain` once described "haltères" (dumbbells) while
  // being tagged bar-only, so the user read a description contradicting the
  // weights the coach was allowed to prescribe.
  const copyOf = (entry) => `${entry.description} ${entry.formCues}`;

  /**
   * The French word the copy uses for each load-bearing implement type. Both
   * bar types share one word on purpose — the Lexique has no reason to spell
   * out which plating scheme applies. `barre chargeable`, not a bare `barre`:
   * `Tirage vertical élastique` legitimately mentions a "barre de traction" (a pull-up
   * bar it hangs an elastic from) and `Tapis de course` its handrails, neither
   * of which is a loadable bar.
   */
  const IMPLEMENT_WORD = {
    dumbbell: /haltère/i,
    dual_bar_symmetric: /barre chargeable/i,
    single_bar_heavy: /barre chargeable/i,
    ankle_weight: /lest/i,
    elastic: /élastique/i,
  };

  /** The words an exercise's implement SET legitimately allows in its copy. */
  const allowedWords = (entry) =>
    entry.implementTypes.map((type) => IMPLEMENT_WORD[type]?.source).filter(Boolean);

  /** True for an exercise that carries an external load at all (bodyweight and cardio do not). */
  const isLoaded = (entry) => allowedWords(entry).length > 0;

  it("names at least one implement the exercise can actually be loaded with", () => {
    for (const [name, entry] of Object.entries(DESCRIPTIONS)) {
      if (!isLoaded(entry)) continue; // bodyweight and cardio carry no implement
      const words = allowedWords(entry);
      const named = words.some((source) => new RegExp(source, "i").test(copyOf(entry)));
      expect(named, `${name} (${entry.implementTypes.join("/")}) should name one of its implements`).toBe(
        true
      );
    }
  });

  it("never names an implement the exercise cannot be loaded with", () => {
    // The union model made this the load-bearing direction: an exercise that
    // takes dumbbells OR bars may describe either, but `Pont fessier`
    // (dumbbell-only) must never suggest a bar, and an ankle-weight exercise
    // must never suggest a dumbbell.
    for (const [name, entry] of Object.entries(DESCRIPTIONS)) {
      if (!isLoaded(entry)) continue;
      const allowed = new Set(allowedWords(entry));
      for (const word of Object.values(IMPLEMENT_WORD)) {
        if (allowed.has(word.source)) continue;
        expect(copyOf(entry), `${name} names an implement it cannot use`).not.toMatch(word);
      }
    }
  });

  it("never describes a bodyweight exercise as carrying a load", () => {
    for (const [name, entry] of Object.entries(DESCRIPTIONS)) {
      if (!entry.implementTypes.includes("bodyweight")) continue;
      expect(copyOf(entry), `${name} is bodyweight`).not.toMatch(/haltère|barre chargeable|lest|élastique/i);
    }
  });

  /**
   * Equipment the copy may only name when `equipmentNeeds` declares it. Without
   * this, the prose can offer a piece of equipment the structured data (and the
   * real inventory) says she does not have — which is what `Développé couché au sol`,
   * `Dips sur chaise` and `Step up` all did: they suggested a bench while being tagged
   * home-legal via the floor or the chair.
   */
  const EQUIPMENT_WORD = {
    bench: /banc/i,
    machine: /machine/i,
    pulley: /poulie/i,
    kettlebell: /kettlebell/i,
    rack: /\brack\b/i,
    chair: /chaise/i,
  };

  it("never names a piece of equipment the exercise does not declare", () => {
    for (const [name, entry] of Object.entries(DESCRIPTIONS)) {
      for (const [token, word] of Object.entries(EQUIPMENT_WORD)) {
        if (entry.equipmentNeeds.includes(token)) continue;
        expect(copyOf(entry), `${name} names "${token}" without declaring it`).not.toMatch(word);
      }
    }
  });

  it("matches the bilateral flag: two implements are described iff bilateral", () => {
    const TWO_IMPLEMENTS = /chaque main|haltères|barres/i;
    for (const [name, entry] of Object.entries(DESCRIPTIONS)) {
      if (!isLoaded(entry) || entry.implementTypes.includes("ankle_weight")) continue;
      if (entry.bilateral) {
        expect(copyOf(entry), `${name} is bilateral (one implement per hand)`).toMatch(TWO_IMPLEMENTS);
      } else {
        expect(copyOf(entry), `${name} is not bilateral (a single implement)`).not.toMatch(TWO_IMPLEMENTS);
      }
    }
  });

  it("matches the perSide flag: reps are announced per side iff perSide", () => {
    const PER_SIDE = /par (jambe|côté|bras)/i;
    for (const [name, entry] of Object.entries(DESCRIPTIONS)) {
      if (entry.perSide) {
        expect(copyOf(entry), `${name} counts reps per side`).toMatch(PER_SIDE);
      } else {
        expect(copyOf(entry), `${name} does not count reps per side`).not.toMatch(PER_SIDE);
      }
    }
  });
});

describe("catalog equipmentNeeds", () => {
  it("gives every entry an equipmentNeeds array drawn from the allowed vocabulary", () => {
    for (const [name, entry] of Object.entries(DESCRIPTIONS)) {
      expect(Array.isArray(entry.equipmentNeeds), `${name} equipmentNeeds`).toBe(true);
      for (const need of entry.equipmentNeeds) {
        expect(EQUIPMENT_VOCABULARY, `${name} equipmentNeeds token "${need}"`).toContain(need);
      }
    }
  });
});

describe("derived exercise locations", () => {
  it("acceptance criterion: no exercise allowed at home requires any disallowed-at-home equipment", () => {
    for (const [name, entry] of Object.entries(DESCRIPTIONS)) {
      const locations = locationsOf(name);
      if (locations.includes("maison")) {
        const hasDisallowed = entry.equipmentNeeds.some((need) =>
          INVENTORY.unavailableAtHome.includes(need)
        );
        expect(hasDisallowed, `${name} is allowed at home but needs disallowed equipment`).toBe(false);
      }
    }
  });

  it("allows every cardio exercise at salle", () => {
    for (const [name, entry] of Object.entries(DESCRIPTIONS)) {
      if (entry.implementTypes.includes("cardio")) {
        expect(locationsOf(name), `${name} should be allowed at salle`).toContain("salle");
      }
    }
  });

  it("disallows Développé incliné and Tirage vertical at home (neither location applies)", () => {
    expect(locationsOf("Développé incliné")).not.toContain("maison");
    expect(locationsOf("Tirage vertical élastique")).not.toContain("maison");
    expect(locationsOf("Développé incliné")).toEqual([]);
    expect(locationsOf("Tirage vertical élastique")).toEqual([]);
  });

  it("allows Développé couché, Dips, Step up and the hip-elastic exercise at home", () => {
    expect(locationsOf("Développé couché au sol")).toContain("maison");
    expect(locationsOf("Dips sur chaise")).toContain("maison");
    expect(locationsOf("Step up")).toContain("maison");
    expect(locationsOf("Abducteurs élastique")).toContain("maison");
  });

  it("handles an unknown exercise name without throwing", () => {
    expect(() => locationsOf("Exercice inexistant")).not.toThrow();
    expect(locationsOf("Exercice inexistant")).toEqual([]);
  });
});

describe("pull-up bar exercises", () => {
  const PULLUP_BAR_EXERCISES = [
    ["Traction pronation", "Upper Body", "haute"],
    ["Traction supination", "Upper Body", "haute"],
    ["Traction négative", "Upper Body", "haute"],
    ["Traction supination négative", "Upper Body", "haute"],
    ["Traction australienne", "Upper Body", "basse"],
    ["Dead hang", "Upper Body", "haute"],
    ["Relevé de jambes suspendu", "Core", "haute"],
    ["Genoux à la poitrine suspendu", "Core", "haute"],
  ];

  it.each(PULLUP_BAR_EXERCISES)("%s is in %s with barHeight %s", (name, group, barHeight) => {
    expect(GROUPS[group]).toContain(name);
    expect(DESCRIPTIONS[name].barHeight).toBe(barHeight);
  });

  it.each(PULLUP_BAR_EXERCISES)("%s needs the bar and is doable at home", (name) => {
    expect(DESCRIPTIONS[name].equipmentNeeds).toContain("pullup_bar");
    expect(locationsOf(name)).toEqual(["maison"]);
  });

  it.each(PULLUP_BAR_EXERCISES)("%s is bodyweight, so only 0 kg is valid", (name) => {
    expect(DESCRIPTIONS[name].implementTypes).toEqual(["bodyweight"]);
  });

  it("gives barHeight only to exercises that need the bar", () => {
    for (const name of ALL) {
      const entry = DESCRIPTIONS[name];
      if (entry?.barHeight != null) {
        expect(entry.equipmentNeeds, `${name} has a barHeight but no pullup_bar`).toContain("pullup_bar");
      }
    }
  });
});

describe("negative variants", () => {
  it.each([
    ["Pompes négatives", []],
    ["Dips négatifs sur chaise", ["chair"]],
  ])("%s is a separate Upper Body entry, bodyweight, doable at home", (name, needs) => {
    expect(GROUPS["Upper Body"]).toContain(name);
    expect(DESCRIPTIONS[name].implementTypes).toEqual(["bodyweight"]);
    expect(DESCRIPTIONS[name].equipmentNeeds).toEqual(needs);
    expect(locationsOf(name)).toEqual(["maison"]);
  });

  it("keeps a negative distinct from its parent movement, so streaks do not merge", () => {
    expect(canonicalExerciseName("Pompes négatives", CATALOG)).toBe("Pompes négatives");
    expect(canonicalExerciseName("Dips négatifs sur chaise", CATALOG)).toBe("Dips négatifs sur chaise");
  });
});

describe("the catalog's blacklist", () => {
  it("keeps three of the four blacklisted exercises available to log by hand, but never Hip thrust", () => {
    // The exercise list and the blacklist are independent consumers:
    // deactivating an exercise never removes it from the manual picker (owner
    // ruling). `Hip thrust` is the opposite case — it is a `forbiddenNames`
    // entry, a banned movement that was never an exercise here, so it must
    // never reach the lexique or the picker at all.
    expect(ALL).toContain("Élévations frontales");
    expect(ALL).toContain("Hollow Body");
    expect(ALL).toContain("Russian twist");
    expect(ALL).not.toContain("Hip thrust");
  });

  it("gives every entry a French reason and a name, and a date that is either absent or ISO", () => {
    for (const entry of CATALOG.blacklist) {
      expect(typeof entry.name).toBe("string");
      expect(entry.name.length).toBeGreaterThan(0);
      expect(typeof entry.reason).toBe("string");
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.date === null || /^\d{4}-\d{2}-\d{2}$/.test(entry.date)).toBe(true);
      expect(entry.replacedBy === null || typeof entry.replacedBy === "string").toBe(true);
    }
  });
});

describe("findBlacklistEntry against the real catalog", () => {
  it("finds Hip thrust even though it has no exercise entry (the lookup covers forbiddenNames)", () => {
    expect(DESCRIPTIONS["Hip thrust"]).toBeUndefined();
    const entry = findBlacklistEntry("Hip thrust", CATALOG);
    expect(entry).not.toBeNull();
    expect(entry.reason).toMatch(/banc/);
  });

  it("matches forgivingly (trimmed, case-insensitive)", () => {
    expect(findBlacklistEntry("  hip thrust  ", CATALOG)?.name).toBe("Hip thrust");
    expect(findBlacklistEntry("RUSSIAN TWIST", CATALOG)?.name).toBe("Russian twist");
  });

  it("matches diacritic-insensitively — the unaccented spelling from constraints.md's own table still resolves the full entry", () => {
    // Regression: coordinator review, 2026-07-26 — Finding 2. "Elevations frontales"
    // (unaccented) previously returned null, so the plan was blocked only by the
    // generic "introuvable dans le catalogue" error, losing the reason and
    // replacement — the whole point of recording a blacklist entry.
    const entry = findBlacklistEntry("Elevations frontales", CATALOG);
    expect(entry).not.toBeNull();
    expect(entry.name).toBe("Élévations frontales");
    expect(entry.reason).toMatch(/Redondant avec les élévations latérales/);
  });

  it("returns null for a non-blacklisted name and never throws on bad input", () => {
    expect(findBlacklistEntry("Squat", CATALOG)).toBeNull();
    expect(findBlacklistEntry("", CATALOG)).toBeNull();
    expect(findBlacklistEntry(undefined, CATALOG)).toBeNull();
    expect(findBlacklistEntry(42, CATALOG)).toBeNull();
  });
});

describe("newly added but deactivated", () => {
  it.each([
    ["Sit-up", "Dead bug, crunch"],
    ["Renegade row", "Rowing unilatéral, gainage planche"],
  ])("%s is blacklisted with a reason and a replacement", (name, replacedBy) => {
    const entry = findBlacklistEntry(name, CATALOG);
    expect(entry).not.toBeNull();
    expect(entry.reason).toBeTruthy();
    expect(entry.replacedBy).toBe(replacedBy);
  });

  it("keeps them in the catalog so the user can still log them by hand", () => {
    expect(ALL).toContain("Sit-up");
    expect(ALL).toContain("Renegade row");
    expect(DESCRIPTIONS["Sit-up"]).toBeDefined();
    expect(DESCRIPTIONS["Renegade row"]).toBeDefined();
  });
});

const NEW_GAP_EXERCISES = [
  ["Squat gobelet", "Lower Body", "SINGLE"],
  ["Fente arrière", "Lower Body", "BILATERAL"],
  ["Fente latérale", "Lower Body", "BILATERAL"],
  ["Mollets debout", "Lower Body", "BILATERAL"],
  ["Chaise murale", "Lower Body", "BODYWEIGHT"],
  ["Soulevé de terre roumain unilatéral", "Lower Body", "BILATERAL"],
  ["Rowing unilatéral", "Upper Body", "SINGLE"],
  ["Écarté au sol", "Upper Body", "BILATERAL"],
  ["Pull-over", "Upper Body", "SINGLE"],
  ["Curl concentration", "Upper Body", "SINGLE"],
  ["Renegade row", "Full Body", "BILATERAL"],
  ["Sit-up", "Core", "BODYWEIGHT"],
];

const EXPECTED_SET = {
  SINGLE: SINGLE_HAND_HELD_IMPLEMENTS,
  BILATERAL: BILATERAL_HAND_IMPLEMENTS,
  BODYWEIGHT: ["bodyweight"],
};

describe("gap exercises her existing gear already supported", () => {
  it.each(NEW_GAP_EXERCISES)("%s is in %s with the %s implement set", (name, group, kind) => {
    expect(GROUPS[group]).toContain(name);
    expect(DESCRIPTIONS[name].implementTypes).toEqual(EXPECTED_SET[kind]);
  });

  it.each(NEW_GAP_EXERCISES)("%s is doable at home", (name) => {
    expect(locationsOf(name)).toEqual(["maison"]);
  });
});

describe("intent", () => {
  // `description` says what the movement is and `formCues` says how to do it;
  // neither answers "why is this in my programme", which is the complaint this
  // field exists for. A test can only check that the line is there and is not
  // one of the other two — the quality of the sentence is not machine-checkable.
  it("is present and non-empty on every catalog entry", () => {
    const missing = ALL.filter((name) => {
      const intent = DESCRIPTIONS[name]?.intent;
      return typeof intent !== "string" || intent.trim() === "";
    });
    expect(missing).toEqual([]);
  });

  it("never merely repeats the description", () => {
    for (const name of ALL) {
      const entry = DESCRIPTIONS[name];
      expect(entry.intent, `${name}`).not.toBe(entry.description);
    }
  });
});

describe("the catalog's aliases", () => {
  it("passes a canonical name through untouched", () => {
    expect(canonicalExerciseName("Squat", CATALOG)).toBe("Squat");
  });

  it("maps every alias to a name that exists in the catalog", () => {
    for (const [old, canonical] of Object.entries(CATALOG.aliases)) {
      expect(canonicalExerciseName(old, CATALOG)).toBe(canonical);
      expect(DESCRIPTIONS, `${old} → ${canonical}`).toHaveProperty(canonical);
    }
  });

  it("never maps a name onto itself, which would be a silent no-op entry", () => {
    for (const [old, canonical] of Object.entries(CATALOG.aliases)) {
      expect(old).not.toBe(canonical);
    }
  });

  // A retired name must NOT still be a live catalog key, or the alias is dead
  // code: resolveCatalogName matches the exact key first and never reaches it.
  it("never keeps a retired name in the catalog", () => {
    for (const old of Object.keys(CATALOG.aliases)) {
      expect(DESCRIPTIONS, old).not.toHaveProperty(old);
    }
  });

  it("leaves an unknown name alone rather than guessing", () => {
    expect(canonicalExerciseName("Un exercice qu'elle a tapé à la main", CATALOG)).toBe(
      "Un exercice qu'elle a tapé à la main"
    );
  });

  it("survives junk without throwing", () => {
    expect(canonicalExerciseName(null, CATALOG)).toBe(null);
    expect(canonicalExerciseName(undefined, CATALOG)).toBe(undefined);
  });
});

describe("the seed against the write-time validators", () => {
  // The invariants above are assertions over a frozen fixture; slice 2 turns
  // the same rules into validation that runs whenever the user saves. These two
  // tests are what keep the pair honest — the day-one catalog is the one
  // document we know to be correct, so a validator that rejects it, or a
  // quality check that complains about it, is wrong about the rule rather
  // than about the data.
  //
  // The per-rule rejection cases live in `src/lib/catalog.test.js`; without
  // them this pair would be a check that has never produced the opposite
  // answer, which is not evidence.
  it("blocks nothing in the day-one catalog", () => {
    expect(validateCatalogDoc(seed)).toEqual([]);
  });

  it("warns about nothing in the day-one catalog", () => {
    expect(checkCatalogQuality(seed)).toEqual([]);
  });
});
