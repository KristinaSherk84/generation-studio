/**
 * POST /api/generate
 *
 * Takes reference photo URLs (already uploaded to Vercel Blob) plus the user's
 * Style / Attire / Lighting / Background selections, assembles a prompt using
 * Kristi's approved v2 prompt framework, and calls Google Gemini Flash Image
 * (Nano Banana) to generate six professional headshot variations.
 *
 * Source of truth for the prompt wording: `prompt-framework-v2.md` at the
 * repo root (approved 2026-04-17). If you edit the wording here, edit the
 * markdown first and keep them in lockstep.
 *
 * Handler style: classic VercelRequest / VercelResponse pattern. Same reason
 * as /api/upload — the Fetch-style handler hangs for 5 minutes under Vercel's
 * Node runtime. Do not rewrite this in Fetch style.
 *
 * One image per call: this endpoint generates exactly ONE headshot per
 * request. The frontend fires six parallel requests so the user sees real
 * progress ("Generating headshot 2 of 6..." etc.) as each one completes,
 * AND so each call only has to fit inside Vercel's per-function timeout
 * individually rather than squeezing six generations into one 60s window.
 *
 * Timeout: image generation typically takes 20–50s per image. maxDuration=300
 * gives a safe ceiling — Vercel Pro honors it; Hobby clamps to 60s, which
 * should still be enough for a single image.
 */

import { GoogleGenAI } from "@google/genai";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// Vercel function-level config. Allow up to 5 minutes for the full 6-image run.
export const maxDuration = 300;

// -------------------- Types --------------------

// Style values (added "urban" 2026-05-01 — Kristi's style revamp). UI labels:
//   corporate    → "Corporate"
//   creative     → "Creative Natural" (renamed from "Creative" — backgrounds
//                  expanded from 2 to 3: trees, spring garden, fall colored)
//   executive    → "Executive"
//   urban        → "Urban Industrial" (NEW — combines the old Creative
//                  industrial-office background with a new urban-street one)
type Style = "corporate" | "creative" | "executive" | "urban";
type Attire = "formal" | "casual" | "keep" | "medical";
type Lighting = "studio" | "natural" | "dramatic" | "golden";
type Background =
  | "white"
  | "lightgrey"
  | "midgrey"
  | "dark"
  | "blue"
  | "green"
  | "rainbow"; // rainbow = generate each of 6 variations with a different color

type Skin = "realistic" | "polished" | "glam";

type GenerateRequest = {
  photoUrls: string[]; // Vercel Blob URLs from Step 3
  style: Style;
  attire: Attire;
  lighting: Lighting;
  background?: Background; // only used when style === "corporate"
  variationIndex: number; // 0-5; frontend fires 6 parallel calls, each with a unique index
  hasWideAngle?: boolean;
  skin?: Skin;
  // ---- Paywall enforcement (added 2026-05-15) ----
  // Exactly one of these two must be present and valid for the request to
  // be processed:
  //   - stripeSessionId: the Stripe Checkout Session ID from the $2.99
  //     entry payment. Server verifies via Stripe API that
  //     metadata.unlock_expires_at > now AND metadata.unlock_consumed !== "true".
  //   - promoCode: the env-var-defined promo code (kristi-vip-abc at time
  //     of writing). Server compares against process.env.PROMO_CODE with
  //     constant-time equality.
  // If neither is present, the request is rejected with 402 Payment Required
  // before any Gemini work happens. This is the structural fix for the leak
  // discovered 2026-05-14 where legacy localStorage unlocks were generating
  // free photos indefinitely.
  stripeSessionId?: string;
  promoCode?: string;
};

type InlineImage = { mimeType: string; data: string };

// -------------------- Prompt blocks (from Kristi's approved v2 framework) --------------------
//
// IMPORTANT: These strings come verbatim from prompt-framework-v2.md at the
// repo root. If the framework changes, edit the markdown first, then mirror
// the change here. The markdown is the source of truth for Kristi's review,
// but these constants are what actually get sent to Gemini at runtime.

// Block 1 IDENTITY — the foundational "this is who the person is" directive.
//
// History:
//   - 2026-05-01: Restructured to be the SINGLE master skin-smoothing rule.
//     Previously Block 1 had a flat 5% retouch cap and the per-skin-tier
//     overrides (Polished, Glam) had to fight against it from later in the
//     prompt. New design: Block 1 itself branches on skin choice + apparent
//     gender, with numerical per-tier smoothing percentages (Realistic OR
//     Male → 5%, Female + Polished → 35%, Female + Glam → 70%/95% under-eye).
//   - 2026-05-07: REWRITTEN AGAIN. Replaced numerical percentages with
//     descriptive aesthetic language (Kristi's photographer voice). Reason:
//     side-by-side test showed Glam vs Realistic outputs were visually
//     identical — Gemini Flash 3.1 doesn't translate "approximately 70%
//     smoothing" into actual smoothing levels. Community research
//     (Google's official prompting guide, dev forums, Skylum/Banana
//     Thumbnail blogs) confirmed image models respond to descriptive
//     aesthetic cues (visual references like "Vogue cover," "Lightroom
//     retouch by working photographer," "natural-light portrait") far
//     more reliably than to numerical targets. Three tiers now described
//     by aesthetic outcome rather than percentage.
//
// Tier matrix (resolved by Gemini at inference from refs + req.skin):
//   Realistic OR Male  → "un-retouched, authentically real, natural-light portrait"
//   Female + Polished  → "slightly retouched and realistic, senior executive's website"
//   Female + Glam      → "Vogue cover / L'Oréal beauty campaign, editorial luxury"
//
// Pore preservation is universal at 100% across all tiers — smoothing
// applies to wrinkles/lines/tone, not to pore micro-texture.
//
// The Skin Polished and Skin Glam blocks (still injected based on user
// choice) layer additional tone-evening + editorial finish direction on
// top of Block 1's per-tier aesthetic. The aesthetic is owned by Block 1.
// 2026-05-19 cleanup: stripped ~half of the original block. Removed the
// gendered Polished/Glam skin-smoothing branches, the per-tier reference-
// fidelity anchor, the pore micro-texture rule, and the 10% jawline-
// refinement allowance — all of which were Path A relics from when initial
// generation handled retouching. In the Glow Up Deluxe (Path B) model,
// retouching is a separate post-purchase Gemini Pro pass via /api/retouch
// with its own dedicated prompts in api/lib/retouchPrompts.ts. Initial
// generation only needs to do ONE thing now: render this specific person
// realistically. The diagnosis: cumulative prompt bloat from leftover
// Path A directives was burying identity preservation and pulling Flash
// 3.1 toward generic stock-photo output (see Ken's bad-render incident
// 2026-05-19).
const BLOCK_1_IDENTITY = `Generate a professional headshot of the person shown in the reference photos.

IDENTITY PRESERVATION (RULE #1 — NON-NEGOTIABLE, OVERRIDES EVERY OTHER DIRECTIVE IN THIS PROMPT):

Preserve the subject's facial features with 100% precision. The generated face must be UNMISTAKABLY the same person. Match the reference photos EXACTLY for:
- Face shape and facial proportions
- Bone structure (cheekbones, jawline, brow ridge, chin shape)
- Eye shape, eye color, eyelid shape, eye spacing, brow shape
- Nose shape, nose width, nostril shape, nose tip
- Mouth shape, lip thickness, lip width, mouth corners
- Hairline
- Skin tone and ethnicity
- All distinguishing marks: freckles, beauty marks, moles, scars, dimples, asymmetries

DO NOT idealize features. DO NOT blend toward generic 'attractive' proportions, or AI-default beauty. DO NOT alter the structural asymmetries that make this person them. NO identity drift. Maintain and keep eye asymmetry, unique nose and chin characteristics. Protect uneven smiles. Keep all asymmetrical BONE/STRUCTURE.

SKIN RENDERING: Render extremely realistic skin texture, exactly as it appears in the reference photos. Remove blemishes only. Keep pores, freckles, moles, texture. Render authentically real skin — no airbrushed look. If no skin texture is visible in reference photos, add texture and skin details for realism.

REFERENCE IMAGE PROCESSING: If any reference photo metadata shows it was taken with a wide-angle lens (phone selfies commonly distort the nose and mid-face), correct the lens distortion in the generated image so the face appears as if photographed with a prime 85mm or 135mm portrait lens — slight compression of features, natural proportions, no bulging nose or elongated jaw.`;

// Block UNDER_EYE — age-aware under-eye rendering for women.
//
// History:
//   - 2026-04-24 v1: Initial rule — softer under-eye for women <30, preserve
//     texture for 30+.
//   - 2026-04-24 v2: "AGGRESSIVELY SMOOTH" / "eliminate ALL" language.
//     Backfired — Block 7's anti-AI-tell defense triggered.
//   - 2026-04-24 v3: Measured language, "70% reduction," region-localized,
//     framed as professional Lightroom retouch.
//   - 2026-04-24 v4: 70% → 60% per Kristi's tuning.
//   - 2026-04-24 v5 (current): TIERED by age band. Side-by-side test of two
//     subjects (one mid-30s, one late-30s/40s) showed v4 worked great on
//     the younger subject but the older one came back with pronounced lines
//     because Gemini classified her as 35+ and applied the "preserve" rule.
//     The 35+ "preserve" tier is where most working-professional headshot
//     subjects land, and it was producing the most complaints. Split into
//     three bands so the 35-50 group (where pronounced lines actually appear
//     and need correction) gets MORE reduction than the under-35 group
//     (which already has minimal lines and was previously over-corrected
//     into uncanny territory at 60%).
//
// Tiered rates (Kristi confirmed 2026-04-24):
//   - Under 35   → 40% reduction (light touch — younger skin needs less)
//   - 35–50      → 55% reduction (heavier — where pronounced lines live)
//   - 50 or older → preserve natural texture (no softening, reads authentic)
const BLOCK_UNDER_EYE = `Under-eye rule (women only). Use reference photos' under-eye condition as a reference but moderately improve under-eye skin appearance. Do not invent shadows, lines, or fatigue that aren't visible in the references. For men: no special rule.`;

