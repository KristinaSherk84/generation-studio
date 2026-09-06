/**
 * POST /api/session-versions  body: { token, versionShots: string[] }  (2026-09-04)
 *
 * Attaches "Generate Versions" bonus variation shots to an already-saved
 * session so they show on the customer's "your headshots are ready" resume
 * link. Version shots are generated AFTER the main grid is saved (customer
 * taps "Love one? Click here to make more variations"), so they get patched
 * in here — same pattern as /api/session-wildcards.
 *
 * Best-effort: any failure returns { ok: false } and never blocks the UI.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { setSessionVersionShots } from "./lib/sessionStore.js";

export const maxDuration = 10;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false });
    return;
  }
  const body = (req.body ?? {}) as { token?: unknown; versionShots?: unknown };
  const token = typeof body.token === "string" ? body.token : "";
  const versionShots = Array.isArray(body.versionShots)
    ? (body.versionShots as unknown[]).filter(
        (u): u is string => typeof u === "string" && /^https?:\/\//.test(u),
      )
    : [];
  if (!token || versionShots.length === 0) {
    res.status(400).json({ ok: false, reason: "bad_input" });
    return;
  }
  try {
    const ok = await setSessionVersionShots(token, versionShots);
    res.status(200).json({ ok });
  } catch (err) {
    console.warn(
      "[session-versions] failed:",
      err instanceof Error ? err.message : String(err),
    );
    res.status(200).json({ ok: false, reason: "store_error" });
  }
}
