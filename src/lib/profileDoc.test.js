import { describe, it, expect } from "vitest";
import { validateProfile } from "./profileDoc.js";
import { TEST_INVENTORY } from "../constants/testInventory.js";

const good = {
  name: "Noa", gender: "m", age: 30, coachNotes: "ok",
  cycle: { enabled: true, lengthDays: 28 }, inventory: TEST_INVENTORY,
};

describe("validateProfile", () => {
  it("accepts a complete profile", () => {
    expect(validateProfile(good)).toEqual({ ok: true, errors: [] });
  });

  // A profile saved by an older build has none of the new fields and carries
  // fields this build no longer reads. Refusing it would strand that device.
  it("accepts a legacy profile with unknown fields and none of the new ones", () => {
    expect(validateProfile({ name: "Noa", equipment: ["Haltères"], goals: "x", legacy: true }).ok).toBe(true);
    expect(validateProfile({}).ok).toBe(true);
  });

  it("accepts a null inventory (not said yet) and a cycle that is off with any length", () => {
    expect(validateProfile({ ...good, inventory: null }).ok).toBe(true);
    expect(validateProfile({ ...good, cycle: { enabled: false, lengthDays: "n'importe quoi" } }).ok).toBe(true);
  });

  it.each([
    ["not an object", "profile"],
    ["an array", []],
    ["null", null],
    ["a non-string name", { ...good, name: 5 }],
    ["an over-long name", { ...good, name: "x".repeat(41) }],
    ["an unknown gender", { ...good, gender: "x" }],
    ["over-long coach notes", { ...good, coachNotes: "x".repeat(4001) }],
    ["a cycle without its switch", { ...good, cycle: { lengthDays: 28 } }],
    ["a cycle that is on with an implausible length", { ...good, cycle: { enabled: true, lengthDays: 5 } }],
    ["a cycle that is on with a fractional length", { ...good, cycle: { enabled: true, lengthDays: 28.5 } }],
    ["an invalid inventory", { ...good, inventory: { ...TEST_INVENTORY, barCount: -1 } }],
  ])("rejects %s, with a message to show", (_label, doc) => {
    const out = validateProfile(doc);
    expect(out.ok).toBe(false);
    expect(out.errors.length).toBeGreaterThan(0);
    out.errors.forEach((message) => expect(typeof message).toBe("string"));
  });

  it("reports every problem, not only the first", () => {
    const out = validateProfile({ ...good, gender: "x", name: 5, cycle: { enabled: true, lengthDays: 1 } });
    expect(out.errors.length).toBeGreaterThanOrEqual(3);
  });
});
