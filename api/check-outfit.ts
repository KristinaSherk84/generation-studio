/**
 * POST /api/check-outfit  (2026-09-25)
 * Body: { url: string }  — the customer's "Upload Cropped Outfit" photo (Blob URL)
 * Returns: { checked: boolean, faces: number }
 *
 * The outfit photo must show ONLY a garment. If a face is in it, Gemini can
 * copy that person's face / skin / body into the headshots (the same leak we
 * saw with uncropped reference photos). The upload screen calls this right
 * after the outfit photo uploads and, when faces > 0, asks the customer to
 * crop the face out before generating.
 *
 * Best-effort: if detection fails (HEIC sharp can't read, timeout, models
 * missing) we return checked:false and the app lets them continue.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { detectFaceBoxes } from "./lib/skin/detectLandmarks.js";

export const maxDuration = 60;

const BLOB_URL_RE = /^https:\/\/[^/]*\.public\.blob\.vercel-storage\.com\//;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const url =
    typeof (req.body as { url?: unknown })?.url === "string"
      ? (req.body as { url: string }).url
      : "";
  if (!BLOB_URL_RE.test(url)) {
    res.status(400).json({ checked: false, faces: 0, reason: "bad_url" });
    return;
  }
  try {
    const r = await fetch(url);
    if (!r.ok) {
      res.status(200).json({ checked: false, faces: 0, reason: "fetch_failed" });
      return;
    }
    const bytes = Buffer.from(await r.arrayBuffer());
    const det = await detectFaceBoxes(bytes);
    if (!det) {
      res.status(200).json({ checked: false, faces: 0, reason: "detect_failed" });
      return;
    }
    res.status(200).json({ checked: true, faces: det.boxes.length });
  } catch (err) {
    console.warn(
      "[check-outfit] failed:",
      err instanceof Error ? err.message : String(err),
    );
    res.status(200).json({ checked: false, faces: 0, reason: "error" });
  }
}
