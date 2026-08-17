/**
 * In-progress batch store (Phase A, 2026-08-17).
 *
 * /api/generate saves every headshot it produces here the instant it's made —
 * keyed by the client's batchId — so a dropped browser connection never loses a
 * generated shot. The browser then recovers the grid from /api/recover-batch
 * instead of showing "Connection interrupted". Backed by the same Upstash Redis
 * as the session/lead stores.
 *
 * Race-safe: the 6 parallel generate calls of one batch each write their OWN
 * hash field (img:<slot>), so there is no read-modify-write collision. Metadata
 * (email, reference photos, style recipe) is written idempotently alongside.
 *
 * Best-effort everywhere: any Redis error is swallowed by the caller —
 * persistence must never affect the image a customer actually receives.
 */
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL ?? "",
  token: process.env.KV_REST_API_TOKEN ?? "",
});

const TTL_SECONDS = 4 * 24 * 60 * 60; // 4 days — matches the saved-session window.
const key = (batchId: string) => `batch:${batchId}`;
const validId = (id: unknown): id is string =>
  typeof id === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(id);

export type RecoveredBatch = {
  images: { index: number; url: string }[];
  email?: string;
  referencePhotoUrls?: string[];
  selections?: unknown;
  hasWideAngle?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

/**
 * Record ONE finished image against its batch. Each slot writes its own hash
 * field, so the 6 parallel calls never collide. Idempotent metadata alongside.
 */
export async function recordBatchImage(
  batchId: string,
  index: number,
  url: string,
  meta: {
    email?: string;
    referencePhotoUrls?: string[];
    selections?: unknown;
    hasWideAngle?: boolean;
  },
): Promise<void> {
  if (!validId(batchId)) return;
  if (!Number.isInteger(index) || index < 0 || index > 7) return;
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) return;
  const k = key(batchId);
  const fields: Record<string, string> = {
    ["img:" + index]: url,
    updatedAt: new Date().toISOString(),
  };
  if (meta.email) fields.email = meta.email;
  if (Array.isArray(meta.referencePhotoUrls))
    fields.refs = JSON.stringify(meta.referencePhotoUrls);
  if (meta.selections !== undefined)
    fields.sel = JSON.stringify(meta.selections);
  if (typeof meta.hasWideAngle === "boolean")
    fields.wide = meta.hasWideAngle ? "1" : "0";
  await redis.hset(k, fields);
  await redis.hsetnx(k, "createdAt", new Date().toISOString());
  await redis.expire(k, TTL_SECONDS);
}

/** Pull a batch's persisted images + metadata, or null if nothing saved. */
export async function getBatch(batchId: string): Promise<RecoveredBatch | null> {
  if (!validId(batchId)) return null;
  let rec: Record<string, unknown> | null;
  try {
    rec = await redis.hgetall<Record<string, unknown>>(key(batchId));
  } catch {
    return null;
  }
  if (!rec || Object.keys(rec).length === 0) return null;

  const images: { index: number; url: string }[] = [];
  for (const [f, v] of Object.entries(rec)) {
    const m = /^img:(\d+)$/.exec(f);
    if (m && typeof v === "string" && /^https?:\/\//.test(v)) {
      images.push({ index: Number(m[1]), url: v });
    }
  }
  images.sort((a, b) => a.index - b.index);

  // Upstash auto-parses JSON-looking values on read, so a stored JSON string
  // may come back already-parsed OR as a raw string — handle both.
  const asObj = (v: unknown): unknown => {
    if (v == null) return undefined;
    if (typeof v === "string") {
      try {
        return JSON.parse(v);
      } catch {
        return undefined;
      }
    }
    return v;
  };

  return {
    images,
    email: typeof rec.email === "string" ? rec.email : undefined,
    referencePhotoUrls: asObj(rec.refs) as string[] | undefined,
    selections: asObj(rec.sel),
    hasWideAngle: rec.wide === "1" || rec.wide === 1,
    createdAt: typeof rec.createdAt === "string" ? rec.createdAt : undefined,
    updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : undefined,
  };
}
