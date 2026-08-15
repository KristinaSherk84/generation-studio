/**
 * GET /api/admin/find-session?pw=ADMIN_PASSWORD&email=someone@example.com
 *
 * Look up a customer's SAVED grid(s) by email (2026-08-09). Scans the saved
 * sessions and returns any whose email matches, with the resume link and the
 * image URLs, so Kristi can see exactly what a lead's shots looked like even
 * if she never got (or lost) the "ready to view" email.
 *
 * Sessions have a 4-day TTL, so a grid older than that is gone (returns none).
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";

export const maxDuration = 60;

const redis = new Redis({
  url: process.env.KV_REST_API_URL ?? "",
  token: process.env.KV_REST_API_TOKEN ?? "",
});

const SITE_URL = (process.env.SITE_URL || "https://generationheadshots.com").replace(/\/$/, "");

type SessionRec = {
  email?: string;
  generatedUrls?: string[];
  referencePhotoUrls?: string[];
  createdAt?: string;
};

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  const pw = typeof req.query.pw === "string" ? req.query.pw : "";
  if (!process.env.ADMIN_PASSWORD || pw !== process.env.ADMIN_PASSWORD) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  const email =
    typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
  if (!email) {
    res.status(400).json({ ok: false, error: "pass ?email=" });
    return;
  }

  const matches: {
    token: string;
    resumeUrl: string;
    createdAt: string | null;
    imageCount: number;
    generatedUrls: string[];
    referencePhotoUrls: string[];
  }[] = [];
  let scanned = 0;
  let cursor = 0;

  try {
    do {
      const result = (await redis.scan(cursor, {
        match: "session:*",
        count: 200,
      })) as [string | number, string[]];
      const next = result[0];
      const keys = result[1] ?? [];
      cursor = typeof next === "string" ? parseInt(next, 10) : (next as number);
      for (const k of keys) {
        scanned++;
        let rec: SessionRec | null = null;
        try {
          rec = await redis.get<SessionRec>(k);
        } catch {
          continue;
        }
        if (!rec?.email || rec.email.trim().toLowerCase() !== email) continue;
        const token = k.slice("session:".length);
        matches.push({
          token,
          resumeUrl: `${SITE_URL}/?resume=${token}`,
          createdAt: rec.createdAt ?? null,
          imageCount: Array.isArray(rec.generatedUrls) ? rec.generatedUrls.length : 0,
          generatedUrls: Array.isArray(rec.generatedUrls) ? rec.generatedUrls : [],
          // The customer's ORIGINAL uploaded reference photos (2026-08-15) - so
          // Kristi can inspect what they actually submitted (e.g. did any show
          // their real teeth) straight from this one lookup.
          referencePhotoUrls: Array.isArray(rec.referencePhotoUrls)
            ? rec.referencePhotoUrls
            : [],
        });
      }
    } while (cursor !== 0);
  } catch (err) {
    res.status(500).json({ ok: false, error: "scan failed: " + String(err) });
    return;
  }

  // Newest first.
  matches.sort((a, b) =>
    (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
  );

  res.status(200).json({
    ok: true,
    email,
    sessionsScanned: scanned,
    found: matches.length,
    matches,
  });
}
