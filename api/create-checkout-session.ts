/**
 * POST /api/create-checkout-session
 *
 * Creates a Stripe Checkout Session for the $2.99 "Try It" entry fee and
 * returns the hosted-checkout URL so the frontend can window.location to it.
 *
 * Pricing model (current 2026-05-15, Path B launch):
 *   - $2.99 entry fee unlocks the 6-headshot generation flow for 2 hours
 *     (or until the customer downloads their first photo, whichever first).
 *   - Each high-rez photo is a flat $11.99 — includes the customer's
 *     chosen retouch tier (Realistic / Polished / Glam). No tier upcharge.
 *   - History:
 *     - Pre-2026-05-15: $9.99/photo with $2.99 credit toward first photo.
 *       Credit leaked because sessionStorage reset per tab.
 *     - 2026-05-14: dropped credit, flat $9.99/photo, no retouch tier.
 *     - 2026-05-15 (Path B): $11.99/photo, retouch tier included. Initial
 *       generation now produces Realistic for everyone; tier choice
 *       happens at the new "Customize your Retouch Level" screen between
 *       grid and checkout. Unlock TTL dropped from 4h to 2h.
 *
 * Server-side gate on /api/generate (2026-05-15):
 *   - Every /api/generate call now requires either the Stripe Checkout
 *     Session ID from this $2.99 payment OR the PROMO_CODE env-var value.
 *   - The Stripe session's metadata (unlock_expires_at + unlock_consumed)
 *     is the source of truth for whether the unlock is still valid.
 *
 * Sandbox vs live: this endpoint reads STRIPE_SECRET_KEY and STRIPE_PRICE_ID_ENTRY
 * from env vars. Currently set to live-mode values (sk_live_... and the
 * $2.99 price ID created 2026-04-30). Sandbox can be re-enabled by swapping
 * both env vars back to test-mode equivalents.
 *
 * Why raw fetch instead of the stripe npm package: the Vercel sandbox this
 * function deploys into is locked down and we couldn't `npm install stripe`
 * from the build environment. Stripe's REST API is stable and form-encoded —
 * easy to call directly.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

// Creating a Checkout Session is a single fast API call.
export const maxDuration = 15;

type CreateCheckoutResponse = {
  url: string;
};

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse | void> {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const priceId = process.env.STRIPE_PRICE_ID_ENTRY;
  if (!secretKey) {
    return res
      .status(500)
      .json({ error: "Server missing STRIPE_SECRET_KEY" });
  }
  if (!priceId) {
    return res
      .status(500)
      .json({ error: "Server missing STRIPE_PRICE_ID_ENTRY" });
  }

  // Build the full origin (scheme + host) so Stripe has an absolute URL for
  // success_url / cancel_url. Vercel always serves over HTTPS.
  const host = req.headers.host;
  if (!host) {
    return res.status(400).json({ error: "Missing Host header" });
  }
  const origin = `https://${host}`;

  // Stripe's Checkout Session create endpoint takes form-encoded body params.
  // Nested keys use bracket notation: line_items[0][price], etc.
  //
  // success_url includes {CHECKOUT_SESSION_ID} — a literal placeholder Stripe
  // substitutes with the real session ID on redirect. The frontend then POSTs
  // that session_id to /api/verify-checkout before unlocking the flow.
  const formBody = new URLSearchParams();
  formBody.append("mode", "payment");
  formBody.append("line_items[0][price]", priceId);
  formBody.append("line_items[0][quantity]", "1");
  formBody.append(
    "success_url",
    `${origin}/?paid=1&session_id={CHECKOUT_SESSION_ID}`,
  );
  formBody.append("cancel_url", `${origin}/`);
  // We want to capture the user's email on the Stripe page so we can match
  // against delivery emails later. Stripe collects it automatically when
  // customer_email isn't pre-populated.
  formBody.append("billing_address_collection", "auto");

  try {
    const stripeResp = await fetch(
      "https://api.stripe.com/v1/checkout/sessions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formBody.toString(),
      },
    );

    if (!stripeResp.ok) {
      const errText = await stripeResp.text().catch(() => "");
      console.error(
        JSON.stringify({
          type: "stripe_checkout_create_failed",
          status: stripeResp.status,
          body: errText.slice(0, 500),
        }),
      );
      return res.status(502).json({
        error: "Stripe rejected the checkout session request",
        detail: errText.slice(0, 200),
      });
    }

    const session = (await stripeResp.json()) as {
      url?: string;
      id?: string;
    };
    if (!session.url) {
      console.error(
        JSON.stringify({
          type: "stripe_checkout_missing_url",
          session_id: session.id,
        }),
      );
      return res
        .status(502)
        .json({ error: "Stripe returned no checkout URL" });
    }

    const payload: CreateCheckoutResponse = { url: session.url };
    return res.status(200).json(payload);
  } catch (error) {
    console.error("=== /api/create-checkout-session FAILED ===");
    console.error(
      "Error message:",
      error instanceof Error ? error.message : String(error),
    );
    const message =
      error instanceof Error ? error.message : "Checkout session create failed";
    return res.status(500).json({ error: message });
  }
}
