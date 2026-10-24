import { describe, it, expect, beforeEach } from "vitest";
import { authorizeToken } from "../functions/lib/db.js";

describe("authorizeToken", () => {
  beforeEach(() => { process.env.SYNC_API_KEY = "secret-key"; });

  it("accepts a matching Bearer token", () => {
    expect(authorizeToken("Bearer secret-key")).toBe(true);
  });
  it("rejects a wrong token", () => {
    expect(authorizeToken("Bearer nope")).toBe(false);
  });
  it("rejects a missing/empty header", () => {
    expect(authorizeToken(undefined)).toBe(false);
    expect(authorizeToken("")).toBe(false);
    expect(authorizeToken("Bearer ")).toBe(false);
  });
  // Hardening 2026-09-30 review: the compare is constant-time. These pin the
  // boundary cases of the equal-length guard.
  it("rejects a token differing only in the last byte", () => {
    expect(authorizeToken("Bearer secret-kex")).toBe(false);
  });
  it("rejects a prefix and an extension of the key", () => {
    expect(authorizeToken("Bearer secret-ke")).toBe(false);
    expect(authorizeToken("Bearer secret-keyy")).toBe(false);
  });
  it("rejects every token when no key is configured", () => {
    delete process.env.SYNC_API_KEY;
    expect(authorizeToken("Bearer undefined")).toBe(false);
    expect(authorizeToken("Bearer secret-key")).toBe(false);
  });
});
