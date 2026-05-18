# Retouching-step prompts (v1) — Kristi's edits 2026-05-15

This document is the **source of truth** for the prompts that will run during the **retouching step** — a separate Gemini API call that fires *after* the customer picks their favorite photo on the grid screen and chooses a tier:

- **Realistic** — no retouching, download the initial generation as-is.
- **Polished** — run the polished retouching prompt on the picked image.
- **Glam** — run the glam retouching prompt on the picked image.

Status as of 2026-05-15: these prompts are **not yet wired into the app**. The retouching endpoint and the per-photo tier picker on the grid screen are the Path B work to be built. Until Path B ships, the existing initial-generation pipeline still applies the legacy skin-tier prompts (BLOCK_SKIN_POLISHED, BLOCK_SKIN_GLAM, BLOCK_UNDER_EYE) at generation time — that's the current production behavior.

Once Path B is built, the legacy generation-time skin tier blocks should be stripped from `api/generate.ts` so the initial generation produces Realistic-only output for every customer, regardless of tier choice. Tier choice moves to the grid screen, and these prompts run there.

Typo fixes applied:
- "port structure" → "pore structure"
- "darkening power eyeliner" → "darkening powder eyeliner"

Removed from previous version per Kristi's edits:
- LUMINOUS FINISH bullet (intentionally dropped).

---

## 1. Polished — Young (under ~35)

### Master Polished directive (from Block 1)

> If the subject appears to be a WOMAN AND the user chose "Polished" skin: Preserve pore structure, even out hot spots on skin, and skin coloration. Even skin tone across the face, remove blemishes. Render the skin around the eyes realistic texture but brighten the under eye areas, and smooth inconsistencies — like a senior executive who slept well last night. The result reads as 'lightly retouched and realistic' — the kind of headshot you'd see on a senior executive's company website.

### Under-eye direction (Tier 1, women under ~35)

> Render the skin around the eyes rested, bright, and even in color. Keep fine texture but remove large wrinkles. Target: "well-rested, hydrated, young adult after a good night's sleep." Avoid over-smoothing the texture of this area. You can brighten and color correct this area to add the look of concealer under the eyes. No plastic skin look.

### Tone evening + pore reinforcement (BLOCK_SKIN_POLISHED)

> - **TONE EVENING:** Smooth out color inconsistencies in skintones — uneven redness, blotchiness, post-acne marks, sunspots, hyperpigmentation patches, and tone variation between forehead / cheeks / chin / neck. The end result reads as an even, healthy skin tone across the face — but not so flat that it loses dimension.
> - **PORE STRUCTURE:** Add or reinforce pore structure and detail across face, neck, and any visible décolletage, even if the reference photos do not show clear skin texture (low-resolution phone selfies, harsh lighting, heavy compression). The end result must read as a real human face with real skin — pores visible at normal viewing distance, with the only "retouch" being the descriptive aesthetic from Block 1, not erased texture.
> - **NO plastic skin.** NO airbrushed or filter-smoothed appearance. NO doll-like or AI-tell smoothness.

---

## 2. Polished — Mature (~35–50)

Same master Polished directive and same tone-evening/pore-reinforcement bullets as Polished — Young (see section 1). Only the under-eye direction changes:

### Under-eye direction (Tier 2, women ~35–50)

> Render the skin around the eyes rested, bright, and color corrected as if a concealer was used under the eyes — like a professional in her 40s who slept well last night. The result reads as the same person as the references, just well-rested. NO over-smoothed under eye area.

---

## 3. Glam — Young (under ~35)

For Glam, there is currently no age branching — Glam handles the under-eye as part of its overall heavy smoothing regardless of age. The same prompt applies to Glam — Young and Glam — Mature.

### Master Glam directive (from Block 1)

> If the subject appears to be a WOMAN AND the user chose "Glam" skin: Editorial luxury beauty retouching, equivalent to a Vogue cover photograph or high-end L'Oréal/Estée Lauder beauty campaign. Skin retains pore detail and structure; tone renders flawlessly even and illuminated. The skin around the eyes renders editorial-flawless — soft, smooth, luminous, like a magazine beauty shot. Filled-in softbox lighting with almost no shadows, professionally retouched in post-production by a high-end beauty retoucher. Skin reads as editorial-magazine-quality but still retains all pore structure. CRITICAL IDENTITY GUARDRAIL FOR THIS TIER: at editorial-level smoothing the model has a strong tendency to drift toward generic-pretty / AI-default features and lose the subject's actual identity — do NOT let that happen. The smoothing only applies to surface evenness. Every facial feature, every proportion, every distinguishing mark, the eye SHAPE itself, the nose, the mouth, the bone structure, the asymmetries — all of those remain UNMISTAKABLY the subject's own. Smooth the surface, not the person.

### BLOCK_SKIN_GLAM (companion to the directive above)

