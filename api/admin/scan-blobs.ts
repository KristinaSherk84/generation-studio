/**
 * GET /api/admin/scan-blobs  (2026-09-13)
 *
 * List Vercel Blob URLs by time window + optional prefix. Used to
 * recover shots for customers whose session record TTL'd out but whose
 * Blob URLs still exist (Amy Yang case: session expired after 4 days
 * but she generated 40 shots we need to find).
 *
 * Params (query string):
 *   pw            required   admin password
 *   sinceISO      required   ISO timestamp — lower bound of uploadedAt
 *   untilISO      required   ISO timestamp — upper bound of uploadedAt
 *   prefix        optional   Blob path prefix (default: "" — all blobs)
 *   pattern       optional   substring the pathname must contain (case-insensitive)
 *   limit         optional   max URLs to return (default: 200, cap: 500)
 *
 * Response:
 *   { ok, windowStart, windowEnd, prefix, pattern, blobsScanned,
 *     matches: [{url, pathname, uploadedAt, sizeKB}] }
 *
 * The scan iterates all pages (Vercel Blob has no server-side time
 * filter) so runtime scales with total blob count. Time budget: 55s.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { list } from "@vercel/blob";

export const maxDuration = 60;

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

  const sinceISO =
    typeof req.query.sinceISO === "string" ? req.query.sinceISO : "";
  const untilISO =
    typeof req.query.untilISO === "string" ? req.query.untilISO : "";
  const prefix =
    typeof req.query.prefix === "string" ? req.query.prefix : "";
  const pattern =
    typeof req.query.pattern === "string" ? req.query.pattern.toLowerCase() : "";
  const limit = Math.max(
    1,
    Math.min(500, Number(req.query.limit) || 200),
  );

  const since = new Date(sinceISO);
  const until = new Date(untilISO);
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
    res
      .status(400)
      .json({ ok: false, error: "sinceISO and untilISO required (ISO8601)" });
    return;
  }
  if (since.getTime() >= until.getTime()) {
    res.status(400).json({ ok: false, error: "sinceISO must be before untilISO" });
    return;
  }

  const matches: {
    url: string;
    pathname: string;
    uploadedAt: string;
    sizeKB: number;
  }[] = [];
  let cursor: string | undefined;
  let scanned = 0;
  const t0 = Date.now();
  const BUDGET_MS = 55_000;
  do {
    if (Date.now() - t0 > BUDGET_MS) break;
    const page: {
      blobs: Array<{
        url: string;
        pathname: string;
        size: number;
        uploadedAt: Date;
      }>;
      cursor?: string;
    } = await list({ prefix, cursor, limit: 1000 });
    for (const b of page.blobs) {
      scanned += 1;
      const t = b.uploadedAt.getTime();
      if (t < since.getTime() || t > until.getTime()) continue;
      if (pattern && !b.pathname.toLowerCase().includes(pattern)) continue;
      matches.push({
        url: b.url,
        pathname: b.pathname,
        uploadedAt: b.uploadedAt.toISOString(),
        sizeKB: Math.round(b.size / 1024),
      });
      if (matches.length >= limit) break;
    }
    if (matches.length >= limit) break;
    cursor = page.cursor;
  } while (cursor);

  matches.sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));

  res.status(200).json({
    ok: true,
    windowStart: since.toISOString(),
    windowEnd: until.toISOString(),
    prefix: prefix || "(all)",
    pattern: pattern || "(none)",
    blobsScanned: scanned,
    matchCount: matches.length,
    matches,
    truncated: matches.length >= limit,
  });
}
