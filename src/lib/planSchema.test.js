import { describe, it, expect } from "vitest";
import { PLAN_JSON_SCHEMA, PLAN_SCHEMA_NAME, buildPlanJsonSchema } from "./planSchema.js";

/** Every object node in a strict JSON schema must list all its props as required. */
function walkObjects(node, path, visit) {
  if (!node || typeof node !== "object") return;
  if (node.type === "object") visit(node, path);
  if (node.type === "array") walkObjects(node.items, `${path}[]`, visit);
  for (const [key, child] of Object.entries(node.properties || {})) {
    walkObjects(child, `${path}.${key}`, visit);
  }
}

describe("PLAN_JSON_SCHEMA", () => {
  it("is named for the response_format wrapper", () => {
    expect(PLAN_SCHEMA_NAME).toBe("fittrack_plan");
  });

  it("satisfies Mistral strict mode at every object level", () => {
    const offenders = [];
    walkObjects(PLAN_JSON_SCHEMA, "$", (node, path) => {
      if (node.additionalProperties !== false) offenders.push(`${path}: additionalProperties`);
      const props = Object.keys(node.properties || {}).sort();
      const required = [...(node.required || [])].sort();
      if (JSON.stringify(props) !== JSON.stringify(required)) {
        offenders.push(`${path}: required ${required} != properties ${props}`);
      }
    });
    expect(offenders).toEqual([]);
  });

  // Probed live 2026-08-16 (see buildPlanJsonSchema): minItems IS enforced by
  // Mistral strict mode, and that is exactly why it must stay off. Under
  // `minItems: 1` a model asked for a rest day returned a junk placeholder
  // rather than an empty array — and with the name enum it would have to insert
  // a REAL exercise, which no validator can catch.
  it("puts no minItems on the exercise list, so an empty session stays visible", () => {
    expect(PLAN_JSON_SCHEMA.properties.sessions.items.properties.exercises.minItems)
      .toBeUndefined();
  });

  it("carries every field the app's plan consumers read", () => {
    const ex = PLAN_JSON_SCHEMA.properties.sessions.items.properties.exercises.items;
    expect(Object.keys(ex.properties).sort()).toEqual([
      "name", "progressionNote", "reps", "restSeconds", "setsCount", "weight", "weightType",
    ]);
    expect(ex.properties.weightType.enum).toEqual(["total", "per_hand"]);
  });

  it("does not let the model author the derived sets display string", () => {
    const ex = PLAN_JSON_SCHEMA.properties.sessions.items.properties.exercises.items;
    expect(ex.properties.sets).toBeUndefined();
  });

  it("carries the notebook so it never rides in visible text", () => {
    expect(PLAN_JSON_SCHEMA.properties.notebook.type).toBe("string");
  });
});

describe("buildPlanJsonSchema", () => {
  const nameNode = (schema) =>
    schema.properties.sessions.items.properties.exercises.items.properties.name;

  it("pins the exercise name to the offered catalog names", () => {
    const schema = buildPlanJsonSchema(["Squat", "Dead hang"]);
    expect(nameNode(schema).type).toBe("string");
    expect(nameNode(schema).enum).toEqual(["Squat", "Dead hang"]);
  });

  // An empty enum is not rejected by the API — probed live 2026-08-16, it
  // returns 200 and the model answers with ZERO exercises, because that is the
  // only output an impossible name constraint permits. So the fallback is not
  // defensive tidiness: without it, a catalog that arrived empty would produce
  // a plan of empty sessions rather than a visible failure.
  it("falls back to a plain string rather than an impossible enum", () => {
    for (const bad of [[], null, undefined, "Squat", 42, {}]) {
      const schema = buildPlanJsonSchema(bad);
      expect(nameNode(schema).enum, String(bad)).toBeUndefined();
      expect(nameNode(schema).type, String(bad)).toBe("string");
    }
  });

  it("never mutates the shared PLAN_JSON_SCHEMA", () => {
    buildPlanJsonSchema(["Squat"]);
    expect(nameNode(PLAN_JSON_SCHEMA).enum).toBeUndefined();
    expect(nameNode(PLAN_JSON_SCHEMA).type).toBe("string");
  });

  it("copies the name list, so a later mutation of the caller's array cannot reach the schema", () => {
    const names = ["Squat"];
    const schema = buildPlanJsonSchema(names);
    names.push("Hip thrust"); // a forbiddenNames entry — must never become emittable
    expect(nameNode(schema).enum).toEqual(["Squat"]);
  });

  it("leaves every other field of the schema alone", () => {
    const schema = buildPlanJsonSchema(["Squat"]);
    const ex = schema.properties.sessions.items.properties.exercises.items;
    expect(Object.keys(ex.properties).sort()).toEqual([
      "name", "progressionNote", "reps", "restSeconds", "setsCount", "weight", "weightType",
    ]);
    expect(ex.properties.weightType.enum).toEqual(["total", "per_hand"]);
    expect(schema.properties.notebook.type).toBe("string");
    expect(schema.properties.sessions.items.properties.exercises.minItems).toBeUndefined();
  });

  it("still satisfies Mistral strict mode at every object level", () => {
    const offenders = [];
    walkObjects(buildPlanJsonSchema(["Squat", "Dead hang"]), "$", (node, path) => {
      if (node.additionalProperties !== false) offenders.push(`${path}: additionalProperties`);
      const props = Object.keys(node.properties || {}).sort();
      const required = [...(node.required || [])].sort();
      if (JSON.stringify(props) !== JSON.stringify(required)) {
        offenders.push(`${path}: required ${required} != properties ${props}`);
      }
    });
    expect(offenders).toEqual([]);
  });
});
