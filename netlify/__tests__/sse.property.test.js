import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createSSEParser } from "../functions/lib/sse.js";

const line = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

/** Feeds `wire` through a fresh parser in `sizes`-driven slices, as a socket would. */
function drain(wire, sizes) {
  const p = createSSEParser();
  let out = "", i = 0, k = 0;
  while (i < wire.length) {
    const len = sizes[k++ % sizes.length];
    out += p.push(wire.slice(i, i + len));
    i += len;
  }
  return { out, thinkingChars: p.thinkingChars() };
}

// A thinking fragment carries a marker no text fragment can contain, so "the
// marker never reaches the output" is exactly "no thinking leaked".
const MARK = "☃";
const text = fc.string().filter((s) => !s.includes(MARK));
const thought = text.map((s) => MARK + s);

// One delta, in any of the shapes a stream may mix: a bare string, a thinking
// block, a text block, or one chunk holding both (the GLM 5.3 hand-over chunk).
const delta = fc.oneof(
  text.map((t) => ({ wire: t, visible: t, thinking: 0 })),
  thought.map((th) => ({ wire: [{ type: "thinking", thinking: [{ type: "text", text: th }], closed: true }], visible: "", thinking: th.length })),
  text.map((t) => ({ wire: [{ type: "text", text: t }], visible: t, thinking: 0 })),
  fc.tuple(thought, text).map(([th, t]) => ({
    wire: [{ type: "thinking", thinking: [{ type: "text", text: th }], closed: true }, { type: "text", text: t }],
    visible: t,
    thinking: th.length,
  }))
);
const sizes = fc.array(fc.integer({ min: 1, max: 64 }), { minLength: 1, maxLength: 8 });

describe("createSSEParser — properties", () => {
  // The parser change must not move a single byte for the models that never
  // sent blocks (Medium, Large): same output as concatenating the strings,
  // however the socket slices the wire.
  it("string-only streams come out byte-identical to their concatenation", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), sizes, (parts, sz) => {
        expect(drain(parts.map(line).join(""), sz).out).toBe(parts.join(""));
      }),
      { numRuns: 1000 }
    );
  });

  it("mixed streams yield exactly the text, never a character of thinking", () => {
    fc.assert(
      fc.property(fc.array(delta), sizes, (ds, sz) => {
        const { out, thinkingChars } = drain(ds.map((d) => line(d.wire)).join(""), sz);
        expect(out).toBe(ds.map((d) => d.visible).join(""));
        expect(out).not.toContain(MARK);
        expect(thinkingChars).toBe(ds.reduce((n, d) => n + d.thinking, 0));
      }),
      { numRuns: 1000 }
    );
  });
});
