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

// ============================================================================
// Customer-facing tier model (2026-05-18 Glow Up Deluxe pivot):
//   "basic"  — Realistic only. No retouching. $9.99 per photo.
//   "deluxe" — Glow Up Deluxe Bundle. Customer receives all 3 versions of
//              the same headshot: Realistic, Polished, and Glam. $14.99
//              per photo. /api/deliver runs both Polished and Glam Gemini
//              Pro passes in parallel on the original Realistic photo.
//
// Old per-tier model ("realistic" | "polished" | "glam") replaced. The
// underlying Polished/Glam prompts still exist below — they're just no
// longer separately selectable by the customer. Deluxe customers get both.
// ============================================================================
export type RetouchTier = "basic" | "deluxe";

// SubTier identifies which retouching pass is being run. Used internally by
// /api/deliver and /api/retouch when fanning out a Deluxe order into two
// parallel Gemini Pro calls.
export type RetouchSubTier = "polished" | "glam";

export type AgeBand = "young" | "mature" | "older";

// Gemini model — Pro Image Preview ("Nano Banana Pro"). Slower (~10-15s
// per call) but produces editorial-grade retouching that Flash 3.1 can't
// match. Cost: ~$0.30-0.40 per image on Tier 2.
export const RETOUCH_MODEL = "gemini-3-pro-image-preview";

// IDENTITY_ANCHOR v4 2026-05-18: added JAW AND CHIN STRUCTURE LOCK and
// MOUTH AND SMILE LOCK clauses. Kristi's Glam test produced an open-mouth-
// with-teeth smile from a closed-mouth input AND visibly slimmed the jaw,
// even though the MOUTH AND SMILE LOCK existed as a Glam-only bullet. Per
// Kristi: protect structure across ALL THREE tiers (Realistic, Polished,
// Glam) by elevating the locks to the IDENTITY_ANCHOR which all tiers
// inherit. Per Kristi explicitly: do NOT change the contouring/jawline-
// shadow language in the Glam ADD CONTOUR bullet — that wording produces
// the visual "pushed-back cheeks and jaw" effect via shadow, NOT structural
// change. The new JAW LOCK explicitly says contouring shadows are
// lighting/makeup effects only, so the two can co-exist.
//
// v3 additions (kept): BACKGROUND AND CROP LOCK clause.
// v2 additions (kept): "and expression" in feature-set, persona-priming.
const IDENTITY_ANCHOR = `Identity preservation — non-negotiable, overrides every other directive below. Preserve the subject's facial features and expression with 100% precision. The retouched face must remain UNMISTAKABLY the same person. Match the input photo EXACTLY for face shape, bone structure, eye shape and color, nose shape, mouth shape, hairline, ethnicity, and every distinguishing mark (freckles, beauty marks, moles, scars, asymmetries). DO NOT idealize features. DO NOT blend toward generic 'attractive' proportions. The retouching below operates ONLY on the skin SURFACE — never on facial structure, proportions, or feature placement. You will act as a high end retoucher changing only surface level items, not structural ones. BACKGROUND AND CROP LOCK: The background AND crop of the output photo MUST be preserved IDENTICALLY to the input photo. Background: everything outside the subject (walls, scenery, light fixtures, depth-of-field blur, color tones, composition) stays unchanged — do NOT replace, regenerate, alter, recolor, or stylize the background in any way. If the input background is blurred, the output background is blurred the same way. Crop and framing: the subject must occupy the same area of the frame as in the input — same head size, same headroom above the hairline, same shoulder line position, same horizontal centering. Do NOT zoom in, do NOT zoom out, do NOT re-crop, do NOT recompose. The output canvas and subject placement must be pixel-equivalent to the input. JAW AND CHIN STRUCTURE LOCK: The jawbone shape, chin shape, jaw width, jaw curvature, and chin point in the output MUST match the input photo exactly. The face silhouette (the outline of the head and jaw against the background) must be IDENTICAL to the input — pixel-for-pixel. Any contouring, shadow, or bronzer technique described below is a LIGHTING/MAKEUP effect ONLY — it may darken skin tone in select areas to create the visual illusion of more dimensional cheeks and a pushed-back jaw, but it does NOT alter the underlying bone structure or change the actual jaw silhouette. Do NOT slim the actual jaw. Do NOT reshape the actual chin. Do NOT taper, narrow, or V-shape the face. If the face silhouette changes from the input — even slightly tapered, slimmer, or more heart-shaped — you have failed this directive. MOUTH AND SMILE LOCK: The mouth, smile, lips, and teeth in the output MUST be IDENTICAL to the input photo. If the input shows a closed-mouth smile, the output shows the SAME closed-mouth smile — do NOT open the mouth, do NOT show teeth, do NOT change the expression. If the input shows teeth, the output shows the SAME teeth in the SAME arrangement — do NOT change which teeth are visible, do NOT change the smile width, do NOT change the smile shape. Lip shape, lip thickness, lip volume, lip outline, mouth corners, smile asymmetry — ALL match the input photo exactly. The retouching operates on skin SURFACE only; the underlying mouth, smile, and expression remain UNTOUCHED. If the output shows a different smile than the input, even slightly, you have failed this directive.`;

