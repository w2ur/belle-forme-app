import { describe, it, expect } from "vitest";
import {
  STARTER_INVENTORY,
  IMPLEMENT_TYPES,
  BILATERAL_HAND_IMPLEMENTS,
  SINGLE_HAND_HELD_IMPLEMENTS,
  computeAchievableLoadsPerImplement,
  buildInventoryViews,
  validateInventory,
  normalizeInventory,
  generateEquipmentLines,
  EQUIPMENT_VOCABULARY,
  LOCATIONS,
  deriveLocations,
  EQUIPMENT_LABELS_FR,
  describeHomeBlockers,
} from "./equipment.js";
import { TEST_INVENTORY } from "./testInventory.js";

// Rounds to 1 decimal the same way the implementation is expected to, so
// tests can assert "no float artifact" without duplicating internal logic.
const round1 = (n) => Math.round(n * 10) / 10;

const INV = buildInventoryViews(TEST_INVENTORY);

describe("IMPLEMENT_TYPES", () => {
  it("lists exactly the seven taxonomy values", () => {
    expect(IMPLEMENT_TYPES).toEqual([
      "bodyweight",
      "dumbbell",
      "dual_bar_symmetric",
      "single_bar_heavy",
      "ankle_weight",
      "elastic",
      "cardio",
    ]);
  });
});

describe("computeAchievableLoadsPerImplement", () => {
  const sets = computeAchievableLoadsPerImplement(TEST_INVENTORY);

  it("computes the dumbbell set as the per-hand options, sorted and deduplicated", () => {
    expect(sets.dumbbell).toEqual([3, 6, 9, 12, 15, 18]);
  });

  it("computes the dual_bar_symmetric per-hand set exactly (4 plates consumed per step)", () => {
    expect(sets.dual_bar_symmetric).toEqual([3, 5, 11, 13]);
  });

  it("computes the single_bar_heavy set exactly: every odd integer from 3 to 25 inclusive, no half-kilo values (strict per-end plate pairing, same rule as dual_bar_symmetric)", () => {
    const expected = Array.from({ length: 12 }, (_, i) => 3 + 2 * i); // 3, 5, ... 25
    expect(sets.single_bar_heavy).toEqual(expected);
    expect(sets.single_bar_heavy.every((v) => Number.isInteger(v))).toBe(true);
    expect(sets.single_bar_heavy).not.toContain(3.5);
  });

  it("produces sets with no floating-point artifacts", () => {
    for (const set of Object.values(sets)) {
      for (const value of set) {
        expect(value).toBe(round1(value));
      }
    }
  });

  it("produces ascending, deduplicated sets", () => {
    for (const set of Object.values(sets)) {
      const sorted = [...set].sort((a, b) => a - b);
      expect(set).toEqual(sorted);
      expect(new Set(set).size).toBe(set.length);
    }
  });
});

