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
 *   { paid: true, sessionId, unlockExpiresAt } — paid; unlock immediately
 *   { paid: false, pending: true }             — async payment in flight
 *   { paid: false }                            — not paid (abandoned/failed)
 *
 * 2026-05-15 — Session-bound paywall gate.
 *   When the session first confirms as paid here, we WRITE two metadata
 *   fields to the Stripe Checkout Session itself:
 *     - unlock_expires_at: epoch milliseconds, set to now + 2 hours.
 *       The window during which /api/generate accepts this session as a
 *       valid unlock token.
 *     - unlock_consumed: "false" initially. /api/deliver flips this to
 *       "true" on a successful download, immediately killing the unlock
 *       even if the 2-hour window hasn't elapsed.
 *   /api/generate then consults THESE FIELDS as the source of truth for
 *   whether to do the expensive Gemini work. Stripe is the database here
 *   — no new infrastructure needed and the customer can never tamper with
 *   their own metadata (only our secret key can write).
 *
 *   The write is idempotent: if metadata.unlock_expires_at is already set
 *   on a re-verify (e.g., the user refreshes the success URL), we leave
 *   the existing values alone. The clock starts ONCE at first confirmation.
 *
 * 2026-05-04 — Cash App Pay race fix (unchanged):
 *   We previously returned `paid: true` only when `payment_status === "paid"`.
 *   That broke for Cash App Pay (and other "delayed notification" payment
 *   methods like Klarna and ACH): Stripe redirects the customer back to
 *   success_url BEFORE settlement completes. We now also accept
 *   `payment_intent.status === "succeeded"` as paid, and surface a `pending`
 *   state when the PI is "processing" or "requires_action" so the frontend
 *   can poll until it resolves.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { recordUnlockPayment } from "./lib/freeGenLimit.js";

export const maxDuration = 15;

// Length of the unlock window after the $2.99 entry is confirmed paid.
// Per Kristi 2026-05-15: 2 hours is long enough for any reasonable
// customer flow (10-15 min for a focused user) but short enough that
// casual return visitors will re-pay if they walk away.
// Tightened to 2h on 2026-05-15 (was 4h). Path B launch shortened the
// session because most converting customers finish within 30 min and the
// shorter window encourages "second look" repeat-buying — customers who
// come back for another batch pay $2.99 again.
const UNLOCK_TTL_MS = 2 * 60 * 60 * 1000;