const PORE_ANCHOR = `Pore micro-texture preservation — applies to every tier below. Preserve the 3D micro-texture of the skin surface (the raised/recessed terrain of pores at close magnification). Pore micro-texture stays at 100% on the face, neck, and visible décolletage. The smoothing operates on surface evenness only — the pore texture itself remains visible at normal viewing distance.`;

// Polished — under-35 (Tier 1). v2 2026-05-18: dialed up smoothing + added
// ORBITAL FILL LIGHT bullet. Master directive shifts the aesthetic anchor
// from "senior executive's company website" to "Forbes/Fast Company magazine
// profile" — meaningfully more retouched. TONE EVENING marked AGGRESSIVE.
// Young variant keeps the original young-specific under-eye direction.
// Polished — under 35 (Tier 1). v3 2026-05-27: full rewrite to match
// the same prompt Kristi shipped for the MATURE (35-50) cohort. Now
// SELF-CONTAINED (no IDENTITY_ANCHOR prepend, no PORE_ANCHOR append).
// Only difference vs MATURE is the age-cohort descriptor on the
// POLISHED RETOUCH header line ("woman under approximately 35 years old"
// instead of "woman between approximately 35 and 50 years old"). All
// other directives — identity-preservation paragraph, BACKGROUND LOCK,
// master directive, under-eye direction, TONE EVENING (AGGRESSIVE),
// ORBITAL FILL LIGHT, PORE STRUCTURE, NO plastic skin, and pore
// micro-texture footer — are identical to the MATURE prompt.
//
// Key changes from v2:
//   - Identity-preservation paragraph now includes an explicit
//     BACKGROUND LOCK clause.
//   - Master directive dropped the Forbes/Fast Company reference and
//     the "visible difference should be obvious" line.
//   - Under-eye direction simplified — dropped the young-adult-specific
//     "well-rested, hydrated young adult after a good night's sleep"
//     framing and the "Keep fine texture but remove large wrinkles"
//     line. Now matches the MATURE under-eye direction word-for-word.
//   - TONE EVENING gained the "Soften forehead lines and 11 lines
//     between the eyebrows" bullet.
//   - Pore micro-texture paragraph baked in at the bottom inline.
export const RETOUCH_POLISHED_YOUNG = `Identity preservation — non-negotiable, overrides every other directive below. Preserve the subject's facial features and expression with 100% precision. The retouched face must remain UNMISTAKABLY the same person. Match the input photo EXACTLY for face shape, bone structure, all facial features, hairline, ethnicity, distinguishing marks (freckles, beauty marks, moles, scars, asymmetries). DO NOT idealize features. The retouching below operates ONLY on the skin SURFACE — never on facial structure, proportions, or features. Act as a high end makeup artist and retoucher changing only surface level items. BACKGROUND LOCK: The background of the photo (everything outside the subject) MUST be preserved IDENTICALLY to the input photo. Do NOT change the background in any way. If the input background is blurred, the output background is blurred the same way. If the input background is a specific scene, the output background is the same scene.

POLISHED RETOUCH (woman under approximately 35 years old):

Master directive: Skin renders smooth, evenly toned, and dimensional. AGGRESSIVELY even out hot spots, redness, blotchiness, and tone variation. Noticeably reduce visible fine lines and texture variation. Even out skin tone strongly, remove blemishes entirely. The result reads as 'professionally retouched magazine profile photo'.

Under-eye direction: Render the skin around the eyes rested, bright, and color corrected as if a light concealer was used under the eyes. The result reads as the same person as the input, just well-rested. NO over-smoothed under-eye area.

- TONE EVENING (AGGRESSIVE): COMPLETELY eliminate uneven redness, blotchiness, post-acne marks, sunspots, hyperpigmentation patches, and tone variation between forehead / cheeks / chin / neck. End result must read as a single even, healthy skin tone across the entire face — dimensional shading comes ONLY from lighting (highlights and shadows kept intact), NOT from blotchy color zones. Soften forehead lines and 11 lines between the eyebrows.
- ORBITAL FILL LIGHT: Illuminate the orbital sockets (the bony eye-socket area surrounding and including the under-eye region) with simulated fill light. The fill should be just slightly darker than the key light — a close-ratio fill (approximately 1:1.5 key-to-fill ratio) — which softens the natural shadow that falls inside the eye socket when only key light is present. Render the eye-socket area noticeably brighter and more lifted than it appears under raw lighting, with minimal residual shadow under the brow and no darkness under the eye.
- PORE STRUCTURE: Add or reinforce pore structure and detail across face, neck, and any visible décolletage, even if the input photo does not show clear skin texture. The end result must read as a real human face with real skin — pores visible at normal viewing distance, not erased texture.
- NO plastic skin. NO airbrushed or filter-smoothed appearance. NO doll-like or AI-tell smoothness.

Pore micro-texture preservation — applies to every tier below. Preserve the 3D micro-texture of the skin surface (the raised/recessed terrain of pores at close magnification). Pore micro-texture stays at 100% on the face, neck, and visible décolletage. The smoothing operates on surface evenness only — the pore texture itself remains visible at normal viewing distance.`;

