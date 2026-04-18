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

type Style = "corporate" | "creative" | "executive";
type Attire = "formal" | "casual" | "keep";
type Lighting = "studio" | "natural" | "dramatic" | "golden";
type Background =
  | "white"
  | "lightgrey"
  | "midgrey"
  | "dark"
  | "blue"
  | "green";

type GenerateRequest = {
  photoUrls: string[]; // Vercel Blob URLs from Step 3
  style: Style;
  attire: Attire;
  lighting: Lighting;
  background?: Background; // only used when style === "corporate"
};

type InlineImage = { mimeType: string; data: string };

// -------------------- Prompt blocks (from Kristi's approved v2 framework) --------------------
//
// IMPORTANT: These strings come verbatim from prompt-framework-v2.md at the
// repo root. If the framework changes, edit the markdown first, then mirror
// the change here. The markdown is the source of truth for Kristi's review,
// but these constants are what actually get sent to Gemini at runtime.

const BLOCK_1_IDENTITY = `Generate a professional headshot of the person shown in the reference photos. Preserve their facial features with absolute precision: face shape, bone structure, eye shape and color, nose, mouth, hairline, skin tone, age, and any distinguishing marks. You may apply the subtle, flattering retouching a professional photographer would do in post-production: up to approximately 5% overall refinement (light skin smoothing while preserving pores and real skin texture, subtle softening of under-eye shadows), and up to approximately 10% structural refinement to the jawline or any double chin if present. Do not exceed those amounts. The goal is to photograph this specific person in a new setting — not to produce a generic, plastic, smooth, attractive, emotionless face that vaguely resembles them. If in doubt, err toward realism over polish. Retain natural skin texture and add it in if not present in the uploaded reference photos. If any reference photo appears to have been taken with a wide-angle lens (phone selfies commonly distort the nose and mid-face), correct that distortion in the generated image so the face appears as if photographed with a prime 85mm or 135mm portrait lens on a full-frame camera — slight compression of features, natural proportions, no bulging nose or elongated jaw.`;

const BLOCK_2_COMPOSITION = `Frame as a professional business headshot: crop from just above the top of the head to mid-chest. Subject faces the camera with a subtle turn of the body (approximately 15 degrees) and the head rotated slightly back toward the lens — a classic subject-to-lens relationship that avoids the flatness of a full-frontal pose. Eye line positioned on the upper third of the frame. Shoulders relaxed, not squared to the camera. Strong posture without stiffness. Across the six variations, vary the zoom length and crop slightly — some tighter on the face, some with a bit more shoulder room.`;

const BLOCK_3_STYLE: Record<Style, string> = {
  corporate: `Style: Clean, neutral, trustworthy. Modern corporate LinkedIn aesthetic. Subtle confidence, approachable but professional — senior individual contributor at a Fortune 500, director-level energy. Backgrounds should match the color specified below at approximately 80% fidelity, with subtle variation across the six images (spots, gradients, vignette variations). Absolutely zero expressionless eyes. Every shot must have active, engaged, smiling eyes.`,
  creative: `Style: Warm, approachable, personable. Softer edges than corporate. Hints of personality — a senior creative, a consultant, or a thought leader who does keynote talks. Less "Wall Street," more "TED stage." Backgrounds must be as blurry and creamy as possible, as if photographed with a prime 135mm lens with the background placed very far away from the subject. Mix natural environment backgrounds (soft foliage, outdoor architectural blur) with industrial workspace backgrounds (warm wood, exposed brick, soft studio blur). Vary the background brightness across the six images — some bright and airy, others closer to a 75% grey value but still softly blurred. In at least some of the six images, choose a background color that contrasts the subject's hair color so the subject pops clearly off the background. Absolutely zero expressionless eyes. Every shot must have active, engaged, smiling eyes.`,
  executive: `Style: Bold, authoritative, commanding. Strong presence — reads as "in charge." Darker tones, higher contrast, more gravitas — C-suite or board member energy. Backgrounds are deep and moody: near-black charcoal, deep gradient to black at the edges, or dark architectural backdrops softly blurred. Hair rim light is essential for separation. Directional lighting is welcome (see lighting rule below), but the downward-facing planes of the face must never fall into deep shadow — the eye sockets, under the nose, the nasolabial folds, and under the chin all stay well-filled so the subject's eyes are clearly visible and expressive. Expressions lean fierce and captivating rather than warm-and-smiling: "ready to take on the world," the knowing look that says "I have a secret I'm not telling you," confident half-smiles that pull the viewer in.`,
};