// Block SKIN_POLISHED — TONE-EVENING companion to Block 1's Polished tier.
//
// Restructured 2026-05-01: Block 1 now owns the smoothing PERCENTAGE for all
// three skin tiers (Polished women → 35% face smoothing). This block layers
// TONE direction (color evenness, pore reinforcement) on top of that baseline.
// Smoothing % is no longer specified here — it's set by Block 1 and Block 7
// reinforces pore preservation universally.
//
// Block is gender-gated inside the prompt itself: it only fires for women.
// For men the block is injected but the body says "ignore for men" — so
// Gemini reads it, evaluates apparent gender, and applies as appropriate.
const BLOCK_SKIN_POLISHED = `Polished tone allowance (women only — ignore for men). When references show uneven skintone (redness, blotchiness, post-acne marks, sunspots, hyperpigmentation), render with a more even, healthy tone. Preserve all natural pore texture, fine lines, and identity features. No plastic, airbrushed, doll-like, or filter-smoothed skin. Detailed retouching is applied in a separate post-generation pass.`;

// Block SKIN_GLAM — TONE-EVENING + EDITORIAL FINISH companion to Block 1's
// Glam tier.
//
// Restructured 2026-05-01: Block 1 now owns the smoothing PERCENTAGE
// (Glam women → 70% face smoothing). This block layers tone evening, pore-vs-
// blotchy distinction, and editorial luminosity direction on top of that
// baseline. The wrinkle-reduction percentage is no longer duplicated here —
// it's set by Block 1, which avoids the conflicting-directives averaging
// problem that produced too many wrinkles in earlier Glam outputs.
//
// Glam continues to OVERRIDE Block UNDER_EYE — when Glam is the user's
// choice, the under-eye gets Glam-level smoothing per Block 1 regardless of
// apparent age, and BLOCK_UNDER_EYE is NOT injected by assemblePrompt below.
//
// Like the other skin blocks, Glam is gender-gated internally. Men's
// treatment never changes.
const BLOCK_SKIN_GLAM = `Glamorous editorial allowance (women only — ignore for men). When references show uneven skintone (redness, blotchiness, post-acne marks, hyperpigmentation, sunspots, broken capillaries), render with a more even, luminous tone. Preserve all natural pore texture, fine lines, and identity features. No plastic, doll-like, or filter-smoothed skin. Editorial-level smoothing and final polish are applied in a separate post-generation retouch pass — do NOT attempt them here.`;

// Block PET — conditional override that only applies when the subject is an
// animal rather than a human. Added 2026-04-23 to support the #professionalpets
// virality angle Kristi is leaning into on the landing page. The dignified
// (not costume-y) framing is load-bearing: the gag only shares widely if the
// portrait is plausibly real, so we lean hard into "real tailoring" and "LinkedIn
// headshot a working photographer might take." Gemini self-detects whether the
// reference photos show a human or an animal and applies the rule accordingly,
// so this block is always present in the prompt — it simply no-ops for humans.
//
// 2026-04-24 update: Kristi wanted 3 female + 3 male professional attire
// options mixed across a 6-image batch so the grid feels varied rather than
// all-masculine (old block defaulted to shirt+tie / bow tie). We now rotate
// through PET_ATTIRE_VARIATIONS, interleaving F/M/F/M/F/M across variationIndex
// 0–5. Each call gets ONE specific attire description — Gemini commits to it
// rather than picking randomly.
const PET_ATTIRE_VARIATIONS: string[] = [
  // 0 — female
  "a tailored silk blouse or fine-knit top with a soft feminine neckline (crew neck, V-neck, or tasteful scoop) in a neutral or muted color",
  // 1 — male
  "a crisp collared dress shirt with a necktie in a classic business color (charcoal, navy, deep burgundy)",
  // 2 — female
  "a well-tailored slim-fit blazer in a neutral color over a feminine blouse with a soft neckline",
  // 3 — male
  "a silk bow tie with a crisp collared dress shirt — classic formal menswear",
  // 4 — female
  "an elegant cardigan or soft structured sweater layered over a delicate top, optionally with a subtle pearl or scarf accent",
  // 5 — male
  "a well-tailored blazer in charcoal or navy over a collared dress shirt",
];

function buildBlockPet(variationIndex: number): string {
  const attire =
    PET_ATTIRE_VARIATIONS[variationIndex] ?? PET_ATTIRE_VARIATIONS[0];
  return `If the subject in the reference photos is an animal (dog, cat, horse, or other pet) rather than a human, still generate a dignified professional portrait of that specific animal. Preserve the animal's exact species, breed, coloring, markings, ear shape, and any distinguishing features with absolute precision — this is a specific animal, not a generic one. For this specific photograph, dress the animal in ${attire}, convincingly scaled to the animal's body so it reads as genuine tailoring — NOT a costume, NOT a hat, NOT a sticker. The clothing must be clearly visible and intentional. Across a full batch of 6 pet portraits, half the variations will feature feminine-coded professional attire and half masculine-coded, giving the owner a varied grid rather than a single aesthetic — do not second-guess the attire direction in this block based on the animal's perceived gender. All other direction in this prompt (lighting, background, framing, expression) still applies, adapted to the animal's anatomy. The final portrait should look like a real LinkedIn headshot that a working photographer might take — dignified, not comedic. That plausibility is what makes it share-worthy.`;
}

const BLOCK_2_COMPOSITION = `Frame as a professional business headshot. The specific body angle and crop are specified in the variation block at the end of this prompt — follow those instructions precisely. General rules:
- Extremely minimal headroom above the top of the head. Only add 2–3% of the total frame height above the top of the head. The top of the head should nearly touch the top of the frame. No empty space above the head.
- The subject's face should occupy the top third to top half of the frame.
- Strong posture, proud posture with shoulders back. Classic subject-to-lens relationship (head rotated slightly back toward the lens).`;

// Block 3 Style base text (no background) per style.
//
// Style revamp 2026-05-01:
//   - "creative" is now "Creative Natural" in the UI — purely outdoor nature
//     backgrounds (trees, spring garden, fall colored). The old industrial-
//     office background moved out of Creative entirely into the new "urban"
//     style. Voice still TED-stage / approachable.
//   - "urban" (NEW) = "Urban Industrial" in the UI — modern lifestyle / on-
//     location feel with city or modern interior backgrounds. Combines the
//     old industrial-office bokeh with a new urban-street one.
const BLOCK_3_STYLE_BASE: Record<Style, string> = {
  corporate: `Style: Clean, neutral, trustworthy. Modern corporate LinkedIn aesthetic. Subtle confidence, approachable but professional — senior individual contributor at a Fortune 500, director-level energy. Background matches the color specified below at approximately 80% fidelity with subtle spot-and-gradient variation within the single image (no hard edges, soft vignette). Absolutely zero expressionless eyes. The eyes must be realistic, active, engaged, and smiling.`,
  creative: `Style: Warm, approachable, personable, with a clear outdoor or natural-environment feel. Softer edges than corporate. Hints of personality — a senior creative, a consultant, or a thought leader who does keynote talks. Less "Wall Street," more "TED stage outdoors." The lighting reads as natural daylight even when shot in a studio — never artificial-fluorescent or harsh-direct. Absolutely zero expressionless eyes. The expression must be realistic, active, engaged, and smiling.`,
  executive: `Style: Bold, authoritative, commanding. Strong presence — reads as "in charge." Darker tones, higher contrast, more gravitas — C-suite or board member energy. Background is deep and moody: near-black charcoal, deep gradient to black at the edges, or dark architectural backdrop softly blurred. Hair rim light is essential for separation. Directional lighting is welcome (see lighting rule below), but the downward-facing planes of the face must never fall into deep shadow — the eye sockets, under the nose, the nasolabial folds, and under the chin all stay well-filled so the subject's eyes are clearly visible and expressive. The realistic expression leans fierce and captivating rather than warm-and-smiling: "ready to take on the world," the knowing look that says "I have a secret I'm not telling you," a confident realistic half-smile that pulls the viewer in.`,
  urban: `Style: Modern, on-location, lifestyle. Reads as a polished professional photographed in a real city environment — a downtown senior tech leader, a designer, a content creator with executive presence. The "I just walked out for coffee" professional vibe — unstuffy but elevated. Background is always a real urban setting (city street, modern office interior) rendered with extreme bokeh so no specific location is identifiable. Absolutely zero expressionless eyes. The expression must be realistic, active, engaged.`,
};

// Background variants — the frontend passes variationIndex 0-5; the
// buildBlock3Style logic distributes backgrounds across that range so a full
// batch of 6 returns a mixed grid rather than 6 of the same scene.

// CREATIVE NATURAL (3 backgrounds × 2 variations each = 2/2/2 split):
const CREATIVE_BG_TREES = `Background: A distant outdoor natural setting, very bokeh heavy — green-foliage trees placed 50+ feet behind the subject — photographed with the most extreme creamy bokeh imaginable (as if shot on a 200mm lens at f/1.2 on a full-frame camera). The background must be SO heavily blurred that you CANNOT identify any specific tree, trunk, branch, or leaf. What should be visible: large creamy bokeh orbs, abstract painterly washes of green and gold, soft dappled highlights. What must NOT be visible: any recognizable tree, branch structure, leaf shape, or specific object. If a viewer could point to a tree and say "that's an oak," the blur is not strong enough. Think impressionist painting, not photograph of a forest.`;

const CREATIVE_BG_SPRING_GARDEN = `Background: A spring garden in full bloom — cherry blossoms, magnolias, dogwoods, peonies, or wisteria at the peak of their flowering season — placed 50+ feet behind the subject and photographed with the most extreme creamy bokeh imaginable (as if shot on a 200mm lens at f/1.2 on a full-frame camera). The background must be SO heavily blurred that you CANNOT identify any specific flower, branch, or petal. What should be visible: large creamy bokeh orbs in soft pinks, whites, lavenders, pale corals, with hints of fresh pale-green leaves; abstract painterly washes of color; gentle dappled highlights. What must NOT be visible: any recognizable flower head, individual petal, leaf, or branch. Think impressionist painting of a garden in May — not a photograph of one.`;

