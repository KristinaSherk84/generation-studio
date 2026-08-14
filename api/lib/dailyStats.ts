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

export type DailyStat = {
  date: string; // YYYY-MM-DD (ET)
  apiCalls: number;
  people: number;
  spendUsd: number | null; // null = not entered yet
};

/** Read stats for a set of ET date keys (order preserved). */
export async function getDailyStats(dates: string[]): Promise<DailyStat[]> {
  const out: DailyStat[] = [];
  for (const date of dates) {
    let apiCalls = 0;
    let people = 0;
    let spendUsd: number | null = null;
    try {
      apiCalls = Number(await redis.get(API_PREFIX + date)) || 0;
    } catch {
      /* ignore */
    }
    try {
      people = Number(await redis.scard(GEN_PREFIX + date)) || 0;
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
    out.push({ date, apiCalls, people, spendUsd });
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