const BLOCK_4_ATTIRE: Record<Attire, string> = {
  formal: `Attire: Suit jacket, crisp collared shirt. Tie optional based on what flatters the subject's face shape and the overall style. Neutral suit colors (charcoal, navy, black). Well-tailored, not boxy.`,
  casual: `Attire: Smart professional attire without a full suit. Options: blazer over an open-collar shirt, knit polo, tailored sweater, or structured blouse. Relaxed but intentional. Favor attire that creates vertical lines guiding the viewer's eye toward the face — a suit jacket, a dark cardigan forming a V-shape, or a structured collar.`,
  keep: `Attire: Preserve the clothing visible in the reference photos as faithfully as possible. Do not change the garment type, color, neckline, or style.`,
};

const BLOCK_5_LIGHTING: Record<Lighting, string> = {
  studio: `Lighting: Broad, soft key light placed slightly above and in front of the subject — a large soft box or beauty dish. A dedicated fill light source (not a passive bounce card — an actual light) on the shadow side at roughly a 1:1.3 to 1:1.5 ratio with the key, meaning the fill is just slightly darker than the key and never less. Additional under-eye fill light from a low position to eliminate shadows in the eye sockets, under the nose, and in the nasolabial folds. Multiple clean catchlights in the eyes from the key, fill, and under-eye fill sources. Minimal shadow on the face overall — the only shadow permitted is a very gentle gradient on the side of the face opposite the key.`,
  natural: `Lighting: Large window light as key, angled at roughly 45 degrees to the subject. Warm 4000K–5000K color temperature. Gentle fall-off to the shadow side, but the shadow side still receives significant warm bounced fill light from multiple angles — reflective surfaces behind the photographer, a large bounce below the subject, and ambient room light. Organic and slightly directional, but never leaving deep shadows. Warm light is welcome; unfilled shadows are not.`,
  dramatic: `Lighting: Directional light with strong contrast — classic Rembrandt or loop pattern from the key. However, shadows are only acceptable on the sides of the face (the cheek on the shadow side, the jawline on the shadow side). The downward-facing planes of the face — the shadow beneath the eyebrow ridge, the underside of the nose, the nasolabial fold area next to the mouth, and the area beneath the chin — must receive significant fill light from below. Fill is never brighter than the key but just slightly darker than the key. The eyes must never fall into darkness. Lower overall key, cinematic feel, background falling to near-black, but the face itself remains fully readable.`,
  golden: `Lighting: Warm, low-angled light as if from a late-afternoon sun. Hair rim light from behind. Strong bounced fill on the shadow side — not a subtle lift, but enough fill to keep all downward-facing planes of the face well-lit (under the brow, under the nose, under the chin). Warm color grade, but skin tones stay true — no orange cast.`,
};

// Block 6 is only used for Corporate. Creative and Executive get background
// direction from Block 3 (self-contained).
const BLOCK_6_BACKGROUND: Record<Background, string> = {
  white: `Background: Seamless white, clean, slight gradient to avoid pure flat. Subject clearly separated from background.`,
  lightgrey: `Background: Neutral light grey seamless, gentle vignette, hint of texture (not solid color), spot and gradient variations across the six images.`,
  midgrey: `Background: Medium grey seamless, classic editorial portrait feel, subtle gradient, spot and gradient variations across the six images. Hair light to separate from the background.`,
  dark: `Background: Near-black charcoal with slight gradient to deeper black at edges. Hair rim light essential for separation. Spot and gradient variations across the six images.`,
  blue: `Background: Muted dusty blue, tranquil but professional. Not saturated. Spot and gradient variations. Subject must always pop from the background.`,
  green: `Background: Muted sage / moss green, natural and warm without tipping into "outdoor" feel. Spot and gradient variations. Subject must always pop from the background.`,
};