const CREATIVE_BG_FALL_TREES = `Background: A distant outdoor autumn setting at peak fall foliage — maples, oaks, and birches in their full color range from gold and amber through burnt orange and deep crimson, with hints of remaining green — placed 50+ feet behind the subject and photographed with the most extreme creamy bokeh imaginable (as if shot on a 200mm lens at f/1.2 on a full-frame camera). The background must be SO heavily blurred that you CANNOT identify any specific tree, branch, or leaf. What should be visible: large creamy bokeh orbs in warm autumn tones (gold, amber, rust, deep red, occasional emerald), abstract painterly washes of warm color, soft dappled highlights. What must NOT be visible: any recognizable tree, branch structure, or leaf shape. Think impressionist painting of New England in October — not a photograph of one.`;

// URBAN INDUSTRIAL (2 backgrounds × 3 variations each = 3/3 split):
const URBAN_BG_INDUSTRIAL = `Background: A bright, modern industrial office interior — exposed concrete, steel beams, polished wood, large windows flooded with natural daylight. Photographed with extreme bokeh blur (as if shot on a 200mm lens at f/1.2 with the background 40+ feet behind the subject). The background must be SO heavily blurred that NO specific beam, window, wall, surface, or object is identifiable. What should be visible: soft ambient light, abstract geometric washes in light grey, white, and warm wood tones, gentle out-of-focus highlights. What must NOT be visible: any recognizable architectural detail, specific window mullion, visible beam, door, or piece of furniture. Think "ambient light and color washes," not "photo of an office."`;

const URBAN_BG_STREET = `Background: A city sidewalk and storefronts at golden hour — brick facades, shop windows, awnings, railings, the subtle suggestion of distant pedestrians. Architectural elements placed 40+ feet behind the subject, photographed with the most extreme creamy bokeh imaginable (as if shot on a 200mm lens at f/1.2 on a full-frame camera). The background must be SO heavily blurred that NO specific sign, doorway, window mullion, person, or business is identifiable. What should be visible: warm afternoon golden-hour light, soft architectural color washes (warm brick reds, deep stone greys, warm window glows), gentle out-of-focus highlights. What must NOT be visible: any recognizable storefront, sign text, doorway, pedestrian, or vehicle. Think "lifestyle headshot taken on a charming city street" — but the street itself is a soft impressionist wash of warm tones, not a recognizable place.`;

function buildBlock3Style(style: Style, variationIndex: number): string {
  // Corporate / Executive: no rotating background — Block 3 is the full style,
  // and Corporate also gets a separate user-picked Block 6 background appended
  // later by assemblePrompt.
  if (style === "corporate" || style === "executive") {
    return BLOCK_3_STYLE_BASE[style];
  }

  if (style === "creative") {
    // 3 outdoor-natural backgrounds × 2 variations each = 2/2/2 split.
    // Indices 0,3 = trees; 1,4 = spring garden; 2,5 = fall colored trees.
    const creativeBgs = [
      CREATIVE_BG_TREES,         // 0
      CREATIVE_BG_SPRING_GARDEN, // 1
      CREATIVE_BG_FALL_TREES,    // 2
      CREATIVE_BG_TREES,         // 3
      CREATIVE_BG_SPRING_GARDEN, // 4
      CREATIVE_BG_FALL_TREES,    // 5
    ];
    const bg = creativeBgs[variationIndex] ?? CREATIVE_BG_TREES;
    return `${BLOCK_3_STYLE_BASE.creative}\n\n${bg}`;
  }

  if (style === "urban") {
    // 2 backgrounds × 3 variations each = 3/3 split.
    // Even indices = industrial office, odd = street.
    const bg = variationIndex % 2 === 0 ? URBAN_BG_INDUSTRIAL : URBAN_BG_STREET;
    return `${BLOCK_3_STYLE_BASE.urban}\n\n${bg}`;
  }

  // Defensive default — shouldn't be reachable since Style type is exhaustive.
  return BLOCK_3_STYLE_BASE[style];
}

const BLOCK_4_ATTIRE_STATIC: Record<Exclude<Attire, "medical">, string> = {
  formal: `Attire: A polished formal business look, tailored to the subject's apparent gender as determined from the reference photos.
- If the subject appears to be a MAN: a well-tailored suit jacket in a neutral color (charcoal, navy, or black) over a crisp collared dress shirt. A necktie is optional based on what flatters the subject's face shape and the overall style.
- If the subject appears to be a WOMAN: a well-tailored slim-fit blazer in a neutral color (charcoal, navy, or black) over a professional blouse, silk top, or fine knit top with a clean, feminine neckline (crew neck, V-neck, open collar, or tasteful scoop). NEVER a necktie. NEVER a men's business shirt with a men's tie. The silhouette should read clearly as women's business attire — softer shoulder, feminine cut, tailored to a woman's frame.
Well-tailored and intentional in either case — not boxy, not ill-fitting.`,
  casual: `Attire: Smart professional attire without a full suit. Options: blazer over an open-collar shirt, knit polo, tailored sweater, or structured blouse. Relaxed but intentional. Favor attire that creates vertical lines guiding the viewer's eye toward the face — a suit jacket, a dark cardigan forming a V-shape, or a structured collar.`,
  keep: `Attire: Preserve the clothing visible in the reference photos as faithfully as possible. Do not change the garment type, color, neckline, or style.`,
};

// Medical attire — 6 distinct variants rotated across the 6-image batch
// (variationIndex 0-5). Three lab-coat variants + three scrubs colors.
// Added 2026-05-04 per Kristi for the healthcare-professional vertical.
//
// CRITICAL universal rule for ALL medical variants: NO names, badges,
// hospital logos, embroidered text, ID lanyards, or any other text-bearing
// element on the garments. Gemini routinely hallucinates gibberish hospital
// names + fake credentials when given medical attire prompts; we forbid
// every text-rendering surface explicitly to head this off.
const MEDICAL_ATTIRE_VARIATIONS: string[] = [
  // 0 — Doctor's white coat over collared shirt OR blouse (gender-aware)
  `A DOCTOR'S WHITE COAT (also called a physician's white coat or medical lab coat). NOT a suit jacket, NOT a blazer, NOT a sport coat. The garment must clearly read as a doctor's white coat — pure white color, simple notched collar (no formal suit lapels), worn open or with the top button only. Underneath, GENDER-AWARE: if the subject appears to be a MAN, a crisp collared dress shirt in a clean neutral color (white, light blue, or pale grey). If the subject appears to be a WOMAN, a soft feminine blouse, fine-knit top, or silk shell with a clean neckline (cream, blush, light grey, or pale blue). NO necktie either way. The white of the coat must dominate the image.`,
  // 1 — Doctor's white coat over BABY BLUE scrubs
  `A DOCTOR'S WHITE COAT (physician's white coat / medical lab coat) worn open over medical SCRUBS visible at the V-neck. NOT a suit jacket, NOT a blazer. The white coat must be pure white and dominate the upper torso. Beneath the coat, only the V-neck of the scrubs is visible — scrubs color: BABY BLUE (soft, pale, slightly desaturated blue — NOT royal blue, NOT navy). The look reads as a doctor mid-shift wearing a white coat over baby blue scrubs.`,
  // 2 — Doctor's white coat over NAVY scrubs
  `A DOCTOR'S WHITE COAT (physician's white coat / medical lab coat) worn open over medical SCRUBS visible at the V-neck. NOT a suit jacket, NOT a blazer. The white coat must be pure white and dominate the upper torso. Beneath the coat, only the V-neck of the scrubs is visible — scrubs color: NAVY BLUE (deep classic navy — NOT royal blue, NOT baby blue). The look reads as a doctor mid-shift wearing a white coat over navy scrubs. CRITICAL: the dominant color in the image MUST be the white coat. If navy dominates, the rendering is wrong — Gemini sometimes mistakes "navy scrubs under white coat" for "navy suit jacket"; this variant must NOT render as a suit.`,
  // 3 — Scrubs in baby blue (no white coat)
  `Medical SCRUBS only (no white coat) — short-sleeve V-neck medical scrub top in BABY BLUE (soft, pale, slightly desaturated blue — NOT royal blue, NOT navy). The garment must clearly read as hospital scrubs: loose drape, V-neck collar, short sleeves, unstructured. NOT a t-shirt, NOT a polo, NOT workout wear.`,
  // 4 — Scrubs in navy blue (no white coat)
  `Medical SCRUBS only (no white coat) — short-sleeve V-neck medical scrub top in NAVY BLUE (deep classic navy — NOT royal blue, NOT baby blue, NOT black). The garment must clearly read as hospital scrubs: loose drape, V-neck collar, short sleeves, unstructured. NOT a t-shirt, NOT a polo, NOT a sweater.`,
  // 5 — Scrubs in medical green (no white coat)
  `Medical SCRUBS only (no white coat) — short-sleeve V-neck medical scrub top in MEDICAL GREEN (the classic surgical / OR scrub-green color — a muted blue-green or teal-green, sometimes called "scrub green" or "ceil"). NOT bright kelly green, NOT lime, NOT olive, NOT forest. The garment must clearly read as hospital scrubs: loose drape, V-neck collar, short sleeves, unstructured.`,
];

const MEDICAL_GUARDRAILS_RULE = `CRITICAL MEDICAL ATTIRE GUARDRAILS — these override any default rendering tendencies:

1. NO TEXT, BADGES, OR LOGOS on any medical garment. Forbidden: name tags, ID badges, embroidered names or credentials on the white coat or scrubs, hospital crests/logos, lanyards with text, stethoscopes with engraved text, conference badges, or any other surface that could render as text. Plain unbranded medical garments only. If you would normally add a name embroidered on the chest pocket, DO NOT — leave the chest area clean and unmarked.

2. NEVER substitute a SUIT JACKET, BLAZER, or SPORT COAT for the doctor's white coat. The medical garment must always read as a physician's white coat (long, white, notched collar, worn open) or as scrubs (V-neck, loose, short sleeves) — depending on the variant specified above. If the prompt above says "white coat," the rendering must be a white doctor's coat — never a navy/charcoal business jacket, even if other style cues might suggest one.

3. The dominant garment color in this image must match the variant specified above. If the variant says "white coat," white must dominate. If "baby blue scrubs," baby blue must dominate. Do not blend toward a different color than specified.`;

