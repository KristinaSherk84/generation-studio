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
// 2026-10-02 (Kristi: "crop in more"): raised from 0.33 so more photos
// get tightened.
const ALREADY_TIGHT = 0.42;
// Output crop is head + neck + top of shoulders: this many face-heights
// tall, 4:5 aspect, with this many face-heights of room above the face
// box (face box ≈ brow to chin). 2026-10-02: tightened from 3.0 / 0.8 —
// the face now fills ~43% of the crop height instead of ~33%.
const CROP_FACE_HEIGHTS = 2.3;
const HEADROOM_FACE_HEIGHTS = 0.55;
const MAX_OUTPUT_SIDE = 1600;

/**
 * Reference-quality score 0–100 (2026-10-02, likeness work). Higher = a
 * better identity reference for Gemini. Blends: face size in pixels (more
 * face detail), sharpness of the face region (Laplacian variance), face
 * exposure (not too dark / blown out), and how frontal the face is (the
 * detector's box gets narrow on profiles). The app sends the top 6.
 */
async function scoreReference(
  bytes: Buffer,
  face: { x: number; y: number; width: number; height: number },
  W: number,
  H: number,
): Promise<number> {
  try {
    const left = Math.max(0, Math.round(face.x));
    const top = Math.max(0, Math.round(face.y));
    const width = Math.max(8, Math.min(Math.round(face.width), W - left));
    const height = Math.max(8, Math.min(Math.round(face.height), H - top));
    const grey = sharp(bytes).rotate().extract({ left, top, width, height }).greyscale();
    const [stats, lap] = await Promise.all([
      grey.clone().stats(),
      grey
        .clone()
        .resize(256, 256, { fit: "inside", withoutEnlargement: true })
        .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] })
        .raw()
        .toBuffer({ resolveWithObject: true }),
    ]);
    // Sharpness: variance of the Laplacian response.
    const px = lap.data;
    let sum = 0;
    for (let i = 0; i < px.length; i++) sum += px[i];
    const mean = sum / px.length;
    let v = 0;
    for (let i = 0; i < px.length; i++) v += (px[i] - mean) ** 2;
    const lapVar = v / px.length; // ~0 (blurry) … 2000+ (very sharp)
    const sharp01 = Math.min(1, Math.log1p(lapVar) / Math.log1p(1500));
    // Face size: 250px face ≈ full marks.
    const size01 = Math.min(1, face.height / 250);
    // Exposure: face mean brightness, best around 90–170 of 255.
    const m = stats.channels[0]?.mean ?? 128;
    const expo01 = m < 90 ? m / 90 : m > 170 ? Math.max(0, 1 - (m - 170) / 85) : 1;
    // Frontal-ness: frontal boxes are ~0.72–0.9 wide-to-tall; profiles narrower.
    const ar = face.width / Math.max(1, face.height);
    const front01 = ar >= 0.72 ? 1 : Math.max(0, (ar - 0.45) / 0.27);
    return Math.round(100 * (0.35 * sharp01 + 0.3 * size01 + 0.15 * expo01 + 0.2 * front01));
  } catch {
    return 50;
  }
}

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
  const keep = (reason: string, faces?: number, quality?: number) =>
    res.status(200).json({ url, cropped: false, reason, faces, quality });

  try {
    const r = await fetch(url);
    if (!r.ok) return keep("fetch_failed");
    const bytes = Buffer.from(await r.arrayBuffer());

    const det = await detectFaceBoxes(bytes);
    if (!det) return keep("detect_failed");
    if (det.boxes.length === 0) return keep("no_face", 0, 5);

    const face = det.boxes[0]; // largest face
    const { width: W, height: H } = det;

    // Group photo? (2026-09-23 per Kristi) Count faces that are at least
    // 40% as tall as the biggest one — real people in the shot, not tiny
    // strangers far in the background. More than one → do NOT guess who
    // the customer is. Leave the photo uncropped and tell the app, which
    // asks the customer to crop in on themselves.
    const people = det.boxes.filter((b) => b.height >= 0.4 * face.height).length;
    if (people > 1) return keep("multiple_faces", people, 10);
    const quality = await scoreReference(bytes, face, W, H);
    if (face.height >= ALREADY_TIGHT * H) return keep("already_tight", det.boxes.length, quality);

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
    res.status(200).json({ url: blob.url, cropped: true, faces: det.boxes.length, quality });
  } catch (err) {
    console.warn(
      "[crop-reference] failed:",
      err instanceof Error ? err.message : String(err),
    );
    keep("error");
  }
}
