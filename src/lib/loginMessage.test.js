import { describe, it, expect } from "vitest";
import { loginErrorMessage } from "./loginMessage.js";

describe("loginErrorMessage", () => {
  it("a wrong passphrase says so", () => {
    expect(loginErrorMessage(401)).toBe("Raté, darling. Réessaie.");
  });

  // Regression: 9bf54d1 — a throttled sign-in (429) showed the generic
  // server-fault message, so the user retried into the lock.
  it("a throttled address is told to wait, with the server's delay", () => {
    expect(loginErrorMessage(429, "900")).toBe("Trop d'essais, darling. Réessaie dans 15 min.");
    expect(loginErrorMessage(429, "61")).toBe("Trop d'essais, darling. Réessaie dans 2 min.");
  });

  it("a throttle reply without a usable Retry-After still says to wait", () => {
    for (const header of [null, "", "soon", "0", "-5"]) {
      expect(loginErrorMessage(429, header)).toBe("Trop d'essais, darling. Réessaie dans quelques minutes.");
    }
  });

  it("anything else is a server fault", () => {
    for (const status of [400, 500, 502, 503]) {
      expect(loginErrorMessage(status)).toBe("Le rideau est coincé (serveur). Réessaie.");
    }
  });
});
