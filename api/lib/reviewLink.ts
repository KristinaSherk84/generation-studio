/**
 * Signed links to the phone-friendly "Review retouches" admin page
 * (2026-10-16, Kristi). The link in Kristi's delivery alert email carries a
 * per-delivery key instead of the admin password, so a forwarded or leaked
 * link only opens that one delivery.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const SITE = "https://generationheadshots.com";

/** Per-delivery key: HMAC of the delivery id with the admin password. */
export function reviewKey(deliveryId: string): string {
  const secret = process.env.ADMIN_PASSWORD ?? "";
  return createHmac("sha256", `retouch-review:${secret}`)
    .update(deliveryId)
    .digest("base64url")
    .slice(0, 24);
}

export function checkReviewKey(deliveryId: string, key: string): boolean {
  if (!process.env.ADMIN_PASSWORD || !deliveryId || !key) return false;
  const want = Buffer.from(reviewKey(deliveryId));
  const got = Buffer.from(key);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function reviewUrl(deliveryId: string): string {
  return `${SITE}/api/admin/retouch-review?d=${encodeURIComponent(deliveryId)}&k=${reviewKey(deliveryId)}`;
}

/** The post-delivery crop check for one delivery (2026-10-20). */
export function cropCheckUrl(deliveryId: string): string {
  return `${SITE}/api/admin/crop-check?d=${encodeURIComponent(deliveryId)}&k=${reviewKey(deliveryId)}`;
}
