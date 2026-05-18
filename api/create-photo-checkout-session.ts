/**
 * POST /api/create-photo-checkout-session
 *
 * Phase 2 paywall (2026-04-24, simplified 2026-05-14, Glow Up Deluxe
 * pivot 2026-05-18). Creates a Stripe Checkout Session for the per-photo
 * charge at delivery time.
 *
 * Body: { retouchTiers: ("basic" | "deluxe")[], customerEmail? }.
 *
 * Pricing model (current 2026-05-18, Glow Up Deluxe Bundle launch):
 *   - Basic photo: $9.99 — Realistic only, no retouching.
 *   - Glow Up Deluxe Bundle photo: $14.99 — customer receives all 3
 *     versions of that headshot (Realistic + Polished + Glam).
 *   - Per-photo tier is chosen on the new RetouchScreen. Mixed orders
 *     are allowed — a customer can buy 1 Basic + 2 Deluxe for $39.97.
 *
 * Previous model (2026-05-15, dropped): every photo was $11.99 flat and
 * the customer picked Realistic / Polished / Glam per photo. The Deluxe
 * pivot replaces that with a simpler 2-tier model where the customer
 * doesn't have to commit to a single retouching style — they can buy
 * all 3 and pick later, hedging against any one tier missing on their face.
 *
 * Single-line-item design: ONE custom-priced line item whose `unit_amount`
 * is the computed total, instead of N separate per-photo line items.
 * Simpler for us, clearer for the user at the Stripe page.
 *
 * success_url carries `photo_paid=1` to distinguish from Phase 1's `paid=1`.
 * The mount-time useEffect in App.tsx picks this up, verifies server-side,
 * reads the pending delivery stash from sessionStorage, and runs /api/deliver.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

export const maxDuration = 15;

// Glow Up Deluxe pricing in cents (2026-05-18). Bifurcated from the prior
// flat $11.99 model.
const PRICE_BASIC_CENTS = 999;     // $9.99 — Realistic only, no retouching
const PRICE_DELUXE_CENTS = 1499;   // $14.99 — Realistic + Polished + Glam

type RetouchTier = "basic" | "deluxe";

type CreatePhotoCheckoutBody = {
  // One entry per picked photo, in the same order the photos were picked.
  // The length of this array determines the total photo count.
  retouchTiers: RetouchTier[];
  // Optional — the email captured by Stripe during the Phase 1 entry
  // checkout. When present we pass it as `customer_email` on the Phase 2
  // session so the Stripe page shows it pre-filled AND so Stripe Link can
  // auto-recognize the customer and fill their saved card. If omitted,
  // Stripe just prompts the user to type their email again.
  customerEmail?: string;
};

type CreatePhotoCheckoutResponse = {
  url: string;
};

function priceCentsForTier(tier: RetouchTier): number {
  return tier === "deluxe" ? PRICE_DELUXE_CENTS : PRICE_BASIC_CENTS;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse | void> {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return res
      .status(500)
      .json({ error: "Server missing STRIPE_SECRET_KEY" });
  }

  const body = req.body as Partial<CreatePhotoCheckoutBody>;
  const rawTiers = Array.isArray(body?.retouchTiers) ? body.retouchTiers : null;
  const customerEmail =
    typeof body?.customerEmail === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.customerEmail.trim())
      ? body.customerEmail.trim()
      : undefined;

  // Validate the tier array: must be present, 1-20 entries, each
  // entry "basic" or "deluxe". Generous count ceiling — typical user
  // buys 1–3 photos but we don't want to artificially cap larger orders.
  if (!rawTiers || rawTiers.length < 1 || rawTiers.length > 20) {
    return res
      .status(400)
      .json({ error: "Invalid retouchTiers — expected 1-20 entries" });
  }
  const tiers: RetouchTier[] = [];
  for (const t of rawTiers) {
    if (t !== "basic" && t !== "deluxe") {
      return res.status(400).json({
        error: `Invalid tier: ${String(t)} — expected "basic" or "deluxe"`,
      });
    }
    tiers.push(t);
  }
  const count = tiers.length;
  const basicCount = tiers.filter((t) => t === "basic").length;
  const deluxeCount = tiers.filter((t) => t === "deluxe").length;

  // Mixed total: Basic at $9.99 each + Deluxe at $14.99 each.
  const totalCents = tiers.reduce(
    (sum, t) => sum + priceCentsForTier(t),
    0,
  );

  const host = req.headers.host;
  if (!host) {
    return res.status(400).json({ error: "Missing Host header" });
  }
  const origin = `https://${host}`;

  // Line item name shows on the Stripe page. Spells out the mix so the
  // customer recognizes what they're paying for (basic vs deluxe).
  let itemName: string;
  if (basicCount > 0 && deluxeCount > 0) {
    itemName = `${basicCount} basic + ${deluxeCount} Glow Up Deluxe headshot${count > 1 ? "s" : ""}`;
  } else if (deluxeCount > 0) {
    itemName = `${deluxeCount} Glow Up Deluxe headshot${deluxeCount > 1 ? "s" : ""} (3 versions each)`;
  } else {
    itemName = `${basicCount} basic AI headshot${basicCount > 1 ? "s" : ""}`;
  }

  const formBody = new URLSearchParams();
  formBody.append("mode", "payment");
  formBody.append("line_items[0][price_data][currency]", "usd");
  formBody.append("line_items[0][price_data][product_data][name]", itemName);
  formBody.append(
    "line_items[0][price_data][unit_amount]",
    String(totalCents),
  );
  formBody.append("line_items[0][quantity]", "1");
  formBody.append(
    "success_url",
    `${origin}/?photo_paid=1&session_id={CHECKOUT_SESSION_ID}`,
  );
  // Cancel brings the user back to the landing — they'll need to re-navigate
  // to the checkout to try again. We accept this UX for Phase 2 MVP.
  formBody.append("cancel_url", `${origin}/?photo_cancel=1`);
  formBody.append("billing_address_collection", "auto");
  // Pre-fill the customer's email on the Stripe Checkout page. With Stripe
  // Link enabled (default on new Sessions), an existing Link user for that
  // email gets their saved card auto-filled one-tap. If they haven't used
  // Link before, the email is still pre-filled so they don't retype it.
  if (customerEmail) {
    formBody.append("customer_email", customerEmail);
  }

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
          type: "stripe_photo_checkout_create_failed",
          status: stripeResp.status,
          count,
          totalCents,
          body: errText.slice(0, 500),
        }),
      );
      return res.status(502).json({
        error: "Stripe rejected the checkout session request",
        detail: errText.slice(0, 200),
      });
    }

    const session = (await stripeResp.json()) as { url?: string; id?: string };
    if (!session.url) {
      console.error(
        JSON.stringify({
          type: "stripe_photo_checkout_missing_url",
          session_id: session.id,
        }),
      );
      return res.status(502).json({ error: "Stripe returned no checkout URL" });
    }

    const payload: CreatePhotoCheckoutResponse = { url: session.url };
    return res.status(200).json(payload);
  } catch (error) {
    console.error("=== /api/create-photo-checkout-session FAILED ===");
    console.error(
      "Error message:",
      error instanceof Error ? error.message : String(error),
    );
    const message =
      error instanceof Error ? error.message : "Photo checkout create failed";
    return res.status(500).json({ error: message });
  }
}
