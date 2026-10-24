import { describe, it, expect } from "vitest";
import { writeErrorStatus, parseBody } from "../functions/lib/writeError.js";

const pg = (code) => Object.assign(new Error("pg"), { code });

describe("writeErrorStatus", () => {
  it("answers 400 for SQLSTATE classes 22 and 23 — the payload will fail again", () => {
    for (const code of ["22001", "22007", "22P02", "23502", "23505", "23514"]) {
      expect(writeErrorStatus(pg(code)), code).toBe(400);
    }
  });

  it("answers 500 for everything that says nothing about the payload", () => {
    for (const e of [pg("08006"), pg("57P01"), pg("40001"), new Error("fetch failed"), new TypeError("x"), undefined, { code: 23505 }]) {
      expect(writeErrorStatus(e)).toBe(500);
    }
  });
});

describe("parseBody", () => {
  it("returns the object, or null for anything that is not a JSON object", () => {
    expect(parseBody('{"a":1}')).toEqual({ a: 1 });
    for (const raw of ["{", "null", "[1]", "3", "", null, undefined]) expect(parseBody(raw), String(raw)).toBeNull();
  });
});
