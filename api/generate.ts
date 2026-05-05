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
  // True if the client read EXIF from any reference photo and found a focal
  // length <40mm (35mm-equivalent). In that case we append a stronger lens-
  // distortion correction block to the prompt. See BLOCK_LENS_CORRECTION below.
  // Defaults to false when the client couldn't read EXIF (e.g. stripped images).
  hasWideAngle?: boolean;
  // "realistic" (default) keeps current behavior — no extra block injected.
  // "polished" adds BLOCK_SKIN_POLISHED, which is gender-gated inside the
  // prompt itself (only fires for women; ignored for men). Added 2026-04-26
  // after three female beta users complained the default treatment made
  // them look older.
  skin?: Skin;
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
// Restructured 2026-05-01 (Kristi's redesign) to be the SINGLE master skin-
// smoothing rule. Previously Block 1 had a flat 5% retouch cap and the
// per-skin-tier overrides (Polished, Glam) had to fight against it from
// later in the prompt. New design: Block 1 itself branches on skin choice
// + apparent gender, so Gemini gets the smoothing percentage from the
// FIRST block rather than averaging conflicting directives.
//
// Skin × gender matrix (resolved by Gemini at inference from refs + req.skin):
//   Realistic   OR Male  → 5% (standard professional retouch)
//   Female + Polished    → 35% smoothing
//   Female + Glam        → 70% smoothing
//
// Pore preservation is universal at 100% across all tiers — smoothing
// applies to wrinkles/lines/tone, not to pore micro-texture.
//
// The Skin Polished and Skin Glam blocks (still injected based on user
// choice) now focus only on tone-evening direction — the smoothing
// percentage is owned exclusively by Block 1.
const BLOCK_1_IDENTITY = `Generate a professional headshot of the person shown in the reference photos.

IDENTITY PRESERVATION (RULE #1 — NON-NEGOTIABLE, OVERRIDES EVERY OTHER DIRECTIVE IN THIS PROMPT INCLUDING THE SKIN SMOOTHING DIRECTIVE BELOW):

Preserve the subject's facial features with 100% precision. The generated face must be UNMISTAKABLY the same person — a coworker, friend, or family member viewing the headshot would recognize them immediately with zero hesitation. Match the reference photos EXACTLY for:
- Face shape and overall facial proportions
- Bone structure (cheekbones, jawline, brow ridge, chin shape)
- Eye shape, eye color, eyelid shape, eye spacing, brow shape
- Nose shape, nose width, nostril shape, nose tip
- Mouth shape, lip thickness, lip width, mouth corners
- Hairline (where the hair meets the forehead)
- Underlying skin tone and ethnicity (the base shade — surface unevenness is separately handled by the smoothing directive)
- Any distinguishing marks: freckles, beauty marks, moles, scars, dimples, asymmetries

DO NOT idealize features. DO NOT blend toward generic "attractive" proportions, the conventional Instagram look, or AI-default beauty patterns. DO NOT smooth away the small irregularities and asymmetries that make this person them. A real human face is slightly asymmetrical and has specific proportions — keep all of that. The smoothing directive below operates ONLY on wrinkles, fine lines, and surface tone unevenness — it NEVER touches facial structure, proportions, feature placement, or distinguishing characteristics.

SKIN SMOOTHING DIRECTIVE — apply based on BOTH the user's chosen Skin option (provided elsewhere in this prompt) AND the subject's apparent gender from the reference photos. This directive operates STRICTLY on the skin SURFACE — wrinkles, fine lines, surface tone unevenness — and never on facial structure or features (Rule #1 above):

- If the user chose "Realistic" skin, OR the subject appears to be a MAN regardless of choice: apply the standard professional photographer's retouch — up to approximately 5% overall refinement (light skin smoothing while preserving pores and real skin texture, subtle softening of under-eye shadows). Do not exceed 5%. Err toward realism over polish.

- If the subject appears to be a WOMAN AND the user chose "Polished" skin: apply approximately 35% skin smoothing across the face — substantially reduce fine lines and crepey texture, even out tone — but the face must still read as a real person AND unmistakably this specific real person.

- If the subject appears to be a WOMAN AND the user chose "Glam" skin: apply approximately 70% skin smoothing across the face — heavily reduce fine lines and wrinkles, target a luminous editorial finish. THE UNDER-EYE AREA SPECIFICALLY (lower lash line down to the top of the cheekbone, including the outer-corner crow's feet zone) gets HEAVIER smoothing than the rest of the face — approximately 95% reduction of under-eye lines, crow's feet, crepey texture, milia, tired-eye darkness, and under-eye puffiness or bags. Under-eye is the priority retouching zone for Glam and should read as almost completely smooth in the final image, with only the subtlest hint of natural texture remaining (so it doesn't read as a 3D render). The Skin Glam companion block later in this prompt reinforces this with more detail. CRITICAL IDENTITY GUARDRAIL FOR THIS TIER: at 70% face / 95% under-eye smoothing the model has a strong tendency to drift toward generic-pretty / AI-default features and lose the subject's actual identity — do NOT let that happen. The smoothing only applies to LINE TEXTURE and TONE evenness. Every facial feature, every proportion, every distinguishing mark, the eye SHAPE itself (not the texture around it), the nose, the mouth, the bone structure, the asymmetries — all of those remain UNMISTAKABLY the subject's own. Smooth the lines, not the person.

CRITICAL FOR ALL CASES (men, women, all three skin tiers): PRESERVE skin texture and pore structure at 100%. Pores must remain visible across the face, neck, and any visible décolletage in EVERY generated image regardless of which Skin treatment level applies. The smoothing applies to wrinkles, fine lines, and tone unevenness — NOT to pores, NOT to skin micro-texture, and NOT to facial structure. Show pores and real skin texture in every generated image.

Up to approximately 10% structural refinement to the jawline or any double chin if present. Do not exceed that amount.

The goal is to photograph THIS SPECIFIC PERSON in a new setting — not to produce a generic, plastic, smooth, emotionless face that vaguely resembles them.

If any reference photo appears to have been taken with a wide-angle lens (phone selfies commonly distort the nose and mid-face), correct that distortion in the generated image so the face appears as if photographed with a prime 85mm or 135mm portrait lens on a full-frame camera — slight compression of features, natural proportions, no bulging nose or elongated jaw.`;

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
const BLOCK_UNDER_EYE = `Under-eye rendering rule (women only). The amount of softening applied to the under-eye area depends on the subject's apparent age, evaluated from the reference photos.

ALL THREE TIERS BELOW ARE REGION-LOCALIZED to the under-eye zone only (the area immediately between the lower lash line and the top of the cheekbone). Do NOT smooth her cheeks, forehead, nose, jawline, or any other facial area — those zones keep full natural skin texture per Blocks 1 and 7. This is a deliberate, professional portrait retouch — the kind a working photographer routinely does in Lightroom — NOT plastic smoothing of the face overall, and Block 7's anti-plasticization rule does not prohibit this localized softening.

TIER 1 — IF THE SUBJECT APPEARS TO BE A WOMAN UNDER APPROXIMATELY 35 YEARS OLD:
- Eliminate approximately 40% of any visible fine lines, crepey texture, crow's feet, milia, tired-eye darkness, and under-eye puffiness. Keep the remaining 60% as subtle natural texture.
- This is a light-touch retouch. Younger skin doesn't have many lines to begin with, so over-correcting (eliminating most or all texture) reads as filter / filler-injected and ages the subject differently. Target: "well-rested young adult after a good night's sleep."

TIER 2 — IF THE SUBJECT APPEARS TO BE A WOMAN BETWEEN APPROXIMATELY 35 AND 50 YEARS OLD:
- Eliminate approximately 55% of any visible fine lines, crepey texture, crow's feet, milia, tired-eye darkness, and under-eye puffiness — even those visible in the reference photos. Keep the remaining 45% as subtle natural texture.
- This tier gets MORE reduction than the under-35 tier on purpose: the 35–50 age band is where pronounced under-eye lines actually appear in real life, and where leaving them unretouched results in a "tired" or "haggard" portrait that customers reject. Target: "well-rested professional in her 40s — she still looks her age, but rested."

TIER 3 — IF THE SUBJECT APPEARS TO BE A WOMAN 50 OR OLDER:
- Preserve natural under-eye texture per Blocks 1 and 7. Subtle fine lines, gentle crow's feet, and real skin texture remain visible. No additional softening beyond Block 1's standard 5% retouch allowance.
- At this age, pronounced under-eye texture reads as authentic and refusing to retouch it reads as deliberate craft. Customers in this band typically prefer realistic to "youthful."

FOR MEN of any age:
- No special under-eye rule. Use the standard Block 1 retouch allowance.

Why partial (not 100%) reduction across tiers 1 and 2: full elimination of under-eye texture produces a "filtered" or "filler-injected" look that reads as fake. The remaining 45–60% natural texture is what keeps the face reading as a real person rather than an avatar.`;

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
const BLOCK_SKIN_POLISHED = `Polished tone treatment (women only — ignore entirely if subject appears to be a man, regardless of any other instruction in this block).

For women: The wrinkle/line smoothing percentage for the Polished tier is set by Block 1's SKIN SMOOTHING DIRECTIVE (approximately 35% across the face for women who chose Polished). This block layers TONE direction and pore reinforcement on top of that baseline.

- TONE EVENING: Smooth out color inconsistencies in skintones — uneven redness, blotchiness, post-acne marks, sunspots, hyperpigmentation patches, and tone variation between forehead / cheeks / chin / neck. The end result reads as an even, healthy skin tone across the face — but not so flat that it loses dimension.

- PORE STRUCTURE: Add or reinforce pore structure and detail across face, neck, and any visible décolletage, even if the reference photos do not show clear skin texture (low-resolution phone selfies, harsh lighting, heavy compression). The end result must read as a real human face with real skin — pores visible at normal viewing distance, with the only "retouch" being even tone and the Block 1 smoothing percentage, not erased texture.

- NO plastic skin. NO airbrushed or filter-smoothed appearance. NO doll-like or AI-tell smoothness.

This block coexists with Block UNDER_EYE — apply both. The under-eye softening rules from Block UNDER_EYE still apply by tier; this block governs the rest of the face's tone evenness and pore-detail reinforcement.

For men: ignore this block entirely. Apply the standard Block 1 skin treatment unchanged.`;

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
const BLOCK_SKIN_GLAM = `Glamorous editorial tone treatment (women only — ignore entirely if subject appears to be a man, regardless of any other instruction in this block).

For women: The wrinkle/line smoothing percentage for the Glam tier is set by Block 1's SKIN SMOOTHING DIRECTIVE (approximately 70% across the face for women who chose Glam). This block layers TONE direction and editorial finish on top of that baseline. The aesthetic target is "red-carpet luxury beauty editorial that hasn't erased the human" — Vogue cover where the model still has visible pores under close inspection. Polished, even-toned, glowing, aspirational — but real skin.

- TONE EVENING (AGGRESSIVE): Completely eliminate color inconsistencies across the entire face — redness on cheeks and nose, blotchiness, post-acne marks, hyperpigmentation, sunspots, melasma, broken capillaries, and color variation between forehead/cheeks/chin/neck. The end result reads as ONE EVEN luminous tone across the entire face. If the reference photos show patchy color, that patchiness is THE THING being retouched away — do not preserve it as "authentic." The whole face should read as a single skin tone with subtle dimensional shading from the lighting, not blotchy color zones.

- PORE STRUCTURE AND SKIN TEXTURE: PRESERVE FULLY at 100% per Block 1's pore-preservation directive. Visible pores across cheeks, forehead, nose, chin, neck, décolletage — the skin should still read as actual human skin under close inspection. CRITICAL DISTINCTION: pore preservation refers to the physical 3D micro-texture of the skin surface (the raised / recessed terrain of pores at close magnification). It does NOT mean preserving color inconsistencies that happen to occur in the same regions. Pores stay; redness/blotchiness goes. Treat these as TWO SEPARATE concerns — texture and color — and only the texture is preserved.

- LUMINOUS FINISH: Skin should look luminous and softly glowing, as though professionally lit. Healthy radiance, not matte, not greasy.

- UNDER-EYE (HEAVIEST RETOUCHING ZONE FOR GLAM — APPROXIMATELY 95% REDUCTION): The under-eye area is the PRIORITY retouching zone for the Glam tier and gets MORE aggressive smoothing than the rest of the face (face overall = 70% per Block 1; under-eye = ~95% here). The under-eye zone is defined as the area immediately below the lower lash line, extending down to the top of the cheekbone, and outward to include the crow's-feet creases at the outer corner of the eye. In that zone, eliminate approximately 95% of: visible fine lines, crow's feet at the outer corners, crepey or wrinkled under-eye skin, milia, tired-eye darkness or shadows, post-tear-trough hollows, and under-eye puffiness or bags. This zone should read as almost completely smooth in the final image — only the subtlest hint of natural texture remains, just enough to keep the eye area from looking like a 3D render or filler-injected. This rule EXPLICITLY OVERRIDES Block UNDER_EYE's age-tiered preservation rules. Pore micro-texture across the under-eye still applies per Block 1's universal pore-preservation directive — the 95% reduction operates on LINES and TONE, not on pores. Do NOT alter the eye shape, eyelid shape, or eye position — only the SKIN around the eye is being smoothed.

- ANTI-PLASTIC GUARDRAIL: Glam should NEVER produce plastic, doll-like, or filter-smoothed skin. The pore preservation is the safeguard against that.

For men: ignore this block entirely. Apply the standard Block 1 skin treatment unchanged.`;

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
- Eye line positioned on the upper third of the frame. The subject's eyes should sit approximately one-third of the way down from the top edge of the image — NOT centered vertically.
- Minimal headroom above the top of the head. The space between the top of the subject's hair and the top edge of the frame should be extremely small — approximately 2–3% of the total frame height. The top of the head should nearly touch the top of the frame. Do NOT leave empty space above the head.
- The subject's face should occupy the TOP HALF of the frame. The shoulders/chest/body live in the bottom half.
- Strong posture without stiffness. Classic subject-to-lens relationship (head rotated slightly back toward the lens), avoiding the flatness of a full-frontal pose.
- Crop tightly per the variation block's "Framing" instruction. If the variation says "from just above the top of the head to the collarbone," the top of the head should be right near the top edge — not floating in the middle of the frame.`;

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
  // 0 — Doctor's white coat over a dress shirt
  // Leading-with "DOCTOR'S WHITE COAT" + explicit "NOT a suit jacket"
  // because the v1 of this variant rendered as a suit (Gemini latched
  // onto "dress shirt + tie + lapels" cues and ignored "lab coat").
  // Removed: "lapels visible", "fully buttoned at the top", and the
  // necktie option — all of those drag toward suit interpretation.
  `A DOCTOR'S WHITE COAT (also called a physician's white coat or medical lab coat). NOT a suit jacket. NOT a blazer. NOT a sport coat. The garment must clearly read as a doctor's white coat — pure white color, simple notched collar (no formal suit lapels), worn open or with the top button only. Underneath: a soft collared dress shirt in a clean neutral color (white, light blue, or pale grey). NO necktie. The white of the coat must dominate the image — if more navy/charcoal is visible than white, the rendering is wrong.`,
  // 1 — Doctor's white coat over a feminine blouse / soft top
  `A DOCTOR'S WHITE COAT (physician's white coat / medical lab coat). NOT a suit jacket, NOT a blazer. Pure white, simple notched collar, worn open. Underneath: a soft feminine blouse, fine-knit top, or silk shell in a muted color (cream, blush, light grey, or pale blue). For a man: substitute a soft solid sweater or knit polo under the white coat. The white coat must dominate the image and read clearly as medical, not business attire.`,
  // 2 — Doctor's white coat over scrubs (clinician-on-shift)
  `A DOCTOR'S WHITE COAT (physician's white coat / medical lab coat) worn open over medical SCRUBS visible at the V-neck. NOT a suit jacket, NOT a blazer. The white coat must be pure white and dominate the upper torso. Beneath the coat, only the V-neck of the scrubs is visible — color of the scrubs: light blue, hospital teal, or muted grey. The look must read clearly as a doctor mid-shift wearing a white coat over scrubs — never as a businessperson in a suit.`,
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
// Restructured 2026-05-01: previously this block contained "no plastic
// smoothing, no over-softening" as a flat universal rule, which was
// canceling Glam's wrinkle reduction. The skin-aware function variant that
// followed was retired when Block 1 was redesigned to own the per-tier
// smoothing percentage. Block 7 now defers to Block 1 for the smoothing
// amount and frames the pore preservation as the universal anti-plastic
// guardrail — compatible with all three tiers because Block 1's smoothing
// targets wrinkles/lines/tone, not pores or skin micro-texture.
const BLOCK_7_TECHNICAL = `Technical quality: 2048-pixel resolution, sharp focus on the eyes, eyelashes visible. Skin texture: preserve pore micro-texture and real skin surface per Block 1's SKIN SMOOTHING DIRECTIVE — the smoothing percentages specified there (5% for Realistic or men, ~35% for Polished women, ~70% for Glam women) target wrinkles, fine lines, and tone unevenness, NOT pores or skin micro-texture. Whichever tier applies to this customer, do NOT produce plastic, doll-like, filter-smoothed, or AI-tell skin — the pore preservation is the universal safeguard against that. Very shallow depth of field — subject's face in perfect focus, shoulders softly falling off, background noticeably blurred. Professional color grading: accurate skin tones, no color cast, slight warmth in shadows. No visible artifacts, no uncanny valley. This is a commercial-grade photograph, extremely realistic — not an illustration, render, or composite.`;

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
const BLOCK_EYEWEAR = `Eyewear: If the subject is wearing glasses (prescription eyeglasses, not sunglasses) in most or all of the reference photos, preserve the same glasses in the generated headshot — match the frame shape, color, and material as closely as possible. If the reference photos show a mix of clear-lens glasses and tinted/sunglasses frames, default to the clear-lens professional pair — a proper business headshot should have clear lenses so the subject's eyes are fully visible. If the subject is NOT wearing glasses in the reference photos, do NOT add any — never invent eyewear that isn't in the reference set.`;

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
const BLOCK_HAIR_DEFAULT = `CRITICAL HAIR STYLING RULE: Evaluate how the subject is wearing their hair across the reference photos.

- If the references show the SAME style consistently (all hair down OR all hair tied back / up / clipped), match that style exactly.

- If the references show a MIX of styles (some down, some tied back / up / pulled away from face / in a ponytail or bun or clip), the generated headshot MUST render hair DOWN — loose, flowing, framing the face. This is non-negotiable when the references are mixed. Hair down is the more flattering and editorial choice for a professional portrait, and the customer benefits from the more polished option. Do not default to "easier to render" tied-back styles when the references give you the option of down.

- If only one or two reference photos exist and the styling is ambiguous, default to hair DOWN.

When generating hair-down: render the hair as the subject's natural length and texture would actually look when worn down — not slicked back, not pulled tight, not held off the face. Frame the face naturally with the hair.

Always match the subject's actual hair length, color, texture, density, and natural part. Do NOT invent a different cut, lengthen or shorten the hair, or change its natural flow or color.

For subjects with very short hair (under approximately chin length), no styling decision applies — just match the reference photos exactly.`;

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

