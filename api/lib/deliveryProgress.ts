/**
 * Live progress for a delivery in progress (2026-10-17, Kristi). A 6-photo
 * Glow Up order takes a few minutes; without progress the delivery screen
 * looked frozen. /api/deliver writes { stage, done, total } here under a
 * random id the browser sends, and /api/delivery-progress reads it back.
 * Best-effort: a Redis hiccup never affects the delivery itself.
 */
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL ?? "",
  token: process.env.KV_REST_API_TOKEN ?? "",
});

export type DeliveryProgress = {
  stage: "retouching" | "finishing" | "done";
  done: number;
  total: number;
  // Each retouched version as it finishes (photo index, version, file URL or
  // failed), so the delivery screen can offer it right away. (2026-10-17)
  items?: { i: number; v: "polished" | "glam"; url?: string; failed?: boolean }[];
  at: string;
};

const key = (id: string) => `delivprog:${id}`;
export const isProgressId = (id: unknown): id is string =>
  typeof id === "string" && /^[A-Za-z0-9_-]{8,48}$/.test(id);

export async function setDeliveryProgress(
  id: string | undefined,
  p: Omit<DeliveryProgress, "at">,
): Promise<void> {
  if (!isProgressId(id)) return;
  try {
    await redis.set(key(id), { ...p, at: new Date().toISOString() }, { ex: 60 * 60 });
  } catch {
    /* best-effort */
  }
}

export async function getDeliveryProgress(id: string): Promise<DeliveryProgress | null> {
  if (!isProgressId(id)) return null;
  try {
    return (await redis.get<DeliveryProgress>(key(id))) ?? null;
  } catch {
    return null;
  }
}
