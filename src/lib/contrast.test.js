import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { relativeLuminance, contrastRatio, parseThemeColors } from "./contrast.js";

const css = readFileSync(fileURLToPath(new URL("../index.css", import.meta.url)), "utf8");
const COLORS = parseThemeColors(css);

/**
 * `gold` cannot carry TEXT (2.20:1 on --color-card, fails AA) — but `text-gold` is also the
 * idiomatic way to set `currentColor` on an SVG ornament, which isn't text at all. A regex can't
 * tell those apart; only a human reading the JSX can. So the guard below flags every `text-gold`
 * EXCEPT in the two files that use it for the `ArtDecoDivider` ornament (see ORNAMENT_ALLOWLIST).
 * Anything else using `text-gold` must still fail — see the "matches text-gold" self-test.
 */
const TEXT_GOLD_PATTERN = /\btext-gold\b(?!-)/;

/** Files where `text-gold` is a known, reviewed `currentColor` ornament use, not text. */
const ORNAMENT_ALLOWLIST = new Set(["App.jsx", "SideRail.jsx"]);

const SRC_DIR = fileURLToPath(new URL("../", import.meta.url));

/** Recursively collects .jsx source files under `dir`, skipping test files. */
function collectJsxFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = `${dir}${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...collectJsxFiles(`${fullPath}/`));
    } else if (entry.name.endsWith(".jsx") && !entry.name.endsWith(".test.jsx")) {
      files.push(fullPath);
    }
  }
  return files;
}

/** Every background a token can be read against. */
const GROUNDS = ["card", "primary", "surface", "nav"];

/** Tokens used as TEXT. `gold` is deliberately absent — it is ornament only. */
const TEXT_TOKENS = ["muted", "muted-dark", "muted-darker", "accent", "danger", "gold-text"];

/** Tokens used as a FILL behind white text. */
const WHITE_ON_FILL = ["accent", "danger"];

const AA_NORMAL = 4.5;

describe("relativeLuminance", () => {
  it("returns 0 for black and 1 for white", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 5);
  });
});

describe("contrastRatio", () => {
  it("is 21:1 for black on white and symmetric", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 2);
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 2);
  });

  it("is 1:1 for a colour against itself", () => {
    expect(contrastRatio("#5B8CA8", "#5B8CA8")).toBeCloseTo(1, 5);
  });
});

describe("parseThemeColors", () => {
  it("extracts every --color-* token from the @theme block", () => {
    const parsed = parseThemeColors("@theme {\n  --color-a: #AABBCC;\n  --font-sans: x;\n}");
    expect(parsed).toEqual({ a: "#AABBCC" });
  });

  it("returns an empty object when there is no @theme block", () => {
    expect(parseThemeColors("body { color: red; }")).toEqual({});
  });
});

describe("the shipped palette", () => {
  it("defines every token the app reads", () => {
    for (const token of [...TEXT_TOKENS, ...GROUNDS]) {
      expect(COLORS[token], `--color-${token} is missing from @theme`).toBeDefined();
    }
  });

  // The user reads these mid-effort, at arm's length, on a bright screen.
  it.each(TEXT_TOKENS)("text token %s meets AA on every ground", (token) => {
    for (const ground of GROUNDS) {
      const ratio = contrastRatio(COLORS[token], COLORS[ground]);
      expect(ratio, `--color-${token} on --color-${ground} is ${ratio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });

  // The gate's disabled submit sits on --color-border-light, a ground the loop above never
  // checks. Its label was muted-dark, 4.2:1 there; muted is what it uses now.
  it("the disabled button label meets AA on border-light", () => {
    const ratio = contrastRatio(COLORS["muted"], COLORS["border-light"]);
    expect(ratio, `muted on border-light is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  // Regression: this commit — "Notes du coach" is text-accent on bg-accent/10, which composites to
  // a tint of the accent itself (4.4:1 with #476F86); the bare-ground loop above never sees it.
  // 10% is the tint every tinted card uses (WeeklyPlan, PlanCard, CoachTab, ResumeCard, RestTimer).
  it("accent text on its own 10% tint meets AA on every ground", () => {
    const channel = (hex, i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
    const tint = (ground) =>
      "#" + [0, 1, 2].map((i) => Math.round(channel(COLORS.accent, i) * 0.1 + channel(COLORS[ground], i) * 0.9)
        .toString(16).padStart(2, "0")).join("");
    for (const ground of GROUNDS) {
      const ratio = contrastRatio(COLORS.accent, tint(ground));
      expect(ratio, `accent on accent/10 over --color-${ground} is ${ratio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });

  it.each(WHITE_ON_FILL)("white text on the %s fill meets AA", (token) => {
    const ratio = contrastRatio("#FFFFFF", COLORS[token]);
    expect(ratio, `white on --color-${token} is ${ratio.toFixed(2)}:1`)
      .toBeGreaterThanOrEqual(AA_NORMAL);
  });
});

