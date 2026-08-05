/**
 * POST /api/save-session  (2026-08-03)
 *
 * Called by the client the moment a batch finishes, right before the
 * "your headshots are ready" email fires. Persists the finished grid so the
 * email link can restore it on any device. Returns { token }.
 *
 * Body: {
 *   email: string,
 *   generatedUrls: string[],        // Blob URLs of the 6 preview shots
 *   referencePhotoUrls?: string[],  // customer's reference photo Blob URLs
 *   selections?: object,            // StyleSelections
 *   hasWideAngle?: boolean
 * }
 * Best-effort: on any failure returns { ok: false } and the client just
 * sends the email without a resume link (falls back to the site).
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { saveSession } from "./lib/sessionStore.js";
import { looksLikeEmail, setLeadResumeToken } from "./lib/leadStore.js";

export const maxDuration = 10;

const isUrlArray = (v: unknown, max: number): v is string[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.length <= max &&
  v.every((u) => typeof u === "string" && /^https?:\/\//.test(u));

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false });
    return;
  }
  const body = (req.body ?? {}) as {
    email?: unknown;
    generatedUrls?: unknown;
    referencePhotoUrls?: unknown;
    selections?: unknown;
    hasWideAngle?: unknown;
  };

  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!looksLikeEmail(email)) {
    res.status(400).json({ ok: false, reason: "invalid_email" });
    return;
  }
  if (!isUrlArray(body.generatedUrls, 8)) {
    res.status(400).json({ ok: false, reason: "invalid_images" });
    return;
  }
  const referencePhotoUrls = isUrlArray(body.referencePhotoUrls, 12)
    ? (body.referencePhotoUrls as string[])
    : [];

  try {
    const token = await saveSession({
      email,
      generatedUrls: body.generatedUrls as string[],
      referencePhotoUrls,
      selections: body.selections ?? null,
      hasWideAngle: body.hasWideAngle === true,
    });
    // Link this session's resume token to the lead so the 12-hour win-back
    // email can point the customer straight back to their saved grid. Best-
    // effort — never fail the save because the lead write hiccuped. (2026-08-05)
    void setLeadResumeToken(email, token).catch(() => {});
    res.status(200).json({ ok: true, token });
  } catch (err) {
    console.warn(
      "[save-session] failed:",
      err instanceof Error ? err.message : String(err),
    );
    res.status(200).json({ ok: false, reason: "store_error" });
  }
}
