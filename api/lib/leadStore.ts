/**
 * Lead store (2026-07-29).
 *
 * Captures the email a customer enters right before their free batch
 * generates, so Kristi has a lead list and can later follow up with people
 * who generated but never purchased (the abandonment-recovery use case).
 *
 * Backed by the same Upstash Redis instance as the promo store. Each lead
 * lives at key `lead:{emailLower}` with a JSON record; a SET at
 * `lead:_index` tracks every email so the export endpoint can iterate
 * without SCAN. Capturing the same email twice UPSERTS (updates counters +
 * lastSeenAt) rather than duplicating.
 *
 * SDK note: mirrors promoStore.ts — @upstash/redis with the KV_ env vars
 * from Vercel's storage integration.
 */

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL ?? "",
  token: process.env.KV_REST_API_TOKEN ?? "",
});

export type LeadRecord = {
  email: string;
  // ISO-8601 first time we saw this email.
  createdAt: string;
  // ISO-8601 most recent time this email started a generation.
  lastSeenAt: string;
  // How many times this email kicked off a generation batch.
  generateCount: number;
  // Flips true once this email completes a purchase (set by the delivery /
  // checkout path later — groundwork for abandonment follow-up so we only
  // email people who did NOT buy).
  purchased: boolean;
  // ISO-8601 when they purchased, or null.
  purchasedAt: string | null;
  // Whether we've already sent an abandonment follow-up (so we don't
  // double-send later). Set true by the follow-up cron after a successful send.
  followedUp: boolean;
  // ISO-8601 when the win-back follow-up email went out, or null. (2026-08-01)
  followedUpAt?: string | null;
  // The unique unlimited promo code we minted and emailed this lead, so Kristi
  // can trace a redemption back to the win-back campaign / revoke it. (2026-08-01)
  followupCode?: string | null;
  // Customer's answer to the "How did you find us?" survey, or null if not
  // answered. One of the fixed options (Referral, Google Ad, LinkedIn Ad,
  // "Best Generator" Article, Facebook). (2026-08-02)
  foundVia?: string | null;
  // Loose context for debugging / segmentation (style picked, etc.).
  source: string;
  // Most recent saved-session resume token (2026-08-05). Set by
  // /api/save-session when a finished batch is persisted, so the 12-hour
  // win-back email can link the customer straight back to their saved grid
  // (?resume=token). Null/absent for old leads or ones that never saved.
  resumeToken?: string | null;
  // Dollars the customer paid for the $2.99 generation UNLOCK (not a download
  // purchase), recorded against the email they GENERATED under — so the leads
  // page can show it in Paid even when they later check out under a different
  // email (Stripe-by-email match would otherwise miss it). (2026-08-10)
  entryUnlockUsd?: number | null;
};

const KEY_PREFIX = "lead:";
const INDEX_KEY = "lead:_index";

function recordKey(email: string): string {
  return `${KEY_PREFIX}${email.trim().toLowerCase()}`;
}

/** Very light email sanity check — real validation is the client's job; this
 *  just stops obviously-junk values from polluting the list. */
export function looksLikeEmail(email: unknown): email is string {
  return (
    typeof email === "string" &&
    email.length <= 254 &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())
  );
}

/**
 * Upsert a lead. First capture creates the record; repeat captures bump
 * generateCount + lastSeenAt. Never throws to the caller for a missing
 * record — always safe to call on every generate.
 */
export async function recordLead(params: {
  email: string;
  source?: string;
}): Promise<LeadRecord> {
  const key = recordKey(params.email);
  const now = new Date().toISOString();
  const existing = (await redis.get<LeadRecord>(key)) ?? null;

  const rec: LeadRecord = existing
    ? {
        ...existing,
        lastSeenAt: now,
        generateCount: (existing.generateCount ?? 0) + 1,
        source: params.source ?? existing.source,
      }
    : {
        email: params.email.trim(),
        createdAt: now,
        lastSeenAt: now,
        generateCount: 1,
        purchased: false,
        purchasedAt: null,
        followedUp: false,
        source: params.source ?? "generate",
      };

  await redis.set(key, rec);
  await redis.sadd(INDEX_KEY, params.email.trim().toLowerCase());
  return rec;
}

/** Mark a lead as having purchased (call from the checkout/deliver path). */
export async function markLeadPurchased(email: string): Promise<void> {
  if (!looksLikeEmail(email)) return;
  const key = recordKey(email);
  const existing = (await redis.get<LeadRecord>(key)) ?? null;
  if (!existing) return;
  await redis.set(key, {
    ...existing,
    purchased: true,
    purchasedAt: new Date().toISOString(),
  });
}

/**
 * Mark a lead as having received the win-back follow-up email, recording the
 * unique promo code we minted for them. Called by the follow-up cron ONLY
 * after Resend accepts the send, so a failed send is retried next run rather
 * than silently skipped. Idempotent and safe on a missing record. (2026-08-01)
 */
export async function markLeadFollowedUp(
  email: string,
  code: string,
): Promise<void> {
  if (!looksLikeEmail(email)) return;
  const key = recordKey(email);
  const existing = (await redis.get<LeadRecord>(key)) ?? null;
  if (!existing) return;
  await redis.set(key, {
    ...existing,
    followedUp: true,
    followedUpAt: new Date().toISOString(),
    followupCode: code,
  });
}

/**
 * Record the customer's "How did you find us?" answer against their lead,
 * WITHOUT bumping generateCount / lastSeenAt (this isn't a new generation, just
 * an attribute update). No-op if the lead doesn't exist yet. (2026-08-02)
 */
export async function setLeadResumeToken(
  email: string,
  token: string,
): Promise<void> {
  if (!looksLikeEmail(email)) return;
  const key = recordKey(email);
  const existing = (await redis.get<LeadRecord>(key)) ?? null;
  if (!existing) return;
  await redis.set(key, { ...existing, resumeToken: token });
}

export async function setLeadFoundVia(
  email: string,
  foundVia: string,
): Promise<void> {
  if (!looksLikeEmail(email)) return;
  const key = recordKey(email);
  const existing = (await redis.get<LeadRecord>(key)) ?? null;
  if (!existing) return;
  await redis.set(key, { ...existing, foundVia: foundVia.slice(0, 60) });
}

/**
 * Record that this lead paid the $2.99 generation unlock, against the email
 * they generated under. Attribute-only (never bumps generateCount). Keeps the
 * largest amount seen so a re-pay can't lower it. No-op if the lead is missing.
 * (2026-08-10)
 */
export async function markLeadEntryUnlock(
  email: string,
  usd: number,
): Promise<void> {
  if (!looksLikeEmail(email)) return;
  if (!Number.isFinite(usd) || usd <= 0) return;
  const key = recordKey(email);
  const existing = (await redis.get<LeadRecord>(key)) ?? null;
  if (!existing) return;
  const prev = existing.entryUnlockUsd ?? 0;
  await redis.set(key, { ...existing, entryUnlockUsd: Math.max(prev, usd) });
}

/** Return every lead record, newest-first. Used by the admin export. */
export async function listLeads(): Promise<LeadRecord[]> {
  const emails = (await redis.smembers(INDEX_KEY)) ?? [];
  if (!emails.length) return [];
  const keys = emails.map((e) => `${KEY_PREFIX}${e}`);
  const records = await redis.mget<LeadRecord[]>(...keys);
  return records
    .filter((r): r is LeadRecord => !!r)
    .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));
}