function buildBlock4Attire(attire: Attire, variationIndex: number): string {
  if (attire === "medical") {
    const variant =
      MEDICAL_ATTIRE_VARIATIONS[
        Math.max(0, Math.min(MEDICAL_ATTIRE_VARIATIONS.length - 1, variationIndex))
      ];
    return `Attire: ${variant}\n\n${MEDICAL_GUARDRAILS_RULE}`;
  }
  return BLOCK_4_ATTIRE_STATIC[attire];
}

const BLOCK_5_LIGHTING: Record<Lighting, string> = {
  studio: `Lighting: Broad, soft key light placed slightly above and in front of the subject — a large soft box or beauty dish. A dedicated fill light source (not a passive bounce card — an actual light) on the shadow side at roughly a 1:1.2 ratio with the key, meaning the fill is barely darker than the key. Aggressive under-eye / under-nose / nasolabial fill light from a low frontal position — the goal is to COMPLETELY ELIMINATE shadows in the eye sockets, under the nose, in the nasolabial folds (smile-line creases), under the brow ridge, and on the cheeks. Skin under those features must read as evenly lit as the rest of the face — no shadow at all in those zones, only smooth even illumination. Multiple clean catchlights in the eyes from the key, fill, and under-eye fill sources. THE ONLY PERMITTED SHADOW on the entire face/neck region is a soft, narrow gradient under the jawline (lower jaw + upper neck) — preserve that to give the subject jaw definition and separation from the body. Cheek shadows: zero. Forehead shadows: zero. Nose shadows: zero. Eye-socket shadows: zero. Side-of-face gradient (away from key): preserved only as the gentlest possible falloff, never reading as "shadow side" of the face.`,
  natural: `Lighting: Large window light as key, angled at roughly 45 degrees to the subject. Warm 4000K–5000K color temperature. Gentle fall-off to the shadow side, but the shadow side still receives significant warm bounced fill light from multiple angles — reflective surfaces behind the photographer, a large bounce below the subject, and ambient room light. Organic and slightly directional, but never leaving deep shadows. Warm light is welcome; unfilled shadows are not.`,
  dramatic: `Lighting: Soft but directional. A large, extremely feathered key light — diffused and gentle in quality — but positioned so the light falls UNEVENLY across the face. For THIS image, choose ONE of these two patterns:
- Side-lit: the key illuminates primarily ONE side of the face; the opposite side falls into gentle shadow. Classic split or short-light pattern.
- Center-lit: the key catches the CENTER of the face, with soft fall-off on both sides toward the ears and jawline. Butterfly or feathered clamshell pattern.
Include a subtle fill from below the subject to soften — not eliminate — the under-eye, under-nose, and under-chin shadows, just enough that the face reads clearly. Keep medium shadows present for a shaped, directional look; do not over-fill or flatten the lighting. Hair rim light preserves separation. Background falls to near-black. Both eyes must always carry at least one visible catchlight.`,
  golden: `Lighting: Warm, low-angled light as if from a late-afternoon sun. Hair rim light from behind. Strong bounced fill on the shadow side — not a subtle lift, but enough fill to keep all downward-facing planes of the face well-lit (under the brow, under the nose, under the chin). Warm color grade, but skin tones stay true — no orange cast.`,
};

// Block 6 is only used for Corporate. Creative and Executive get background
// direction from Block 3 (self-contained).
const BLOCK_6_BACKGROUND: Record<Exclude<Background, "rainbow">, string> = {
  white: `Background: Seamless white, clean, slight gradient to avoid pure flat. Subject clearly separated from background.`,
  lightgrey: `Background: Neutral light grey seamless, gentle vignette, hint of texture (not solid color), subtle spot-and-gradient variation within the single image.`,
  midgrey: `Background: Medium grey seamless, classic editorial portrait feel, subtle gradient within the single image. Hair light to separate from the background.`,
  dark: `Background: Near-black charcoal with slight gradient to deeper black at edges. Hair rim light essential for separation. Subtle spot-and-gradient variation within the single image.`,
  blue: `Background: Muted dusty blue, tranquil but professional. Not saturated. Subtle spot-and-gradient variation within the single image. Subject must always pop from the background.`,
  green: `Background: Muted sage / moss green, natural and warm without tipping into "outdoor" feel. Subtle spot-and-gradient variation within the single image. Subject must always pop from the background.`,
};

// Three accent colors used ONLY by Rainbow — they aren't offered as standalone
// swatches in the Corporate background picker. Kept here so Rainbow has 6
// distinct colors (3 from BLOCK_6_BACKGROUND above + these 3).
const BG_BEIGE = `Background: Warm beige / cream seamless, a soft neutral with warm undertones. Subtle spot-and-gradient variation within the single image, gentle vignette. Skin tones should look warm and flattering against it. Subject must pop from the background.`;
const BG_BURGUNDY = `Background: Deep muted burgundy seamless — a rich, slightly desaturated wine/oxblood tone. Sophisticated, classic, not aggressive. Subtle spot-and-gradient variation within the single image, gentle vignette. Hair rim light to separate the subject from the background.`;
const BG_TEAL = `Background: Deep muted teal seamless — a cool, refined blue-green, not saturated. Professional editorial feel. Subtle spot-and-gradient variation within the single image. Hair rim light essential for separation.`;

// Rainbow chooses a different color for each variationIndex so a single batch
// of 6 generations returns 6 different backgrounds — three from the standard
// swatches, three new accent colors. The fixed ordering below makes the grid
// read predictably: light → dark → cool → warm → bold → refined.
function buildBlock6Background(background: Background, variationIndex: number): string {
  if (background !== "rainbow") {
    return BLOCK_6_BACKGROUND[background];
  }
  const rainbow = [
    BLOCK_6_BACKGROUND.lightgrey, // 0: light neutral
    BLOCK_6_BACKGROUND.dark,      // 1: dark neutral
    BLOCK_6_BACKGROUND.blue,      // 2: cool (dusty blue)
    BG_BEIGE,                     // 3: warm neutral
    BG_BURGUNDY,                  // 4: warm accent
    BG_TEAL,                      // 5: cool accent
  ];
  // Safe fallback: if somehow variationIndex is out of range, default to light grey.
  return rainbow[variationIndex] ?? BLOCK_6_BACKGROUND.lightgrey;
}

// Block 7 TECHNICAL — fires LAST in the prompt, so its language has strong
// "final word" weight on Gemini.
//
// History:
//   - 2026-05-01 v1: simplified to a flat universal rule that deferred to
//     Block 1 for smoothing amounts and used "no plastic skin" as a universal
//     anti-AI-tell guardrail. Worked OK for Realistic/Polished but the
//     "preserve pore micro-texture and real skin surface" + "do NOT produce
//     plastic, doll-like, filter-smoothed, or AI-tell skin" final-word
//     language was quietly fighting Glam's 70%/95% smoothing — Gemini was
//     averaging those directives and leaving forehead lines, the "11"
//     between brows, crow's feet, and under-eye texture visible at full
//     reference-photo intensity even on Glam.
//   - 2026-05-07 v2 (current): restored tier-awareness via a function. For
//     Glam the final-word REINFORCES Block 1's smoothing percentages and
//     names the specific failure points (forehead lines, "11", crow's feet,
//     under-eye texture). For Realistic/Polished the language stays close
//     to v1's anti-plastic guardrail but tightens "real skin surface" to
//     "3D pore micro-texture only" to remove the same ambiguity. Realistic/
//     Polished also adds an explicit "redness and broken capillaries can be
//     color corrected" allowance.
function buildBlock7Technical(skin: Skin | undefined): string {
  if (skin === "glam") {
    return `Technical quality: 2048-pixel resolution, sharp focus on the eyes, eyelashes visible. Skin: Apply Block 1's Glam aesthetic (Vogue cover / L'Oréal beauty campaign — flawlessly even and illuminated). The customer paid for an editorial luxury beauty result and expects it. Preserve the 3D pore micro-texture (the raised/recessed surface terrain visible at close magnification) — that is what keeps the skin from reading as plastic or AI-rendered. Do NOT produce: doll-like featurelessness, filter-smoothed featureless skin, AI-default beauty patterns, or mannequin skin. DO produce: editorial luminous skin with visible pore micro-texture beneath the smoothing — high-end magazine cover where the model still has visible pores at close inspection. Very shallow depth of field — subject's face in perfect focus, shoulders softly falling off, background noticeably blurred. Professional color grading: accurate skin tones, no color cast, slight warmth in shadows. No visible artifacts, no uncanny valley. This is a commercial-grade photograph, extremely realistic — not an illustration, render, or composite.`;
  }
  return `Technical quality: 2048-pixel resolution, sharp focus on the eyes, eyelashes visible. Skin: Preserve the 3D pore micro-texture (the raised/recessed surface terrain at close magnification) per Block 1's directive. Apply Block 1's per-tier descriptive aesthetic (Realistic = un-retouched authentic natural-light portrait for men or anyone who chose Realistic; Polished = light Lightroom retouch / senior executive's company website for women who chose Polished) to wrinkles, fine lines, and tone unevenness — those are NOT pores. Do NOT produce plastic, doll-like, filter-smoothed, or AI-tell skin — the pore micro-texture preservation is the safeguard against that. Very shallow depth of field — subject's face in perfect focus, shoulders softly falling off, background noticeably blurred. Professional color grading: accurate skin tones, no color cast, slight warmth in shadows. No visible artifacts, no uncanny valley. This is a commercial-grade photograph, extremely realistic — not an illustration, render, or composite. Skin redness and broken blood vessels can be color corrected to match surrounding skin tone colorations.`;
}

