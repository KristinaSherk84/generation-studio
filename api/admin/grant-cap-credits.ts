/**
 * POST /api/admin/grant-cap-credits  (2026-09-09)
 *
 * Manually grant an IP additional hard-cap credits. Use when a paying
 * customer hit the abuse-floor cap and Kristi wants to unblock them
 * without them having to re-pay (or in Lawrence's case, when they DID
 * re-pay before the auto-credit was live and need the credits
 * retroactively).
 *
 * Body / query params:
 *   ip     required   the customer's IP address (find in Vercel logs or leads dashboard)
 *   amount optional   credits to add; defaults to 30 (one $3.99 unlock's worth)
 *
 * Auth: ADMIN_PASSWORD via ?pw=… or Authorization: Bearer …
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { addHardCapCredits } from "../lib/freeGenLimit.js";

export const maxDuration = 10;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  const expected = process.env.ADMIN_PASSWORD ?? "";
  if (!expected) {
    res.status(500).json({ ok: false, error: "admin password not configured" });
    return;
  }
  const pwFromQuery = typeof req.query.pw === "string" ? req.query.pw : "";
  const auth = req.headers.authorization ?? "";
  const pwFromHeader = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const provided = pwFromQuery || pwFromHeader;
  if (provided !== expected) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  const q = req.query;
  const b = (req.body ?? {}) as { ip?: unknown; amount?: unknown };
  const ip =
    typeof q.ip === "string"
      ? q.ip.trim()
      : typeof b.ip === "string"
      ? b.ip.trim()
      : "";
  if (!ip) {
    res.status(400).json({ ok: false, error: "missing ip" });
    return;
  }
  const amount = Math.max(
    1,
    Math.min(
      500,
      Number(
        typeof q.amount === "string"
          ? q.amount
          : typeof b.amount === "number"
          ? b.amount
          : 30,
      ) || 30,
    ),
  );

  const result = await addHardCapCredits(ip, amount);
  res.status(200).json({
    ok: result.ok,
    ip,
    granted: result.ok ? amount : 0,
    totalCreditsForIp: result.total,
  });
}
