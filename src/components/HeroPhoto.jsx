import { heroPhotoSrc, HERO_PHOTOS_AVAILABLE } from "../lib/heroPhotos.js";

/** A decorative photo, or nothing at all when this build ships none (see `heroPhotos.js`). */
export default function HeroPhoto({ name, className = "" }) {
  const src = heroPhotoSrc(name, HERO_PHOTOS_AVAILABLE);
  if (!src) return null;
  return <img src={src} alt="" className={`hero-photo ${className}`.trim()} />;
}
