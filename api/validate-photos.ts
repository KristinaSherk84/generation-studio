/**
 * POST /api/validate-photos
 *
 * Pre-flight check for the reference photos the customer just uploaded.
 * Catches "your selfie was shot from across the room" / "this is a group
 * photo with 6 tiny faces" cases BEFORE the customer commits to a
 * generation that will produce bad output and trigger a refund request.
 *
 * Body: { photoUrls: string[] }   — 1–10 Vercel Blob URLs
 * Returns: { results: Array<{ url, ok, faceWidthPct?, reason? }> }
 *
 * Validation rules (current as of 2026-05-15):
 *   - We detect a face via Gemini 2.5 Flash vision (same model used by
 *     /api/deliver's BEFORE-circle face crop — proven reliable for our
 *     reference-photo distribution).
 *   - We measure the detected face's WIDTH as a percentage of the
 *     image width. The Gemini bbox returns normalized [0..1] coordinates,
 *     so faceWidthPct = xMax - xMin.
 *   - A photo passes if faceWidthPct >= MIN_FACE_WIDTH_PCT (15%). That
 *     threshold catches obvious failures (group shots, full-body, etc.)
 *     while allowing slightly-distant portraits that the AI can still
 *     learn from.
 *   - A photo fails when no face is detected, OR when the largest face
 *     is below the threshold.
 *
 * Failure-mode policy: if Gemini Vision itself errors (timeout, 5xx,
 * malformed response), we return ok:true with a "validation skipped"
 * note rather than blocking the customer. This is a soft gate — its
 * job is to catch obvious mistakes, not to harden a security boundary.
 * Better to occasionally let a tiny-face photo through than to refuse
 * service when our own pipeline is the flaky party.
 *
 * Cost / latency:
 *   - Gemini 2.5 Flash vision: ~$0.0001 per photo on Tier 1 — negligible
 *     even at scale.
 *   - Latency: ~1-3 seconds per photo, processed in parallel via
 *     Promise.all so the whole batch typically returns in 2-4 seconds
 *     total regardless of count.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { detectFaceBox } from "./lib/detectFaceBox.js";

// Vercel function timeout. Validation does up to 10 Gemini Vision calls
// in parallel, each ~1-3s. 30s is generous headroom for the long tail
// (a slow worker or a flaky retry) without sitting on the user's tab
// indefinitely.
export const maxDuration = 30;

// Minimum face width as a fraction of image width. Below this we treat
// the photo as too far away for the AI to learn the subject's features.
// 0.15 (15%) catches the obvious failure cases (group shots, full-body
// photos, selfies from across a room) without being too strict on
// slightly-distant but still-usable portrait shots.
const MIN_FACE_WIDTH_PCT = 0.15;

// Hard cap on photos we'll validate per request — matches the upload
// screen's UI cap (5-8 photos per generation, with 10 as a buffer).
const MAX_PHOTOS_PER_REQUEST = 10;

type ValidateRequest = { photoUrls: string[] };
type ValidationResult = {
  url: string;
  ok: boolean;
  faceWidthPct?: number;
  reason?: string;
};
type ValidateResponse = { results: ValidationResult[] };

async function validateOne(url: string): Promise<ValidationResult> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      // Couldn't fetch the photo from Blob — likely a stale URL or
      // network hiccup. Soft-pass; let the customer continue and let
      // /api/generate be the authoritative reader. We don't want
      // transient Blob fetch errors to block uploads.
      return {
        url,
        ok: true,
        reason: "Validation skipped (could not fetch photo for face check).",
      };
    }
    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType =
      resp.headers.get("content-type") ?? "image/jpeg";

    const bbox = await detectFaceBox(buffer, mimeType);
    if (!bbox) {
      // Gemini explicitly returned "no face." This is a hard fail —
      // we cannot generate a headshot from a photo with no clear face.
      return {
        url,
        ok: false,
        reason:
          "No clear face detected. Please use a photo where your face is clearly visible.",
      };
    }

    const faceWidthPct = bbox.xMax - bbox.xMin;
    if (faceWidthPct < MIN_FACE_WIDTH_PCT) {
      return {
        url,
        ok: false,
        faceWidthPct,
        reason: `Your face is too small in this photo (about ${Math.round(faceWidthPct * 100)}% of the image width). Try a closer-up shot — the AI works best when your face fills more of the frame.`,
      };
    }

    return { url, ok: true, faceWidthPct };
  } catch (err) {
    // Soft-pass policy on system errors (timeouts, Gemini 5xx, etc.) —
    // see header comment for rationale.
    console.warn(
      "[validate-photos] soft-pass on system error:",
      err instanceof Error ? err.message : String(err),
    );
    return {
      url,
      ok: true,
      reason: "Validation skipped (system error).",
    };
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse | void> {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body as Partial<ValidateRequest>;
  if (
    !Array.isArray(body.photoUrls) ||
    body.photoUrls.length === 0 ||
    body.photoUrls.length > MAX_PHOTOS_PER_REQUEST ||
    !body.photoUrls.every((u) => typeof u === "string" && u.length > 0)
  ) {
    return res.status(400).json({
      error: `photoUrls must be 1–${MAX_PHOTOS_PER_REQUEST} non-empty URLs`,
    });
  }

  // Parallel validation — typical 5-photo batch finishes in 2-4 seconds.
  const results = await Promise.all(body.photoUrls.map(validateOne));

  const payload: ValidateResponse = { results };
  return res.status(200).json(payload);
}
