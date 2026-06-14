/**
 * POST /api/burn-unlock
 *
 * Flips metadata.unlock_consumed = "true" on a Stripe Checkout Session,
 * which prevents that session's $2.99 unlock from being reused for a
 * second batch of /api/generate calls.
 *
 * Called by the frontend on the FIRST download click on the Download
 * screen. Replaces the burn that used to live at the end of /api/deliver.
 *
 * Why this exists (2026-06-12): the old deliver-side burn killed the
 * "Regenerate in another style" bonus teaser, because the bonus uses
 * /api/generate and the unlock was already consumed by the time the
 * customer landed on the Download screen. Moving the burn to first
 * download click lets the bonus teaser fire BEFORE the unlock is burned.
 *
 * Idempotent: a second call with the same sessionId is a no-op (the
 * field is already "true"), so the frontend can safely call it again on
 * subsequent download clicks without worry. The Stripe API also accepts
 * a redundant write without error.
 *
 * Promo-unlock customers do not call this endpoint at all (they have
 * no sessionId). Their unlock persists for as many sessions as they
 * want, which is intentional — friends/family/Tiffany etc. shouldn't
 * have to ask for a new code every time.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

export const maxDuration = 10;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse | void> {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body as { session_id?: string } | undefined;
  const sessionId = body?.session_id?.trim();
  if (!sessionId) {
    return res.status(400).json({ error: "Missing session_id" });
  }
  if (!sessionId.startsWith("cs_")) {
    return res.status(400).json({ error: "Invalid session_id" });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    console.error("STRIPE_SECRET_KEY not set — cannot burn unlock");
    // Non-blocking: respond 200 so the frontend doesn't show a download
    // error to a paid customer over a server-config issue. The 4h TTL
    // backstop still applies.
    return res.status(200).json({ burned: false, reason: "no_secret_key" });
  }

  try {
    const formBody = new URLSearchParams();
    formBody.append("metadata[unlock_consumed]", "true");
    const burnResp = await fetch(
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
    if (!burnResp.ok) {
      const errText = await burnResp.text().catch(() => "");
      console.warn(
        JSON.stringify({
          type: "unlock_burn_failed",
          status: burnResp.status,
          sessionId,
          body: errText.slice(0, 300),
        }),
      );
      // Still respond 200 — the customer's download experience must
      // not be blocked by a metadata write hiccup. The 4h TTL is the
      // backstop, and the next download click will retry the burn.
      return res
        .status(200)
        .json({ burned: false, reason: `stripe_${burnResp.status}` });
    }
    return res.status(200).json({ burned: true });
  } catch (err) {
    console.warn(
      "burn-unlock threw:",
      err instanceof Error ? err.message : String(err),
    );
    return res.status(200).json({ burned: false, reason: "exception" });
  }
}
</content>
