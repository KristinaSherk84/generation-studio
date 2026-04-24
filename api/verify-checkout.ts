/**
 * POST /api/verify-checkout
 *
 * After Stripe redirects the user back to our site with
 * `?paid=1&session_id=<ID>`, the frontend MUST call this endpoint to confirm
 * the session was actually paid before unlocking the flow. Never trust the
 * query param alone — anyone can forge `?paid=1` in their browser URL bar.
 *
 * This endpoint retrieves the Stripe Checkout Session by ID using our secret
 * key and returns `{ paid: true/false }` based on `payment_status`.
 *
 * Phase 1 scope: the unlock is purely UI-side (a sessionStorage flag). Phase 2
 * will also gate `/api/generate` on a server-verified signal, but that's a
 * later change.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

export const maxDuration = 15;

type VerifyResponse = {
  paid: boolean;
  customerEmail?: string;
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

  const body = req.body as { session_id?: string } | undefined;
  const sessionId = body?.session_id?.trim();
  if (!sessionId) {
    return res.status(400).json({ error: "Missing session_id" });
  }
  // Stripe session IDs always start with "cs_" — cheap sanity check to bail
  // before calling Stripe with obviously garbage input.
  if (!sessionId.startsWith("cs_")) {
    return res.status(400).json({ error: "Invalid session_id" });
  }

  try {
    const stripeResp = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
      },
    );

    if (!stripeResp.ok) {
      const errText = await stripeResp.text().catch(() => "");
      console.error(
        JSON.stringify({
          type: "stripe_session_retrieve_failed",
          status: stripeResp.status,
          body: errText.slice(0, 500),
        }),
      );
      // 404 → user forged a session id. Just return paid: false.
      if (stripeResp.status === 404) {
        const payload: VerifyResponse = { paid: false };
        return res.status(200).json(payload);
      }
      return res
        .status(502)
        .json({ error: "Stripe rejected the verify request" });
    }

    const session = (await stripeResp.json()) as {
      payment_status?: string;
      customer_details?: { email?: string } | null;
      customer_email?: string | null;
    };

    // Stripe payment_status values: "paid", "unpaid", "no_payment_required".
    // Only "paid" unlocks the flow. "no_payment_required" shouldn't occur for
    // our $4.99 mode=payment session but is caught defensively.
    const paid = session.payment_status === "paid";

    const email =
      session.customer_details?.email ??
      session.customer_email ??
      undefined;

    const payload: VerifyResponse = {
      paid,
      ...(email ? { customerEmail: email } : {}),
    };
    return res.status(200).json(payload);
  } catch (error) {
    console.error("=== /api/verify-checkout FAILED ===");
    console.error(
      "Error message:",
      error instanceof Error ? error.message : String(error),
    );
    const message =
      error instanceof Error ? error.message : "Verify failed";
    return res.status(500).json({ error: message });
  }
}
