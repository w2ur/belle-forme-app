import { describe, it, expect } from "vitest";
import { heroPhotoSrc, HERO_PHOTO_DIR } from "./heroPhotos.js";

describe("heroPhotoSrc", () => {
  it("names the photo under the hero folder when the build has them", () => {
    expect(heroPhotoSrc("entrance", true)).toBe(`${HERO_PHOTO_DIR}/entrance.jpg`);
  });

  // The public build ships no photos. Returning null — not a URL — is what keeps
  // the app from requesting a file the host would answer with the SPA's HTML.
  it("returns null when this build ships no photos, whatever is asked for", () => {
    expect(heroPhotoSrc("entrance", false)).toBeNull();
    expect(heroPhotoSrc("entrance", undefined)).toBeNull();
  });

  it("refuses a name that is not a plain file stem, so a prop can never build a path", () => {
    for (const bad of ["../secret", "a/b", "a.jpg", "", "A", undefined, null, 5]) {
      expect(heroPhotoSrc(bad, true)).toBeNull();
    }
  });
});