// Block LENS_CORRECTION — fires ONLY when the client's EXIF read found
// focal length <40mm (35mm-equivalent) on any reference photo. This is much
// stronger wording than Block 1's "if it APPEARS wide-angle..." because here
// we KNOW it was. Shoots straight for "phone selfie" distortion patterns.
//
// Added 2026-04-21. Client flag wired in App.tsx via the exifr library.
const BLOCK_LENS_CORRECTION = `CRITICAL LENS CORRECTION: The reference photos were CONFIRMED via EXIF metadata to be shot with a wide-angle lens (35mm-equivalent focal length under 40mm — typically a phone selfie camera at 24–28mm equivalent). Wide-angle lenses create predictable facial distortion: the nose appears ENLARGED and pushed forward, the mid-face (cheeks, forehead) appears stretched and bulged toward the viewer, and the ears / jawline appear pushed back and foreshortened. FULLY CORRECT this distortion in the generated headshot. Render the subject's face as if photographed with a prime 85mm or 135mm portrait lens on a full-frame camera: the nose sits in correct proportion to the cheeks and jaw, the face reads naturally compressed and flattering, no bulging nose or mid-face, no stretched forehead, no "selfie face." This correction is MANDATORY — it is a bigger problem than any other quality issue in the output.`;

// Block EYEWEAR — quick-win glasses-preservation rule (added 2026-04-20).
//
// Context: beta tester's reference photos ALL showed him wearing glasses (one
// clear-frame professional pair, one pink-tinted casual sunglasses). V1
// generated headshots with no glasses. This block tells Gemini to keep the
// glasses when the subject consistently wears them — without us having to run
// a separate detection pass. Roadmap item #11 tracks the full detection-based
// V1.1 version; this is the "tide us over" fix.
//
// Preference rules baked in:
//   1. Only preserve glasses if the subject appears to wear them in most/all
//      reference photos (keeps the prompt from hallucinating glasses onto
//      someone who isn't wearing any).
//   2. Prefer clear-lens professional frames over tinted/sunglasses frames,
//      because headshots are almost always a clear-lens context.
//   3. Do NOT add glasses if the subject isn't wearing any in the reference
//      photos — this must never become an accessory invention.
const BLOCK_EYEWEAR = `Eyewear: Only if the subject is wearing clear eyeglasses in most or all of the reference photos, preserve the same glasses in the generated headshot — match the frame shape, frame color, and material as closely as possible. Remove all tint and all reflections from lenses. If the subject is NOT wearing glasses in the reference photos, do NOT add glasses.`;

// Block HAIR — same pattern as Block EYEWEAR. Added 2026-05-01 after Kristi
// noticed that when reference photos showed the subject with hair both DOWN
// (loose, flowing, framing the face) and TIED BACK (ponytail, bun, clip),
// Gemini was sometimes picking the tied-back style for the headshot. Down
// hair is the more flattering and editorial choice for a professional
// portrait, so when the reference set is mixed, we tell Gemini to prefer
// down. When unanimous (all down or all tied back), match the reference.
//
// 2026-05-01 update: made skin-aware. For Glam (red-carpet / editorial
// tier) we lean even more toward hair-down. The default rule already
// handles "any hair down → all down" via the mixed-references branch,
// but for Glam we additionally do a 50/50 split across the 6 variations
// when ALL references are hair-back: half match references (hair back)
// and half render hair down — so a Glam customer who only uploaded
// hair-up shots still sees 3 hair-down options in their grid. Realistic
// and Polished keep the original strict-match rule.
const BLOCK_HAIR_DEFAULT = `CRITICAL HAIR STYLING RULE: Match hair styles from reference photos.

- If ALL reference photos show the same hair style (all hair down OR all hair tied back / up / clipped), match that style exactly.

- If reference photo hairstyles are mixed (some down, some tied back), the generated headshot MUST render hair DOWN — loose, flowing, framing the face. This is non-negotiable when the references are mixed.

Match hair length, color, texture, density, and natural part to the reference photos.`;

function buildBlockHair(skin: Skin | undefined, variationIndex: number): string {
  if (skin === "glam") {
    // Even indices (0, 2, 4) render hair DOWN when refs are unanimously back;
    // odd indices (1, 3, 5) match the references. So a 6-image batch returns
    // 3 hair-back + 3 hair-down even when no reference shows hair down.
    const isDownVariant = variationIndex % 2 === 0;
    const allBackBranch = isDownVariant
      ? "RENDER HAIR DOWN. Even though no reference photo shows the hair down, the customer chose Glam (the editorial / red-carpet tier) and benefits from seeing some variations with hair down. Use the subject's apparent hair length, color, texture, density, and natural part as inferred from the references — render the hair as it would naturally fall when worn loose. Do NOT invent a different cut, color, or length. Just take the hair the references show pulled back and let it down naturally."
      : "MATCH THE REFERENCE PHOTOS exactly — render the hair tied back / up in the same specific style shown in the references (ponytail, bun, clip, slicked-back, French twist, whatever the references show). Match the natural hair length, color, texture, density, and part visible in the references.";
    return `CRITICAL HAIR STYLING RULE (Glam tier — favors editorial hair-down look):

Step 1 — Evaluate the reference photos and determine which case applies:

CASE A: At least ONE reference photo shows the subject's hair DOWN (loose, flowing, or partially framing the face).
ACTION: Render the generated headshot with hair DOWN, matching the subject's natural length, color, texture, density, and natural part. This is non-negotiable when even one reference photo has hair down — hair down is the more flattering and editorial choice for the Glam tier.

CASE B: ALL reference photos show the subject's hair tied back, up, in a ponytail, bun, clip, slicked back, or otherwise pulled away from the face — NO reference photo shows hair down.
ACTION: This generation is variation index ${variationIndex} of 6. ${allBackBranch}

CASE C: Only one or two reference photos exist and the styling is ambiguous.
ACTION: Render hair DOWN.

When generating hair-down: render the hair as the subject's natural length and texture would actually look when worn down — not slicked back, not pulled tight, not held off the face. Frame the face naturally with the hair.

Always match the subject's actual hair length, color, texture, density, and natural part. Do NOT invent a different cut, lengthen or shorten the hair, or change its natural flow or color.

For subjects with very short hair (under approximately chin length), no styling decision applies — just match the reference photos exactly.`;
  }

  // Realistic and Polished keep the original universal rule.
  return BLOCK_HAIR_DEFAULT;
}

// Smile-style fidelity rule (added 2026-05-15 per recurring customer
// feedback about "weird AI teeth"). The per-slot FLAVORS array below
// mixes closed-mouth and teeth-showing expressions — slot 0 is a closed
// mouth, slot 2 is teeth-showing, slot 4 is closed, etc. If the subject
// naturally smiles with their mouth closed in real life, forcing AI teeth
// onto them produces uncanny results that read as "obviously AI."
//
// Fix without adding a vision-detection step: tell Gemini explicitly that
// the references are the source of truth for smile style. The model can
// already see whether the reference photos show teeth — we just need to
// give it permission (and instruction) to override the per-slot direction
// when references unanimously show closed-mouth smiles.
const BLOCK_SMILE_FIDELITY = `SMILE STYLE FIDELITY RULE: Look carefully at the reference photos before deciding what kind of smile to render in this image.

- If ALL reference photos show the subject with a closed-mouth smile (no teeth visible in any reference), generate a closed-mouth smile in this image too — EVEN IF the per-image expression directive in the variation block below asks for a teeth-showing or "open" smile. The expression directive is a suggestion; reference fidelity overrides it. Closed-mouth subjects who are forced into teeth-showing smiles by AI generation produce visibly uncanny, "AI-looking" teeth. The warmth of the smile comes from cheek lift and slight eye-squint — neither of which requires visible teeth.

- If AT LEAST ONE reference photo clearly shows the subject smiling with teeth visible in a natural open smile, the per-image expression directive applies as written — teeth-showing smiles are appropriate. When you render teeth, match the subject's reference teeth closely: keep the same alignment, shape, size, spacing, and natural irregularities. A slight brightening or de-yellowing is fine — the subject can look like they just had a routine cleaning. Do NOT straighten or align the teeth. Do NOT enlarge or plump them. Do NOT remove gaps, chips, overlaps, slight rotations, or other distinctive features. The teeth should still look like the customer's teeth — just at their best — not like generic "Hollywood-perfect" teeth.

- When in doubt about whether teeth are visible in the references, default to a closed-mouth smile. Closed-mouth smiles are universally flattering; uncanny AI-generated teeth ruin a headshot.

The subject's natural smile style AND the recognizable appearance of the subject's teeth — as evidenced by their reference photos — are more important than the slot-level variation in this batch.`;

// Block 8 — Single-photo variation instruction.
//
// The frontend fires SIX parallel requests, each with a different variationIndex
// (0–5). This function selects one "flavor" from the FLAVORS array and formats
// it as a per-photo direction. Each call produces exactly ONE photograph — not
// a grid, not a contact sheet — with its own expression, body pose, crop, and
// (optionally) attire detail.

type Flavor = {
  expression: string;
  bodyPose: string;
  crop: string;
  attireHint: string; // only applied when attire !== "keep"
};

