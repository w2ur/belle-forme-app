import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createNotebookSplitter } from "../functions/lib/notebookStream.js";

// Text fragments that never contain "<" so they can't form a partial sentinel.
const safe = fc.string().filter((s) => !s.includes("<"));

/** Feeds `full` through a fresh splitter in `sizes`-driven chunks. */
function drain(full, sizes) {
  const s = createNotebookSplitter();
  let out = "", i = 0, k = 0;
  while (i < full.length) {
    const len = sizes[k++ % sizes.length];
    out += s.push(full.slice(i, i + len));
    i += len;
  }
  out += s.end();
  return { out, notebook: s.notebook() };
}

const chunking = fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1 });

describe("notebookStream properties", () => {
  // The block is an INTERRUPTION in the visible text, not a terminator: what
  // surrounds it is the answer, and both sides must survive any chunking.
  it("forwards everything outside the block and captures exactly the block body", () => {
    fc.assert(
      fc.property(safe, safe, safe, chunking, (pre, nb, post, sizes) => {
        const { out, notebook } = drain(`${pre}<<<NOTEBOOK>>>${nb}<<<END>>>${post}`, sizes);
        expect(out).toBe(pre + post);
        expect(notebook).toBe(nb.trim());
      }),
      { numRuns: 300 },
    );
  });

  // A block that never closes is not a notebook. Its caller overwrites the
  // stored notebook wholesale, so reporting a fragment would destroy real
  // memory — and a fragment is exactly what a cut-off reply leaves behind.
  it("reports no notebook for a block that never closes, for any chunking", () => {
    fc.assert(
      fc.property(safe, safe, chunking, (pre, partial, sizes) => {
        const { out, notebook } = drain(`${pre}<<<NOTEBOOK>>>${partial}`, sizes);
        expect(out).toBe(pre);
        expect(notebook).toBeNull();
      }),
      { numRuns: 200 },
    );
  });

  it("forwards all text and captures null when there is no block", () => {
    fc.assert(
      fc.property(safe, fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1 }), (text, sizes) => {
        const s = createNotebookSplitter();
        let out = "", i = 0, k = 0;
        while (i < text.length) {
          const len = sizes[k++ % sizes.length];
          out += s.push(text.slice(i, i + len));
          i += len;
        }
        out += s.end();
        expect(out).toBe(text);
        expect(s.notebook()).toBeNull();
      }),
      { numRuns: 200 },
    );
  });
});
