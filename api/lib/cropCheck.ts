/**
 * Crop-drift check for Glow Up retouches (2026-10-16, Kristi).
 *
 * The Pro retouch pass sometimes re-crops the photo tighter than the
 * Realistic original, so Polished / Glam come back zoomed in. Kristi was
 * checking every delivery email by hand to catch it. This compares the size
 * of the largest face in the original vs the retouched image: a ratio above
 * CROP_TIGHT_RATIO means the retouch zoomed in.
 *
 * Uses the local face-api models (no API cost). Best-effort: returns null if
 * a face can't be found in either image, and callers then skip the check.
 */
import { detectFaceBoxes } from "./skin/detectLandmarks.js";

/** Face noticeably bigger than the original = cropped tighter. */
export const CROP_TIGHT_RATIO = 1.08;

/** Face height as a fraction of the image height, or null if no face. */
export async function faceScale(image: Buffer): Promise<number | null> {
  const r = await detectFaceBoxes(image);
  if (!r || r.boxes.length === 0 || !r.height) return null;
  return r.boxes[0].height / r.height;
}

/**
 * How much bigger the face is in `retouched` than in the original
 * (1.0 = same framing, 1.15 = 15% tighter). Pass the original's faceScale
 * when you already have it. Null when either face can't be measured.
 */
export async function cropRatio(
  originalScale: number | null,
  retouched: Buffer,
): Promise<number | null> {
  if (!originalScale) return null;
  const s = await faceScale(retouched);
  return s ? s / originalScale : null;
}