> The aesthetic target is "red-carpet luxury beauty editorial that hasn't erased the human" — Vogue cover where the model still has visible pores under close inspection. Polished, even-toned, glowing, aspirational — but real skin.
>
> - **TONE EVENING (AGGRESSIVE):** Completely eliminate redness on cheeks and nose, blotchiness, post-acne marks, hyperpigmentation, sunspots, melasma, broken capillaries. Moderately even tones between forehead/cheeks/chin/neck. Even the tone but keep the highlights and shadows. The whole face should read as a single skin tone with dimensional shading from the lighting, not blotchy color zones.
> - **SURFACE EVENNESS (FACE AND NECK):** Per the Glam aesthetic in Block 1, render the face and neck as smooth, luminous, editorial skin — the forehead, the area between the brows, the cheeks, the area around the mouth, and the front of the neck all render even and rested. Match the reference photos for facial structure exactly; the smoothing applies only to surface evenness. The skin retains pore micro-texture per Block 1's directive — it stays smooth and luminous, not blurred.
> - **ADD CONTOUR:** Slightly darken the sides of the nose, under the cheekbones, the skin closest to the hairline around the forehead, and the facial skin closest to the jawline. Brighten the skin on the bridge of the nose, the under eye areas, the tops of the cheeks and the lower forehead in the center. Also brighten the top of the chin area. Reference the areas where makeup artists brighten and darken the face to create the illusion of a more 3 dimensional face. Act as if you are adding illuminating makeup to the areas that need brightening, and bronzing makeup to the areas that need darkening. Also darken the upper eye lids near the outer corners. As if darkening eye shadow was added above the eyes.
> - **PORE STRUCTURE AND SKIN TEXTURE:** Preserve per Block 1's pore-preservation directive. Visible pores across cheeks, forehead, nose, chin, neck, décolletage — the skin should still read as softened actual human skin under close inspection. CRITICAL DISTINCTION: pore preservation refers to the physical 3D micro-texture of the skin surface (the raised / recessed terrain of pores at close magnification). Pores stay; fine lines and redness/blotchiness should be removed. Treat these as TWO SEPARATE concerns — texture and color — and only the small skin texture is preserved, wrinkles can be removed.
> - **SKIN AROUND THE EYES (PRIORITY ZONE FOR GLAM):** Render the skin around the eyes editorial-flawless — soft, smooth, luminous, magazine-beauty-shot quality. The zone covers the area immediately below the lower lash line, extending down to the top of the cheekbone, and outward to the outer corner of the eye. Pore micro-texture across this zone still applies per Block 1's universal pore-preservation directive. Do NOT alter the eye shape, eyelid shape, or eye position — only the SKIN around the eye is being smoothed. This rule EXPLICITLY OVERRIDES Block UNDER_EYE's age-tiered preservation rules for the Glam tier.
> - **ANTI-PLASTIC GUARDRAIL:** Glam should NEVER produce plastic, doll-like, or filter-smoothed skin. The pore preservation is the safeguard against that.
> - **MAKEUP:** Add soft makeup to accentuate the eyes and lips. Add contrast to the lash area, darken the upper lash line and the outer corners of the lower lashes with soft darkening powder eyeliner. Punch lip color and slightly outline lips with a darker color of the actual lip color.
> - **TEETH:** Moderately neutralize yellow color of teeth by adding blue if teeth are off color. Moderately fix alignment if teeth are showing in the image. Do not over whiten or generate teeth that do not look like the original. Slightly fix alignment of teeth as if Invisalign was used to help straighten teeth.

---

## 4. Glam — Mature (35+)

Currently identical to Glam — Young (see section 3). No age branching exists for Glam.

Future option: if Kristi later decides Glam should differentiate by age (e.g., a touch more reduction of pronounced under-eye lines for mature subjects while keeping the same overall editorial glow), an internal age branch can be added to BLOCK_SKIN_GLAM the way BLOCK_UNDER_EYE does for Polished.

---

## Notes for Path B implementation

When the retouching endpoint is built, the prompts above should be used like this:

- Identity preservation: the existing Block 1 IDENTITY PRESERVATION rule applies to every retouching call — pass it in unchanged.
- Pore micro-texture preservation: the existing Block 1 PORE MICRO-TEXTURE rule applies — pass it in unchanged.
- Skin smoothing direction: use the section above corresponding to the customer's tier choice plus apparent age band.
- BLOCK_SMILE_FIDELITY: **does not apply** in the retouching call (it's specific to initial generation). The Glam TEETH bullet above governs teeth handling at the retouching stage.
- Model: per the Path B architecture notes, use `gemini-3-pro-image-preview` (Nano Banana Pro) for the retouching pass — higher fidelity for editorial-level retouch than Flash.
- Pricing: per Kristi 2026-05-15, all three tiers are included in the flat **$11.99 per photo** price. There is no per-tier upcharge. Customers pick whichever tier they want at the new "Customize your Retouch Level" screen between Grid and Checkout, and the price is the same regardless.
