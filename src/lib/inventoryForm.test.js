import { describe, it, expect } from "vitest";
import { inventoryToDraft, inventoryFromDraft } from "./inventoryForm.js";
import { STARTER_INVENTORY, validateInventory } from "../constants/equipment.js";
import { TEST_INVENTORY } from "../constants/testInventory.js";

describe("inventoryToDraft", () => {
  it("renders numbers the French way, lists with ', ', plates as poids x quantité", () => {
    const draft = inventoryToDraft(TEST_INVENTORY);
    expect(draft.dumbbells).toBe("3, 6, 9, 12, 15, 18");
    expect(draft.plates).toBe("4x4, 1x6");
    expect(draft.barEmptyKg).toBe("3");
    expect(draft.barCount).toBe("2");
    expect([...draft.owned].sort()).toEqual([...TEST_INVENTORY.owned].sort());
  });

  it("shows the starter inventory when none was saved", () => {
    expect(inventoryToDraft(null).dumbbells).toBe(inventoryToDraft(STARTER_INVENTORY).dumbbells);
    expect(inventoryToDraft(undefined).barCount).toBe(String(STARTER_INVENTORY.barCount));
  });
});

describe("inventoryFromDraft", () => {
  it("round-trips an inventory without changing a number", () => {
    const { inventory, errors } = inventoryFromDraft(inventoryToDraft(TEST_INVENTORY));
    expect(errors).toEqual([]);
    expect({ ...inventory, owned: [...inventory.owned].sort() }).toEqual({
      ...TEST_INVENTORY,
      dumbbellOptionsKg: [...TEST_INVENTORY.dumbbellOptionsKg],
      plateStock: TEST_INVENTORY.plateStock.map((p) => ({ ...p })),
      owned: [...TEST_INVENTORY.owned].sort(),
    });
    expect(validateInventory(inventory).ok).toBe(true);
  });

  // « 2,5 » is one dumbbell. Splitting on every comma would read it as 2 and 5
  // and the user would save an inventory they never typed.
  it("reads a decimal comma as a decimal, and ', ' ';' or spaces as list separators", () => {
    const parse = (dumbbells) => inventoryFromDraft({ ...inventoryToDraft(TEST_INVENTORY), dumbbells }).inventory?.dumbbellOptionsKg;
    expect(parse("2,5, 4")).toEqual([2.5, 4]);
    expect(parse("2,5; 4")).toEqual([2.5, 4]);
    expect(parse("2.5 4")).toEqual([2.5, 4]);
  });

  it("refuses an unreadable entry instead of dropping or guessing it", () => {
    const base = inventoryToDraft(TEST_INVENTORY);
    expect(inventoryFromDraft({ ...base, dumbbells: "2, abc" })).toMatchObject({ inventory: null });
    expect(inventoryFromDraft({ ...base, dumbbells: "2,5,4" }).inventory).toBeNull();
    expect(inventoryFromDraft({ ...base, plates: "5-4" }).inventory).toBeNull();
    expect(inventoryFromDraft({ ...base, plates: "5x" }).inventory).toBeNull();
    expect(inventoryFromDraft({ ...base, barCount: "" }).inventory).toBeNull();
    expect(inventoryFromDraft({ ...base, ankleWeightKg: "lourd" }).errors.length).toBeGreaterThan(0);
  });

  it("applies the same write-time rules as the server", () => {
    const base = inventoryToDraft(TEST_INVENTORY);
    expect(inventoryFromDraft({ ...base, barCount: "-1" }).inventory).toBeNull();
    expect(inventoryFromDraft({ ...base, dumbbells: "-3" }).inventory).toBeNull();
    expect(inventoryFromDraft({ ...base, barCount: "1.5" }).inventory).toBeNull();
  });

  it("accepts an empty rack and no plates (a user with bodyweight only)", () => {
    const { inventory, errors } = inventoryFromDraft({
      ...inventoryToDraft(TEST_INVENTORY), dumbbells: "", plates: "", barCount: "0", owned: [],
    });
    expect(errors).toEqual([]);
    expect(inventory.dumbbellOptionsKg).toEqual([]);
    expect(inventory.plateStock).toEqual([]);
  });

  it("keeps the equipment tokens in vocabulary order and drops unknown ones", () => {
    const { inventory } = inventoryFromDraft({ ...inventoryToDraft(TEST_INVENTORY), owned: ["chair", "jetpack", "dumbbell"] });
    expect(inventory.owned).toEqual(["chair", "dumbbell"]);
  });
});
