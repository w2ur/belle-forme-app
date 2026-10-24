/**
 * A fixed inventory for tests: exact-load assertions (« 12 kg/main is the next
 * step after 7 ») need numbers that do not move when the starter inventory is
 * retuned. Invented round numbers, chosen to differ from the starter inventory
 * in every value; not anyone's equipment.
 */
export const TEST_INVENTORY = Object.freeze({
  dumbbellOptionsKg: Object.freeze([3, 6, 9, 12, 15, 18]),
  barEmptyKg: 3,
  barCount: 2,
  plateStock: Object.freeze([
    Object.freeze({ weightKg: 4, count: 4 }),
    Object.freeze({ weightKg: 1, count: 6 }),
  ]),
  ankleWeightKg: 1,
  owned: Object.freeze(["dumbbell", "bar", "ankle_weight", "pullup_bar", "elastic_hips", "chair"]),
});
