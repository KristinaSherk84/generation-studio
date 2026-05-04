/**
 * POST /api/verify-checkout
 *
 * After Stripe redirects the user back to our site with
 * `?paid=1&session_id=<ID>`, the frontend MUST call this endpoint to confirm
 * the session was actually paid before unlocking the flow. Never trust the
 * query param alone — anyone can forge `?paid=1` in their browser URL bar.
 *
 * This endpoint retrieves the Stripe Checkout Session by ID using our secret
 * key and returns one of three states:
 *   { paid: true }                 — session is fully paid; unlock immediately
 *   { paid: false, pending: true } — async payment method (Cash App Pay,
 *                                    Klarna, ACH, etc.) is still settling.
 *                                    Frontend should poll and show a
 *                                    "Verifying payment…" UI.
 *   { paid: false }                — payment did not go through (abandoned,
 *                                    failed, or unpaid for non-async reasons).
 *
 * 2026-05-04 — Cash App Pay race fix:
 *   We previously returned `paid: true` only when `payment_status === "paid"`.
 *   That broke for Cash App Pay (and other "delayed notification" payment
 *   methods like Klarna and ACH): Stripe redirects the customer back to
 *   success_url BEFORE settlement completes, so the very first verify call
 *   sees `payment_status: "unpaid"` even though the customer just authorized.
 *   The frontend silently dumped them to the landing page. One customer
 *   was refunded out of customer-service necessity (May 4, 2026) before
 *   we caught this.
 *   Fix: also retrieve the session's payment_intent (via expand[]) and
 *   surface a `pending` state when the PI is "processing" or "requires_action."
 *   Frontend polls until it resolves to paid: true or a real failure.
 *
 * Phase 1 scope: the unlock is purely UI-side (a sessionStorage flag). Phase 2
 * will also gate `/api/generate` on a server-verified signal, but that's a
 * later change.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

export const maxDuration = 15;

type VerifyResponse = {
  paid: boolean;
  // True when the session is "complete" but settlement is still in progress
  // (Cash App Pay / Klarna / ACH etc.). Frontend should keep polling. When
  // paid is true, pending is irrelevant and omitted.
  pending?: boolean;
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
    // Expand `payment_intent` so we get the underlying PI's status alongside
    // the session, in one round trip. Stripe's expand[] syntax replaces the
    // string-id with the full object. We need this because the session's
    // top-level payment_status lags settlement for async methods (Cash App
    // Pay etc.) — the PI status is the more accurate "is the money in
    // motion?" signal.
    const stripeResp = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent`,
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
      // Session-level fields:
      //   - status: "open" | "complete" | "expired"
      //     "complete" means the customer finished the Stripe Checkout flow
      //     (i.e., they authorized payment). It does NOT guarantee settlement.
      //   - payment_status: "paid" | "unpaid" | "no_payment_required"
      //     For async methods this stays "unpaid" until Stripe receives final
      //     confirmation from the issuer/wallet — can be seconds (Cash App)
      //     to days (ACH).
      status?: string;
      payment_status?: string;
      customer_details?: { email?: string } | null;
      customer_email?: string | null;
      // After expand[]=payment_intent this is the PI object, not just an id.
      // PI.status: "requires_payment_method" | "requires_confirmation" |
      //   "requires_action" | "processing" | "requires_capture" |
      //   "succeeded" | "canceled"
      // "succeeded" and "processing" both indicate the customer authorized
      // a real payment that's either settled or in transit. Both are safe
      // to recognize as "the money is real."
      payment_intent?: {
        status?: string;
      } | string | null;
    };

    const piStatus =
      session.payment_intent && typeof session.payment_intent === "object"
        ? session.payment_intent.status
        : undefined;

    // Decision tree for the three return states:
    //
    // (1) Fully paid → unlock immediately.
    //     Two ways to land here:
    //       a. session.payment_status === "paid"  (cards, settled async)
    //       b. payment_intent.status === "succeeded"  (covers a tiny race
    //          where the PI flipped to succeeded but the session.payment_status
    //          field hasn't propagated yet — happens in practice).
    //
    // (2) Async settlement in progress → tell frontend to poll.
    //     Triggered by: session.status === "complete" AND PI.status === "processing"
    //     (Cash App Pay normally, ACH always, Klarna sometimes.)
    //     Also includes "requires_action" defensively (rare for hosted Checkout
    //     but Stripe's docs allow it).
    //
    // (3) Not paid (abandoned, expired, failed). Default branch.
    let paid = false;
    let pending = false;
    if (session.payment_status === "paid" || piStatus === "succeeded") {
      paid = true;
    } else if (
      session.status === "complete" &&
      (piStatus === "processing" || piStatus === "requires_action")
    ) {
      pending = true;
    }

    const email =
      session.customer_details?.email ??
      session.customer_email ??
      undefined;

    const payload: VerifyResponse = {
      paid,
      ...(pending && !paid ? { pending: true } : {}),
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