type VerifyResponse = {
  paid: boolean;
  // True when the session is "complete" but settlement is still in progress
  // (Cash App Pay / Klarna / ACH etc.). Frontend should keep polling. When
  // paid is true, pending is irrelevant and omitted.
  pending?: boolean;
  customerEmail?: string;
  // GA4 / Google Ads conversion tracking fields (added 2026-06-11 per the
  // conversion-tracking handoff). Returned only when paid:true. Frontend
  // fires gtag('event','purchase',{ transaction_id, value, currency })
  // exactly once per session_id using these values + a localStorage guard.
  paymentIntentId?: string;
  amountTotal?: number; // STRIPE NATIVE UNITS — cents. Frontend divides by 100.
  currency?: string; // lowercase ISO 4217 from Stripe (e.g. "usd"); frontend uppercases.
  // Returned only when paid:true. The Stripe session ID is what the
  // frontend stores and forwards on every /api/generate call so the
  // server can re-verify the unlock.
  sessionId?: string;
  // Returned only when paid:true. Epoch milliseconds when the 2-hour
  // window expires. Frontend uses this for the countdown UI and to
  // detect expiry without a server round-trip.
  unlockExpiresAt?: number;
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
  if (!sessionId.startsWith("cs_")) {
    return res.status(400).json({ error: "Invalid session_id" });
  }

  try {
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
      if (stripeResp.status === 404) {
        const payload: VerifyResponse = { paid: false };
        return res.status(200).json(payload);
      }
      return res
        .status(502)
        .json({ error: "Stripe rejected the verify request" });
    }

    const session = (await stripeResp.json()) as {
      status?: string;
      payment_status?: string;
      customer_details?: { email?: string } | null;
      customer_email?: string | null;
      payment_intent?:
        | { id?: string; status?: string }
        | string
        | null;
      // GA4 conversion-tracking fields (read 2026-06-11). Stripe always
      // returns amount_total in the smallest currency unit (cents for USD).
      amount_total?: number | null;
      currency?: string | null;
      // Our own unlock-state fields written by this endpoint on first
      // confirmation and read on every subsequent /api/generate call.
      metadata?: Record<string, string> | null;
    };

    const piStatus =
      session.payment_intent && typeof session.payment_intent === "object"
        ? session.payment_intent.status
        : undefined;
    const paymentIntentId =
      session.payment_intent && typeof session.payment_intent === "object"
        ? session.payment_intent.id
        : undefined;

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

    // -----------------------------------------------------------------
    // First-confirmation hook: when paid:true AND we haven't already
    // stamped unlock_expires_at on this session, write it now. The clock
    // starts here and runs for UNLOCK_TTL_MS (4h). Idempotent across
    // re-verifies — if the field is already set we leave it alone.
    // -----------------------------------------------------------------
    let unlockExpiresAt: number | undefined;
    if (paid) {
      const existing = session.metadata?.unlock_expires_at;
      const existingNum = existing ? Number(existing) : NaN;
      if (Number.isFinite(existingNum) && existingNum > 0) {
        // Re-verify of a session we've already stamped — use the
        // existing window so the clock doesn't reset on refresh.
        unlockExpiresAt = existingNum;
      } else {
        // First confirmation. Write the window to Stripe metadata AND grant
        // the caller's IP additional hard-cap credits (2026-09-09 per
        // Kristi) so a paying user isn't blocked at the 40-call abuse
        // floor. Idempotency: the credit grant is gated on the SAME
        // "no unlock_expires_at yet" branch as the metadata write, so a
        // page refresh / re-verify never double-credits.
        unlockExpiresAt = Date.now() + UNLOCK_TTL_MS;
        // Client IP for the per-IP hard-cap credit. Vercel puts the real
        // client first in x-forwarded-for; x-real-ip is the fallback.
        const xff = req.headers["x-forwarded-for"];
        const clientIp =
          (typeof xff === "string"
            ? xff.split(",")[0]?.trim()
            : Array.isArray(xff)
              ? xff[0]
              : "") ||
          (typeof req.headers["x-real-ip"] === "string"
            ? (req.headers["x-real-ip"] as string)
            : "") ||
          "";
        // Fire the credit grant BEFORE the Stripe write so the customer
        // sees the extra headroom on their very next /api/generate call.
        // Best-effort — a Redis blip should never fail the paywall verify.
        // recordUnlockPayment tracks how many $3.99 payments this IP has
        // made in the rolling window and only grants credits on the 2nd+
        // payment (2026-09-09 per Kristi's model — payment #1 = 40 total,
        // payment #2 = 70, payment #3 = 100).
        let creditsGranted = 0;
        try {
          const result = await recordUnlockPayment(clientIp);
          creditsGranted = result.creditsGranted;
          console.log(
            JSON.stringify({
              type:
                creditsGranted > 0
                  ? "hardcap_credit_granted"
                  : "hardcap_first_payment_no_credit",
              ip: clientIp || "unknown",
              sessionId,
              paymentNumber: result.paymentNumber,
              creditsGranted,
              totalExtraCreditsForIp: result.totalExtraCredits,
              email,
            }),
          );
        } catch (err) {
          console.warn(
            "hardcap credit grant threw:",
            err instanceof Error ? err.message : String(err),
          );
        }
        try {
          const formBody = new URLSearchParams();
          formBody.append(
            "metadata[unlock_expires_at]",
            String(unlockExpiresAt),
          );
          formBody.append("metadata[unlock_consumed]", "false");
          // Stamp the credit grant on the Stripe session too so an audit
          // trail lives outside Redis (Redis is ephemeral; Stripe metadata
          // survives forever) and so we can spot double-credits later.
          if (creditsGranted > 0) {
            formBody.append(
              "metadata[hardcap_credit_granted]",
              String(creditsGranted),
            );
          }
          const updateResp = await fetch(
            `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${secretKey}`,
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: formBody.toString(),
            },
          );
          if (!updateResp.ok) {
            // Log but don't fail the whole verify — the user has paid;
            // we can recover by reading metadata on the next call.
            const errText = await updateResp.text().catch(() => "");
            console.warn(
              JSON.stringify({
                type: "stripe_session_metadata_write_failed",
                status: updateResp.status,
                sessionId,
                body: errText.slice(0, 400),
              }),
            );
            // Fall back to in-memory window — user gets full 4h locally
            // even though server can't enforce until metadata is set.
          }
        } catch (err) {
          console.warn(
            "Stripe session metadata write threw:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }

    const payload: VerifyResponse = {
      paid,
      ...(pending && !paid ? { pending: true } : {}),
      ...(email ? { customerEmail: email } : {}),
      ...(paid ? { sessionId } : {}),
      ...(paid && unlockExpiresAt ? { unlockExpiresAt } : {}),
      // GA4 conversion-tracking fields (2026-06-11). Only included when
      // paid so the frontend can fire gtag('event','purchase',...) once.
      ...(paid && paymentIntentId ? { paymentIntentId } : {}),
      ...(paid && typeof session.amount_total === "number"
        ? { amountTotal: session.amount_total }
        : {}),
      ...(paid && session.currency ? { currency: session.currency } : {}),
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
