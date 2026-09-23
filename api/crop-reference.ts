/**
 * POST /api/crop-reference  (2026-09-23)
 * Body: { url: string }  — one uploaded reference photo (Vercel Blob URL)
 * Returns: { url, cropped, reason?, faces? }
 *
 * Crops a reference photo to a head-and-shoulders frame around the
 * subject's face BEFORE it goes to Gemini. Why: customers upload loose
 * selfies where the face is a small part of the picture. Gemini then gets
 * fewer face pixels to copy (weaker likeness — the #1 reason non-buyers
 * gave in the Sept survey) and extra body/background content leaks into
 * the output (the "blobs" case).
 *
 * Group photos (2+ people) are NEVER cropped — we'd have to guess which
 * face is the customer. They come back with reason "multiple_faces" and
 * the upload screen asks the customer to crop in on themselves.
 *
 * Called by the upload screen right after each photo finishes uploading,
 * so the work happens while the customer is choosing a style — it never
 * delays generation. ALWAYS best-effort: any failure (no face found, HEIC
 * that sharp can't read, models missing, timeout) returns the ORIGINAL
 * url with cropped:false, and generation uses the original as before.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { put } from "@vercel/blob";
import sharp from "sharp";
import { detectFaceBoxes } from "./lib/skin/detectLandmarks.js";

export const maxDuration = 60;

// Only accept our own Blob storage URLs.
const BLOB_URL_RE = /^https:\/\/[^/]*\.public\.blob\.vercel-storage\.com\//;

// Skip cropping when the face already fills this much of the photo's
// height — it's already a close-up and cropping would only cost detail.
const ALREADY_TIGHT = 0.33;
// Output crop is head + neck + shoulders: this many face-heights tall,
// 4:5 aspect, with this many face-heights of room above the face box.
const CROP_FACE_HEIGHTS = 3.0;
const HEADROOM_FACE_HEIGHTS = 0.8;
const MAX_OUTPUT_SIDE = 1600;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const url =
    typeof (req.body as { url?: unknown })?.url === "string"
      ? ((req.body as { url: string }).url)
      : "";
  if (!BLOB_URL_RE.test(url)) {
    res.status(400).json({ url, cropped: false, reason: "bad_url" });
    return;
  }
  const keep = (reason: string, faces?: number) =>
    res.status(200).json({ url, cropped: false, reason, faces });

  try {
    const r = await fetch(url);
    if (!r.ok) return keep("fetch_failed");
    const bytes = Buffer.from(await r.arrayBuffer());

    const det = await detectFaceBoxes(bytes);
    if (!det) return keep("detect_failed");
    if (det.boxes.length === 0) return keep("no_face", 0);

    const face = det.boxes[0]; // largest face
    const { width: W, height: H } = det;

    // Group photo? (2026-09-23 per Kristi) Count faces that are at least
    // 40% as tall as the biggest one — real people in the shot, not tiny
    // strangers far in the background. More than one → do NOT guess who
    // the customer is. Leave the photo uncropped and tell the app, which
    // asks the customer to crop in on themselves.
    const people = det.boxes.filter((b) => b.height >= 0.4 * face.height).length;
    if (people > 1) return keep("multiple_faces", people);
    if (face.height >= ALREADY_TIGHT * H) return keep("already_tight", det.boxes.length);

    // Head-and-shoulders box around the face, 4:5 portrait.
    let cropH = face.height * CROP_FACE_HEIGHTS;
    let cropW = cropH * 0.8;
    // Never ask for more than the photo has (keeps the crop un-stretched).
    if (cropW > W) {
      cropW = W;
      cropH = Math.min(H, cropW / 0.8);
    }
    if (cropH > H) {
      cropH = H;
      cropW = Math.min(W, cropH * 0.8);
    }
    const faceCx = face.x + face.width / 2;
    let left = faceCx - cropW / 2;
    let top = face.y - face.height * HEADROOM_FACE_HEIGHTS;
    // Slide back inside the photo without changing size.
    left = Math.max(0, Math.min(left, W - cropW));
    top = Math.max(0, Math.min(top, H - cropH));

    const out = await sharp(bytes)
      .rotate() // honor EXIF orientation, same as detection
      .extract({
        left: Math.round(left),
        top: Math.round(top),
        width: Math.max(1, Math.min(Math.round(cropW), W - Math.round(left))),
        height: Math.max(1, Math.min(Math.round(cropH), H - Math.round(top))),
      })
      .resize(MAX_OUTPUT_SIDE, MAX_OUTPUT_SIDE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 92 })
      .toBuffer();

    const blob = await put(`refcrop/${Date.now()}-crop.jpg`, out, {
      access: "public",
      contentType: "image/jpeg",
      addRandomSuffix: true,
    });
    res.status(200).json({ url: blob.url, cropped: true, faces: det.boxes.length });
  } catch (err) {
    console.warn(
      "[crop-reference] failed:",
      err instanceof Error ? err.message : String(err),
    );
    keep("error");
  }
}
