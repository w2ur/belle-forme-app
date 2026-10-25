import { describe, it, expect } from "vitest";
import { SW_NAVIGATE_DENYLIST } from "./swDenylist.js";

// Workbox matches `url.pathname + url.search`, so that is what is tested here.
const denied = (href) => {
  const url = new URL(href, "https://example.test");
  return SW_NAVIGATE_DENYLIST.some((re) => re.test(url.pathname + url.search));
};

describe("SW_NAVIGATE_DENYLIST", () => {
  // Regression, code review 2026-10-25: `/^\/demo(\/|$)/` let `/demo?x=1`
  // through, and the real app's worker answered it with the real index.html.
  it("keeps every form of a /demo navigation away from the real app", () => {
    for (const href of ["/demo", "/demo/", "/demo?utm=x", "/demo/?x=1", "/demo/coach"]) expect(denied(href), href).toBe(true);
  });

  it("keeps the API out", () => {
    expect(denied("/api/sync-pull")).toBe(true);
  });

  it("control: the real app's own routes stay served", () => {
    for (const href of ["/", "/?x=1", "/demonstration", "/coach", "/profil?demo=1"]) expect(denied(href), href).toBe(false);
  });
});
