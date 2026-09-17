/**
 * GET /api/admin/weekly-grads?pw=ADMIN_PASSWORD&sinceISO=...&untilISO=...
 *
 * Returns the delivery manifests for a date window — used by the local
 * build_weekly_grads.py script to download that week's purchasers into
 * per-customer folders on Kristi's Desktop for the Monday LinkedIn post.
 *
 * If sinceISO / untilISO are omitted, defaults to the LAST FULL MON–SUN
 * (Eastern Time) window ending on Sunday just past. So running this on a
 * Monday morning gives you the week that just closed.
 *
 * Response:
 *   {
 *     ok, windowStart, windowEnd, count,
 *     grads: [
 *       {
 *         customerName, email, deliveredAt,
 *         referencePhotoUrls: [url, url, ...],
 *         deliveredHeadshotUrls: [url, url, ...],
 *         style, attire, deliveryId
 *       }, ...
 *     ]
 *   }
 *
 * Deduplication: if the same email has multiple deliveries in the window
 * (e.g. bought once, then bought again for a Deluxe upgrade), the LATEST
 * delivery wins so we get the customer's final chosen shots.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { list } from "@vercel/blob";

export const maxDuration = 60;

type Manifest = {
  deliveryId: string;
  timestamp: string;
  email: string;
  customerName: string;
  style?: string;
  attire?: string;
  referencePhotoUrls: string[];
  deliveredHeadshots?: { realistic: string; polished?: string; glam?: string }[];
  deliveredHeadshotUrls?: string[];
};

/**
 * Return the ISO bounds for the "last complete Mon-Sun (ET)" week relative
 * to the current moment. On a Monday, this covers the 7 days that JUST
 * ended (previous Mon 00:00 ET → previous Sun 23:59:59 ET).
 */
function lastCompleteMonSunET(): { sinceISO: string; untilISO: string } {
  // Convert "now" to ET, then walk back to the most recent Sunday-end.
  const nowET = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" }),
  );
  const day = nowET.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  // Days since last Sunday-end (i.e. last Monday 00:00). If today is Sunday,
  // "last full week" is the one that ended TODAY (so back 7). Otherwise
  // back to the most recent Sunday-end.
  const daysSinceLastSundayEnd = day === 0 ? 7 : day;
  const untilET = new Date(nowET);
  untilET.setDate(nowET.getDate() - (daysSinceLastSundayEnd - 1));
  untilET.setHours(23, 59, 59, 999); // end of Sunday
  const sinceET = new Date(untilET);
  sinceET.setDate(untilET.getDate() - 6);
  sinceET.setHours(0, 0, 0, 0); // start of Monday
  // ET-anchored times → real ISO strings. Because we constructed the Dates
  // via a locale string, they're already in local (script host) time zone
  // representing ET wall-clock times, which we send as ISO for downstream
  // convenience. Timestamp filtering below compares within ~1h of intent.
  return { sinceISO: sinceET.toISOString(), untilISO: untilET.toISOString() };
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  const expected = process.env.ADMIN_PASSWORD ?? "";
  if (!expected) {
    res.status(500).json({ ok: false, error: "admin password not configured" });
    return;
  }
  const pwFromQuery = typeof req.query.pw === "string" ? req.query.pw : "";
  const auth = req.headers.authorization ?? "";
  const pwFromHeader = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if ((pwFromQuery || pwFromHeader) !== expected) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  const overrideSince =
    typeof req.query.sinceISO === "string" ? req.query.sinceISO : "";
  const overrideUntil =
    typeof req.query.untilISO === "string" ? req.query.untilISO : "";
  const { sinceISO, untilISO } =
    overrideSince && overrideUntil
      ? { sinceISO: overrideSince, untilISO: overrideUntil }
      : lastCompleteMonSunET();
  const since = new Date(sinceISO);
  const until = new Date(untilISO);
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
    res.status(400).json({ ok: false, error: "invalid sinceISO/untilISO" });
    return;
  }

  // Walk deliveries/ blobs and pick just the manifest.json entries.
  const manifestBlobs: { url: string; uploadedAt: string }[] = [];
  let cursor: string | undefined;
  const t0 = Date.now();
  try {
    do {
      const page = await list({
        prefix: "deliveries/",
        cursor,
        limit: 1000,
      });
      for (const b of page.blobs) {
        if (!b.pathname.endsWith("/manifest.json")) continue;
        const ts = new Date(b.uploadedAt);
        if (ts < since || ts > until) continue;
        // Vercel Blob returns uploadedAt as a Date object at runtime even
        // though the type declares string. Normalize to ISO string so
        // downstream localeCompare + JSON serialize works.
        manifestBlobs.push({
          url: b.url,
          uploadedAt: ts.toISOString(),
        });
      }
      cursor = page.cursor;
      if (Date.now() - t0 > 45_000) break;
    } while (cursor);
  } catch (err) {
    res
      .status(500)
      .json({ ok: false, error: "blob list failed: " + String(err) });
    return;
  }

  // Fetch manifests in parallel (bounded). Keep the LATEST per email.
  const byEmail: Record<
    string,
    Manifest & { deliveredAt: string }
  > = {};
  const CONCURRENCY = 12;
  for (let i = 0; i < manifestBlobs.length; i += CONCURRENCY) {
    const slice = manifestBlobs.slice(i, i + CONCURRENCY);
    const chunk = await Promise.all(
      slice.map(async (b) => {
        try {
          const r = await fetch(b.url);
          if (!r.ok) return null;
          const m = (await r.json()) as Manifest;
          return { manifest: m, deliveredAt: b.uploadedAt };
        } catch {
          return null;
        }
      }),
    );
    for (const item of chunk) {
      if (!item || !item.manifest?.email) continue;
      const key = item.manifest.email.trim().toLowerCase();
      const prior = byEmail[key];
      if (!prior || prior.deliveredAt < item.deliveredAt) {
        byEmail[key] = { ...item.manifest, deliveredAt: item.deliveredAt };
      }
    }
    if (Date.now() - t0 > 55_000) break;
  }

  // Shape the response: flat list of grads, newest first.
  const grads = Object.values(byEmail)
    .map((m) => ({
      customerName: m.customerName ?? "",
      email: m.email,
      deliveredAt: m.deliveredAt,
      style: m.style ?? "",
      attire: m.attire ?? "",
      deliveryId: m.deliveryId,
      referencePhotoUrls: Array.isArray(m.referencePhotoUrls)
        ? m.referencePhotoUrls
        : [],
      deliveredHeadshotUrls:
        m.deliveredHeadshotUrls && m.deliveredHeadshotUrls.length > 0
          ? m.deliveredHeadshotUrls
          : Array.isArray(m.deliveredHeadshots)
            ? m.deliveredHeadshots.flatMap((h) =>
                [h.realistic, h.polished, h.glam].filter(
                  (u): u is string => typeof u === "string" && !!u,
                ),
              )
            : [],
    }))
    .sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt));

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: true,
    windowStart: sinceISO,
    windowEnd: untilISO,
    count: grads.length,
    grads,
  });
}
