import { describe, it, expect, vi } from "vitest";
import { checkForSwUpdate } from "./swUpdate.js";

describe("checkForSwUpdate", () => {
  // Regression: c908274 — an offline update() rejection escaped the hourly and on-focus checks unhandled.
  it("does not call update() while offline", async () => {
    const update = vi.fn().mockResolvedValue();
    expect(await checkForSwUpdate({ update }, false)).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it("swallows a rejected update() instead of letting it escape", async () => {
    const update = vi.fn().mockRejectedValue(new TypeError("Failed to update a ServiceWorker"));
    await expect(checkForSwUpdate({ update }, true)).resolves.toBe(false);
    expect(update).toHaveBeenCalledOnce();
  });

  it("swallows a synchronous throw from update() too", async () => {
    const update = vi.fn(() => { throw new Error("boom"); });
    await expect(checkForSwUpdate({ update }, true)).resolves.toBe(false);
  });

  it("calls update() when online and reports success", async () => {
    const update = vi.fn().mockResolvedValue();
    expect(await checkForSwUpdate({ update }, true)).toBe(true);
    expect(update).toHaveBeenCalledOnce();
  });

  it("is a no-op without a registration", async () => {
    expect(await checkForSwUpdate(undefined, true)).toBe(false);
  });
});
