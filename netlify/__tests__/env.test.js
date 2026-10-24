import { describe, it, expect, afterEach } from "vitest";
import { env } from "../functions/lib/env.js";

afterEach(() => {
  delete globalThis.Netlify;
  delete process.env.BF_TEST_KEY;
});

describe("env", () => {
  it("reads from process.env when that is all there is (Node functions, tests)", () => {
    process.env.BF_TEST_KEY = "from-process";
    expect(env("BF_TEST_KEY")).toBe("from-process");
  });

  // The edge runtime is Deno: `process` is not defined there, and reading
  // `process.env.MISTRAL_API_KEY` throws a ReferenceError on the first request
  // rather than returning undefined. Every rung of the ladder then answers 401
  // and the user reads one generic "coach indisponible".
  it("reads from Netlify.env when process is absent, without touching process", () => {
    const realProcess = globalThis.process;
    globalThis.Netlify = { env: { get: (n) => (n === "BF_TEST_KEY" ? "from-netlify" : undefined) } };
    try {
      delete globalThis.process;
      expect(env("BF_TEST_KEY")).toBe("from-netlify");
    } finally {
      globalThis.process = realProcess;
    }
  });

  it("prefers Netlify.env, which is the one populated in both runtimes on Netlify", () => {
    process.env.BF_TEST_KEY = "from-process";
    globalThis.Netlify = { env: { get: () => "from-netlify" } };
    expect(env("BF_TEST_KEY")).toBe("from-netlify");
  });

  it("falls through to process.env when Netlify.env has no value for the name", () => {
    process.env.BF_TEST_KEY = "from-process";
    globalThis.Netlify = { env: { get: () => undefined } };
    expect(env("BF_TEST_KEY")).toBe("from-process");
  });

  it("returns undefined for a name neither runtime knows", () => {
    expect(env("BF_DEFINITELY_UNSET")).toBeUndefined();
  });
});
