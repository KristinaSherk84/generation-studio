/**
 * Free-tier abuse guard (2026-08-05).
 *
 * When ENTRY_FEE_ENABLED === "false" the app lets people generate for free,
 * and the "one free batch" rule is enforced only in the browser (a React
 * counter). That counter resets on a new tab, incognito, a different device,
 * clearing site data, or the "resume my session" email link — so a single
 * person can keep starting over and generating free batches indefinitely
 * (observed: one lead ran 3 free batches in ~15 minutes). Each batch is ~8
 * paid Gemini images, so this is a direct cost leak.
 *
 * This adds a SERVER-SIDE cap keyed on the caller's IP. The client sends a
 * `batchId` that is the SAME for every call belonging to one user-initiated
 * batch (the 6 main shots + the 2 wild cards + any regenerations) and CHANGES
 * only when the user kicks off a brand-new batch. We store the set of distinct
 * batchIds seen per IP within a rolling window; once the count exceeds
 * FREE_BATCHES_PER_IP, further NEW batches from that IP are refused (402) until
 * the window rolls off. Regens/wild cards reuse the batchId, so they never
 * count against the cap.
 *
 * Deliberately IP-based (no login): it stops the common case — same person,
 * same browser/network, resume link — without adding friction for real users.
 * It does NOT stop VPNs or a truly different network; the airtight fix for
 * that is turning the entry fee back on.
 *
 * FAIL-OPEN: any missing input or Redis error returns { allowed: true }. A
 * generation must never be blocked because of an infra hiccup on this guard.
 *
 * Tuning (Vercel env, no redeploy of logic needed):
 *   FREE_BATCHES_PER_IP    default 1   — distinct free batches allowed per IP
 *   FREE_BATCH_WINDOW_HOURS default 24 — rolling window length
 */
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL ?? "",
  token: process.env.KV_REST_API_TOKEN ?? "",
});

const LIMIT = Math.max(1, Number(process.env.FREE_BATCHES_PER_IP ?? "1"));
const WINDOW_SECONDS =
  Math.max(1, Number(process.env.FREE_BATCH_WINDOW_HOURS ?? "24")) * 3600;

const key = (ip: string) => `freebatch:${ip}`;

export async function checkFreeBatchLimit(
  ip: string | undefined,
  batchId: string | undefined,
): Promise<{ allowed: boolean; batches: number }> {
  // No IP or no batchId → can't attribute this call to a person/batch. Allow
  // (fail-open) rather than risk blocking a legitimate generation.
  if (!ip || !batchId) return { allowed: true, batches: 0 };
  try {
    const k = key(ip);
    // SADD is idempotent: the 6 parallel main-shot calls (and the wild cards /
    // regens that reuse this batchId) all add the same member, so the set
    // grows by exactly one per genuinely-new batch.
    await redis.sadd(k, batchId);
    await redis.expire(k, WINDOW_SECONDS);
    const batches = await redis.scard(k);
    return { allowed: batches <= LIMIT, batches };
  } catch {
    // Redis unreachable → never block generation on this guard.
    return { allowed: true, batches: 0 };
  }
}

/**
 * Post-purchase batch credit (2026-08-11). After a customer BUYS, they get a
 * few more free full batches even though their IP already used its free batch.
 * Keyed by the paid Stripe checkout session (verified paid by the caller), and
 * counts DISTINCT batchIds — so the batch's regens/wild cards (which reuse the
 * batchId) don't burn extra credits. Allows up to POST_PURCHASE_BATCHES.
 * Fail-CLOSED (no credit) on any error — the caller then falls through to the
 * normal per-IP cap, which is itself fail-open, so generation is never blocked
 * by an infra hiccup here.
 */
const PP_LIMIT = Math.max(1, Number(process.env.POST_PURCHASE_BATCHES ?? "2"));
const ppKey = (sessionId: string) => `ppcredit:${sessionId}`;

export async function checkPurchaseBatchCredit(
  sessionId: string | undefined,
  batchId: string | undefined,
): Promise<{ allowed: boolean }> {
  if (!sessionId || !batchId) return { allowed: false };
  try {
    const k = ppKey(sessionId);
    await redis.sadd(k, batchId);
    await redis.expire(k, 7 * 24 * 3600);
    const n = await redis.scard(k);
    return { allowed: n <= PP_LIMIT };
  } catch {
    return { allowed: false };
  }
}
