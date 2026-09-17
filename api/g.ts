/**
 * GET /api/g?w=<weekCode>
 *
 * Tracking redirect used by the QR code on the weekly Graduates LinkedIn
 * graphic. Every scan lands here, we log it in Redis so Kristi can see the
 * click count per week code in her leads dashboard, tag the visitor's
 * "foundVia" so any lead who signs up in the same session shows up on the
 * leads page under "Weekly Grads · <weekCode>", then redirect them to the
 * homepage.
 *
 * Example QR URL:
 *   https://generationheadshots.com/api/g?w=grads-2026-09-15
 *
 * The `w` param is a free-form code (usually the Monday of the week the
 * post went up); the leads page already reads foundVia values from a
 * dropdown that Kristi can add options to, so a new week code just shows
 * as its own bucket on the "How they found us" panel.
 *
 * If `w` is missing or invalid, we still redirect (never leave the visitor
 * on an error page) but skip the logging.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";

export const maxDuration = 5;

const redis = new Redis({
  url: process.env.KV_REST_API_URL ?? "",
  token: process.env.KV_REST_API_TOKEN ?? "",
});

const SITE_URL = (
  process.env.SITE_URL || "https://generationheadshots.com"
).replace(/\/$/, "");

// Only allow simple slugs so a hostile QR URL can't inject weird cookie
// values (e.g. control chars, newlines).
const WEEK_CODE_RE = /^[a-z0-9-]{1,40}$/;

// 30 days — long enough that even a lag between scan and signup gets
// attributed correctly.
const FOUND_VIA_COOKIE_TTL_SEC = 30 * 24 * 3600;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  const rawW = typeof req.query.w === "string" ? req.query.w.toLowerCase() : "";
  const w = WEEK_CODE_RE.test(rawW) ? rawW : "";

  if (w) {
    // Fire-and-forget: never block the redirect on Redis. The counters
    // and click log are best-effort — a Redis blip just means one scan
    // isn't counted, the visitor still lands on the homepage instantly.
    void (async () => {
      try {
        const nowISO = new Date().toISOString();
        // Count total scans per week code — feeds the leads page.
        await redis.incr(`gscan:count:${w}`);
        // Rolling list of last 200 scan timestamps for spot-checking.
        await redis.lpush(`gscan:log:${w}`, nowISO);
        await redis.ltrim(`gscan:log:${w}`, 0, 199);
        // Index of every week code ever seen (so we can enumerate them
        // on the leads page later).
        await redis.sadd("gscan:codes", w);
      } catch {
        /* best-effort */
      }
    })();

    // Tag the visitor so a later signup gets automatic foundVia. The
    // client's email-capture flow reads this cookie and passes it as
    // `foundVia` in the /api/save-lead payload.
    //
    // Cookie is intentionally NOT HttpOnly — the client-side JS needs to
    // read it. Set SameSite=Lax so it survives the LinkedIn → homepage
    // redirect but isn't sent on third-party embedded requests.
    const cookieVal = `weekly-grads-${w}`;
    res.setHeader(
      "Set-Cookie",
      `gh_source=${encodeURIComponent(cookieVal)}; Path=/; Max-Age=${FOUND_VIA_COOKIE_TTL_SEC}; SameSite=Lax; Secure`,
    );
  }

  // Cache-bust so QR scans always hit the counter.
  res.setHeader("Cache-Control", "no-store");
  // 302 not 301 so browsers don't cache the redirect itself.
  res.writeHead(302, { Location: SITE_URL + "/" });
  res.end();
}
