/**
 * GET/POST /api/recover-batch?batchId=...
 *
 * Returns the headshots we saved server-side for this batch (see batchStore —
 * Phase A, 2026-08-17). The browser calls this when its live generate calls
 * dropped, so it can rebuild the grid from what we already generated instead of
 * showing "Connection interrupted". Images are public Blob URLs and the batchId
 * is an unguessable random id, so no extra auth is required (same model as the
 * ?resume= session links).
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getBatch } from "./lib/batchStore.js";

export const maxDuration = 10;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  const q = req.query.batchId;
  const b = (req.body ?? {}) as { batchId?: unknown };
  const batchId =
    typeof q === "string" ? q : typeof b.batchId === "string" ? b.batchId : "";
  if (!batchId) {
    res.status(400).json({ ok: false, error: "missing batchId" });
    return;
  }
  const rec = await getBatch(batchId);
  if (!rec || rec.images.length === 0) {
    res.status(200).json({ ok: true, found: false, images: [] });
    return;
  }
  res.status(200).json({ ok: true, found: true, ...rec });
}