// Polished — 35-50 (Tier 2). v3 2026-05-27: full rewrite by Kristi.
// Now SELF-CONTAINED (no IDENTITY_ANCHOR prepend, no PORE_ANCHOR append —
// own identity-preservation and pore-micro-texture language inline).
// Key changes from v2:
//   - Identity-preservation paragraph rewritten and now includes an
//     explicit BACKGROUND LOCK clause forbidding any change to anything
//     outside the subject (blurred backgrounds stay blurred, scene
//     backgrounds stay the same scene).
//   - Master directive tightened: dropped the verbose Forbes/Fast Company
//     reference and the "visible difference should be obvious" line —
//     replaced with a simpler 'professionally retouched magazine profile
//     photo' framing. Also dropped the "brighten the under-eye area to
//     neutralize shadows" clause since the dedicated Under-eye direction
//     and ORBITAL FILL LIGHT bullets cover that work.
//   - Under-eye direction: concealer descriptor changed from "concealer"
//     to "light concealer". Dropped "like a professional in her 40s who
//     slept well last night" age-narrative framing.
//   - TONE EVENING gained an explicit "Soften forehead lines and 11 lines
//     between the eyebrows" bullet (was implicit before).
//   - Pore micro-texture paragraph baked in at the bottom of the prompt
//     instead of pulled from the shared PORE_ANCHOR constant — matches
//     the Glam v8 self-contained pattern.
export const RETOUCH_POLISHED_MATURE = `Identity preservation — non-negotiable, overrides every other directive below. Preserve the subject's facial features and expression with 100% precision. The retouched face must remain UNMISTAKABLY the same person. Match the input photo EXACTLY for face shape, bone structure, all facial features, hairline, ethnicity, distinguishing marks (freckles, beauty marks, moles, scars, asymmetries). DO NOT idealize features. The retouching below operates ONLY on the skin SURFACE — never on facial structure, proportions, or features. Act as a high end makeup artist and retoucher changing only surface level items. BACKGROUND LOCK: The background of the photo (everything outside the subject) MUST be preserved IDENTICALLY to the input photo. Do NOT change the background in any way. If the input background is blurred, the output background is blurred the same way. If the input background is a specific scene, the output background is the same scene.

POLISHED RETOUCH (woman between approximately 35 and 50 years old):

Master directive: Skin renders smooth, evenly toned, and dimensional. AGGRESSIVELY even out hot spots, redness, blotchiness, and tone variation. Noticeably reduce visible fine lines and texture variation. Even out skin tone strongly, remove blemishes entirely. The result reads as 'professionally retouched magazine profile photo'.

Under-eye direction: Render the skin around the eyes rested, bright, and color corrected as if a light concealer was used under the eyes. The result reads as the same person as the input, just well-rested. NO over-smoothed under-eye area.

- TONE EVENING (AGGRESSIVE): COMPLETELY eliminate uneven redness, blotchiness, post-acne marks, sunspots, hyperpigmentation patches, and tone variation between forehead / cheeks / chin / neck. End result must read as a single even, healthy skin tone across the entire face — dimensional shading comes ONLY from lighting (highlights and shadows kept intact), NOT from blotchy color zones. Soften forehead lines and 11 lines between the eyebrows.
- ORBITAL FILL LIGHT: Illuminate the orbital sockets (the bony eye-socket area surrounding and including the under-eye region) with simulated fill light. The fill should be just slightly darker than the key light — a close-ratio fill (approximately 1:1.5 key-to-fill ratio) — which softens the natural shadow that falls inside the eye socket when only key light is present. Render the eye-socket area noticeably brighter and more lifted than it appears under raw lighting, with minimal residual shadow under the brow and no darkness under the eye.
- PORE STRUCTURE: Add or reinforce pore structure and detail across face, neck, and any visible décolletage, even if the input photo does not show clear skin texture. The end result must read as a real human face with real skin — pores visible at normal viewing distance, not erased texture.
- NO plastic skin. NO airbrushed or filter-smoothed appearance. NO doll-like or AI-tell smoothness.

Pore micro-texture preservation — applies to every tier below. Preserve the 3D micro-texture of the skin surface (the raised/recessed terrain of pores at close magnification). Pore micro-texture stays at 100% on the face, neck, and visible décolletage. The smoothing operates on surface evenness only — the pore texture itself remains visible at normal viewing distance.`;

