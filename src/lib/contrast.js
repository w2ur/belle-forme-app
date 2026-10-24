/**
 * WCAG 2.1 colour maths. Used by `contrast.test.js` to hold the shipped
 * palette to AA — the palette regressed unnoticed once because it had only
 * ever been checked by eye.
 */

/** WCAG relative luminance of a `#RRGGBB` colour, 0 (black) to 1 (white). */
export function relativeLuminance(hex) {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two `#RRGGBB` colours, 1 to 21. Symmetric. */
export function contrastRatio(hexA, hexB) {
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Extract `--color-*` declarations from a Tailwind v4 `@theme { … }` block.
 * The stylesheet stays the single source of truth — Tailwind needs the tokens
 * there, so the test reads them rather than duplicating them in JS.
 */
export function parseThemeColors(cssText) {
  const block = cssText.match(/@theme\s*\{([\s\S]*?)\n\}/);
  if (!block) return {};
  const colors = {};
  for (const [, name, value] of block[1].matchAll(/--color-([\w-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g)) {
    colors[name] = value.toUpperCase();
  }
  return colors;
}