function buildBlock8(attire: Attire, variationIndex: number): string {
  // Defensive: clamp index into the valid range.
  const flavor = FLAVORS[Math.max(0, Math.min(FLAVORS.length - 1, variationIndex))];

  const outfitLine =
    attire === "keep"
      ? `- Outfit: Preserve the exact clothing from the reference photos — do not change the garment type, color, neckline, or style.`
      : `- Outfit detail: ${flavor.attireHint}. This must stay firmly within the attire category specified above.`;

  return `Photograph direction for this single image:
- Expression: ${flavor.expression}. Eyes must look alert, engaged, and realistic — never blank, glazed, doll-like, or expressionless.
- Body and head: ${flavor.bodyPose}.
- Framing: ${flavor.crop}.
${outfitLine}

REFERENCE PHOTO USAGE RULE: The uploaded reference photos are provided ONLY so you can learn the subject's facial likeness — face shape, features, hair, skin tone. You MUST NOT copy, sample, or draw inspiration from the reference photos' backgrounds, environments, colors, lighting, or scenes. The new photograph's background and lighting come ENTIRELY from the direction in the prompt above — ignore anything visible behind or around the subject in the reference photos.

IMPORTANT OUTPUT CONSTRAINT: Return exactly ONE single photograph. Do NOT return a grid, contact sheet, collage, multi-panel image, side-by-side comparison, or any composition containing more than one headshot. One photo only. The most important thing is preserving the subject's real likeness from the reference photos.`;
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
  // The smoothing PERCENTAGE for each tier lives in Block 1 (5% / 35% / 70%);
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

  parts.push(BLOCK_7_TECHNICAL);
  parts.push(buildBlock8(req.attire, req.variationIndex));

  return parts.join("\n\n");
}

