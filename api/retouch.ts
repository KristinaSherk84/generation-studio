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
import {
  buildRetouchPrompt,
  RETOUCH_MODEL,
  type RetouchTier as Tier,
  type AgeBand,
} from "./lib/retouchPrompts.js";

// Pro Image Preview is ~10-15s per call typically, up to 30s on a slow
// worker. 60s gives us headroom for one retry on a single image. The
// /api/deliver caller chains multiple of these in parallel.
export const maxDuration = 60;

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
  // Case-insensitive promo compare — see note in api/generate.ts verifyUnlock.
  // The landing-page input force-uppercases; PROMO_CODE env var is likely
  // lowercase; verify-promo lowercases both sides. Mirror that here so
  // promo-unlock users don't 402 on retouch. Bug fixed 2026-05-18.
  if (promoCode && typeof promoCode === "string") {
    const envCode = process.env.PROMO_CODE;
    if (
      envCode &&
      constantTimeEquals(
        promoCode.trim().toLowerCase(),
        envCode.trim().toLowerCase(),
      )
    ) {
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

// Prompt strings + buildRetouchPrompt live in api/lib/retouchPrompts.ts
// so /api/deliver can share them. Imported at the top of this file.

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
      // Keep aspectRatio: "3:4" so Gemini doesn't recompose framing.
      // imageSize "2K" was removed 2026-05-22: pinning the size made
      // Pro apply less aggressive retouching than the standalone
      // tester (which sends no imageConfig). Trade-off accepted —
      // retouched output is ~896x1200 instead of 2K but the aesthetic
      // is meaningfully better. See deliver.ts runSubTier for the
      // same change.
      config: {
        imageConfig: {
          aspectRatio: "3:4",
        },
      },
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