describe("text-gold usage guard", () => {
  // The token-value tests above only check `gold`'s contrast in the abstract — they never
  // check WHERE it's used. `gold` is ornament-only (2.20:1 on --color-card, fails AA) as TEXT,
  // so `text-gold` anywhere outside ORNAMENT_ALLOWLIST is a bug regardless of the token's value.

  it("matches text-gold but not text-gold-text (the guard must not false-positive)", () => {
    expect(TEXT_GOLD_PATTERN.test("text-gold")).toBe(true);
    expect(TEXT_GOLD_PATTERN.test('className="text-xs text-gold uppercase"')).toBe(true);
    expect(TEXT_GOLD_PATTERN.test("text-gold-text")).toBe(false);
    expect(TEXT_GOLD_PATTERN.test('className="text-xs text-gold-text uppercase"')).toBe(false);
  });

  it("never appears as `text-gold` outside the ornament allow-list (bg-gold, border-gold and text-gold-text are always fine)", () => {
    const files = collectJsxFiles(SRC_DIR).filter(
      (path) => !ORNAMENT_ALLOWLIST.has(path.split("/").pop()),
    );
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(
        TEXT_GOLD_PATTERN.test(source),
        `${file} uses text-gold as a text colour — gold is ornament-only (2.20:1), use text-gold-text instead`,
      ).toBe(false);
    }
  });

  it("the ornament allow-list files still exist and still use text-gold for the SVG divider", () => {
    for (const name of ORNAMENT_ALLOWLIST) {
      const [file] = collectJsxFiles(SRC_DIR).filter((path) => path.endsWith(`/${name}`));
      expect(file, `${name} is on ORNAMENT_ALLOWLIST but no longer exists under src/`).toBeDefined();
      const source = readFileSync(file, "utf8");
      expect(
        TEXT_GOLD_PATTERN.test(source),
        `${name} is on ORNAMENT_ALLOWLIST but no longer uses text-gold — remove it from the allow-list`,
      ).toBe(true);
    }
  });
});

