// A synthetic profile for the backend tests: a made-up person and the fixed
// test inventory, so exact-load assertions do not depend on anyone's real kit.
import { TEST_INVENTORY } from "../../src/constants/testInventory.js";

export const TEST_PROFILE = Object.freeze({
  name: "Camille",
  gender: "f",
  age: 30,
  height: 170,
  weight: 65,
  coachNotes: "",
  cycle: Object.freeze({ enabled: false, lengthDays: 28 }),
  inventory: TEST_INVENTORY,
});
