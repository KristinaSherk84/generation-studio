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
  | "green"
  | "rainbow"; // rainbow = generate each of 6 variations with a different color

type GenerateRequest = {
  photoUrls: string[]; // Vercel Blob URLs from Step 3
  style: Style;
  attire: Attire;
  lighting: Lighting;
  background?: Background; // only used when style === "corporate"
  variationIndex: number; // 0-5; frontend fires 6 parallel calls, each with a unique index
};

type InlineImage = { mimeType: string; data: string };

// -------------------- Prompt blocks (from Kristi's approved v2 framework) --------------------
//
// IMPORTANT: These strings come verbatim from prompt-framework-v2.md at the
// repo root. If the framework changes, edit the markdown first, then mirror
// the change here. The markdown is the source of truth for Kristi's review,
// but these constants are what actually get sent to Gemini at runtime.

const BLOCK_1_IDENTITY = `Generate a professional headshot of the person shown in the reference photos. Preserve their facial features with absolute precision: face shape, bone structure, eye shape and color, nose, mouth, hairline, skin tone, age, and any distinguishing marks. You may apply the subtle, flattering retouching a professional photographer would do in post-production: up to approximately 5% overall refinement (light skin smoothing while preserving pores and real skin texture, subtle softening of under-eye shadows), and up to approximately 10% structural refinement to the jawline or any double chin if present. Do not exceed those amounts. The goal is to photograph this specific person in a new setting — not to produce a generic, plastic, smooth, attractive, emotionless face that vaguely resembles them. If in doubt, err toward realism over polish. Retain natural skin texture and add it in if not present in the uploaded reference photos. If any reference photo appears to have been taken with a wide-angle lens (phone selfies commonly distort the nose and mid-face), correct that distortion in the generated image so the face appears as if photographed with a prime 85mm or 135mm portrait lens on a full-frame camera — slight compression of features, natural proportions, no bulging nose or elongated jaw.`;

const BLOCK_2_COMPOSITION = `Frame as a professional business headshot. The specific body angle and crop are specified in the variation block at the end of this prompt — follow those instructions precisely. General rules:
- Eye line positioned on the upper third of the frame. The subject's eyes should sit approximately one-third of the way down from the top edge of the image — NOT centered vertically.
- Minimal headroom above the top of the head. The space between the top of the subject's hair and the top edge of the frame should be small — approximately 5–8% of the total frame height. The top of the head must nearly reach the top of the frame. Do NOT leave large empty space above the head.
- The subject's face should occupy the TOP HALF of the frame. The shoulders/chest/body live in the bottom half.
- Strong posture without stiffness. Classic subject-to-lens relationship (head rotated slightly back toward the lens), avoiding the flatness of a full-frontal pose.
- Crop tightly per the variation block's "Framing" instruction. If the variation says "from just above the top of the head to the collarbone," the top of the head should be right near the top edge — not floating in the middle of the frame.`;

// Block 3 Style base text (no background) per style.
const BLOCK_3_STYLE_BASE: Record<Style, string> = {
  corporate: `Style: Clean, neutral, trustworthy. Modern corporate LinkedIn aesthetic. Subtle confidence, approachable but professional — senior individual contributor at a Fortune 500, director-level energy. Background matches the color specified below at approximately 80% fidelity with subtle spot-and-gradient variation within the single image (no hard edges, soft vignette). Absolutely zero expressionless eyes. The eyes must be realistic, active, engaged, and smiling.`,
  creative: `Style: Warm, approachable, personable. Softer edges than corporate. Hints of personality — a senior creative, a consultant, or a thought leader who does keynote talks. Less "Wall Street," more "TED stage." Absolutely zero expressionless eyes. The expression must be realistic, active, engaged, and smiling.`,
  executive: `Style: Bold, authoritative, commanding. Strong presence — reads as "in charge." Darker tones, higher contrast, more gravitas — C-suite or board member energy. Background is deep and moody: near-black charcoal, deep gradient to black at the edges, or dark architectural backdrop softly blurred. Hair rim light is essential for separation. Directional lighting is welcome (see lighting rule below), but the downward-facing planes of the face must never fall into deep shadow — the eye sockets, under the nose, the nasolabial folds, and under the chin all stay well-filled so the subject's eyes are clearly visible and expressive. The realistic expression leans fierce and captivating rather than warm-and-smiling: "ready to take on the world," the knowing look that says "I have a secret I'm not telling you," a confident realistic half-smile that pulls the viewer in.`,
};

// Creative-only backgrounds. The frontend passes variationIndex 0-5; even
// indices get OUTDOOR TREES, odd indices get INDUSTRIAL OFFICE — that way the
// 6 generated photos always include a 3+3 mix rather than leaving it to
// stochastic sampling (which was producing all-trees batches).
const CREATIVE_BG_TREES = `Background: A distant outdoor natural setting, very bokeh heavy — trees and foliage placed 50+ feet behind the subject — photographed with the most extreme creamy bokeh imaginable (as if shot on a 200mm lens at f/1.2 on a full-frame camera). The background must be SO heavily blurred that you CANNOT identify any specific tree, trunk, branch, or leaf. What should be visible: large creamy bokeh orbs, abstract painterly washes of green and gold, soft dappled highlights. What must NOT be visible: any recognizable tree, branch structure, leaf shape, or specific object. If a viewer could point to a tree and say "that's an oak," the blur is not strong enough. Think impressionist painting, not photograph of a forest.`;

