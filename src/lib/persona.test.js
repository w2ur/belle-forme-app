import { describe, it, expect } from "vitest";
import { resolvePersona, needsProfileSetup, GENDERS, NAME_MAX_CHARS } from "./persona.js";

describe("resolvePersona", () => {
  it("uses the profile's name and agrees with its gender", () => {
    expect(resolvePersona({ name: "Noa", gender: "m" })).toMatchObject({
      name: "Noa", gender: "m", she: "il", She: "Il", her: "lui", self: "lui-même", la: "le", e: "",
    });
    expect(resolvePersona({ name: "Noa", gender: "f" })).toMatchObject({
      name: "Noa", gender: "f", she: "elle", She: "Elle", her: "elle", self: "elle-même", la: "la", e: "e",
    });
  });

  // The prompt was written in the feminine and a profile saved before the field
  // existed must keep the coach's voice, not flip it.
  it("agrees in the feminine when the gender is absent or unknown", () => {
    for (const profile of [undefined, null, {}, { name: "Noa" }, { gender: "" }, { gender: "x" }]) {
      expect(resolvePersona(profile).she).toBe("elle");
    }
  });

  it("names the person neutrally when there is no name, in the gender's own grammar", () => {
    expect(resolvePersona({ gender: "f" }).name).toBe("l'utilisatrice");
    expect(resolvePersona({ gender: "m" }).name).toBe("l'utilisateur");
    expect(resolvePersona({ name: "   " }).name).toBe("l'utilisatrice");
  });

  it("trims the name and bounds free text read from a stored document", () => {
    expect(resolvePersona({ name: "  Noa  " }).name).toBe("Noa");
    expect(resolvePersona({ name: "x".repeat(500) }).name).toHaveLength(NAME_MAX_CHARS);
    expect(resolvePersona({ name: 42 }).name).toBe("l'utilisatrice");
    expect(resolvePersona({ coachNotes: "  note  " }).coachNotes).toBe("note");
    expect(resolvePersona({ coachNotes: "x".repeat(10_000) }).coachNotes.length).toBeLessThanOrEqual(4000);
    expect(resolvePersona({ coachNotes: { not: "text" } }).coachNotes).toBe("");
  });

  it("exposes exactly the two genders the prompt can agree with", () => {
    expect(GENDERS).toEqual(["f", "m"]);
  });
});

describe("needsProfileSetup", () => {
  it("is true until the profile has a name", () => {
    expect(needsProfileSetup(undefined)).toBe(true);
    expect(needsProfileSetup({})).toBe(true);
    expect(needsProfileSetup({ name: "" })).toBe(true);
    expect(needsProfileSetup({ name: "   " })).toBe(true);
    expect(needsProfileSetup({ name: "Noa" })).toBe(false);
  });

  // A profile saved before the gender existed is complete: it must not be sent
  // back to the setup form.
  it("does not ask an existing, named profile to set up again", () => {
    expect(needsProfileSetup({ name: "Noa", age: 30 })).toBe(false);
  });
});
