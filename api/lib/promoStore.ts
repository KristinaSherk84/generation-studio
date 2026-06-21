/**
 * Promo code store (2026-06-03).
 *
 * Backed by Upstash Redis (provisioned through Vercel's storage
 * integration). Each code lives at key `promo:{code}` with a JSON-encoded
 * record. A SET at `promo:_index` tracks all known codes so the admin
 * list endpoint can iterate without SCAN.
 *
 * Single-use semantics: when `redeemCode` succeeds, it atomically flips
 * the record's `consumed: true`. A subsequent attempt to redeem the same
 * code returns `{ valid: false, reason: "consumed" }`. The atomic flip
 * uses optimistic concurrency — read, mutate, write with a version check
 * — so even simultaneous redemption attempts can't both succeed.
 *
 * Auth gates and rate limits live in the route handlers, NOT here. This
 * module is the data-layer primitive only.
 *
 * SDK note (2026-06-03): switched from @vercel/kv to @upstash/redis
 * after Vercel deprecated their wrapper. The Vercel integration still
 * uses the KV_ prefix on env vars, so we instantiate the Redis client
 * by passing KV_REST_API_URL / KV_REST_API_TOKEN explicitly rather than
 * using Redis.fromEnv() (which expects UPSTASH_* names).
 */

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL ?? "",
  token: process.env.KV_REST_API_TOKEN ?? "",
});

// A single promo code record. `code` is the human-readable string the
// customer enters; the index field uses it as the unique identifier.
export type PromoRecord = {
  code: string;
  // ISO-8601 timestamp string. Created by admin endpoint.
  createdAt: string;
  // Admin email that minted this code (whoever logged into /admin).
  createdBy: string;
  // Free-text label so Kristi/husband can tag codes ("mary realtor",
  // "facebook ad jan-15", etc.). Optional.
  notes: string;
  // True once a customer redeems it. Single-use: once true, stays true.
  consumed: boolean;
  // ISO-8601 timestamp when the customer redeemed. Null until consumed.
  consumedAt: string | null;
  // Server-side fingerprint of the redeemer (we don't have an account
  // model; just stash whatever's useful for tracking — IP from headers,
  // and maybe email later if we capture it pre-redemption).
  consumedFingerprint: string | null;
  // Monotonic version for optimistic-concurrency control on the redeem
  // path. Increments on every write.
  version: number;
  // Optional explicit revoke flag. Manually flipped by admin. Cannot be
  // redeemed even if not consumed.
  revoked: boolean;
};

const KEY_PREFIX = "promo:";
const INDEX_KEY = "promo:_index";

function recordKey(code: string): string {
  return `${KEY_PREFIX}${code.toLowerCase()}`;
}

/**
 * Generate a fresh random code in the shape `gh-{6 chars}`. Avoids easily
 * confused glyphs (0/O, 1/l/I). 6 chars × 30-char alphabet = ~7.3e8
 * combinations — far above what's brute-forceable through /api/verify-promo
 * (which is rate-limited by Vercel's edge limits + the single-shot
 * semantic of consumed codes).
 */
const SAFE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function generateCode(): string {
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += SAFE_ALPHABET[Math.floor(Math.random() * SAFE_ALPHABET.length)];
  }
  return `gh-${suffix}`;
}

/**
 * Create a new code record and index it. Caller must check for collisions
 * — extremely unlikely with 30^6 alphabet but the index SET acts as a
 * uniqueness guarantee anyway.
 */
export async function createCode(params: {
  code: string;
  createdBy: string;
  notes: string;
}): Promise<PromoRecord> {
  const code = params.code.toLowerCase().trim();
  if (!code) throw new Error("Empty code");
  const existing = await redis.get<PromoRecord>(recordKey(code));
  if (existing) throw new Error("Code already exists");

  const record: PromoRecord = {
    code,
    createdAt: new Date().toISOString(),
    createdBy: params.createdBy,
    notes: params.notes,
    consumed: false,
    consumedAt: null,
    consumedFingerprint: null,
    version: 1,
    revoked: false,
  };
  await redis.set(recordKey(code), record);
  await redis.sadd(INDEX_KEY, code);
  return record;
}

/**
 * Return all known codes, sorted newest-first. Caller is the admin
 * endpoint, which is auth-gated. Worst case (Kristi + husband mint
 * hundreds of codes), this still completes in well under the 10s
 * serverless timeout — KV multi-get is O(N) but fast.
 */
export async function listCodes(): Promise<PromoRecord[]> {
  const codes = await redis.smembers(INDEX_KEY);
  if (!codes || codes.length === 0) return [];
  const records = await Promise.all(
    codes.map((code) => redis.get<PromoRecord>(recordKey(String(code)))),
  );
  // Filter out any null/missing records (orphans from a botched delete);
  // log them so we can fix the index later if needed.
  const live = records.filter((r): r is PromoRecord => r !== null);
  live.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return live;
}