describe("computeAchievableLoadsPerImplement — the sets are DERIVED, not hardcoded", () => {
  // The rule is binding: derive the sets in code from the raw inventory, never
  // hardcode the flat lists. Every other test here asserts the sets for ONE
  // inventory, so replacing the enumeration with literal arrays would keep them
  // green and silently destroy the rule's whole purpose. Feeding a different
  // inventory in is what catches that.
  const withOnlyFivesStock = computeAchievableLoadsPerImplement({
    ...TEST_INVENTORY,
    plateStock: [{ weightKg: 5, count: 4 }],
  });

  it("follows a changed plate stock on the single bar (2 plates per step: 3, 13, 23 kg)", () => {
    expect(withOnlyFivesStock.single_bar_heavy).toEqual([3, 13, 23]);
  });

  it("follows a changed plate stock on the dual bars (4 plates per step: 3, 13 kg)", () => {
    expect(withOnlyFivesStock.dual_bar_symmetric).toEqual([3, 13]);
  });

  it("follows a changed empty-bar weight", () => {
    const heavierBar = computeAchievableLoadsPerImplement({
      ...TEST_INVENTORY,
      plateStock: [{ weightKg: 5, count: 4 }],
      barEmptyKg: 10,
    });
    expect(heavierBar.single_bar_heavy).toEqual([10, 20, 30]);
  });

  it("follows a changed dumbbell rack", () => {
    const otherDumbbells = computeAchievableLoadsPerImplement({
      ...TEST_INVENTORY,
      dumbbellOptionsKg: [3, 6, 12],
    });
    expect(otherDumbbells.dumbbell).toEqual([3, 6, 12]);
  });

  it("gives no dual-bar set with fewer than two bars, and no bar set with none", () => {
    const oneBar = computeAchievableLoadsPerImplement({ ...TEST_INVENTORY, barCount: 1 });
    expect(oneBar.dual_bar_symmetric).toEqual([]);
    expect(oneBar.single_bar_heavy.length).toBeGreaterThan(0);
    const noBar = computeAchievableLoadsPerImplement({ ...TEST_INVENTORY, barCount: 0 });
    expect(noBar.single_bar_heavy).toEqual([]);
  });
});

describe("STARTER_INVENTORY", () => {
  it("is valid and derives non-empty load sets", () => {
    expect(validateInventory(STARTER_INVENTORY).ok).toBe(true);
    const views = buildInventoryViews(undefined);
    expect(views.isStarter).toBe(true);
    expect(views.perHandUnion.length).toBeGreaterThan(0);
    expect(views.achievable.dual_bar_symmetric.length).toBeGreaterThan(0);
  });

  it("is not the test inventory (the starter can be retuned without moving any exact-load test)", () => {
    expect(STARTER_INVENTORY.dumbbellOptionsKg).not.toEqual(TEST_INVENTORY.dumbbellOptionsKg);
  });
});

describe("buildInventoryViews", () => {
  it("equals the confirmed union of dumbbell and dual_bar_symmetric for the test inventory", () => {
    expect(INV.perHandUnion).toEqual([3, 5, 6, 9, 11, 12, 13, 15, 18]);
  });

  it("is data only, so it survives a JSON round trip", () => {
    expect(JSON.parse(JSON.stringify(INV))).toEqual(INV);
  });

  it("lists as unavailable at home exactly the vocabulary the user does not own", () => {
    expect([...INV.unavailableAtHome].sort()).toEqual(["bench", "elastic_upper", "kettlebell", "machine", "pulley", "rack"]);
    const withBench = buildInventoryViews({ ...TEST_INVENTORY, owned: [...TEST_INVENTORY.owned, "bench"] });
    expect(withBench.unavailableAtHome).not.toContain("bench");
  });

  it("is not marked as the starter once an inventory was given", () => {
    expect(INV.isStarter).toBe(false);
  });
});

describe("normalizeInventory", () => {
  it("reads null and undefined as 'not said yet' (the starter)", () => {
    expect(normalizeInventory(null).isStarter).toBe(true);
    expect(normalizeInventory(undefined).isStarter).toBe(true);
  });

  it("never fills a damaged document from the starter: a missing field is empty", () => {
    const out = normalizeInventory({ dumbbellOptionsKg: [4, -1, "x", 6] });
    expect(out.dumbbellOptionsKg).toEqual([4, 6]);
    expect(out.plateStock).toEqual([]);
    expect(out.owned).toEqual([]);
    expect(out.barCount).toBe(0);
  });
});