const BLOCK_7_TECHNICAL = `Technical quality: 2048-pixel resolution, sharp focus on the eyes, eyelashes visible, realistic natural skin texture preserved (no plastic smoothing, no over-softening). Very shallow depth of field — subject's face in perfect focus, shoulders softly falling off, background noticeably blurred. Professional color grading: accurate skin tones, no color cast, slight warmth in shadows. No visible artifacts, no uncanny valley, no AI-tell signs. This is a commercial-grade photograph, extremely realistic — not an illustration, render, or composite.`;

// Block 8 — Variation Instruction. Outfit variation rule is conditional on
// whether the user chose "Keep my outfit" or one of the attire categories.
function buildBlock8(attire: Attire): string {
  const outfitRule =
    attire === "keep"
      ? `Outfit variations: The user selected "Keep my outfit" — all six images must preserve the exact clothing from the reference photos without variation.`
      : `Outfit variations: Vary the attire across the six images — different jacket colors and styles, different shirt/blouse colors, different accessories or collar treatments — while keeping each variation firmly within the selected attire category above.`;

  return `Variation instruction: Generate six distinct variations. Each must feel like a different frame from the same 5-minute studio session with the same photographer — not six different people photographed by six different stylists. Vary the following across the six:

- Facial expression: All six must have active, engaged, smiling eyes. Vary only the mouth and warmth level — subtle closed-mouth smile, soft open smile, fuller teeth-showing smile, knowing half-smile, confident warm expression. Never expressionless, never awkward, never extreme.
- Body angle and head tilt: Subtle shifts across the six — some more squared to camera, some with a bit more body turn, slight variation in head tilt.
- Catchlight placement: Small shifts in eye catchlights consistent with the chosen lighting block.
- ${outfitRule}

The most important thing across all six is preserving the subject's real likeness from the reference photos.`;
}

// -------------------- Prompt assembly --------------------

function assemblePrompt(req: GenerateRequest): string {
  const parts: string[] = [
    BLOCK_1_IDENTITY,
    BLOCK_2_COMPOSITION,
    BLOCK_3_STYLE[req.style],
    BLOCK_4_ATTIRE[req.attire],
    BLOCK_5_LIGHTING[req.lighting],
  ];

  // Block 6 Background is ONLY for Corporate. Creative / Executive get their
  // background direction embedded in Block 3 itself.
  if (req.style === "corporate" && req.background) {
    parts.push(BLOCK_6_BACKGROUND[req.background]);
  }

  parts.push(BLOCK_7_TECHNICAL);
  parts.push(buildBlock8(req.attire));

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
    // Switched from gemini-3-pro-image-preview (Nano Banana Pro) to Flash on
    // 2026-04-18 due to rate limits (429s) on fresh projects at Tier 1.
    // Flash has generous Tier 1 limits and still produces commercial-grade
    // headshots. Can switch back to Pro later once spend qualifies for Tier 2.
    model: "gemini-2.5-flash-image-preview",
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
  if (!body.style || !["corporate", "creative", "executive"].includes(body.style)) {
    return res.status(400).json({ error: "Invalid style" });
  }
  if (!body.attire || !["formal", "casual", "keep"].includes(body.attire)) {
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
    !["white", "lightgrey", "midgrey", "dark", "blue", "green"].includes(body.background)
  ) {
    return res.status(400).json({ error: "Invalid background" });
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
    //      parallel so it can show real per-image progress to the user. ----
    const ai = new GoogleGenAI({ apiKey });
    const image = await generateOneHeadshot(ai, prompt, photos);

    return res.status(200).json({ image });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generation failed";
    return res.status(500).json({ error: message });
  }
}
