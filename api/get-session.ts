/**
 * GET /api/get-session?token=...  (2026-08-03)
 *
 * Restores a saved finished-grid session for the "your headshots are ready"
 * email link. Returns the generated grid + reference photos + selections so
 * the client can drop the customer straight back on their actual shots.
 *
 * Returns 404 if the token is missing / expired (48h TTL) / malformed.
 * Deliberately does NOT return the email — the restore doesn't need it.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSession } from "./lib/sessionStore.js";

export const maxDuration = 10;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  const token =
    typeof req.query.token === "string"
      ? req.query.token
      : Array.isArray(req.query.token)
        ? req.query.token[0]
        : "";

  const session = await getSession(token);
  if (!session) {
    res.status(404).json({ ok: false, reason: "not_found" });
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: true,
    generatedUrls: session.generatedUrls,
    referencePhotoUrls: session.referencePhotoUrls,
    selections: session.selections,
    hasWideAngle: session.hasWideAngle,
  });
}