const CREATIVE_BG_INDUSTRIAL = `Background: A bright, modern industrial office interior — exposed concrete, steel beams, polished wood, large windows flooded with natural daylight. Photographed with extreme bokeh blur (as if shot on a 200mm lens at f/1.2 with the background 40+ feet behind the subject). The background must be SO heavily blurred that NO specific beam, window, wall, surface, or object is identifiable. What should be visible: soft ambient light, abstract geometric washes in light grey, white, and warm wood tones, gentle out-of-focus highlights. What must NOT be visible: any recognizable architectural detail, specific window mullion, visible beam, door, or piece of furniture. Think "ambient light and color washes," not "photo of an office."`;

function buildBlock3Style(style: Style, variationIndex: number): string {
  if (style !== "creative") {
    return BLOCK_3_STYLE_BASE[style];
  }
  // Even index (0, 2, 4) = trees; odd index (1, 3, 5) = industrial office.
  const background = variationIndex % 2 === 0 ? CREATIVE_BG_TREES : CREATIVE_BG_INDUSTRIAL;
  return `${BLOCK_3_STYLE_BASE.creative}\n\n${background}`;
}

const BLOCK_4_ATTIRE: Record<Attire, string> = {
  formal: `Attire: A polished formal business look, tailored to the subject's apparent gender as determined from the reference photos.
- If the subject appears to be a MAN: a well-tailored suit jacket in a neutral color (charcoal, navy, or black) over a crisp collared dress shirt. A necktie is optional based on what flatters the subject's face shape and the overall style.
- If the subject appears to be a WOMAN: a well-tailored slim-fit blazer in a neutral color (charcoal, navy, or black) over a professional blouse, silk top, or fine knit top with a clean, feminine neckline (crew neck, V-neck, open collar, or tasteful scoop). NEVER a necktie. NEVER a men's business shirt with a men's tie. The silhouette should read clearly as women's business attire — softer shoulder, feminine cut, tailored to a woman's frame.
Well-tailored and intentional in either case — not boxy, not ill-fitting.`,
  casual: `Attire: Smart professional attire without a full suit. Options: blazer over an open-collar shirt, knit polo, tailored sweater, or structured blouse. Relaxed but intentional. Favor attire that creates vertical lines guiding the viewer's eye toward the face — a suit jacket, a dark cardigan forming a V-shape, or a structured collar.`,
  keep: `Attire: Preserve the clothing visible in the reference photos as faithfully as possible. Do not change the garment type, color, neckline, or style.`,
};

const BLOCK_5_LIGHTING: Record<Lighting, string> = {
  studio: `Lighting: Broad, soft key light placed slightly above and in front of the subject — a large soft box or beauty dish. A dedicated fill light source (not a passive bounce card — an actual light) on the shadow side at roughly a 1:1.3 to 1:1.5 ratio with the key, meaning the fill is just slightly darker than the key and never less. Additional under-eye fill light from a low position to eliminate shadows in the eye sockets, under the nose, and in the nasolabial folds. Multiple clean catchlights in the eyes from the key, fill, and under-eye fill sources. Minimal shadow on the face overall — the only shadow permitted is a very gentle gradient on the side of the face opposite the key.`,
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

const BLOCK_7_TECHNICAL = `Technical quality: 2048-pixel resolution, sharp focus on the eyes, eyelashes visible, realistic natural skin texture preserved (no plastic smoothing, no over-softening). Very shallow depth of field — subject's face in perfect focus, shoulders softly falling off, background noticeably blurred. Professional color grading: accurate skin tones, no color cast, slight warmth in shadows. No visible artifacts, no uncanny valley, no AI-tell signs. This is a commercial-grade photograph, extremely realistic — not an illustration, render, or composite.`;

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
    expression: "subtle closed-mouth realistic smile, warm and composed",
    bodyPose: "body squared to camera, shoulders relaxed",
    crop: "tighter crop — from just above the top of the head to the collarbone",
    attireHint: "shirt or top in crisp white",
  },
  {
    expression: "soft realistic open smile, approachable",
    bodyPose: "body turned approximately 15 degrees to the subject's left, head rotated slightly back toward the lens",
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
    expression: "knowing realistic half-smile, confident and poised",
    bodyPose: "body squared to camera, shoulders relaxed",
    crop: "wider crop — more shoulder and upper chest visible",
    attireHint: "a subtly different jacket or top in a mid-tone, well-tailored",
  },
  {
    expression: "confident warm realistic expression with slight smile, engaged eyes",
    bodyPose: "body turned approximately 10 degrees to the subject's right",
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
  const parts: string[] = [
    BLOCK_1_IDENTITY,
    BLOCK_2_COMPOSITION,
    buildBlock3Style(req.style, req.variationIndex),
    BLOCK_4_ATTIRE[req.attire],
    BLOCK_5_LIGHTING[req.lighting],
  ];

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