describe("validateInventory", () => {
  it("accepts the test inventory and the starter", () => {
    expect(validateInventory(TEST_INVENTORY)).toEqual({ ok: true, errors: [] });
    expect(validateInventory(STARTER_INVENTORY).ok).toBe(true);
  });

  it.each([
    ["not an object", "x"],
    ["an array", []],
    ["a negative dumbbell", { ...TEST_INVENTORY, dumbbellOptionsKg: [-2] }],
    ["a non-numeric dumbbell", { ...TEST_INVENTORY, dumbbellOptionsKg: ["2"] }],
    ["too many dumbbells", { ...TEST_INVENTORY, dumbbellOptionsKg: Array.from({ length: 41 }, (_, i) => i + 1) }],
    ["a fractional bar count", { ...TEST_INVENTORY, barCount: 1.5 }],
    ["a negative plate count", { ...TEST_INVENTORY, plateStock: [{ weightKg: 5, count: -1 }] }],
    ["a malformed plate", { ...TEST_INVENTORY, plateStock: [null] }],
    ["an unknown equipment token", { ...TEST_INVENTORY, owned: ["jetpack"] }],
    ["an absurd load", { ...TEST_INVENTORY, ankleWeightKg: 9999 }],
  ])("rejects %s with a message", (_label, doc) => {
    const out = validateInventory(doc);
    expect(out.ok).toBe(false);
    expect(out.errors.length).toBeGreaterThan(0);
  });

  it("never throws, whatever it is given", () => {
    for (const doc of [undefined, null, 0, "", { owned: 5 }]) {
      expect(() => validateInventory(doc)).not.toThrow();
    }
  });
});

describe("generateEquipmentLines", () => {
  const lines = generateEquipmentLines(TEST_INVENTORY);

  it("returns an array of French user-facing lines", () => {
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    lines.forEach((line) => expect(typeof line).toBe("string"));
  });

  it("states the heaviest dumbbell of THIS inventory", () => {
    expect(lines.join(" ")).toContain("18kg");
    expect(generateEquipmentLines({ ...TEST_INVENTORY, dumbbellOptionsKg: [3, 20] }).join(" ")).toContain("20kg");
  });

  it("mentions ankle weights, hip elastics and the chair only when they are owned", () => {
    const joined = lines.join(" ");
    expect(joined).toContain("Lests cheville");
    expect(joined.toLowerCase()).toContain("hanches");
    expect(joined).toContain("Chaise");
    const bare = generateEquipmentLines({ ...TEST_INVENTORY, owned: ["dumbbell"], barCount: 0, ankleWeightKg: 0 }).join(" ");
    expect(bare).not.toContain("Lests");
    expect(bare).not.toContain("Chaise");
    expect(bare).not.toContain("barres");
  });

  it("lists the pull-up bar when owned", () => {
    expect(lines.some((line) => /barre de traction/i.test(line))).toBe(true);
  });

  it("accepts a views object as well as a raw document", () => {
    expect(generateEquipmentLines(INV)).toEqual(lines);
  });
});

describe("EQUIPMENT_LABELS_FR / describeHomeBlockers", () => {
  it("labels every vocabulary token, so no raw token can leak into a French message", () => {
    for (const token of EQUIPMENT_VOCABULARY) {
      expect(typeof EQUIPMENT_LABELS_FR[token]).toBe("string");
      expect(EQUIPMENT_LABELS_FR[token].length).toBeGreaterThan(0);
    }
  });

  it("names only the equipment that is unavailable at home", () => {
    expect(describeHomeBlockers(["bench", "dumbbell"], INV)).toEqual([EQUIPMENT_LABELS_FR.bench]);
    expect(describeHomeBlockers(["elastic_upper"], INV)).toEqual([EQUIPMENT_LABELS_FR.elastic_upper]);
  });

  it("returns nothing for a home-legal exercise's needs", () => {
    expect(describeHomeBlockers([], INV)).toEqual([]);
    expect(describeHomeBlockers(["dumbbell", "chair", "elastic_hips"], INV)).toEqual([]);
  });

  it("follows the inventory: owning a bench stops it being a blocker", () => {
    const withBench = buildInventoryViews({ ...TEST_INVENTORY, owned: [...TEST_INVENTORY.owned, "bench"] });
    expect(describeHomeBlockers(["bench"], withBench)).toEqual([]);
  });

  it("never throws on a missing or malformed needs list", () => {
    expect(describeHomeBlockers(undefined, INV)).toEqual([]);
    expect(describeHomeBlockers(null, INV)).toEqual([]);
  });
});