describe("opacity guard", () => {
  // Regression: e91920a — completed plan cards carried `opacity-75`, which composited muted text
  // to 3.95:1 and accent loads to 3.02:1 on --color-surface while every token test above stayed
  // green — they check tokens, not the transparency applied over them. Three spellings fade text
  // the same way and are all checked: an opacity utility (`opacity-75`, `opacity-[.6]`,
  // `opacity-(--fade)`, `!opacity-50`), a text colour alpha (`text-muted/60`,
  // `text-[#544E47]/60`, `text-(--color-muted)/60`), and an inline `opacity` style.
  //
  // The ONE exempt variant chain is exactly `disabled:` (WCAG exempts inactive controls). The
  // whole chain is compared, and a segment may hold anything but whitespace, a quote or a colon
  // (`max-[480px]:`, `group-hover/card:`, `[&_svg]:`). The size shorthand `text-sm/6` (font size
  // and line height, no colour) is not a fade and is not matched, named or arbitrary
  // (`text-[14px]/6`, `text-[length:1rem]/6`).
  const SIZES = String.raw`xs|sm|base|lg|xl|[2-9]xl|\[(?:length:)?[\d.]+(?:px|rem|em)\]`;
  const CLASS_FADE = new RegExp(
    String.raw`(?<![^\s"'\`{])((?:[^\s"'\`:]+:)*)!?` +
      String.raw`(?:opacity-(?:\d|\[|\()|text-(?!(?:${SIZES})\/)(?:[a-z][\w-]*|\[[^\]\s]+\]|\([^)\s]+\))\/(?:\d|\[|\())`,
    "g",
  );
  const fadesText = (source) =>
    [...source.matchAll(CLASS_FADE)].some(([, chain]) => chain !== "disabled:");

  // An opacity PROPERTY anywhere in a component, read line by line: `opacity: x` and the
  // shorthand `{ opacity }`, in a literal `style={{…}}`, a const object or a spread alike.
  // Not the word inside a string (`transition: "opacity 200ms"`), which sets nothing.
  const OPACITY_PROP = /\bopacity\s*(?::|,|\})/;
  const opacityLines = (source) => source.split("\n").filter((line) => OPACITY_PROP.test(line));

  // Each exempt inline fade, by file AND exact text, so a second fade in the same file is still
  // caught and a stale entry fails. Each is not text she reads.
  const INLINE_FADE_ALLOWLIST = [
    // The dnd-kit placeholder left in the list while its row is dragged; the DragOverlay shows
    // the real row at full strength for the whole drag.
    { file: "SeanceSummary.jsx", text: "opacity: isDragging ? 0.4 : 1" },
  ];

  it("flags every fading spelling and variant chain except exactly disabled:", () => {
    for (const faded of [
      'className="p-3 opacity-75"', 'className="opacity-[.6]"', 'className="opacity-(--fade)"',
      'className="!opacity-50"', 'className="hover:!opacity-50"',
      'className="text-muted/60"', 'className="text-white/[.6]"',
      'className="text-[#544E47]/60"', 'className="text-(--color-muted)/60"',
      "hover:opacity-60", "group-hover:opacity-0", "not-disabled:opacity-60",
      "group-disabled:opacity-50", "peer-disabled:opacity-50", "md:disabled:opacity-50",
      "max-[480px]:disabled:opacity-50", "group-hover/card:disabled:opacity-50",
      "[&_svg]:disabled:opacity-50",
    ]) expect(fadesText(faded), faded).toBe(true);
    for (const kept of [
      'className="px-4 disabled:opacity-50"', "bg-black/30", "border-accent/20",
      'className="text-sm/6"', 'className="text-2xl/8"',
      'className="text-[14px]/6"', 'className="text-[length:1rem]/6"',
    ]) expect(fadesText(kept), kept).toBe(false);
  });

  it("finds an opacity property in any spelling, not the word in a string", () => {
    for (const faded of [
      "style={{ opacity: 0.5 }}", "style={{ opacity }}", "const s = { opacity: 0.5 };",
      "style={{ ...(done ? { opacity: 0.5 } : {}) }}", "style={{ width: `${pct}%`, opacity: 0.5 }}",
      "  opacity: isDragging ? 0.4 : 1,",
    ]) expect(opacityLines(faded).length, faded).toBe(1);
    expect(opacityLines('style={{ transition: "opacity 200ms" }}')).toEqual([]);
  });

  it("never fades text with an opacity utility or a text alpha outside disabled:", () => {
    const offenders = collectJsxFiles(SRC_DIR).filter((path) => fadesText(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("never fades text with an inline opacity style outside the allowlist, and has no stale entry", () => {
    const offenders = [];
    const used = new Set();
    for (const path of collectJsxFiles(SRC_DIR)) {
      const file = path.split("/").pop();
      for (const line of opacityLines(readFileSync(path, "utf8"))) {
        const entry = INLINE_FADE_ALLOWLIST.find((a) => a.file === file && line.includes(a.text));
        if (entry) used.add(entry);
        else offenders.push(`${file}: ${line.trim().slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(INLINE_FADE_ALLOWLIST.filter((a) => !used.has(a))).toEqual([]);
  });
});
