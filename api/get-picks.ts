/**
 * GET /api/get-picks?id=<shareId>  (2026-10-22, Kristi)
 *
 * Feeds the manager's /approve/<id> page. Returns ONLY the shots the employee
 * put in their cart — never the rest of the gallery, and never the gallery
 * token — plus what /api/deliver needs to fill the order.
 *
 * 200 { ok, ownerEmail, picks, purchased, selections, referencePhotoUrls }
 *   picks      = cart shots not bought yet
 *   purchased  = cart shots already bought (shown with the green rim)
 * 404 if the link is unknown / expired; 403 if the employee is blocked.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getShareToken, getSession, SHARE_ID_RE } from "./lib/sessionStore.js";
import { isEmailBlacklisted } from "./lib/leadStore.js";

export const maxDuration = 10;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const raw = req.query.id;
  const id = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : "";
  res.setHeader("Cache-Control", "no-store");
  if (!id || !SHARE_ID_RE.test(id)) {
    res.status(404).json({ ok: false, reason: "not_found" });
    return;
  }
  const token = await getShareToken(id);
  const session = token ? await getSession(token) : null;
  if (!session) {
    res.status(404).json({ ok: false, reason: "not_found" });
    return;
  }
  const ownerEmail = typeof session.email === "string" ? session.email : "";
  // Same rule as get-session: a blocked customer's gallery stays closed.
  if (ownerEmail && (await isEmailBlacklisted(ownerEmail).catch(() => false))) {
    res.status(403).json({ ok: false, reason: "blocked" });
    return;
  }
  const bought = new Set(session.purchasedUrls ?? []);
  const cart = session.cartUrls ?? [];
  const picks = cart.filter((u) => !bought.has(u));
  // Bought through this link (they've left the cart) + any cart shot the
  // employee bought themselves.
  const purchased = Array.from(
    new Set([...(session.approvedUrls ?? []), ...cart.filter((u) => bought.has(u))]),
  );
  res.status(200).json({
    ok: true,
    ownerEmail,
    picks,
    purchased,
    selections: session.selections ?? null,
    referencePhotoUrls: session.referencePhotoUrls ?? [],
  });
}