describe("LOCATIONS", () => {
  it("lists exactly maison and salle", () => {
    expect(LOCATIONS).toEqual(["maison", "salle"]);
  });
});

describe("deriveLocations", () => {
  // Takes the exercise's implement SET (an array), not a single type — an
  // exercise can be loaded with more than one implement.
  it("allows a bodyweight/dumbbell exercise at home only", () => {
    expect(deriveLocations([], ["bodyweight"], INV)).toEqual(["maison"]);
    expect(deriveLocations(["dumbbell"], BILATERAL_HAND_IMPLEMENTS, INV)).toEqual(["maison"]);
  });

  it("allows a cardio exercise at the gym only when it needs a machine", () => {
    expect(deriveLocations(["machine"], ["cardio"], INV)).toEqual(["salle"]);
  });

  it("allows a cardio exercise with no equipment needs at both locations", () => {
    expect(deriveLocations([], ["cardio"], INV)).toEqual(["maison", "salle"]);
  });

  it("allows an exercise nowhere when it needs equipment the user lacks and isn't cardio", () => {
    expect(deriveLocations(["bench"], BILATERAL_HAND_IMPLEMENTS, INV)).toEqual([]);
    expect(deriveLocations(["elastic_upper"], ["elastic"], INV)).toEqual([]);
  });

  it("FOLLOWS THE INVENTORY: the same exercise is home-legal once the user owns the bench", () => {
    const withBench = buildInventoryViews({ ...TEST_INVENTORY, owned: [...TEST_INVENTORY.owned, "bench"] });
    expect(deriveLocations(["bench"], BILATERAL_HAND_IMPLEMENTS, withBench)).toEqual(["maison"]);
    const withoutChair = buildInventoryViews({ ...TEST_INVENTORY, owned: ["dumbbell"] });
    expect(deriveLocations(["chair"], ["bodyweight"], withoutChair)).toEqual([]);
  });

  it("treats elastic_hips as home-legal, unlike elastic_upper", () => {
    expect(deriveLocations(["elastic_hips"], ["elastic"], INV)).toEqual(["maison"]);
  });

  it("never throws on a missing implement set", () => {
    expect(deriveLocations([], undefined, INV)).toEqual(["maison"]);
  });
});

describe("implement sets", () => {
  it("encodes the general rule: one implement per hand, or a single hand-held implement", () => {
    expect(BILATERAL_HAND_IMPLEMENTS).toEqual(["dumbbell", "dual_bar_symmetric"]);
    expect(SINGLE_HAND_HELD_IMPLEMENTS).toEqual(["dumbbell", "single_bar_heavy"]);
  });

  it("draws only from the implement-type vocabulary, and is frozen (the sets are shared by reference)", () => {
    for (const set of [BILATERAL_HAND_IMPLEMENTS, SINGLE_HAND_HELD_IMPLEMENTS]) {
      for (const type of set) expect(IMPLEMENT_TYPES).toContain(type);
      expect(Object.isFrozen(set)).toBe(true);
    }
  });
});

describe("pullup_bar", () => {
  it("is a known equipment token with a French label", () => {
    expect(EQUIPMENT_VOCABULARY).toContain("pullup_bar");
    expect(EQUIPMENT_LABELS_FR.pullup_bar).toBe("une barre de traction");
  });

  it("is available at home when owned, so it does not block a location", () => {
    expect(INV.unavailableAtHome).not.toContain("pullup_bar");
    expect(describeHomeBlockers(["pullup_bar"], INV)).toEqual([]);
    expect(deriveLocations(["pullup_bar"], ["bodyweight"], INV)).toEqual(["maison"]);
  });
});
