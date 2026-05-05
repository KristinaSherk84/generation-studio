/**
 * GET /api/test-email
 *
 * Sends a sample customer delivery email — same layout, copy, and From
 * address as a real customer would receive — without burning a Gemini
 * batch. Costs $0 (no image generation; reuses public marketing assets
 * already deployed at /marketing/examples/*.jpg).
 *
 * Use this to verify email rendering after layout/copy edits, after
 * Resend domain swaps, or to debug deliverability without running a
 * full purchase flow.
 *
 * Gated by the same `PROMO_CODE` env var Kristi uses for friend/family
 * unlocks. Anyone without that code gets a 403.
 *
 * Usage:
 *   https://generation-studio-gamma.vercel.app/api/test-email
 *     ?to=kristi@kristinasherk.com
 *     &secret=<your-promo-code>
 *
 * Returns:
 *   { ok: true, sentTo: "..." } on success
 *   { error: "..." } on failure
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  sendCustomerDeliveryEmail,
  type DeliveryManifest,
} from "./deliver.js";

export const maxDuration = 15;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse | void> {
  // Gate by promo code so only Kristi (or anyone she's shared the code
  // with) can fire this endpoint. Prevents random visitors from spamming
  // the test email at her or anyone else's address.
  const expectedSecret = process.env.PROMO_CODE;
  if (!expectedSecret) {
    return res
      .status(500)
      .json({ error: "Server missing PROMO_CODE env var" });
  }
  const submittedSecret =
    typeof req.query.secret === "string" ? req.query.secret : "";
  if (
    submittedSecret.trim().toLowerCase() !==
    expectedSecret.trim().toLowerCase()
  ) {
    return res.status(403).json({ error: "Bad or missing secret" });
  }

  // Default to Kristi's inbox if no `to` is supplied — most common case
  // is her testing the rendering on her own email.
  const toRaw =
    typeof req.query.to === "string" ? req.query.to : "kristi@kristinasherk.com";
  const to = toRaw.trim();
  if (!EMAIL_REGEX.test(to)) {
    return res.status(400).json({ error: "Invalid `to` email" });
  }

  // Build the public origin so email image URLs resolve from the
  // deployed Vercel app (these JPGs ship in /public/marketing/examples).
  const host = req.headers.host;
  if (!host) {
    return res.status(400).json({ error: "Missing Host header" });
  }
  const origin = `https://${host}`;

  // Mock manifest. Photo URLs + share-graphic URLs all point to existing
  // public marketing examples so the email renders with real images
  // (rather than broken-image icons). The "share graphics" in the test
  // email aren't actual 1200x1740 composites with QR — just the same
  // example AI headshots — but the layout, copy, fonts, From line, and
  // overall styling will be identical to a real delivery, which is what
  // we usually want to verify.
  const exampleUrls = [
    `${origin}/marketing/examples/ai-headshot-generator-man-suit-tie.jpg`,
    `${origin}/marketing/examples/ai-headshot-generator-woman-blue-blazer.jpg`,
    `${origin}/marketing/examples/ai-headshot-generator-man-glasses.jpg`,
  ];

  const manifest: DeliveryManifest = {
    deliveryId: `test-email-${Date.now()}`,
    timestamp: new Date().toISOString(),
    email: to,
    style: "corporate",
    attire: "formal",
    lighting: "studio",
    background: "lightgrey",
    skin: "polished",
    referencePhotoUrls: [],
    deliveredHeadshotUrls: exampleUrls,
    shareGraphicUrls: exampleUrls,
  };

  try {
    await sendCustomerDeliveryEmail({ manifest });
    return res.status(200).json({
      ok: true,
      sentTo: to,
      note: "Test email sent. Check inbox (and spam folder if you don't see it).",
    });
  } catch (error) {
    console.error("=== /api/test-email FAILED ===");
    console.error(error instanceof Error ? error.message : String(error));
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Test send failed",
    });
  }
}
