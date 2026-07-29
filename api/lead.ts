/**
 * POST /api/lead
 *
 * Public endpoint. Called from the client right before a free generation
 * batch starts, to capture the customer's email for the lead list +
 * abandonment follow-up. Fire-and-forget from the client's point of view:
 * a failure here must NEVER block generation, so the client ignores the
 * response and proceeds regardless.
 *
 * Body: { email: string, source?: string }
 * Returns: { ok: true } on success, { ok: false, reason } otherwise.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { recordLead, looksLikeEmail } from "./lib/leadStore.js";

export const maxDuration = 10;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, reason: "method_not_allowed" });
    return;
  }

  const body = (req.body ?? {}) as { email?: unknown; source?: unknown };
  const email = typeof body.email === "string" ? body.email.trim() : "";

  if (!looksLikeEmail(email)) {
    res.status(400).json({ ok: false, reason: "invalid_email" });
    return;
  }

  const source =
    typeof body.source === "string" ? body.source.slice(0, 120) : "generate";

  try {
    await recordLead({ email, source });
    res.status(200).json({ ok: true });
  } catch (err) {
    // Log for diagnostics but don't surface — the client proceeds anyway.
    console.error("[lead] recordLead failed:", err);
    res.status(200).json({ ok: false, reason: "store_error" });
  }
}
