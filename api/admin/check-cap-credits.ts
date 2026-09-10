/**
 * GET /api/admin/check-cap-credits?ip=…&pw=…  (2026-09-09)
 *
 * Inspect one IP's hard-cap state: how many API calls this IP has used
 * in the rolling window, and how many bonus credits are stacked on top
 * from their $3.99 unlocks. Used to verify that repeat-payers are
 * actually getting their +30 credits applied — no state change, just a
 * read.
 *
 * Auth: ADMIN_PASSWORD via ?pw=… or Authorization: Bearer …
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";

export const maxDuration = 10;

const redis = new Redis({
  url: process.env.KV_REST_API_URL ?? "",
  token: process.env.KV_REST_API_TOKEN ?? "",
});

const BASE_HARD_CAP = Math.max(
  1,
  Number(process.env.GEN_HARD_CAP_PER_IP ?? "40"),
);

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
  if ((pwFromQuery || pwFromHeader) !== expected) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  const ip = typeof req.query.ip === "string" ? req.query.ip.trim() : "";
  if (!ip) {
    res.status(400).json({ ok: false, error: "missing ip" });
    return;
  }

  const usageKey = `gencap:${ip}`;
  const creditsKey = `gencap:extra:${ip}`;
  const freeCallsKey = `freecalls:${ip}`;
  const payCountKey = `gencap:paycount:${ip}`;

  const [
    rawUsage,
    rawCredits,
    rawFreeCalls,
    rawPayCount,
    usageTtl,
    creditsTtl,
  ] = await Promise.all([
    redis.get<string | number | null>(usageKey),
    redis.get<string | number | null>(creditsKey),
    redis.get<string | number | null>(freeCallsKey),
    redis.get<string | number | null>(payCountKey),
    redis.ttl(usageKey),
    redis.ttl(creditsKey),
  ]);

  const toInt = (v: string | number | null): number => {
    if (v === null || v === undefined) return 0;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? Math.floor(n) : 0;
  };

  const used = toInt(rawUsage);
  const extraCredits = toInt(rawCredits);
  const freeCallsUsed = toInt(rawFreeCalls);
  const paymentCount = toInt(rawPayCount);
  const effectiveCap = BASE_HARD_CAP + extraCredits;
  const remaining = Math.max(0, effectiveCap - used);
  const overCap = used > effectiveCap;

  res.status(200).json({
    ok: true,
    ip,
    baseHardCap: BASE_HARD_CAP,
    extraCredits,
    effectiveCap,
    used,
    remaining,
    overCap,
    freeCallsUsed,
    paymentCount,
    ttlSeconds: {
      usage: usageTtl,
      credits: creditsTtl,
    },
    notes: {
      overCap:
        "true means this IP is currently blocked. Grant more credits via /api/admin/grant-cap-credits or wait for the TTL to roll off.",
      remaining:
        "How many more /api/generate calls this IP can make right now.",
      paymentCount:
        "Number of confirmed $3.99 unlocks in the rolling window. Credits are granted on payment #2 and later (payment #1 unlocks the base 40 with no bonus).",
    },
  });
}
