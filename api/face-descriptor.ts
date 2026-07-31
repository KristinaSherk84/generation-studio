/**
 * POST /api/face-descriptor
 * Body: { photoUrls: string[] }  — the customer's reference photo Blob URLs.
 * Returns: { descriptor: number[] | null }  — an averaged 128-D face descriptor.
 *
 * This is the "identity anchor" the frontend compares each generated headshot
 * against, to auto-regenerate low-likeness shots (2026-07-30). Best-effort:
 * any failure returns { descriptor: null } and the frontend simply skips the
 * identity-based auto-regeneration. It NEVER blocks or fails generation.
 *
 * Called once per batch, in parallel with the 6 /api/generate calls, so its
 * face-detection time is hidden behind the generation wait.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";

// Face detection on reference photos is CPU work on the (slow) tfjs CPU
// backend + a cold-start model load, so give it real headroom — 60s was
// tight enough to time out (2026-07-31). Runs in parallel with generation,
// so a longer ceiling doesn't slow the customer down.
export const maxDuration = 300;

async function fetchBuffer(url: string): Promise<Buffer | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const ab = await resp.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body as { photoUrls?: unknown };
  const photoUrls = Array.isArray(body.photoUrls)
    ? (body.photoUrls.filter((u) => typeof u === "string") as string[])
    : [];
  if (photoUrls.length === 0) {
    return res.status(200).json({ descriptor: null });
  }

  try {
    const { computeFaceDescriptor } = await import(
      "./lib/skin/detectLandmarks.js"
    );

    // Cap how many references we score. On the CPU tfjs backend each
    // detection is slow, and scoring 5 was timing out — 2 is plenty to
    // anchor identity and keeps this well under the ceiling (2026-07-31).
    const MAX_REFS = 2;
    const urls = photoUrls.slice(0, MAX_REFS);
    const buffers = await Promise.all(urls.map(fetchBuffer));

    // Detect sequentially to avoid piling parallel work onto the CPU tfjs
    // backend (which would contend and be slower overall).
    const descriptors: number[][] = [];
    for (const buf of buffers) {
      if (!buf) continue;
      const d = await computeFaceDescriptor(buf);
      if (d && d.length === 128) descriptors.push(d);
    }

    if (descriptors.length === 0) {
      return res.status(200).json({ descriptor: null });
    }

    // Element-wise average for a stable identity anchor across references.
    const avg = new Array<number>(128).fill(0);
    for (const d of descriptors) {
      for (let i = 0; i < 128; i++) avg[i] += d[i];
    }
    for (let i = 0; i < 128; i++) avg[i] /= descriptors.length;

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ descriptor: avg });
  } catch (err) {
    console.warn(
      "[identity] /api/face-descriptor failed:",
      err instanceof Error ? err.message : String(err),
    );
    return res.status(200).json({ descriptor: null });
  }
}