// -------------------- Reference photo fetching --------------------

// Fetch a Vercel Blob URL and convert to the inline base64 format Gemini wants.
async function fetchPhotoAsInlineData(url: string): Promise<InlineImage> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch reference photo (${response.status}): ${url}`);
  }
  const contentType = response.headers.get("content-type") || "image/jpeg";
  const arrayBuffer = await response.arrayBuffer();
  const data = Buffer.from(arrayBuffer).toString("base64");
  return { mimeType: contentType, data };
}

// -------------------- Gemini call --------------------

async function generateOneHeadshot(
  ai: GoogleGenAI,
  prompt: string,
  photos: InlineImage[],
): Promise<string> {
  const response = await ai.models.generateContent({
    // Model history on this project:
    //  - gemini-3-pro-image-preview (Nano Banana Pro): hit 429 rate limits on
    //    fresh Tier 1 projects (2026-04-18). Swapped out.
    //  - gemini-2.5-flash-image (Nano Banana 1): worked but delivered
    //    occasional 503 UNAVAILABLE capacity errors (2026-04-20) and had
    //    weaker face-likeness than we wanted.
    //  - gemini-3.1-flash-image-preview (Nano Banana 2, current): released
    //    2026-02-26. Same Flash tier / same Tier 1 limits, but noticeably
    //    better subject consistency (directly addresses the #1 AI-headshot
    //    complaint — loss of likeness). Keep this model unless it regresses.
    //    If Google deprecates the preview suffix, revert to 2.5 flash image.
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
  return false;
}

async function generateOneHeadshotWithRetry(
  ai: GoogleGenAI,
  prompt: string,
  photos: InlineImage[],
  maxAttempts = 3,
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
      // Exponential backoff: 1s, 2s. Plus up to 500ms jitter so six parallel
      // callers don't all hit Google again at exactly the same millisecond.
      const baseDelay = 1000 * Math.pow(2, attempt - 1); // 1000, 2000
      const jitter = Math.floor(Math.random() * 500);
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

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse | void> {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ---- Validate inputs (cheap, fail fast) ----
  const body = req.body as Partial<GenerateRequest>;

  if (
    !body.photoUrls ||
    !Array.isArray(body.photoUrls) ||
    body.photoUrls.length < 3
  ) {
    return res.status(400).json({ error: "At least 3 reference photos required" });
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
    const photos = await Promise.all(
      body.photoUrls.map((url) => fetchPhotoAsInlineData(url)),
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