// Polished — MALE (all ages). Added 2026-07-13 by Kristi. Men's editorial
// retouch: keeps skin texture, protects facial hair, reinforces pore
// visibility above the female tiers, and forbids any feminizing softening.
// Routed via the gender-gating wrapper in buildRetouchPrompt below — Gemini
// evaluates the subject's apparent gender and applies THIS section only when
// the subject is a man; women continue to receive the YOUNG / MATURE prompts
// above. This is Kristi's exact submitted text, verbatim.
export const RETOUCH_POLISHED_MALE = `Identity preservation — non-negotiable, overrides every other directive below. Preserve the subject's facial features and expression with 100% precision. The retouched face must remain UNMISTAKABLY the same person. Match the input photo EXACTLY for face shape, bone structure, all facial features, hairline, ethnicity, distinguishing marks (freckles, beauty marks, moles, scars, asymmetries), AND facial hair density / pattern / length / color. DO NOT idealize features. The retouching below operates ONLY on the skin SURFACE — never on facial structure, proportions, features, or facial hair. Act as a high end retoucher who specializes in men's editorial portraiture, changing only surface level items. BACKGROUND LOCK: The background of the photo (everything outside the subject) MUST be preserved IDENTICALLY to the input photo. Do NOT change the background in any way. If the input background is blurred, the output background is blurred the same way. If the input background is a specific scene, the output background is the same scene.
POLISHED RETOUCH (man):
Master directive: Keep skin texture. remove red blemishes and veins, even tone, RETAIN texture. Soften lighting hot-spots, keep fine lines, brow texture. The result reads as 'professionally retouched magazine profile photo of a confident man' no airbrushing.
FACIAL HAIR LOCK: If detected, Preserve and protect all facial hair (stubble, beard, mustache, sideburns) EXACTLY as in the input. Beards and stubble retain visible texture and grain at close inspection.
Under-eye direction: Slightly even out color around the eyes — remove dark circles. The result reads as the same person, just well-rested. Add lighting to orbital sockets. Keep visible character — keep under eye skin texture. Remove half of the crows feet. Shorten crows feet wrinkle lengths and deepness.
- TONE EVENING: Even out tone variation between forehead / cheeks / chin / neck. keep subtle shine in hotspot areas to protect form of the face. Keep and protect all freckles and identifying marks.
- BROW: Preserve exact brow shape, hair pattern, density, and stray hairs.
- PORE STRUCTURE: Add or reinforce pore structure across face and neck. Pore visibility is imperative. male skin keeps more texture in professional retouching.
- NO plastic skin. NO airbrushed look. NO smoothing. NO femininizing softening of jaw or features.
- If teeth are visible, keep their shape identical to before, remove yellow tinge and slightly brighten them.
Pore micro-texture preservation — Preserve the 3D micro-texture of the skin surface (the raised/recessed terrain of pores at close magnification). Pore micro-texture stays at 100% — should read MORE visible than female-subject retouching, especially across the cheeks, forehead, and chin.`;

