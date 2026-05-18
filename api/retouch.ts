/**
 * POST /api/retouch
 *
 * Path B retouching endpoint (2026-05-15). Runs a SECOND pass on an
 * already-generated headshot using Gemini 3 Pro Image Preview ("Nano
 * Banana Pro") with tier-specific retouching prompts from
 * prompt-framework-retouching-v1.md.
 *
 * Architecture:
 *   - Initial 6-photo generation uses Gemini 3.1 Flash Image Preview
 *     (cheap, fast, ~$0.07/image). That output is what the customer
 *     picks favorites from on the grid screen.
 *   - This endpoint runs AFTER payment confirms, polishing each picked
 *     photo with Pro (slower, ~10-15s per image; ~$0.30-0.40 each).
 *   - The customer chose a tier per photo on the new "Customize your
 *     Retouch Level" screen between Grid and Checkout. That tier drives
 *     which prompt block this endpoint sends.
 *
 * Tier behavior:
 *   - "realistic" — short-circuits. Returns the input image unchanged.
 *     No Pro call. No retouching. This is what the customer ticked when
 *     they wanted to ship the initial-generation photo as-is.
 *   - "polished" — Gemini Pro pass with the Polished retouching prompt.
 *     The exact prompt text depends on the subject's apparent age band
 *     (under-35 vs 35-50 vs 50+), routed inside the prompt itself per
 *     prompt-framework-retouching-v1.md sections 1 and 2.
 *   - "glam" — Gemini Pro pass with the Glam retouching prompt. Same
 *     prompt for all age bands; Glam handles age differences inside
 *     the prompt (no age branching currently exists for Glam).
 *
 * Body: { photoBase64, tier, paywall fields }
 * Returns: { image } — base64 data URI of the retouched photo.
 *
 * Cost / latency budget:
 *   - Pro Image Preview: ~$0.30-0.40 per call on Tier 2
 *   - Latency: 10-20 seconds per image (Pro is meaningfully slower
 *     than Flash but produces editorial-grade retouching)
 *   - maxDuration set to 60s so a single image with retries fits in
 *     one Vercel function invocation. The /api/deliver caller fires
 *     /api/retouch in parallel for all picked photos.
 *
 * Paywall: same gate as /api/generate. Customer must include a valid
 * stripeSessionId (within 2h unlock window, not consumed) OR the
 * PROMO_CODE env var. 402 otherwise.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GoogleGenAI, type Part } from "@google/genai";

// Pro Image Preview is ~10-15s per call typically, up to 30s on a slow
// worker. 60s gives us headroom for one retry on a single image. The
// /api/deliver caller chains multiple of these in parallel.
export const maxDuration = 60;

// Gemini model for retouching. Pro is the same family that produced
// the original Glam quality concerns when used on initial generation
// (it 429ed under load) — but here we're calling it ONE image at a
// time, post-payment, with no parallelism storms. Should fit inside
// Tier 2's rate limit comfortably.
const RETOUCH_MODEL = "gemini-3-pro-image-preview";

// Customer tier choice — matches the values in the new RetouchScreen UI.
// "realistic" is a sentinel meaning "no retouch, return input as-is" and
// never reaches the Gemini Pro call.
type Tier = "realistic" | "polished" | "glam";

// Apparent age band — only used to route Polished prompts to the right
// under-eye treatment (under-35 → light, 35-50 → concealer-look, 50+ →
// preserve natural texture). Glam ignores age band currently. Optional
// in the request body; defaults to "mature" (the more conservative
// retouch) if missing so we don't over-smooth a customer whose age the
// client failed to detect.
type AgeBand = "young" | "mature" | "older";

type RetouchRequest = {
  photoBase64: string; // data URI or raw base64 (we accept both)
  tier: Tier;
  ageBand?: AgeBand;
  stripeSessionId?: string;
  promoCode?: string;
};

type RetouchResponse = {
  image: string; // base64 data URI of the retouched photo
};

// ---- Paywall verification (mirrors /api/generate's verifyUnlock) ----
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
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (promoCode && typeof promoCode === "string") {
    const envCode = process.env.PROMO_CODE;
    if (envCode && constantTimeEquals(promoCode.trim(), envCode.trim())) {
      return { ok: true };
    }
  }
  if (!stripeSessionId || !stripeSessionId.startsWith("cs_")) {
    return { ok: false, reason: "missing-or-invalid" };
  }
  try {
    const resp = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(stripeSessionId)}`,
      { headers: { Authorization: `Bearer ${stripeSecretKey}` } },
    );
    if (!resp.ok) return { ok: false, reason: "stripe-fetch-failed" };
    const session = (await resp.json()) as {
      payment_status?: string;
      metadata?: Record<string, string> | null;
      payment_intent?: { status?: string } | string | null;
    };
    const piStatus =
      session.payment_intent && typeof session.payment_intent === "object"
        ? session.payment_intent.status
        : undefined;
    const isPaid =
      session.payment_status === "paid" || piStatus === "succeeded";
    if (!isPaid) return { ok: false, reason: "not-paid" };
    if (session.metadata?.unlock_consumed === "true") {
      // NOTE: unlike /api/generate, /api/retouch is allowed to run AFTER
      // unlock_consumed flips to true. This is intentional: /api/deliver
      // flips that flag BEFORE calling /api/retouch in the new flow, and
      // it would be a bug to refuse the very retouching the customer
      // just paid for. The "consumed" flag locks /api/generate (no new
      // batches without re-paying $2.99) but not /api/retouch on the
      // current batch's downstream pass.
    }
    const expiresAt = Number(session.metadata?.unlock_expires_at ?? 0);
    // Allow retouching slightly past the 2h window — the customer paid
    // just before /api/retouch fires, so a few seconds of clock drift
    // shouldn't lock them out. Generous 1h grace.
    if (Number.isFinite(expiresAt) && expiresAt + 3600_000 < Date.now()) {
      return { ok: false, reason: "expired" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "verify-threw" };
  }
}

// ---- Retouching prompt assembly ----
//
// Pulls from prompt-framework-retouching-v1.md (the markdown source of
// truth Kristi authored 2026-05-15). To keep this file standalone, the
// prompt strings are inlined here. If the markdown is updated, mirror
// the change down to these constants.

const RETOUCH_IDENTITY_ANCHOR = `Identity preservation — non-negotiable, overrides every other directive below. Preserve the subject's facial features with 100% precision. The retouched face must remain UNMISTAKABLY the same person. Match the input photo EXACTLY for face shape, bone structure, eye shape and color, nose shape, mouth shape, hairline, ethnicity, and every distinguishing mark (freckles, beauty marks, moles, scars, asymmetries). DO NOT idealize features. DO NOT blend toward generic 'attractive' proportions. The retouching below operates ONLY on the skin SURFACE — never on facial structure, proportions, or feature placement.`;

const RETOUCH_PORE_ANCHOR = `Pore micro-texture preservation — applies to every tier below. Preserve the 3D micro-texture of the skin surface (the raised/recessed terrain of pores at close magnification). Pore micro-texture stays at 100% on the face, neck, and visible décolletage. The smoothing operates on surface evenness only — the pore texture itself remains visible at normal viewing distance.`;

// Polished — under-35 (Tier 1)
const RETOUCH_POLISHED_YOUNG = `${RETOUCH_IDENTITY_ANCHOR}

POLISHED RETOUCH (woman under approximately 35 years old):

Master directive: Preserve pore structure, even out hot spots on skin, and skin coloration. Even skin tone across the face, remove blemishes. Render the skin around the eyes with realistic texture but brighten the under-eye areas, and smooth inconsistencies — like a senior executive who slept well last night. The result reads as 'lightly retouched and realistic' — the kind of headshot you'd see on a senior executive's company website.

Under-eye direction: Render the skin around the eyes rested, bright, and even in color. Keep fine texture but remove large wrinkles. Target: "well-rested, hydrated, young adult after a good night's sleep." Avoid over-smoothing the texture of this area. You can brighten and color correct this area to add the look of concealer under the eyes. No plastic skin look.

- TONE EVENING: Smooth out color inconsistencies in skin tones — uneven redness, blotchiness, post-acne marks, sunspots, hyperpigmentation patches, and tone variation between forehead / cheeks / chin / neck. The end result reads as an even, healthy skin tone across the face — but not so flat that it loses dimension.
- PORE STRUCTURE: Add or reinforce pore structure and detail across face, neck, and any visible décolletage, even if the input photo does not show clear skin texture. The end result must read as a real human face with real skin — pores visible at normal viewing distance, not erased texture.
- NO plastic skin. NO airbrushed or filter-smoothed appearance. NO doll-like or AI-tell smoothness.

${RETOUCH_PORE_ANCHOR}`;

// Polished — 35-50 (Tier 2). Same as young except for the under-eye line.
const RETOUCH_POLISHED_MATURE = `${RETOUCH_IDENTITY_ANCHOR}

POLISHED RETOUCH (woman between approximately 35 and 50 years old):

Master directive: Preserve pore structure, even out hot spots on skin, and skin coloration. Even skin tone across the face, remove blemishes. Render the skin around the eyes with realistic texture but brighten the under-eye areas, and smooth inconsistencies — like a senior executive who slept well last night. The result reads as 'lightly retouched and realistic' — the kind of headshot you'd see on a senior executive's company website.

Under-eye direction: Render the skin around the eyes rested, bright, and color corrected as if a concealer was used under the eyes — like a professional in her 40s who slept well last night. The result reads as the same person as the input, just well-rested. NO over-smoothed under-eye area.

- TONE EVENING: Smooth out color inconsistencies in skin tones — uneven redness, blotchiness, post-acne marks, sunspots, hyperpigmentation patches, and tone variation between forehead / cheeks / chin / neck. The end result reads as an even, healthy skin tone across the face — but not so flat that it loses dimension.
- PORE STRUCTURE: Add or reinforce pore structure and detail across face, neck, and any visible décolletage, even if the input photo does not show clear skin texture. The end result must read as a real human face with real skin — pores visible at normal viewing distance, not erased texture.
- NO plastic skin. NO airbrushed or filter-smoothed appearance. NO doll-like or AI-tell smoothness.

${RETOUCH_PORE_ANCHOR}`;

// Glam — all ages
const RETOUCH_GLAM = `${RETOUCH_IDENTITY_ANCHOR}

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

${RETOUCH_PORE_ANCHOR}`;

function buildRetouchPrompt(tier: Tier, ageBand: AgeBand | undefined): string {
  if (tier === "polished") {
    return ageBand === "young" ? RETOUCH_POLISHED_YOUNG : RETOUCH_POLISHED_MATURE;
  }
  if (tier === "glam") {
    return RETOUCH_GLAM;
  }
  // realistic never reaches buildRetouchPrompt — the handler short-circuits
  // before getting here. Returning an empty string would be a bug if it did,
  // so we throw to make the misuse loud.
  throw new Error(`buildRetouchPrompt called with unexpected tier: ${tier}`);
}

// ---- Helper to normalize base64 input ----
// The client may send either a full data URI ("data:image/jpeg;base64,...")
// or just the raw base64 payload. We accept both and return the pieces
// Gemini's SDK needs.
function parseBase64Input(input: string): { mimeType: string; data: string } {
  const match = input.match(/^data:([^;]+);base64,(.+)$/);
  if (match) {
    return { mimeType: match[1], data: match[2] };
  }
  // Raw base64 — assume JPEG (Gemini accepts JPEG/PNG/WebP).
  return { mimeType: "image/jpeg", data: input };
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse | void> {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body as Partial<RetouchRequest>;

  // ---- Paywall gate ----
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    return res.status(500).json({ error: "Server missing STRIPE_SECRET_KEY" });
  }
  const unlock = await verifyUnlock(
    body.stripeSessionId,
    body.promoCode,
    stripeSecretKey,
  );
  if (!unlock.ok) {
    return res
      .status(402)
      .json({ error: "Payment required", reason: unlock.reason });
  }

  // ---- Validate inputs ----
  if (!body.photoBase64 || typeof body.photoBase64 !== "string") {
    return res.status(400).json({ error: "Missing photoBase64" });
  }
  if (
    !body.tier ||
    (body.tier !== "realistic" &&
      body.tier !== "polished" &&
      body.tier !== "glam")
  ) {
    return res.status(400).json({ error: "Invalid tier" });
  }

  // ---- Realistic short-circuit ----
  // No second pass needed; return the input image as the "retouched" output.
  // This keeps the calling code symmetric (always calls /api/retouch even
  // for Realistic) and centralizes the "what counts as the final image"
  // decision here.
  if (body.tier === "realistic") {
    const dataUri = body.photoBase64.startsWith("data:")
      ? body.photoBase64
      : `data:image/jpeg;base64,${body.photoBase64}`;
    return res.status(200).json({ image: dataUri });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server missing GEMINI_API_KEY" });
  }

  try {
    const prompt = buildRetouchPrompt(body.tier, body.ageBand);
    const { mimeType, data } = parseBase64Input(body.photoBase64);

    const ai = new GoogleGenAI({ apiKey });
    const parts: Part[] = [
      { text: prompt },
      { inlineData: { mimeType, data } },
    ];

    const response = await ai.models.generateContent({
      model: RETOUCH_MODEL,
      contents: [{ role: "user", parts }],
    });

    // Walk the response for the first inline image part.
    const candidates = response.candidates ?? [];
    for (const candidate of candidates) {
      const candParts = candidate.content?.parts ?? [];
      for (const p of candParts) {
        const inline = (p as { inlineData?: { mimeType?: string; data?: string } })
          .inlineData;
        if (inline?.data && inline.mimeType) {
          const dataUri = `data:${inline.mimeType};base64,${inline.data}`;
          const payload: RetouchResponse = { image: dataUri };
          return res.status(200).json(payload);
        }
      }
    }
    // No image came back — surface as a 502 so the caller can decide
    // whether to retry or fall back to the un-retouched input.
    console.error(
      "[retouch] Gemini Pro returned no image:",
      JSON.stringify(response).slice(0, 800),
    );
    return res
      .status(502)
      .json({ error: "Gemini Pro returned no image for retouch" });
  } catch (error) {
    console.error("=== /api/retouch FAILED ===");
    console.error("Error type:", error?.constructor?.name);
    console.error(
      "Error message:",
      error instanceof Error ? error.message : String(error),
    );
    const message =
      error instanceof Error ? error.message : "Retouch failed";
    return res.status(500).json({ error: message });
  }
}
