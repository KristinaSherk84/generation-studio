/**
 * POST /api/create-photo-checkout-session
 *
 * Phase 2 paywall (2026-04-24, simplified 2026-05-14). Creates a Stripe
 * Checkout Session for the per-photo charge at delivery time.
 * Body: { count, customerEmail? }.
 *
 * Pricing model (simplified 2026-05-14):
 *   - Each high-rez headshot is $9.99 flat.
 *   - Total = $9.99 × count, always. No credit, no per-customer discount.
 *
 * Previously: the $2.99 entry fee was credited against the first photo
 * purchase, so 1 photo would cost $9.99 ($2.99 paid earlier + $7.00 at
 * checkout). That model was dropped because the client-side `credit_used`
 * tracking lived in sessionStorage, which resets per tab — customers
 * coming back in a new session were re-claiming the credit indefinitely.
 * Flat-price keeps the math honest and the copy simple. Paired with a
 * 48-hour TTL on the entry unlock so casual return visitors re-pay $2.99
 * to re-enter (see PAYWALL_UNLOCK_TTL_MS in src/App.tsx).
 *
 * Single-line-item design: ONE custom-priced line item whose `unit_amount`
 * is the computed total, instead of N separate $9.99 line items. Simpler
 * for us, clearer for the user at the Stripe page.
 *
 * success_url carries `photo_paid=1` to distinguish from Phase 1's `paid=1`.
 * The mount-time useEffect in App.tsx picks this up, verifies server-side,
 * reads the pending delivery stash from sessionStorage, and runs /api/deliver.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

export const maxDuration = 15;

const PRICE_PER_PHOTO_CENTS = 999;

type CreatePhotoCheckoutBody = {
  count: number;
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

  // Flat pricing — no credit, no discount.
  const totalCents = PRICE_PER_PHOTO_CENTS * count;

  const host = req.headers.host;
  if (!host) {
    return res.status(400).json({ error: "Missing Host header" });
  }
  const origin = `https://${host}`;

  // Line item name shows on the Stripe page. Plural-aware so the user
  // recognizes what they're paying for.
  const itemName = `${count} high-rez AI headshot${count > 1 ? "s" : ""}`;

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