// Glam (female) — all ages. v9 2026-06-21: small rewrite by Kristi.
// Only change from v8: dropped the TEETH bullet entirely. The mouth-
// and-smile lock already prevents teeth changes, and the explicit
// whitening + alignment directive was producing unnaturally bright /
// re-arranged teeth on real customer outputs.
//
// v8 history (2026-05-22 — kept for reference):
//   - Tightened identity preservation paragraph (kept the locks, dropped
//     the verbose explanation)
//   - Added SHINE bullet, EYES bullet, HAIR bullet
//   - SURFACE EVENNESS gained explicit "remove all wrinkles and 11
//     lines from forehead and area between brows"
//   - PORE STRUCTURE allows "wrinkles can be completely removed"
//   - ADD CONTOUR jawline shadow now sweeps "temples area down to
//     the chin"; slightly unsaturated bronzer specified
//   - ANTI-PLASTIC tightened
export const RETOUCH_GLAM = `Identity preservation — non-negotiable, overrides every other directive below. Preserve the subject's facial features and expression with 100% precision. The retouched face must remain UNMISTAKABLY the same person. Match EXACTLY all facial features and distinguishing mark. DO NOT change facial feature shapes. Retouching operates ONLY on the skin SURFACE — never on facial structure. Act as a high end beauty retoucher.

Background: generate identical background to the input reference photo, do not change anything in the background. Regenerate an identical background.

Crop and framing: regenerate an identical crop and zoom to the input photo. Do NOT re-crop, do NOT recompose. The output canvas and subject placement must be pixel-equivalent to the input.

JAW AND CHIN STRUCTURE LOCK: The jawbone shape, chin shape, jaw width, jaw curvature, and chin point in the output MUST match the input photo exactly. The face silhouette (the outline of the head and jaw against the background) must be IDENTICAL to the input — pixel-for-pixel. Any contouring, shadow, or bronzer technique described below is a LIGHTING/MAKEUP effect ONLY. Do NOT reshape the actual chin. MOUTH AND SMILE LOCK: Do not change mouth, smile, teeth shape or lips. The mouth, smile, lips, and teeth in the output MUST be IDENTICAL to the input photo. Do NOT open a closed mouth, do NOT create teeth if not in the input photo. If the input shows teeth, the output shows teeth in the SAME arrangement, do NOT change the smile width, do NOT change the smile shape. Lip shape, mouth corners, smile asymmetry — ALL match the input photo exactly. If the output shows a different smile than the input, you have failed this directive.

GLAM RETOUCH (editorial luxury beauty):

Master directive: Editorial, significant, beauty retouching, equivalent to beauty skin campaign skin. Skin should look like a flawless commercial-beauty-campaign examples. Extremely even and polished skin tonality, but Skin retains all pore detail; tone renders flawlessly even and illuminated. The skin around the eyes renders editorial-flawless — luminous with even tone, like a magazine beauty shot. Filled-in softbox lighting with almost no shadows, professionally retouched in post-production by a high-end beauty retoucher. Skin reads as commercial-beauty-campaign-quality but still retains all pore structure. CRITICAL IDENTITY GUARDRAIL: do not drift toward generic-pretty / AI-default features and lose the subject's actual identity — do NOT let that happen. The smoothing only applies to surface evenness. Every facial feature, every proportion, every distinguishing mark, the eye SHAPE itself, the nose, the mouth, the bone structure, the asymmetries — all of those remain UNMISTAKABLY the subject's own. Smooth the surface, not the person.

- MOUTH AND SMILE LOCK (CRITICAL — OVERRIDES EVERYTHING BELOW): The mouth, smile, lips, and teeth in the output MUST be IDENTICAL to the input photo. This is non-negotiable.
- TONE EVENING (AGGRESSIVE): Completely eliminate redness on cheeks and nose, blotchiness, post-acne marks, hyperpigmentation, sunspots, melasma, broken capillaries. Moderately even tones between forehead/cheeks/chin/neck. Even the tone but keep the highlights and shadows.
- SURFACE EVENNESS (FACE, NECK, AND DÉCOLLETAGE): Render the face, neck, AND visible décolletage as smooth, luminous, commercial-beauty skin — Remove all wrinkles and 11 lines from the forehead and the area between the brows. Apply the same surface-smoothing aggressiveness to neck and décolletage as to the face — soften visible texture, even out tone variations, remove neck horizontal lines and discoloration in those zones. The smoothing applies only to surface evenness. The skin retains pore micro-texture but its color and tone is very even.
- SHINE: remove shine from highlight areas and hot spots. Soften overly shiny areas as if the color is blended with the rest of the face.
- ADD CONTOUR: Slightly darken the sides of the nose, under the cheekbones, the skin closest to the hairline around the edges of the forehead, and the facial skin closest to the jawline. Brighten and highlight the skin on the bridge of the nose, the under-eye areas, the tops of the cheeks and the lower forehead in the center between the eye brows. Also brighten the top of the chin area. Reference the areas where makeup artists brighten and darken the face to create the illusion of a more 3-dimensional face. Act as if you are adding illuminating makeup to the areas that need brightening, and darkening makeup to the areas that need darkening. Also darken the upper eyelids near the outer corners, as if darkening eye shadow was added above the eyes. ADD A DEFINED JAWLINE SHADOW: Place visible contouring shadow along the underside of the jawline, following the jawbone from the temples area down to the chin. Treat this as slightly unsaturated bronzer applied by a high-end makeup artist to sculpt and slim the jaw. The shadow should be soft-edged but readable, defining the jawline against the neck. Do NOT darken the cheek itself — only the underside of the jaw and edges of the face.
- PORE STRUCTURE AND SKIN TEXTURE: Preserve per the pore-preservation directive below. Visible pores everywhere — the skin should still read as softened actual human skin under close inspection. Pores stay; fine lines, 11 lines, forehead lines and redness/blotchiness should be completely removed. Treat these as TWO SEPARATE concerns — texture and color — and only the small skin texture is preserved, wrinkles can be completely removed.
- ORBITAL FILL LIGHT (AGGRESSIVE): Moderately illuminate the orbital sockets (the bony eye-socket area surrounding and including the under-eye region and eyes) with bright, simulated fill light at near-key intensity. The fill should be eliminating the natural under eye shadow that falls inside the eye socket. The orbital area should render dramatically bright, approaching the brightness of the lit cheek and forehead. Reference: a beauty advertising campaign where the eye area is filled with reflected light from below and the model appears wide-eyed, lifted, and well-rested under near-shadowless lighting (beauty dish + lower reflector setup).
- EYES: brighten the insides of the bottoms of the iris. Slightly intensify native eye color and add slight saturation. Amplify contrast around the eyes. Add small catchlights in the bottoms of the iris.
- SKIN AROUND THE EYES (HIGHEST-PRIORITY): Soften on all images, regardless of current state: The under-eye area must render shadow-free and brighter than the original photo. Remove ALL darkness, ALL shadowing, and ALL discoloration from the under-eye zone. SOFTEN fine lines and creases under the eyes. Remove half of current under eye texture, but leave tiny hints of natural under eye skin texture and subtle line texture intact so the under-eye reads as 'well-rested and lifted,' NOT airbrushed or artificially smooth. Zone: the area immediately below the lower lash line, down to the top of the cheekbone, and outward to the outer corner of the eye. Bright and shadow-free, with retained subtle texture. Do NOT alter the eye shape, eyelid shape, or eye position — only the SKIN below the eye is being slightly smoothed and BRIGHTENED. Shorten wrinkles on the outer corners of the eyes by half. Give the illusion of younger eye skin.
- ANTI-PLASTIC GUARDRAIL: Glam should NEVER produce doll-like, or filter-smoothed skin. The pore preservation is the safeguard against that.
- MAKEUP: Add SUBTLE eye accent — enhancement of natural lash definition. Apply soft, thin, powder eye liner. Exaggerate or amplify whatever eye makeup level was already present in the input — only refine and lift, do not transform. Slightly darken and fill in eye brows. LIPS: do NOT alter, darken, deepen, outline, or punch lip color. Render the lips EXACTLY as they appear in the input photo — same color, same shape, same edges, same saturation.
- HAIR: Do not change color, texture or placement of hair. Add shine to hair highlights, fill in any gaps where the background is showing through. Remove distracting fly aways. Make hair slightly fuller.

Pore micro-texture preservation - Preserve the 3D micro-texture of the skin surface (the raised/recessed terrain of pores at close magnification). Pore micro-texture stays at 100% on the face, neck, and visible décolletage. The smoothing operates on surface evenness only — the pore texture itself remains visible at normal viewing distance.`;

