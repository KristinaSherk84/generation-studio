/**
 * POST /api/verify-promo
 *
 * Checks a user-submitted promo code against the `PROMO_CODE` env var and
 * returns `{ valid: true/false }`. On match, the frontend flips the same
 * sessionStorage unlock flag that `/api/verify-checkout` would set — so a
 * valid promo skips Stripe entirely.
 *
 * This is a friends-and-family bypass, not a coupon system. One shared code,
 * rotated in Vercel whenever Kristi wants. If the code leaks, rotate the env
 * var. Not high-stakes.
 *
 * Server-side (not client-side) so the code never ships in the JS bundle —
 * anyone inspecting the source won't see the value.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

export const maxDuration = 10;

// Constant-time string compare. Stripe secret keys get this treatment by
// convention; promo codes don't really need it (the code can always be
// brute-forced if you wanted), but it's a tiny cost.
function safeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse | void> {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const expected = process.env.PROMO_CODE;
  if (!expected) {
    // Deliberately return valid:false (not 500) so clients can't tell whether
    // the code is unset vs wrong. Log so Kristi notices in Vercel logs.
    console.warn(
      JSON.stringify({
        type: "promo_code_env_missing",
        msg: "PROMO_CODE env var not set — all promo attempts will fail",
      }),
    );
    return res.status(200).json({ valid: false });
  }

  const body = req.body as { code?: string } | undefined;
  const submitted = body?.code?.trim();
  if (!submitted) {
    return res.status(400).json({ error: "Missing code" });
  }
  // Soft length cap — real codes are short; anything past 256 chars is
  // someone fuzzing our endpoint.
  if (submitted.length > 256) {
    return res.status(400).json({ error: "Invalid code" });
  }

  const valid = safeEquals(submitted, expected.trim());
  return res.status(200).json({ valid });
}
