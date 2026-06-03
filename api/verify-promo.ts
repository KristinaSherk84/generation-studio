/**
 * POST /api/verify-promo
 *
 * Checks a user-submitted promo code in TWO places:
 *
 *   1. KV-backed single-use store (preferred). If the code is in the
 *      store and not consumed/revoked, atomically flip it to consumed
 *      and return valid: true. Single-use enforcement happens here.
 *
 *   2. PROMO_CODE env var (legacy fallback). A single shared code
 *      Kristi can rotate from the Vercel dashboard. Multi-use,
 *      brute-forceable — kept around for emergency / friends-and-family
 *      use until KV is provisioned.
 *
 * On success, the frontend flips the same localStorage unlock flag that
 * `/api/verify-checkout` would set — so a valid promo skips Stripe entirely.
 *
 * Server-side (not client-side) so the env-var code never ships in the JS
 * bundle.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { redeemCode } from "./lib/promoStore.js";

export const maxDuration = 10;

// Constant-time string compare. Stripe secret keys get this treatment by
// convention; promo codes don't really need it (the env code can always be
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

  // Fingerprint the redeemer for the audit trail. We don't have an
  // account model, so the best we can do is take the request IP from
  // the Vercel-set headers. Doesn't have to be unique — it's just for
  // Kristi to spot patterns ("this code got redeemed from 12 different
  // IPs in 10 minutes — investigate").
  const fingerprint =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    (req.headers["x-real-ip"] as string) ??
    "unknown";

  // 1) Try the KV single-use store first. KV may be unprovisioned in
  // dev / pre-deploy — in that case, the @vercel/kv import throws on
  // first read; we catch and fall through to the env var check.
  try {
    const result = await redeemCode({
      code: submitted.toLowerCase(),
      fingerprint,
    });
    if (result.valid) {
      return res.status(200).json({ valid: true, source: "kv" });
    }
    // The code WAS found in KV but couldn't be redeemed (already
    // consumed / revoked / etc.). Don't fall through to the env var —
    // a customer who tries to reuse a single-use code shouldn't be
    // saved by typing the master code instead.
    if (result.reason === "consumed" || result.reason === "revoked") {
      return res.status(200).json({
        valid: false,
        reason: result.reason,
      });
    }
    // result.reason === "unknown" — not in KV at all, try the env var
  } catch (err) {
    // KV not provisioned, network glitch, etc. Log and fall through to
    // env-var fallback so Kristi never loses access entirely.
    console.warn(
      JSON.stringify({
        type: "promo_kv_unavailable",
        msg: "KV lookup failed; falling back to env var",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  // 2) Env-var fallback.
  const expected = process.env.PROMO_CODE;
  if (!expected) {
    // Deliberately return valid:false (not 500) so clients can't tell whether
    // the code is unset vs wrong. Log so Kristi notices in Vercel logs.
    console.warn(
      JSON.stringify({
        type: "promo_code_env_missing",
        msg: "PROMO_CODE env var not set — fallback unavailable",
      }),
    );
    return res.status(200).json({ valid: false });
  }

  // Case-insensitive compare so capitalization typos still unlock — Kristi
  // shares the code verbally with friends and over text where capitalization
  // gets inconsistent.
  const valid = safeEquals(
    submitted.toLowerCase(),
    expected.trim().toLowerCase(),
  );
  return res.status(200).json({ valid, source: valid ? "env" : undefined });
}
