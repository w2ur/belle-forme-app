/**
 * The schema travels on the REQUEST, and only on one kind of request.
 *
 * Probed live 2026-08-10 against both ladder rungs, streaming: `json_schema`
 * with `strict: true` produced a valid plan first try on `mistral-large-2512`
 * and on `mistral-small-2603`, while `json_object` failed on both. So the
 * wrapper's exact shape — `strict`, and the name the schema is registered
 * under — is the difference between a plan that imports and one that does not,
 * which is why it is asserted rather than assumed.
 */
import { describe, it, expect } from "vitest";
import { buildRequest } from "../functions/lib/providers.js";
import { PLAN_JSON_SCHEMA, PLAN_SCHEMA_NAME } from "../../src/lib/planSchema.js";

const entry = { model: "mistral-large-2512" };
const messages = [{ role: "user", content: "salut" }];

describe("buildRequest", () => {
  it("omits response_format when none is asked for", () => {
    const body = JSON.parse(buildRequest(entry, messages).body);
    expect(body.response_format).toBeUndefined();
  });

  it("attaches the strict json_schema wrapper when asked", () => {
    const responseFormat = {
      type: "json_schema",
      json_schema: { name: PLAN_SCHEMA_NAME, schema: PLAN_JSON_SCHEMA, strict: true },
    };
    const body = JSON.parse(buildRequest(entry, messages, { responseFormat }).body);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.name).toBe("fittrack_plan");
    // The schema itself has to survive the round trip through JSON.stringify —
    // a wrapper carrying no schema is accepted by the API and enforces nothing.
    expect(body.response_format.json_schema.schema).toEqual(PLAN_JSON_SCHEMA);
  });

  it("keeps streaming and usage reporting on, which the schema must not disturb", () => {
    const body = JSON.parse(buildRequest(entry, messages, { responseFormat: { type: "json_object" } }).body);
    expect(body.stream).toBe(true);
    expect(body.stream_options.include_usage).toBe(true);
  });
});
