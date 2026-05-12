/**
 * Top-level entry point for the skin pre-filter pipeline.
 *
 * Usage from /api/generate.ts (or wherever we send reference photos to
 * Gemini):
 *
 *     import { preFilterReference } from "./lib/skin/index.js";
 *     const smoothed = await preFilterReference(referenceBytes, skinTier);
 *     // pass `smoothed` to Gemini instead of the raw reference
 *
 * Pipeline:
 *   1. detect 68 face landmarks + gender (face-api, on-disk model files)
 *   2. look up smoothing intensity for (skin tier × detected gender)
 *   3. build base + under-eye masks from landmarks
 *   4. apply frequency-separation smoothing
 *   5. return JPEG buffer ready for Gemini
 *
 * Fails safe: if landmark detection misses (no face, model file missing,
 * lib throws), returns the ORIGINAL image bytes unchanged. The Gemini call
 * still goes through with the un-smoothed reference. We never break a
 * paid generation because the pre-filter had a hiccup.
 */

import sharp from "sharp";
import { detectLandmarks } from "./detectLandmarks.js";
import { buildBaseSmoothMask, buildUnderEyeMask } from "./buildMask.js";
import { smoothImage } from "./smooth.js";
import { getSkinIntensity, isPreFilterEnabled, type Skin } from "./intensityMatrix.js";

/**
 * Pre-filter a single reference photo for the given skin tier. Returns a
 * JPEG buffer of the smoothed image, or the original bytes unchanged if
 * smoothing isn't needed (Realistic tier) or fails (no face detected).
 *
 * Safe to call regardless of skin tier — it'll short-circuit on Realistic
 * and on any failure.
 */
export async function preFilterReference(
  referenceBytes: Buffer,
  skin: Skin | undefined,
): Promise<Buffer> {
  // Short-circuit: skin tier is Realistic or undefined → no filtering
  if (!skin || skin === "realistic") return referenceBytes;

  try {
    // 1. Detect landmarks + gender on the reference photo
    const landmarks = await detectLandmarks(referenceBytes);
    if (!landmarks) {
      // No face detected, or face-api models missing — return original
      return referenceBytes;
    }

    // 2. Look up intensity for this (skin × gender) combo
    const intensity = getSkinIntensity(skin, landmarks.gender);
    if (!isPreFilterEnabled(skin, landmarks.gender)) {
      return referenceBytes;
    }

    // 3. We need to know the ACTUAL image dimensions after EXIF rotation
    //    so the masks line up with the smoothed image. Re-decode just to
    //    grab metadata.
    const orientedMeta = await sharp(referenceBytes).rotate().metadata();
    const W = orientedMeta.width;
    const H = orientedMeta.height;
    if (!W || !H) return referenceBytes;

    // 4. Build masks
    const baseMask = await buildBaseSmoothMask({
      imageWidth: W,
      imageHeight: H,
      landmarks,
      protectBeard: intensity.protectBeard,
    });

    // Under-eye mask only generated when its intensity exceeds the base
    // (otherwise it'd be redundant and we'd waste compute)
    const underEyeMask =
      intensity.underEye > intensity.base
        ? await buildUnderEyeMask({
            imageWidth: W,
            imageHeight: H,
            landmarks,
            protectBeard: intensity.protectBeard,
          })
        : null;

    // 5. Smooth and return
    return await smoothImage({
      imageBytes: referenceBytes,
      baseMask,
      underEyeMask,
      baseStrength: intensity.base,
      underEyeStrength: intensity.underEye,
      width: W,
      height: H,
    });
  } catch (err) {
    // Anything unexpected — log and return the original unchanged. Never
    // let a pre-filter bug break a paid generation.
    console.warn(
      "[preFilterReference] failed, returning original:",
      err instanceof Error ? err.message : String(err),
    );
    return referenceBytes;
  }
}

// Re-export the types so callers don't have to import from sub-modules
export type { Skin } from "./intensityMatrix.js";
