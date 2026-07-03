/**
 * GET /api/config
 *
 * Small runtime-config endpoint. Frontend hits this on mount to know which
 * feature flags are active. Currently returns only entryFeeEnabled, but this
 * is the natural place to hang other user-facing flags in the future.
 *
 * Why runtime and not Vite build-time env replacement:
 *   - Flipping a Vite build-time flag requires a full rebuild + redeploy.
 *     Reading process.env at request time means Kristi can flip
 *     ENTRY_FEE_ENABLED in the Vercel dashboard and the change is live on
 *     the next request (no code rebuild needed). Faster revert path.
 *   - The 50-100 ms extra on the first render is negligible compared to
 *     the network + Stripe redirect chain elsewhere in the app.
 *
 * Default: entryFeeEnabled = true. Absent env var behaves like the classic
 * entry-fee flow. Setting ENTRY_FEE_ENABLED = "false" activates the
 * post-generation paywall flow (see api/generate.ts verifyUnlock + the
 * matching frontend branches in src/App.tsx).
 *
 * Added 2026-07-03 alongside the free-tier rollout.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

export const maxDuration = 5;

export default function handler(
  req: VercelRequest,
  res: VercelResponse,
): VercelResponse | void {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const entryFeeEnabled = process.env.ENTRY_FEE_ENABLED !== "false";

  // Short-cache: 60s at the CDN, 60s in browser. The flag changes rarely;
  // when Kristi flips it in Vercel, the redeploy invalidates the CDN cache
  // automatically, so a stale minute-old cache is fine.
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
  return res.status(200).json({
    entryFeeEnabled,
  });
}
