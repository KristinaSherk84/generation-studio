/**
 * GET /api/delivery-progress?id=<progressId>  (2026-10-17)
 * Returns { stage, done, total } for a delivery in progress, or
 * { stage: "unknown" } before /api/deliver has written anything. Read-only.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDeliveryProgress, isProgressId } from "./lib/deliveryProgress.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const id = req.query.id;
  if (!isProgressId(id)) {
    res.status(400).json({ error: "bad id" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json((await getDeliveryProgress(id)) ?? { stage: "unknown", done: 0, total: 0 });
}
