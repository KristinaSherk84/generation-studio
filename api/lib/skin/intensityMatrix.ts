/**
 * Skin pre-filter intensity matrix.
 *
 * The pre-filter smooths reference photos before they're sent to Gemini, so
 * Gemini's "match what it sees" behavior renders cleaner output skin. Each
 * tier has a base strength applied to face skin zones (cheeks, forehead,
 * chin) plus an optional under-eye boost — only Glam-woman currently gets
 * the extra under-eye smoothing.
 *
 * Per Kristi 2026-05-06:
 *   - Realistic: never pre-filter
 *   - Polished: 30% for women, 10% for men, UNIFORM across the face (no
 *     under-eye boost — Polished is meant to look only lightly retouched)
 *   - Glam: 50% face + 65% under-eye for women; 30% uniform for men (men
 *     who pick Glam get treated as Polished-woman, no under-eye boost)
 *
 * Men also get beard / stubble protection on top of the standard
 * feature-protection mask.
 */

// Inlined here to avoid a dependency on generate.ts. Keep these two
// string-literal unions in sync with the matching ones in generate.ts
// and deliver.ts; both files re-declare the same union locally.
export type Skin = "realistic" | "polished" | "glam";
export type Gender = "male" | "female";

export type SkinIntensity = {
  /** Multiplier applied to general face-skin zones (forehead, cheeks, chin, jaw). */
  base: number;
  /** Multiplier applied to the under-eye sub-zone (additive zone, only fires
   *  when > base). 0 = no extra under-eye smoothing. */
  underEye: number;
  /** Should we also protect a beard / stubble zone derived from the lower
   *  jawline and chin? True for men, false for women. */
  protectBeard: boolean;
};

const ZERO: SkinIntensity = { base: 0, underEye: 0, protectBeard: false };

/**
 * Return the intensity settings for a (skin tier × gender) pair.
 * Caller passes undefined for skin if the user didn't choose a tier — that
 * defaults to Realistic (no smoothing).
 */
export function getSkinIntensity(
  skin: Skin | undefined,
  gender: Gender,
): SkinIntensity {
  if (!skin || skin === "realistic") return ZERO;

  if (skin === "polished") {
    return gender === "female"
      ? { base: 0.30, underEye: 0.30, protectBeard: false }
      : { base: 0.10, underEye: 0.10, protectBeard: true };
  }

  // skin === "glam"
  return gender === "female"
    ? { base: 0.50, underEye: 0.65, protectBeard: false }
    : { base: 0.30, underEye: 0.30, protectBeard: true };
}

/** Helper: should we run the pre-filter at all for this tier/gender? */
export function isPreFilterEnabled(
  skin: Skin | undefined,
  gender: Gender,
): boolean {
  const { base, underEye } = getSkinIntensity(skin, gender);
  return base > 0 || underEye > 0;
}