const FLAVORS: Flavor[] = [
  {
    expression: "subtle closed-mouth realistic smile, warm and composed — the mouth stays gentle, but the EYES smile clearly: slight crinkle at the outer corners, upper cheeks lifted, the unmistakable warm-eye Duchenne smile that reads as genuine joy. Under no circumstances flat, neutral, or blank eyes",
    bodyPose: "body squared to camera, shoulders relaxed",
    crop: "tighter crop — from just above the top of the head to the collarbone",
    attireHint: "shirt or top in crisp white",
  },
  {
    expression: "soft realistic open smile, approachable",
    bodyPose: "body turned approximately 10 degrees to the subject's left, head rotated slightly back toward the lens",
    crop: "medium crop — from just above the top of the head to the upper chest",
    attireHint: "shirt or top in a soft light blue",
  },
  {
    expression: "warm realistic teeth-showing smile, genuine and bright",
    bodyPose: "body turned approximately 15 degrees to the subject's right, head rotated slightly back toward the lens",
    crop: "medium crop — from just above the top of the head to the upper chest",
    attireHint: "shirt or top in a soft pastel tone (blush, cream, or pale grey)",
  },
  {
    expression: "knowing realistic half-smile, confident and poised — mouth stays composed with a subtle lift on one side, but the EYES smile clearly: slight crinkle at the outer corners, upper cheeks lifted, warm Duchenne-style smile-eyes that read as engaged and in-on-the-moment. Under no circumstances flat, neutral, or blank eyes",
    bodyPose: "body squared to camera, shoulders relaxed",
    crop: "wider crop — more shoulder and upper chest visible",
    attireHint: "a subtly different jacket or top in a mid-tone, well-tailored",
  },
  {
    expression: "confident warm realistic expression with slight smile, engaged eyes",
    bodyPose: "body turned approximately 5 degrees to the subject's right",
    crop: "tighter crop — from just above the top of the head to the collarbone",
    attireHint: "a darker-tone option — charcoal or deep navy",
  },
  {
    expression: "natural easy realistic smile, relaxed and personable",
    bodyPose: "body turned approximately 10 degrees to the subject's left",
    crop: "medium crop — from just above the top of the head to the upper chest",
    attireHint: "a subtly textured option within the category (pinstripe, herringbone, or fine knit)",
  },
];

// 2026-05-07: buildBlock8 gained a third `skin` parameter so the Glam tier
// can inject a final-position override targeting the under-eye and outer-
// eye-corner skin specifically. Earlier prompt edits to Block 1 / SKIN_GLAM
// / Block 7 moved Glam smoothing only marginally, because Block 8's
// per-image expression directives (the FLAVORS array) sit far closer to
// the model's "what to render in THIS image" reasoning than the abstract
// per-tier smoothing percentages do — and natural smile rendering produces
// crow's feet and under-eye scrunch lines as a biomechanical side-effect
// even when FLAVORS doesn't explicitly request them. The Glam override
// here lives at the bottom of buildBlock8's output (just above the single-
// image structural constraint) so it has near-final-word weight while
// keeping the "one photograph, not a grid" directive last.
function buildBlock8(
  attire: Attire,
  variationIndex: number,
  skin: Skin | undefined,
): string {
  // Defensive: clamp index into the valid range.
  const flavor = FLAVORS[Math.max(0, Math.min(FLAVORS.length - 1, variationIndex))];

  const outfitLine =
    attire === "keep"
      ? `- Outfit: Preserve the exact clothing from the reference photos — do not change the garment type, color, neckline, or style.`
      : `- Outfit detail: ${flavor.attireHint}. This must stay firmly within the attire category specified above.`;

  // For women on Polished or Glam tiers, add a final-position reference-
  // fidelity anchor right before the output constraint. This is the single
  // most important sentence for under-eye behavior — it tells Gemini to
  // match the reference photos rather than auto-inventing texture.
  const womenSkinAnchor =
    skin === "polished" || skin === "glam"
      ? `\n\nFINAL SKIN FIDELITY ANCHOR: Match the reference photos' actual skin condition around the eyes. If the references show smooth, well-rested skin around the eyes, the generated photograph renders smooth, well-rested skin around the eyes. Do not add fine lines, shadows, or signs of fatigue that aren't visible in the references.`
      : "";

  const glamUnderEyeOverride =
    skin === "glam"
      ? `\n\nGLAM-TIER FINAL OVERRIDE: The expression above creates a warm, engaged, smiling subject — preserve that 100%. The skin around the eyes renders editorial-flawless: soft, smooth, luminous, magazine-beauty-shot quality. The smile-eyes warmth comes ENTIRELY from cheek lift, slight squint, eye sparkle, and catchlights. Think Vogue cover.`
      : "";

  return `Photograph direction for this single image:
- Expression: ${flavor.expression}. Eyes must look alert, engaged, and realistic — never blank, glazed, doll-like, or expressionless.
- Body and head: ${flavor.bodyPose}.
- Framing: ${flavor.crop}.
${outfitLine}

REFERENCE PHOTO USAGE RULE: The uploaded reference photos are provided ONLY so you can learn the subject's facial likeness — face shape, features, hair, skin tone. You MUST NOT copy, sample, or draw inspiration from the reference photos' backgrounds, environments, colors, lighting, or scenes. The new photograph's background and lighting come ENTIRELY from the direction in the prompt above — ignore anything visible behind or around the subject in the reference photos.${womenSkinAnchor}${glamUnderEyeOverride}

FINAL IDENTITY CHECK (most important rule in this entire prompt): Above all else, the face in this output must look UNMISTAKABLY like the person in the reference photos — same face shape, same bone structure, same eye shape and color, same nose, same mouth, same hairline, same ethnicity, same distinguishing marks. If the generated face wouldn't be recognized by a coworker, friend, or family member at first glance, you have failed this image. The style, lighting, and outfit directives above NEVER override identity. Do NOT default to a generic professional-headshot face. Do NOT blend toward stock-photo proportions. This is THIS SPECIFIC PERSON in a new setting, not a generic professional in their general age and ethnic range.

IMPORTANT OUTPUT CONSTRAINT: Return exactly ONE single photograph. Do NOT return a grid, contact sheet, collage, multi-panel image, side-by-side comparison, or any composition containing more than one headshot. One photo only.`;
}

// -------------------- Prompt assembly --------------------

function assemblePrompt(req: GenerateRequest): string {
  const parts: string[] = [BLOCK_1_IDENTITY];

  // BLOCK_UNDER_EYE refines Block 1's under-eye behavior based on the
  // subject's apparent age — young women get smoother under-eye rendering;
  // women 30+ keep realistic texture. We DO NOT inject this when the user
  // selected Glam — Glam handles the under-eye as part of overall heavy
  // smoothing and the per-age rules would just confuse Gemini.
  if (req.skin !== "glam") {
    parts.push(BLOCK_UNDER_EYE);
  }

  // buildBlockPet sits right after identity so Gemini evaluates "is this a
  // pet?" before it starts applying gendered-human attire rules from
  // Block 4. Order matters: if Block 4 fires first, the model is already
  // committed to a human interpretation by the time it reads the pet rule.
  // variationIndex picks one of 6 attire options (3 feminine + 3 masculine)
  // so a full batch returns a varied grid.
  parts.push(buildBlockPet(req.variationIndex));
  parts.push(BLOCK_2_COMPOSITION);
  parts.push(buildBlock3Style(req.style, req.variationIndex));
  parts.push(buildBlock4Attire(req.attire, req.variationIndex));
  parts.push(BLOCK_EYEWEAR);
  parts.push(buildBlockHair(req.skin, req.variationIndex));
  parts.push(BLOCK_5_LIGHTING[req.lighting]);

  // Wide-angle lens detected on the client via EXIF? Append the stronger
  // correction block so Gemini KNOWS the distortion is present rather than
  // guessing from pixels.
  if (req.hasWideAngle) {
    parts.push(BLOCK_LENS_CORRECTION);
  }

  // Skin toggle (women only — each block self-gates internally for men).
  // The descriptive aesthetic for each tier lives in Block 1 (Realistic =
  // un-retouched natural-light portrait, Polished = light Lightroom retouch
  // for a senior executive, Glam = Vogue cover / L'Oréal beauty campaign);
  // these companion blocks add tone-evening and editorial finish direction
  // on top of that baseline.
  // - "realistic" or unset: no companion block (Block 1 + UNDER_EYE only).
  // - "polished": layered on top of UNDER_EYE — tone-evening + pore reinforcement.
  // - "glam": OVERRIDES UNDER_EYE (we already skipped injecting UNDER_EYE
  //   above) — aggressive tone evening + editorial luminosity.
  if (req.skin === "polished") {
    parts.push(BLOCK_SKIN_POLISHED);
  } else if (req.skin === "glam") {
    parts.push(BLOCK_SKIN_GLAM);
  }

  // Block 6 Background is ONLY for Corporate. Creative / Executive get their
  // background direction embedded in Block 3 itself. Rainbow routes through
  // buildBlock6Background so each variationIndex gets a different color.
  if (req.style === "corporate" && req.background) {
    parts.push(buildBlock6Background(req.background, req.variationIndex));
  }

  parts.push(buildBlock7Technical(req.skin));
  parts.push(buildBlock8(req.attire, req.variationIndex, req.skin));

  // Smile-style fidelity rule — INTENTIONALLY LAST IN THE PROMPT
  // (2026-05-19 position fix). Tells Gemini to match the smile style of
  // the reference photos (closed-mouth references → closed-mouth output)
  // and to OVERRIDE the per-slot expression directive in Block 8 when
  // the references unanimously show closed mouths.
  //
  // Why this is last: Kristi found that with this block placed earlier
  // in the prompt, the model would still follow Block 8's "teeth-showing
  // smile" directive even when references were all closed-mouth (recency
  // bias — Block 8 was the last thing the model read about expressions).
  // Moving the fidelity rule to LAST position gives it the recency
  // advantage, so the override takes effect.
  parts.push(BLOCK_SMILE_FIDELITY);

  return parts.join("\n\n");
}

// -------------------- Reference photo fetching --------------------

// LAZY-LOADED skin pre-filter. We do NOT import preFilterReference at the
// top of the file — its transitive imports (@vladmandic/face-api +
// @tensorflow/tfjs) sometimes throw at module-load time in the Vercel
// runtime (native binding incompat, missing browser globals, etc.). A
// throw at module-load takes down the WHOLE generate.ts module and ALL
// 6 parallel generations fail with no useful error.
//
// Instead: dynamically import the pre-filter on first use, inside a
// try/catch. If anything in the import chain fails, we set the cached
// pre-filter to null and the rest of generate.ts works exactly like
// before — no pre-filter, original references go straight to Gemini.
type PreFilterFn = (bytes: Buffer, skin?: Skin) => Promise<Buffer>;
let _preFilterCache: PreFilterFn | null = null;
let _preFilterAttempted = false;

