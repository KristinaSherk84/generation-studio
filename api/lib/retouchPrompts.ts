/**
 * Retouch prompts (Path B 2026-05-15).
 *
 * Shared between /api/retouch (the standalone endpoint) and /api/deliver
 * (which runs an inline retouching pass on each picked photo at the
 * customer's chosen tier before sending the email).
 *
 * These prompts mirror prompt-framework-retouching-v1.md — Kristi's
 * markdown source of truth. If the markdown is updated, mirror the
 * change down to the constants below.
 */

export type RetouchTier = "realistic" | "polished" | "glam";
export type AgeBand = "young" | "mature" | "older";

// Gemini model — Pro Image Preview ("Nano Banana Pro"). Slower (~10-15s
// per call) but produces editorial-grade retouching that Flash 3.1 can't
// match. Cost: ~$0.30-0.40 per image on Tier 2.
export const RETOUCH_MODEL = "gemini-3-pro-image-preview";

const IDENTITY_ANCHOR = `Identity preservation — non-negotiable, overrides every other directive below. Preserve the subject's facial features with 100% precision. The retouched face must remain UNMISTAKABLY the same person. Match the input photo EXACTLY for face shape, bone structure, eye shape and color, nose shape, mouth shape, hairline, ethnicity, and every distinguishing mark (freckles, beauty marks, moles, scars, asymmetries). DO NOT idealize features. DO NOT blend toward generic 'attractive' proportions. The retouching below operates ONLY on the skin SURFACE — never on facial structure, proportions, or feature placement.`;

const PORE_ANCHOR = `Pore micro-texture preservation — applies to every tier below. Preserve the 3D micro-texture of the skin surface (the raised/recessed terrain of pores at close magnification). Pore micro-texture stays at 100% on the face, neck, and visible décolletage. The smoothing operates on surface evenness only — the pore texture itself remains visible at normal viewing distance.`;

// Polished — under-35 (Tier 1)
export const RETOUCH_POLISHED_YOUNG = `${IDENTITY_ANCHOR}

POLISHED RETOUCH (woman under approximately 35 years old):

Master directive: Preserve pore structure, even out hot spots on skin, and skin coloration. Even skin tone across the face, remove blemishes. Render the skin around the eyes with realistic texture but brighten the under-eye areas, and smooth inconsistencies — like a senior executive who slept well last night. The result reads as 'lightly retouched and realistic' — the kind of headshot you'd see on a senior executive's company website.

Under-eye direction: Render the skin around the eyes rested, bright, and even in color. Keep fine texture but remove large wrinkles. Target: "well-rested, hydrated, young adult after a good night's sleep." Avoid over-smoothing the texture of this area. You can brighten and color correct this area to add the look of concealer under the eyes. No plastic skin look.

- TONE EVENING: Smooth out color inconsistencies in skin tones — uneven redness, blotchiness, post-acne marks, sunspots, hyperpigmentation patches, and tone variation between forehead / cheeks / chin / neck. The end result reads as an even, healthy skin tone across the face — but not so flat that it loses dimension.
- PORE STRUCTURE: Add or reinforce pore structure and detail across face, neck, and any visible décolletage, even if the input photo does not show clear skin texture. The end result must read as a real human face with real skin — pores visible at normal viewing distance, not erased texture.
- NO plastic skin. NO airbrushed or filter-smoothed appearance. NO doll-like or AI-tell smoothness.

${PORE_ANCHOR}`;

// Polished — 35-50 (Tier 2). Same as young except for the under-eye line.
export const RETOUCH_POLISHED_MATURE = `${IDENTITY_ANCHOR}

POLISHED RETOUCH (woman between approximately 35 and 50 years old):

Master directive: Preserve pore structure, even out hot spots on skin, and skin coloration. Even skin tone across the face, remove blemishes. Render the skin around the eyes with realistic texture but brighten the under-eye areas, and smooth inconsistencies — like a senior executive who slept well last night. The result reads as 'lightly retouched and realistic' — the kind of headshot you'd see on a senior executive's company website.

Under-eye direction: Render the skin around the eyes rested, bright, and color corrected as if a concealer was used under the eyes — like a professional in her 40s who slept well last night. The result reads as the same person as the input, just well-rested. NO over-smoothed under-eye area.

- TONE EVENING: Smooth out color inconsistencies in skin tones — uneven redness, blotchiness, post-acne marks, sunspots, hyperpigmentation patches, and tone variation between forehead / cheeks / chin / neck. The end result reads as an even, healthy skin tone across the face — but not so flat that it loses dimension.
- PORE STRUCTURE: Add or reinforce pore structure and detail across face, neck, and any visible décolletage, even if the input photo does not show clear skin texture. The end result must read as a real human face with real skin — pores visible at normal viewing distance, not erased texture.
- NO plastic skin. NO airbrushed or filter-smoothed appearance. NO doll-like or AI-tell smoothness.

${PORE_ANCHOR}`;