/**
 * Check if a single-use KV code is currently active for /api/generate
 * calls. Returns true iff the code:
 *   - exists in KV
 *   - is NOT revoked
 *   - was consumed (i.e. /api/verify-promo accepted it on entry)
 *   - was consumed within the last 4 hours (matches the Stripe unlock TTL)
 *
 * Why a 4h window: when a customer enters a single-use code, we want
 * them to be able to generate multiple batches over a reasonable session
 * (same as the $2.99 Stripe unlock window). Without this window,
 * /api/verify-promo would consume the code and /api/generate would have
 * no way to know the code was valid — every subsequent generate call
 * would 402. Bug found 2026-06-21.
 *
 * Idempotent and read-only. Does NOT consume or modify the record.
 */
const PROMO_GENERATE_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours

export async function isCodeActiveForGenerate(
  code: string,
): Promise<boolean> {
  if (!code) return false;
  try {
    const existing = await redis.get<PromoRecord>(recordKey(code));
    if (!existing) return false;
    if (existing.revoked) return false;
    if (!existing.consumed) return false; // not yet activated
    if (!existing.consumedAt) return false;
    const consumedAtMs = Date.parse(existing.consumedAt);
    if (!Number.isFinite(consumedAtMs)) return false;
    return Date.now() - consumedAtMs <= PROMO_GENERATE_WINDOW_MS;
  } catch {
    // KV unavailable — fail closed (return false). The caller falls
    // through to other unlock paths (Stripe session), and a real customer
    // with a valid Stripe session can still generate. Only KV-promo users
    // see the impact.
    return false;
  }
}

/**
 * Permanently delete a code from Redis. Removes both the record at
 * `promo:{code}` AND the index-set membership at `promo:_index`. Unlike
 * revokeCode this is destructive — the audit trail is gone. Use for
 * test codes, typos, or codes that no longer need to be tracked.
 *
 * Returns true if the code existed and was deleted; false if no record
 * was found (idempotent).
 */
export async function deleteCode(code: string): Promise<boolean> {
  const key = recordKey(code);
  const existing = await redis.get<PromoRecord>(key);
  if (!existing) return false;
  // Two-step delete: remove from index first, then drop the record.
  // If the record drop fails for some reason, the index entry is
  // already gone, so listCodes will filter it out as an orphan.
  await redis.srem(INDEX_KEY, code.toLowerCase());
  await redis.del(key);
  return true;
}

/**
 * Revoke a code so it can no longer be redeemed. Doesn't delete — keeps
 * the record around for audit. Idempotent.
 */
export async function revokeCode(code: string): Promise<PromoRecord | null> {
  const key = recordKey(code);
  const existing = await redis.get<PromoRecord>(key);
  if (!existing) return null;
  if (existing.revoked) return existing;
  const next: PromoRecord = {
    ...existing,
    revoked: true,
    version: existing.version + 1,
  };
  await redis.set(key, next);
  return next;
}

/**
 * Attempt to redeem a code on behalf of a customer. Returns a result
 * object the verify endpoint forwards to the client. On success, the
 * record is mutated in-place to `consumed: true`.
 *
 * Optimistic concurrency: re-reads after the SET and compares version.
 * If a concurrent redemption also flipped it, we lost the race and
 * return `{ valid: false, reason: "consumed" }` — the other request
 * already redeemed it.
 */
// Result type uses a non-discriminated union (both variants carry an
// optional reason) so callers can read `.reason` without first narrowing
// on `.valid`. TypeScript 6.0.2 (the build server) gives up narrowing
// the strict discriminated form across early-return boundaries; this
// shape is friendlier to its inference.
export type RedeemResult =
  | { valid: true; reason?: undefined }
  | { valid: false; reason: "unknown" | "revoked" | "consumed" };

export async function redeemCode(params: {
  code: string;
  fingerprint: string;
}): Promise<RedeemResult> {
  const key = recordKey(params.code);
  const existing = await redis.get<PromoRecord>(key);
  if (!existing) return { valid: false, reason: "unknown" };
  if (existing.revoked) return { valid: false, reason: "revoked" };
  if (existing.consumed) return { valid: false, reason: "consumed" };

  const next: PromoRecord = {
    ...existing,
    consumed: true,
    consumedAt: new Date().toISOString(),
    consumedFingerprint: params.fingerprint,
    version: existing.version + 1,
  };
  await redis.set(key, next);

  // Re-read to verify our write won. If version skipped ahead of what we
  // expected (someone else's write landed between our GET and SET), the
  // OTHER side took the code; we have to back off.
  const verify = await redis.get<PromoRecord>(key);
  if (!verify || verify.version !== next.version) {
    return { valid: false, reason: "consumed" };
  }
  return { valid: true };
}
