/**
 * Frequency-separation skin smoothing for reference photos.
 *
 * Technique (the photographer's-grade approach):
 *
 *   1. Decode the image to a raw RGB pixel buffer at full resolution.
 *   2. Compute a LOW-frequency layer = light gaussian blur of the image.
 *      The low layer captures broad color zones, tonal variation, and
 *      large-scale shadows (including the broad shadow shapes that make
 *      wrinkles visible).
 *   3. Compute a HEAVILY-blurred version of the low layer. This is what
 *      "smoothed" broad tones look like — patches of color blend together,
 *      shadows soften.
 *   4. Mix the original-low layer with the heavily-blurred-low layer based
 *      on the per-pixel mask values × strength. Inside the smooth-zone
 *      mask, low → smoothed_low. Outside, low → original_low (unchanged).
 *   5. Recombine: result = mixed_low + (original - original_low).
 *      The (original - original_low) term IS the high-frequency layer:
 *      pores, fine hairs, individual lash strands. It's preserved at 100%
 *      regardless of what we did to the low frequency — so skin character
 *      and pore detail survive.
 *
 * Net effect: skin tone evens out, broad shadow shapes soften (including
 * wrinkle shadows since those live in the low frequency), but pore-level
 * detail stays exactly as in the original. Skin color/saturation is NOT
 * desaturated because we never touched the difference between original
 * and original-low.
 *
 * Implementation choice: we do the per-pixel math in JS Uint8Array loops
 * rather than trying to chain Sharp composite ops. Sharp doesn't have a
 * signed-subtract or weighted-blend primitive that works on raw pixel
 * data cleanly, so JS loops over the buffer are simpler and fast enough
 * (~50ms for a 1024×1024 image).
 */

import sharp from "sharp";

export type SmoothOptions = {
  /** Raw input image bytes (jpg/png/heic). */
  imageBytes: Buffer;
  /** Base smooth-zone mask — grayscale buffer, same dimensions as image.
   *  255 = fully smooth at base intensity, 0 = protect. */
  baseMask: Buffer;
  /** Optional under-eye sub-zone mask (Glam-woman only). */
  underEyeMask: Buffer | null;
  /** Base smoothing intensity 0..1 (multiplied with the base mask). */
  baseStrength: number;
  /** Under-eye smoothing intensity 0..1 (multiplied with the under-eye mask).
   *  Should be >= baseStrength to produce a meaningful "extra" under-eye
   *  effect; falls back to base when equal. */
  underEyeStrength: number;
  /** Image dimensions — must match the mask buffers. */
  width: number;
  height: number;
};

/**
 * Apply frequency-separation smoothing and return the result as a JPEG buffer.
 * The output is ready to hand straight to Gemini.
 */
export async function smoothImage(opts: SmoothOptions): Promise<Buffer> {
  const {
    imageBytes,
    baseMask,
    underEyeMask,
    baseStrength,
    underEyeStrength,
    width: W,
    height: H,
  } = opts;

  // Quick exits: no smoothing requested, or mask is all-zero
  if (baseStrength <= 0 && underEyeStrength <= 0) {
    return imageBytes;
  }

  // 1. Decode source to RGB raw at our target dimensions.
  // Auto-orient first so EXIF rotation is applied to pixels.
  const oriented = await sharp(imageBytes).rotate().toBuffer();
  const origRaw = await sharp(oriented)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (origRaw.info.width !== W || origRaw.info.height !== H) {
    throw new Error(
      `[smoothImage] image/mask dimension mismatch: image ${origRaw.info.width}×${origRaw.info.height}, mask ${W}×${H}`,
    );
  }

  // 2. Compute LOW-frequency layer. Sigma scales with face/image size —
  //    we want it big enough to absorb wrinkle shadows (medium-scale
  //    features) but small enough to leave pores in the high-frequency
  //    layer.
  const lowSigma = Math.max(1.5, Math.min(W, H) * 0.005);
  const lowRaw = await sharp(oriented)
    .removeAlpha()
    .blur(lowSigma)
    .raw()
    .toBuffer();

  // 3. Compute the HEAVILY-smoothed low layer. Bigger sigma → more aggressive
  //    smoothing of broad tones.
  const heavySigma = Math.max(8, Math.min(W, H) * 0.04);
  const heavyRaw = await sharp(oriented)
    .removeAlpha()
    .blur(heavySigma)
    .raw()
    .toBuffer();

  // 4. Walk every pixel and apply the math.
  const out = Buffer.allocUnsafe(origRaw.data.length); // RGB, 3 bytes/pixel
  const totalPixels = W * H;

  for (let i = 0; i < totalPixels; i++) {
    // Per-pixel mask values (0..1)
    const baseMaskVal = (baseMask[i] ?? 0) / 255;
    const underMaskVal = underEyeMask ? (underEyeMask[i] ?? 0) / 255 : 0;

    // Combine: under-eye mask gets its own strength; if it's > baseStrength
    // in that pixel, use it. Otherwise fall back to the base.
    // This way the under-eye area smoothes at MAX of (base_in_this_pixel,
    // under_eye_strength × under_eye_mask), never less than the base.
    const baseContribution = baseMaskVal * baseStrength;
    const underContribution = underMaskVal * underEyeStrength;
    const localStrength = Math.max(baseContribution, underContribution);

    if (localStrength <= 0) {
      // No smoothing here — copy original pixel unchanged
      const p = i * 3;
      out[p] = origRaw.data[p];
      out[p + 1] = origRaw.data[p + 1];
      out[p + 2] = origRaw.data[p + 2];
      continue;
    }

    // Frequency-separation per-pixel math:
    //   high       = orig - low
    //   mixed_low  = low * (1 - s) + heavy * s
    //   result     = mixed_low + high = mixed_low + orig - low
    const s = localStrength;
    const inv = 1 - s;
    const p = i * 3;
    for (let c = 0; c < 3; c++) {
      const o = origRaw.data[p + c];
      const l = lowRaw[p + c];
      const h = heavyRaw[p + c];
      const mixedLow = l * inv + h * s;
      const result = mixedLow + o - l;
      out[p + c] = result < 0 ? 0 : result > 255 ? 255 : result | 0;
    }
  }

  // 5. Re-encode as JPEG for Gemini. Quality 92 keeps the smoothing
  //    benefit visible without ballooning payload size.
  return await sharp(out, {
    raw: { width: W, height: H, channels: 3 },
  })
    .jpeg({ quality: 92, progressive: true })
    .toBuffer();
}
