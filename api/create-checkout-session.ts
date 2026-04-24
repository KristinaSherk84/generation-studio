/**
 * POST /api/create-checkout-session
 *
 * Creates a Stripe Checkout Session for the $4.99 "Try It" entry fee and
 * returns the hosted-checkout URL so the frontend can window.location to it.
 *
 * Phase 1 paywall (2026-04-24): this endpoint exists purely to gate the UI
 * flow — `/api/generate` is NOT gated on paid state yet, so a determined user
 * could still bypass by calling the backend directly. That's acceptable for
 * Phase 1 and will tighten in Phase 2 alongside the $9.99 per-photo checkout.
 *
 * Pricing model reminder (confirmed with Kristi):
 *   - $4.99 entry fee unlocks the 6-headshot generation flow.
 *   - The $4.99 is CREDITED against the first $9.99 high-rez purchase in
 *     Phase 2 — so 1 photo total = $9.99 net, not $14.98.
 *
 * Sandbox vs live: this endpoint reads STRIPE_SECRET_KEY and STRIPE_PRICE_ID_ENTRY
 * from env vars. As long as those are test-mode values (sk_test_... /
 * price_... from the sandbox), every transaction here is fake money. When
 * Kristi flips to live, swap both env vars and nothing else needs to change.
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