/**
 * Build the prompt for a single retouching SUB-TIER pass.
 *
 * In the Glow Up Deluxe model, the customer-facing tier is "basic" or
 * "deluxe". Basic skips retouching entirely (no Gemini Pro call needed).
 * Deluxe fans out into TWO sub-tier passes: "polished" + "glam", run in
 * parallel against the original Realistic photo. This function returns
 * the prompt for a single sub-tier.
 */
export function buildRetouchPrompt(
  subTier: RetouchSubTier,
  ageBand: AgeBand | undefined,
): string {
  if (subTier === "polished") {
    // Gender routing (added 2026-07-13). The app never captures the customer's
    // gender — it lets Gemini read apparent gender from the photo, the same
    // convention the generation prompts use. So we hand the model BOTH the
    // men's and women's Polished prompts under an explicit "pick the one
    // matching section" instruction. Men get RETOUCH_POLISHED_MALE; women get
    // the age-appropriate YOUNG / MATURE prompt unchanged.
    const femalePrompt =
      ageBand === "young" ? RETOUCH_POLISHED_YOUNG : RETOUCH_POLISHED_MATURE;
    return `SUBJECT GENDER ROUTING — evaluate this FIRST, before reading any directive below. Look at the input photo and determine the subject's apparent gender. Then follow ONLY the single matching section below and COMPLETELY IGNORE the other section — do not blend them.

============================================================
IF THE SUBJECT APPEARS TO BE A MAN — follow ONLY this section, ignore the WOMAN section entirely:
============================================================
${RETOUCH_POLISHED_MALE}

============================================================
IF THE SUBJECT APPEARS TO BE A WOMAN — follow ONLY this section, ignore the MAN section entirely:
============================================================
${femalePrompt}`;
  }
  if (subTier === "glam") {
    return RETOUCH_GLAM;
  }
  throw new Error(
    `buildRetouchPrompt called with unexpected sub-tier: ${subTier}`,
  );
}

/**
 * Which sub-tier passes does a customer-facing tier require?
 *   basic  → no Pro calls
 *   deluxe → both Polished and Glam Pro calls in parallel
 */
export function subTiersForTier(tier: RetouchTier): RetouchSubTier[] {
  if (tier === "deluxe") return ["polished", "glam"];
  return [];
}