async function loadPreFilterOnce(): Promise<PreFilterFn | null> {
  if (_preFilterAttempted) return _preFilterCache;
  _preFilterAttempted = true;
  try {
    const mod = await import("./lib/skin/index.js");
    _preFilterCache = mod.preFilterReference;
    console.log("[skin] pre-filter loaded successfully");
  } catch (err) {
    // Log the error message as its own short log line FIRST so Vercel's
    // message-column truncation in the dashboard doesn't swallow the
    // actual cause (as happened repeatedly when chasing the tfjs ESM
    // failures — the truncated view showed "[skin] failed to load
    // pre-f..." with the real error hidden after the prefix). Stack trace
    // gets its own line too.
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? err.stack : undefined;
    console.warn("[skin] LOAD-ERR:", errMsg);
    if (errStack) {
      console.warn("[skin] LOAD-STACK:", errStack);
    }
    console.warn("[skin] pre-filter disabled for this function instance");
    _preFilterCache = null;
  }
  return _preFilterCache;
}

// Fetch a Vercel Blob URL and convert to the inline base64 format Gemini wants.
// On Polished / Glam tiers, the reference passes through the skin
// pre-filter first (lazily loaded — see above). Any failure in the
// pre-filter falls back to the original reference, so generation always
// completes regardless of pre-filter health.
async function fetchPhotoAsInlineData(
  url: string,
  skin?: Skin,
): Promise<InlineImage> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch reference photo (${response.status}): ${url}`);
  }
  const contentType = response.headers.get("content-type") || "image/jpeg";
  const arrayBuffer = await response.arrayBuffer();
  // Annotate as plain `Buffer` so the later assignment from the
  // pre-filter (which returns a different Buffer<ArrayBuffer> generic)
  // type-checks cleanly. Without this, TypeScript narrows the type to
  // Buffer<ArrayBufferLike> based on the Buffer.from overload and the
  // later assignment `buffer = filtered` fails.
  let buffer: Buffer = Buffer.from(arrayBuffer);
  let preFilterApplied = false;

  // Only attempt pre-filter for the tiers that need it.
  if (skin === "polished" || skin === "glam") {
    const preFilter = await loadPreFilterOnce();
    if (preFilter) {
      const originalSize = buffer.length;
      try {
        const filtered = await preFilter(buffer, skin);
        if (filtered !== buffer) {
          buffer = filtered;
          preFilterApplied = true;
          console.log(
            `[skin] pre-filter APPLIED (skin=${skin}, ${originalSize} → ${filtered.length} bytes)`,
          );
        } else {
          // preFilter returned the original unchanged. This means
          // landmark detection failed, or model files weren't found,
          // or the input is somehow bypassing smoothing. Important to
          // surface — Glam customers paid for smoothing they're not
          // getting.
          console.warn(
            `[skin] pre-filter returned ORIGINAL unchanged (skin=${skin}) — no smoothing applied. Likely cause: no face detected, model files missing, or smoothing intensity is zero.`,
          );
        }
      } catch (err) {
        // Per-call failure — log and use original. Doesn't disable
        // the cache (next call might succeed if it was a transient
        // issue like a bad input).
        console.warn(
          "[skin] preFilter call failed, using original reference:",
          err instanceof Error ? err.message : String(err),
        );
      }
    } else {
      // loadPreFilterOnce returned null — face-api import failed at
      // cold-start. This is a permanent failure for this function
      // instance. Important to surface on every call so we can see it
      // in any log, not just the first call after cold start.
      console.warn(
        `[skin] pre-filter is DISABLED for this function instance (skin=${skin}) — face-api failed to load`,
      );
    }
  }

  return {
    // If we applied the pre-filter the result is JPEG (re-encoded at
    // quality 92). Otherwise keep the original content type so Gemini
    // sees the correct format.
    mimeType: preFilterApplied ? "image/jpeg" : contentType,
    data: buffer.toString("base64"),
  };
}

// -------------------- Gemini call --------------------

// Per-attempt timeout. Gemini occasionally returns a long-tail latency
// (one request takes 2-3 min while others return in 30s) — typically
// because the request was routed to a slow worker. Better to abort
// after 60s and retry on a different worker than to sit indefinitely.
//
// 60s rationale (tightened 2026-05-14 after a 504 in Vercel logs):
// the previous 90s × 5 attempts could run 457s worst-case, blowing
// past Vercel's 300s function maxDuration if two attempts hung the
// full timeout. 60s × 4 attempts (see retryGeminiOnTransientError
// below) caps worst-case at ~243s including backoffs, with plenty of
// margin under the 300s cap. 60s still covers the typical 30-50s
// success latency.
const PER_ATTEMPT_TIMEOUT_MS = 60_000;

async function generateOneHeadshot(
  ai: GoogleGenAI,
  prompt: string,
  photos: InlineImage[],
): Promise<string> {
  const apiCall = ai.models.generateContent({
    // Model history on this project:
    //  - gemini-3-pro-image-preview (Nano Banana Pro): hit 429 rate limits on
    //    fresh Tier 1 projects (2026-04-18). Swapped out.
    //  - gemini-2.5-flash-image (Nano Banana 1): worked but delivered
    //    occasional 503 UNAVAILABLE capacity errors (2026-04-20) and had
    //    weaker face-likeness than we wanted.
    //  - gemini-3.1-flash-image-preview (Nano Banana 2): released 2026-02-26.
    //    Same Flash tier / same Tier 1 limits, but noticeably better subject
    //    consistency than 2.5 Flash. Used 2026-04-20 → 2026-05-07. Hedges on
    //    smoothing directives — Glam tier never reached its 70%/95% targets
    //    even with prompt restructuring on 2026-05-07.
    //  - gemini-3-pro-image-preview (Nano Banana Pro): RETRIED 2026-05-07
    //    to address Flash's prompt-hedging on Glam smoothing. ALL 6
    //    GENERATIONS FAILED on first test — same symptom as 2026-04-18.
    //    Reverted to Flash 3.1 the same day to restore service. Need to
    //    investigate the actual API error (rate limit / 400 / timeout)
    //    via Vercel function logs before retrying. Do NOT swap back to
    //    Pro until the failure mode is understood.
    //  - gemini-3.1-flash-image-preview (Nano Banana 2, current): reverted
    //    here 2026-05-07 after the Pro retry failed. Same model used
    //    2026-04-20 → 2026-05-07. Hedges on Glam smoothing directives but
    //    is at least reliable. Glam smoothing problem still open — need
    //    a different solution approach.
    model: "gemini-3.1-flash-image-preview",
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          ...photos.map((photo) => ({
            inlineData: { mimeType: photo.mimeType, data: photo.data },
          })),
        ],
      },
    ],
    // responseModalities is required — without it the API returns text only.
    // imageConfig controls aspect ratio and resolution; 3:4 matches our grid
    // card and 2K hits the 2048px spec from Block 7 Technical.
    config: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: {
        aspectRatio: "3:4",
        imageSize: "2K",
      },
    },
  });

  // Race the API call against a hard timeout. If Gemini hasn't replied in
  // PER_ATTEMPT_TIMEOUT_MS, throw a retryable error so the caller can
  // retry on a fresh worker rather than sitting here for the full Vercel
  // function maxDuration (currently 300s).
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`Gemini timeout after ${PER_ATTEMPT_TIMEOUT_MS}ms`)),
      PER_ATTEMPT_TIMEOUT_MS,
    );
  });
  const response = await Promise.race([apiCall, timeoutPromise]);

  const candidate = response.candidates?.[0];
  if (!candidate?.content?.parts) {
    throw new Error("Gemini returned no candidate");
  }
  const imagePart = candidate.content.parts.find((p) => p.inlineData);
  if (!imagePart?.inlineData?.data) {
    throw new Error("Gemini returned no image data");
  }
  const mime = imagePart.inlineData.mimeType || "image/png";
  return `data:${mime};base64,${imagePart.inlineData.data}`;
}

// -------------------- Retry wrapper --------------------
//
// Google's image models occasionally return transient errors — most commonly
// 503 UNAVAILABLE (model overloaded) and 429 RESOURCE_EXHAUSTED (rate limits
// for the quota window). Both usually clear within a couple of seconds. We
// retry up to 3 times total with exponential backoff. Non-transient errors
// (bad prompt, auth failure, wrong model name, validation errors) propagate
// immediately — retrying won't help and just wastes the user's time.

function isRetryableGeminiError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;
  // The @google/genai SDK serializes the API error body into .message, so the
  // JSON "code" and "status" fields are literally present in the string.
  if (msg.includes('"code":503') || msg.includes("UNAVAILABLE")) return true;
  if (msg.includes('"code":429') || msg.includes("RESOURCE_EXHAUSTED")) return true;
  // Transient network hiccups also worth one more try.
  if (msg.includes("ECONNRESET") || msg.includes("ETIMEDOUT")) return true;
  if (msg.includes("fetch failed")) return true;
  // Our own per-attempt timeout — a stuck Gemini call we aborted. Retry on
  // a fresh worker rather than sitting indefinitely.
  if (msg.includes("Gemini timeout after")) return true;
  return false;
}

async function generateOneHeadshotWithRetry(
  ai: GoogleGenAI,
  prompt: string,
  photos: InlineImage[],
  // History:
  //  - 3 attempts (original)
  //  - Bumped from 3 → 5 on 2026-05-06 to absorb gemini-3.1-flash-image-preview's
  //    well-documented 503 server-overload issues on Tier 1 paid accounts (Google
  //    forum: discuss.ai.google.dev/t/persistent-503-server-overloaded-errors-on-
  //    gemini-3-1-flash-image-preview-tier-1-paid-account/134665).
  //  - Reduced from 5 → 4 on 2026-05-14 after a Vercel 504 in production. Root
  //    cause: PER_ATTEMPT_TIMEOUT_MS is 60s (was 90s, now tightened — see comment
  //    on that constant). 5 × 60s + backoffs could still run ~307s in the worst
  //    case if every attempt hung the full timeout, dangerously close to the
  //    300s Vercel function maxDuration. 4 × 60s + 3.5s backoffs caps at ~243s
  //    with safe margin.
  //
  // Worst case timing (4 attempts, 60s timeout each):
  //   60 + 0.5 + 60 + 1 + 60 + 2 + 60 = 243.5s
  //   Backoffs: 500ms, 1000ms, 2000ms (3 backoffs between 4 attempts).
  // Versus Vercel maxDuration: 300s. Safety margin: ~56s.
  maxAttempts = 4,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await generateOneHeadshot(ai, prompt, photos);
    } catch (error) {
      lastError = error;
      // Give up immediately if this isn't the kind of error that benefits from
      // a retry, or if we're already on the last attempt.
      if (attempt === maxAttempts || !isRetryableGeminiError(error)) {
        throw error;
      }
      // Exponential backoff: 500ms, 1s, 2s, 4s. Plus up to 300ms jitter so
      // six parallel callers don't all hit Google again at exactly the same
      // millisecond. Shorter than the previous 1s/2s baseline because the
      // bottleneck isn't OUR rate — it's Google's worker pool being busy,
      // and there's no point waiting 16s between attempts when 1-2s is
      // enough for the pool to rotate.
      const baseDelay = 500 * Math.pow(2, attempt - 1); // 500, 1000, 2000, 4000
      const jitter = Math.floor(Math.random() * 300);
      const delay = baseDelay + jitter;
      console.warn(
        `Gemini returned transient error on attempt ${attempt}/${maxAttempts}; ` +
          `retrying in ${delay}ms: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  // Unreachable in practice — the loop either returns on success or throws on
  // failure. The explicit throw keeps TypeScript happy about the return type.
  throw lastError;
}

