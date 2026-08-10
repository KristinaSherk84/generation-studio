/**
 * POST /api/update-session  (2026-08-10)
 *
 * Patch ONE slot of an already-saved "ready to view" grid so a regeneration
 * done from the resume link STICKS when the link is reopened. Kristi's
 * damage-control flow: she can open a customer's link before they do, tap the
 * regenerate icon on a shot that doesn't look like them, and have the fixed
 * shot replace the bad one on the saved grid (so the customer sees the good
 * one). Any resume-link visitor's regen persists the same way.
 *
 * Body: { token: string, index: number, url: string }  // url = https Blob URL
 * Best-effort: returns { ok:false } on bad input / missing session / store
 * error — the on-screen regen still shows regardless.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { updateSessionSlot } from "./lib/sessionStore.js";

export const maxDuration = 10;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false });
    return;
  }
  const body = (req.body ?? {}) as {
    token?: unknown;
    index?: unknown;
    url?: unknown;
  };
  const token = typeof body.token === "string" ? body.token : "";
  const index = typeof body.index === "number" ? body.index : -1;
  const url = typeof body.url === "string" ? body.url : "";
  if (!token || !Number.isInteger(index) || !/^https?:\/\//.test(url)) {
    res.status(400).json({ ok: false, reason: "bad_input" });
    return;
  }
  try {
    const ok = await updateSessionSlot(token, index, url);
    res.status(200).json({ ok });
  } catch (err) {
    console.warn(
      "[update-session] failed:",
      err instanceof Error ? err.message : String(err),
    );
    res.status(200).json({ ok: false, reason: "store_error" });
  }
}
