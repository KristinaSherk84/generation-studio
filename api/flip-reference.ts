/**
 * POST /api/flip-reference  (2026-10-16, Kristi)
 * Body: { url: string }  — one uploaded reference photo (Vercel Blob URL)
 * Returns: { url }  — a mirror-image (left-right flipped) copy
 *
 * Used by the upload screen's "↔ Flip" button when the mirror check
 * (/api/check-marks) finds a mole/mark on different sides in different
 * photos. The customer decides which photos to flip; this only does it.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { put } from "@vercel/blob";
import sharp from "sharp";

export const maxDuration = 30;

const BLOB_URL_RE = /^https:\/\/[^/]*\.public\.blob\.vercel-storage\.com\//;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false });
    return;
  }
  const url = typeof req.body?.url === "string" ? req.body.url : "";
  if (!BLOB_URL_RE.test(url)) {
    res.status(400).json({ ok: false, error: "bad url" });
    return;
  }
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch ${r.status}`);
    // .rotate() applies EXIF orientation first so "left-right" means what the
    // customer sees; .flop() mirrors horizontally.
    const out = await sharp(Buffer.from(await r.arrayBuffer()))
      .rotate()
      .flop()
      .jpeg({ quality: 92 })
      .toBuffer();
    const blob = await put(`refflip/${Date.now()}-flipped.jpg`, out, {
      access: "public",
      contentType: "image/jpeg",
      addRandomSuffix: true,
    });
    res.status(200).json({ ok: true, url: blob.url });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
