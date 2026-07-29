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
  // double-send later). Groundwork; unused until the automation ships.
  followedUp: boolean;
  // Loose context for debugging / segmentation (style picked, etc.).
  source: string;
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
