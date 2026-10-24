import { describe, it, expect } from "vitest";
import { toDraft, fromDraft, filledProfileFields, toEditDraft, fromEditDraft } from "./profileForm.js";
import { TEST_INVENTORY } from "../constants/testInventory.js";

describe("profileForm", () => {
  // Regression: b09a0f8 — age/height/weight were saved as strings
  it("coerces numeric fields to numbers", () => {
    expect(fromDraft({ age: "34" }).age).toBe(34);
    expect(fromDraft({ height: "172.5" }).height).toBe(172.5);
  });

  // Regression: b09a0f8 — an emptied field must not become 0
  it("maps an empty or invalid numeric field to null, not 0", () => {
    expect(fromDraft({ weight: "" }).weight).toBeNull();
    expect(fromDraft({ weight: "abc" }).weight).toBeNull();
  });

  it("leaves text fields and absent numeric fields alone", () => {
    const out = fromDraft({ name: "Camille" });
    expect(out).toEqual({ name: "Camille" });
  });

  it("toDraft copies, so editing the draft never mutates the profile", () => {
    const profile = { name: "Camille", equipment: ["a"] };
    const draft = toDraft(profile);
    draft.name = "X";
    expect(profile.name).toBe("Camille");
  });
});

describe("filledProfileFields", () => {
  const render = { name: (v) => `${v}`, age: (v) => `${v} ans`, frequency: (v) => `Fréquence : ${v}` };

  it("renders the filled fields in the order given", () => {
    expect(filledProfileFields({ frequency: "3x", age: 34, name: "Camille" }, render)).toEqual([
      "Camille", "34 ans", "Fréquence : 3x",
    ]);
  });

  it("skips null, missing and blank fields, and keeps a real 0", () => {
    expect(filledProfileFields({ name: null, age: 0, frequency: "" }, render)).toEqual(["0 ans"]);
    expect(filledProfileFields({}, render)).toEqual([]);
    expect(filledProfileFields(null, render)).toEqual([]);
  });

  // Regression: 4857643 — whitespace counted as filled and was printed as is.
  it("trims a string for the test and for what is printed", () => {
    expect(filledProfileFields({ name: "   ", frequency: "  3x  " }, render)).toEqual(["Fréquence : 3x"]);
  });
});

describe("toEditDraft / fromEditDraft", () => {
  const profile = {
    name: "Noa", gender: "m", age: 30, height: 170, weight: 65,
    coachNotes: "courtes", cycle: { enabled: true, lengthDays: 27 }, inventory: TEST_INVENTORY,
  };

  it("round-trips a complete profile", () => {
    const { profile: out, errors } = fromEditDraft(toEditDraft(profile));
    expect(errors).toEqual([]);
    expect(out).toMatchObject({
      name: "Noa", gender: "m", age: 30, coachNotes: "courtes", cycle: { enabled: true, lengthDays: 27 },
    });
    expect(out.inventory.dumbbellOptionsKg).toEqual([...TEST_INVENTORY.dumbbellOptionsKg]);
  });

  it("keeps the draft-only keys out of the saved profile", () => {
    const { profile: out } = fromEditDraft(toEditDraft(profile));
    for (const key of ["cycleEnabled", "cycleLengthDays", "inventoryDraft"]) expect(out).not.toHaveProperty(key);
  });

  // A profile saved before the gender existed shows what the coach already says;
  // a brand-new one shows nothing, so the choice has to be made.
  it("shows the feminine for a named profile without a gender, and no gender for a new one", () => {
    expect(toEditDraft({ name: "Noa" }).gender).toBe("f");
    expect(toEditDraft({ name: "" }).gender).toBe("");
    expect(toEditDraft(undefined).gender).toBe("");
  });

  it("requires a name and a gender, and returns no profile while anything is wrong", () => {
    const draft = toEditDraft({ ...profile, name: "  ", gender: "" });
    const out = fromEditDraft(draft);
    expect(out.profile).toBeNull();
    expect(out.errors).toEqual(expect.arrayContaining([expect.stringMatching(/prénom/), expect.stringMatching(/accord/)]));
  });

  it("trims the name", () => {
    const { profile: out } = fromEditDraft({ ...toEditDraft(profile), name: "  Noa  " });
    expect(out.name).toBe("Noa");
  });

  it("starts a new profile with the cycle off, at the default length", () => {
    const draft = toEditDraft(undefined);
    expect(draft.cycleEnabled).toBe(false);
    expect(draft.cycleLengthDays).toBe("28");
  });

  it("refuses an implausible cycle length only when the cycle is on", () => {
    const base = toEditDraft(profile);
    expect(fromEditDraft({ ...base, cycleEnabled: true, cycleLengthDays: "3" }).profile).toBeNull();
    expect(fromEditDraft({ ...base, cycleEnabled: false, cycleLengthDays: "3" }).profile).not.toBeNull();
  });

  it("surfaces an unreadable inventory entry and saves nothing", () => {
    const draft = toEditDraft(profile);
    draft.inventoryDraft.dumbbells = "2, abc";
    const out = fromEditDraft(draft);
    expect(out.profile).toBeNull();
    expect(out.errors.join(" ")).toMatch(/Haltères/);
  });
});
