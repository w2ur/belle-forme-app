import { describe, it, expect } from "vitest";
import { navigate, scrollOnScreenChange } from "./navigation.js";

describe("navigate", () => {
  // Regression: 1b4f5bd — a tap on « Séance », the tab the séance runs under, closed the running
  // séance screen.
  it("keeps the séance screen open on a tap on the current tab", () => {
    expect(navigate({ tab: "session", next: "session", seanceOpen: true })).toEqual({
      tab: "session",
      seanceOpen: true,
    });
  });

  it("closes the séance screen when the tab changes", () => {
    expect(navigate({ tab: "session", next: "coach", seanceOpen: true })).toEqual({
      tab: "coach",
      seanceOpen: false,
    });
  });

  it("changes tab normally with no séance on screen", () => {
    expect(navigate({ tab: "coach", next: "profile", seanceOpen: false })).toEqual({
      tab: "profile",
      seanceOpen: false,
    });
  });
});

describe("scrollOnScreenChange", () => {
  const list = { tab: "session", view: "list", seanceOpen: false };

  // A same-tab tap changes nothing, so the page must not jump mid-séance.
  it("leaves the page where it is when the screen did not change", () => {
    expect(scrollOnScreenChange(list, { ...list })).toBe(null);
    const seance = { ...list, seanceOpen: true };
    expect(scrollOnScreenChange(seance, { ...seance })).toBe(null);
  });

  it("opens a new tab at its top", () => {
    expect(scrollOnScreenChange({ ...list, tab: "exercises" }, { ...list, tab: "profile" })).toBe(0);
  });

  // Regression: eb4f309 — a session opened from low in the history opened with its header
  // off-screen.
  it("opens a session, a form or the séance screen at the top", () => {
    for (const view of ["detail", "new", "edit"]) {
      expect(scrollOnScreenChange(list, { ...list, view }), view).toBe(0);
    }
    expect(scrollOnScreenChange(list, { ...list, seanceOpen: true })).toBe(0);
  });

  // Regression: 127476b, be87d35 and 3165f3e — a restored history offset landed past her card, because
  // what sits above the list changes height while she is away. Every way back opens at the top.
  it("opens the history at the top on every way back", () => {
    for (const view of ["detail", "new", "edit"]) {
      expect(scrollOnScreenChange({ ...list, view }, list), view).toBe(0);
    }
    expect(scrollOnScreenChange({ ...list, seanceOpen: true }, list)).toBe(0);
  });
});
