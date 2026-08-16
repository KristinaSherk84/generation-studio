/**
 * Daily activity counters (2026-08-14, Kristi).
 *
 * Tracks, per calendar day in Eastern Time:
 *   - stats:apicalls:{YYYY-MM-DD}   INCR on every /api/generate that reaches
 *     the model (one Gemini image call = one unit of Google spend).
 *   - stats:generators:{YYYY-MM-DD} SADD the caller's IP, so SCARD ~ how many
 *     distinct people hit generate that day.
 *   - stats:spend:{YYYY-MM-DD}      the actual Google/Gemini spend for that day
 *     (dollars) that Kristi types into the admin page from
 *     https://aistudio.google.com/spend - powers the real cost-per-call.
 *
 * Backed by the same Upstash Redis instance as the lead / free-gen stores.
 * Every write is best-effort and never throws to the caller - a Redis blip
 * must never block a generation.
 */
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL ?? "",
  token: process.env.KV_REST_API_TOKEN ?? "",
});

const API_PREFIX = "stats:apicalls:";
const GEN_PREFIX = "stats:generators:";
const SPEND_PREFIX = "stats:spend:";
// Gemini 3 Pro (retouch) image calls on a given ET day - the expensive
// per-image retouch renders fired inside /api/deliver, counted separately from
// the cheap flash previews so the admin can see each. (2026-08-16, Kristi)
const PRO_PREFIX = "stats:procalls:";
// Distinct email addresses that received a "your headshots are ready to view"
// email that day. SCARD ~ how many real people generated - dedupes a person
// who generates several batches, and counts one person once even across
// devices. Preferred over the IP set. Added 2026-08-14 (Kristi).
const EMAIL_PREFIX = "stats:genemails:";
// Manual per-day override for the "People generated" number, typed on the admin
// page (e.g. to backfill a day from before email-tracking existed). When set,
// it wins over both the email and IP counts.
const PEOPLE_OVERRIDE_PREFIX = "stats:people_override:";

// Counters expire after ~60 days so the store never grows unbounded; the admin
// page only ever shows the last two weeks. Spend values are kept ~400 days.
const COUNTER_TTL_SEC = 60 * 60 * 24 * 60;
const SPEND_TTL_SEC = 60 * 60 * 24 * 400;

/** YYYY-MM-DD for the given instant in Eastern Time (matches the leads page). */
export function etDateKey(d: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Count one Gemini image call and register the caller's IP as a distinct
 * generator for today (ET). Fire this once per /api/generate that clears the
 * paywall. Best-effort.
 */
export async function bumpApiCall(ip: string): Promise<void> {
  try {
    const day = etDateKey(new Date());
    const apiKey = API_PREFIX + day;
    await redis.incr(apiKey);
    await redis.expire(apiKey, COUNTER_TTL_SEC);
    if (ip) {
      const genKey = GEN_PREFIX + day;
      await redis.sadd(genKey, ip);
      await redis.expire(genKey, COUNTER_TTL_SEC);
    }
  } catch {
    /* best-effort - stats must never block generation */
  }
}

/**
 * Count Gemini 3 Pro (retouch) image calls for today (ET). Fire once per
 * generateContent call to the Pro model in the delivery retouch pass, so the
 * admin can split expensive retouch renders from cheap flash previews.
 * Best-effort - never blocks a delivery.
 */
export async function bumpProCall(n = 1): Promise<void> {
  try {
    const day = etDateKey(new Date());
    const key = PRO_PREFIX + day;
    await redis.incrby(key, n);
    await redis.expire(key, COUNTER_TTL_SEC);
  } catch {
    /* best-effort - stats must never block a delivery */
  }
}

/**
 * Register one distinct email address as having generated today (ET): the
 * recipient of a "your headshots are ready to view" email. Fire once per
 * successful ready-email send. SADD dedupes, so a person who generates several
 * times still counts once. Best-effort.
 */
export async function bumpGeneratedEmail(email: string): Promise<void> {
  try {
    const addr = (email || "").trim().toLowerCase();
    if (!addr) return;
    const day = etDateKey(new Date());
    const key = EMAIL_PREFIX + day;
    await redis.sadd(key, addr);
    await redis.expire(key, COUNTER_TTL_SEC);
  } catch {
    /* best-effort - stats must never block the email path */
  }
}

export type DailyStat = {
  date: string; // YYYY-MM-DD (ET)
  apiCalls: number; // flash preview image calls (stats:apicalls)
  proCalls: number; // Gemini 3 Pro retouch image calls (stats:procalls)
  people: number; // resolved: override ?? distinct-emails ?? distinct-IPs
  peopleOverride: number | null; // manual override if one is set, else null
  spendUsd: number | null; // null = not entered yet
};

/** Read stats for a set of ET date keys (order preserved). */
export async function getDailyStats(dates: string[]): Promise<DailyStat[]> {
  const out: DailyStat[] = [];
  for (const date of dates) {
    let apiCalls = 0;
    let proCalls = 0;
    let peopleByIp = 0;
    let peopleByEmail = 0;
    let peopleOverride: number | null = null;
    let spendUsd: number | null = null;
    try {
      apiCalls = Number(await redis.get(API_PREFIX + date)) || 0;
    } catch {
      /* ignore */
    }
    try {
      proCalls = Number(await redis.get(PRO_PREFIX + date)) || 0;
    } catch {
      /* ignore */
    }
    try {
      peopleByIp = Number(await redis.scard(GEN_PREFIX + date)) || 0;
    } catch {
      /* ignore */
    }
    try {
      peopleByEmail = Number(await redis.scard(EMAIL_PREFIX + date)) || 0;
    } catch {
      /* ignore */
    }
    try {
      const raw = await redis.get(PEOPLE_OVERRIDE_PREFIX + date);
      peopleOverride = raw == null ? null : Number(raw);
      if (peopleOverride != null && !Number.isFinite(peopleOverride))
        peopleOverride = null;
    } catch {
      /* ignore */
    }
    try {
      const raw = await redis.get(SPEND_PREFIX + date);
      spendUsd = raw == null ? null : Number(raw);
      if (spendUsd != null && !Number.isFinite(spendUsd)) spendUsd = null;
    } catch {
      /* ignore */
    }
    // Prefer the distinct-email count (one real person = one email); fall back
    // to the IP set for older days before email-tracking existed. A manual
    // override always wins.
    const people =
      peopleOverride != null
        ? peopleOverride
        : peopleByEmail > 0
          ? peopleByEmail
          : peopleByIp;
    out.push({ date, apiCalls, proCalls, people, peopleOverride, spendUsd });
  }
  return out;
}

/** Save the actual Google spend (USD) for an ET date, typed in by Kristi. */
export async function setDailySpend(date: string, usd: number): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  const key = SPEND_PREFIX + date;
  await redis.set(key, usd);
  await redis.expire(key, SPEND_TTL_SEC);
}

/**
 * Manually override the "People generated" number for an ET date, or clear it
 * by passing null. Overrides win over the auto email/IP counts. Used from the
 * admin page - e.g. to backfill a day from before email-tracking existed.
 */
export async function setDailyPeople(
  date: string,
  count: number | null,
): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  const key = PEOPLE_OVERRIDE_PREFIX + date;
  if (count == null) {
    await redis.del(key);
    return;
  }
  await redis.set(key, count);
  await redis.expire(key, SPEND_TTL_SEC);
}

/** The last `n` ET date keys, today first. */
export function lastEtDates(n: number): string[] {
  const days: string[] = [];
  const dayMs = 86400000;
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    days.push(etDateKey(new Date(now - i * dayMs)));
  }
  return days;
}