// -------------------- Handler --------------------

// ---- Paywall verification ----
//
// Returns { ok: true } if the request carries either a valid Stripe session
// ID OR the correct promo code. Returns { ok: false, reason } otherwise.
// Stripe path: GET the Checkout Session via Stripe API and check metadata
// fields written by /api/verify-checkout when the entry payment confirmed:
//   - metadata.unlock_expires_at: epoch ms; must be in the future
//   - metadata.unlock_consumed: must NOT be "true" (burned by /api/deliver
//     when the user successfully downloads a photo)
// Promo path: compare the submitted code against process.env.PROMO_CODE
// with constant-time equality so timing attacks can't probe the code.
type UnlockCheck =
  | { ok: true; via: "stripe"; sessionId: string }
  | { ok: true; via: "promo" }
  | { ok: false; reason: "missing" | "expired" | "consumed" | "invalid" };

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function verifyUnlock(
  stripeSessionId: string | undefined,
  promoCode: string | undefined,
  stripeSecretKey: string,
): Promise<UnlockCheck> {
  // Promo path takes precedence — cheaper (no network call) and the promo
  // code is a power-user bypass that Kristi gates by sharing manually.
  //
  // Case-insensitive compare (lowercased both sides) — matches the behavior
  // of /api/verify-promo. The landing-page input force-uppercases the user's
  // typed code before submission, while PROMO_CODE in Vercel env is likely
  // stored lowercase. Without lowercasing here, verify-promo accepts the
  // code at the landing screen but /api/generate then 402's every call.
  // Bug found 2026-05-18.
  if (promoCode && typeof promoCode === "string") {
    const envCode = process.env.PROMO_CODE;
    if (
      envCode &&
      constantTimeEquals(
        promoCode.trim().toLowerCase(),
        envCode.trim().toLowerCase(),
      )
    ) {
      return { ok: true, via: "promo" };
    }
    // Fall through to stripe check if a promo was sent but didn't match —
    // a client might pass both for some defensive reason. Don't 402 yet.
  }

  if (!stripeSessionId || typeof stripeSessionId !== "string") {
    return { ok: false, reason: "missing" };
  }
  if (!stripeSessionId.startsWith("cs_")) {
    return { ok: false, reason: "invalid" };
  }

  try {
    const resp = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(stripeSessionId)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${stripeSecretKey}` },
      },
    );
    if (!resp.ok) {
      console.warn(
        JSON.stringify({
          type: "unlock_verify_stripe_fetch_failed",
          status: resp.status,
          sessionId: stripeSessionId,
        }),
      );
      return { ok: false, reason: "invalid" };
    }
    const session = (await resp.json()) as {
      payment_status?: string;
      metadata?: Record<string, string> | null;
      payment_intent?: { status?: string } | string | null;
    };

    // Sanity check: only sessions actually paid for can unlock anything.
    // Mirrors the paid:true logic in /api/verify-checkout (handles Cash
    // App Pay async settlement via PI.status === "succeeded" too).
    const piStatus =
      session.payment_intent && typeof session.payment_intent === "object"
        ? session.payment_intent.status
        : undefined;
    const isPaid =
      session.payment_status === "paid" || piStatus === "succeeded";
    if (!isPaid) {
      return { ok: false, reason: "invalid" };
    }

    const consumed = session.metadata?.unlock_consumed === "true";
    if (consumed) {
      return { ok: false, reason: "consumed" };
    }

    const expiresAtRaw = session.metadata?.unlock_expires_at;
    const expiresAt = expiresAtRaw ? Number(expiresAtRaw) : NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
      // Defensive: if metadata wasn't written (e.g., verify-checkout
      // hadn't run yet on this session), treat as invalid. The user
      // should re-trigger verification by reloading.
      return { ok: false, reason: "invalid" };
    }
    if (Date.now() > expiresAt) {
      return { ok: false, reason: "expired" };
    }

    return { ok: true, via: "stripe", sessionId: stripeSessionId };
  } catch (err) {
    console.warn(
      "unlock verification threw:",
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, reason: "invalid" };
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse | void> {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ---- Validate inputs (cheap, fail fast) ----
  const body = req.body as Partial<GenerateRequest>;

  // ---- Paywall gate: verify the caller has a valid unlock BEFORE doing
  //      any expensive Gemini work. Returns 402 Payment Required with a
  //      reason code the client can use to display the right error UI
  //      (expired → "your 2-hour window ran out, pay again"; consumed →
  //      "you already downloaded, this unlock is spent"; missing/invalid
  //      → "you need to pay $2.99 to use the generator"). ----
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    return res
      .status(500)
      .json({ error: "Server missing STRIPE_SECRET_KEY" });
  }
  const unlock = await verifyUnlock(
    body.stripeSessionId,
    body.promoCode,
    stripeSecretKey,
  );
  if (!unlock.ok) {
    return res.status(402).json({
      error: "Payment required",
      reason: unlock.reason,
    });
  }

  if (
    !body.photoUrls ||
    !Array.isArray(body.photoUrls) ||
    body.photoUrls.length < 5
  ) {
    // Minimum bumped from 3 → 5 on 2026-05-15 per Kristi: more reference
    // photos = better "look like you" output = higher keeper-buy rate.
    // Frontend validation in src/App.tsx matches this server check; both
    // must move together so the user doesn't sneak past the UI gate.
    return res.status(400).json({ error: "At least 5 reference photos required" });
  }
  if (!body.style || !["corporate", "creative", "executive", "urban"].includes(body.style)) {
    return res.status(400).json({ error: "Invalid style" });
  }
  if (!body.attire || !["formal", "casual", "keep", "medical"].includes(body.attire)) {
    return res.status(400).json({ error: "Invalid attire" });
  }
  if (
    !body.lighting ||
    !["studio", "natural", "dramatic", "golden"].includes(body.lighting)
  ) {
    return res.status(400).json({ error: "Invalid lighting" });
  }
  if (
    body.style === "corporate" &&
    body.background &&
    !["white", "lightgrey", "midgrey", "dark", "blue", "green", "rainbow"].includes(body.background)
  ) {
    return res.status(400).json({ error: "Invalid background" });
  }
  if (
    typeof body.variationIndex !== "number" ||
    body.variationIndex < 0 ||
    body.variationIndex > 5 ||
    !Number.isInteger(body.variationIndex)
  ) {
    return res.status(400).json({ error: "variationIndex must be an integer between 0 and 5" });
  }
  // skin is optional; if present, must be a known value. Default behavior
  // (no block injected) when omitted or set to "realistic".
  if (body.skin && !["realistic", "polished", "glam"].includes(body.skin)) {
    return res.status(400).json({ error: "Invalid skin" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server missing GEMINI_API_KEY" });
  }

  try {
    // ---- Fetch all reference photos in parallel ----
    // The pre-filter runs inside fetchPhotoAsInlineData when skin is
    // Polished or Glam — it detects 68 landmarks, builds a smooth-zone
    // mask, and applies frequency-separation smoothing. For Realistic
    // (or undefined) it's a no-op.
    const photos = await Promise.all(
      body.photoUrls.map((url) => fetchPhotoAsInlineData(url, body.skin)),
    );

    // ---- Assemble the prompt from Kristi's v2 framework ----
    const prompt = assemblePrompt(body as GenerateRequest);

    // ---- Generate ONE headshot. The frontend calls this six times in
    //      parallel so it can show real per-image progress to the user. The
    //      retry wrapper absorbs transient 503/429 hiccups from Google. ----
    const ai = new GoogleGenAI({ apiKey });
    const image = await generateOneHeadshotWithRetry(ai, prompt, photos);

    return res.status(200).json({ image });
  } catch (error) {
    // Log full error details to Vercel Runtime Logs so we can see exactly what
    // Google returned (status, message, body). The status-only view in the
    // "External APIs" widget hides the body.
    console.error("=== /api/generate FAILED ===");
    console.error("Error type:", error?.constructor?.name);
    console.error("Error message:", error instanceof Error ? error.message : String(error));
    if (error && typeof error === "object") {
      console.error("Error JSON:", JSON.stringify(error, Object.getOwnPropertyNames(error)));
    }
    const message = error instanceof Error ? error.message : "Generation failed";
    return res.status(500).json({ error: message });
  }
}
