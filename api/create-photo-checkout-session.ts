/**
 * POST /api/create-photo-checkout-session
 *
 * Phase 2 paywall (2026-04-24). Creates a Stripe Checkout Session for the
 * per-photo charge at delivery time. Body: { count, creditApplied }.
 *
 * Pricing model:
 *   - Each high-rez headshot is $9.99.
 *   - If `creditApplied` is true (user paid the $4.99 entry earlier and hasn't
 *     consumed the credit yet), we subtract $4.99 from the total.
 *   - If `creditApplied` is false (user used a promo code OR has already
 *     consumed the credit on a prior purchase), the total is $9.99 × count.
 *
 * Single-line-item design: instead of N separate $9.99 line items plus a
 * Stripe Coupon for the discount, we create ONE custom-priced line item whose
 * `unit_amount` is the computed total. Simpler for us, clearer for the user
 * at the Stripe page ("2 high-rez AI headshots ($4.99 credit applied) — $14.99").
 *
 * success_url carries `photo_paid=1` to distinguish from Phase 1's `paid=1`.
 * The mount-time useEffect in App.tsx picks this up, verifies server-side,
 * reads the pending delivery stash from sessionStorage, and runs /api/deliver.
 *
 * Notes for the future:
 *   - We could also expose `creditApplied` as a server-computed field instead
 *     of trusting the client — look the customer up by email and check Stripe
 *     for prior $4.99 charges. Not worth it for Phase 2 MVP.
 *   - When the full Stripe integration matures, consider a webhook-driven
 *     fulfillment flow so /api/deliver isn't gated on the client's ability to
 *     come back from Stripe. For now, the verify-on-return path is simpler.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

export const maxDuration = 15;

const PRICE_PER_PHOTO_CENTS = 999;
const ENTRY_CREDIT_CENTS = 499;

type CreatePhotoCheckoutBody = {
  count: number;
  creditApplied: boolean;
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
  const count = Number(body?.count);
  const creditApplied = body?.creditApplied === true;
  const customerEmail =
    typeof body?.customerEmail === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.customerEmail.trim())
      ? body.customerEmail.trim()
      : undefined;

  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 20 // generous ceiling — typical user buys 1–3
  ) {
    return res.status(400).json({ error: "Invalid count" });
  }

  // Compute the line-item total. Clamp to 0 in case a future credit scheme
  // produces a negative (Stripe would reject negative unit_amount anyway).
  const subtotalCents = PRICE_PER_PHOTO_CENTS * count;
  const creditCents = creditApplied ? ENTRY_CREDIT_CENTS : 0;
  const totalCents = Math.max(0, subtotalCents - creditCents);

  // Edge case: if the credit covers the entire purchase (e.g. a future plan
  // where credit > first-photo price), Stripe won't accept a $0 line item.
  // Return an error so the client can fall through to the skip-Stripe branch.
  if (totalCents === 0) {
    return res
      .status(400)
      .json({ error: "Total is zero — skip Stripe and deliver directly" });
  }

  const host = req.headers.host;
  if (!host) {
    return res.status(400).json({ error: "Missing Host header" });
  }
  const origin = `https://${host}`;

  // Line item name shows on the Stripe page. Make it descriptive so the user
  // recognizes what they're paying for and sees the credit reflected.
  const itemName = `${count} high-rez AI headshot${count > 1 ? "s" : ""}${
    creditApplied ? " (includes $4.99 credit from your entry purchase)" : ""
  }`;

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
          creditApplied,
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