// Glam — all ages
export const RETOUCH_GLAM = `${IDENTITY_ANCHOR}

GLAM RETOUCH (editorial luxury beauty):

Master directive: Editorial luxury beauty retouching, equivalent to a Vogue cover photograph or high-end L'Oréal/Estée Lauder beauty campaign. Skin retains pore detail and structure; tone renders flawlessly even and illuminated. The skin around the eyes renders editorial-flawless — soft, smooth, luminous, like a magazine beauty shot. Filled-in softbox lighting with almost no shadows, professionally retouched in post-production by a high-end beauty retoucher. Skin reads as editorial-magazine-quality but still retains all pore structure. CRITICAL IDENTITY GUARDRAIL: at editorial-level smoothing the model has a strong tendency to drift toward generic-pretty / AI-default features and lose the subject's actual identity — do NOT let that happen. The smoothing only applies to surface evenness. Every facial feature, every proportion, every distinguishing mark, the eye SHAPE itself, the nose, the mouth, the bone structure, the asymmetries — all of those remain UNMISTAKABLY the subject's own. Smooth the surface, not the person.

The aesthetic target is "red-carpet luxury beauty editorial that hasn't erased the human" — Vogue cover where the model still has visible pores under close inspection. Polished, even-toned, glowing, aspirational — but real skin.

- TONE EVENING (AGGRESSIVE): Completely eliminate redness on cheeks and nose, blotchiness, post-acne marks, hyperpigmentation, sunspots, melasma, broken capillaries. Moderately even tones between forehead/cheeks/chin/neck. Even the tone but keep the highlights and shadows. The whole face should read as a single skin tone with dimensional shading from the lighting, not blotchy color zones.
- SURFACE EVENNESS (FACE AND NECK): Render the face and neck as smooth, luminous, editorial skin — the forehead, the area between the brows, the cheeks, the area around the mouth, and the front of the neck all render even and rested. Match the input for facial structure exactly; the smoothing applies only to surface evenness. The skin retains pore micro-texture per the pore-preservation directive above — it stays smooth and luminous, not blurred.
- ADD CONTOUR: Slightly darken the sides of the nose, under the cheekbones, the skin closest to the hairline around the forehead, and the facial skin closest to the jawline. Brighten the skin on the bridge of the nose, the under-eye areas, the tops of the cheeks and the lower forehead in the center. Also brighten the top of the chin area. Reference the areas where makeup artists brighten and darken the face to create the illusion of a more 3-dimensional face. Act as if you are adding illuminating makeup to the areas that need brightening, and bronzing makeup to the areas that need darkening. Also darken the upper eyelids near the outer corners, as if darkening eye shadow was added above the eyes.
- PORE STRUCTURE AND SKIN TEXTURE: Preserve per the pore-preservation directive above. Visible pores across cheeks, forehead, nose, chin, neck, décolletage — the skin should still read as softened actual human skin under close inspection. CRITICAL DISTINCTION: pore preservation refers to the physical 3D micro-texture of the skin surface (the raised / recessed terrain of pores at close magnification). Pores stay; fine lines and redness/blotchiness should be removed. Treat these as TWO SEPARATE concerns — texture and color — and only the small skin texture is preserved, wrinkles can be removed.
- SKIN AROUND THE EYES (PRIORITY ZONE FOR GLAM): Render the skin around the eyes editorial-flawless — soft, smooth, luminous, magazine-beauty-shot quality. The zone covers the area immediately below the lower lash line, extending down to the top of the cheekbone, and outward to the outer corner of the eye. Do NOT alter the eye shape, eyelid shape, or eye position — only the SKIN around the eye is being smoothed.
- ANTI-PLASTIC GUARDRAIL: Glam should NEVER produce plastic, doll-like, or filter-smoothed skin. The pore preservation is the safeguard against that.
- MAKEUP: Add soft makeup to accentuate the eyes and lips. Add contrast to the lash area, darken the upper lash line and the outer corners of the lower lashes with soft darkening powder eyeliner. Punch lip color and slightly outline lips with a darker color of the actual lip color.
- TEETH: Moderately neutralize yellow color of teeth by adding blue if teeth are off color. Moderately fix alignment if teeth are showing in the image. Do not over-whiten or generate teeth that do not look like the original. Slightly fix alignment of teeth as if Invisalign was used to help straighten teeth.

${PORE_ANCHOR}`;

export function buildRetouchPrompt(
  tier: RetouchTier,
  ageBand: AgeBand | undefined,
): string {
  if (tier === "polished") {
    return ageBand === "young"
      ? RETOUCH_POLISHED_YOUNG
      : RETOUCH_POLISHED_MATURE;
  }
  if (tier === "glam") {
    return RETOUCH_GLAM;
  }
  throw new Error(`buildRetouchPrompt called with unexpected tier: ${tier}`);
}
