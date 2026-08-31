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
import { updateSessionSlot, revertSessionSlot } from "./lib/sessionStore.js";

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
    previousUrl?: unknown;
    action?: unknown;
  };
  const token = typeof body.token === "string" ? body.token : "";
  const index = typeof body.index === "number" ? body.index : -1;
  const action = typeof body.action === "string" ? body.action : "patch";
  if (!token || !Number.isInteger(index)) {
    res.status(400).json({ ok: false, reason: "bad_input" });
    return;
  }

  // Toggle-revert branch (2026-08-31): the customer tapped the ↶ / ↷ button
  // on a tile. Swap current ↔ previous for that slot in the saved session so
  // the toggle direction survives a resume-link reload.
  if (action === "revert") {
    try {
      const result = await revertSessionSlot(token, index);
      res.status(200).json(result);
    } catch (err) {
      console.warn(
        "[update-session] revert failed:",
        err instanceof Error ? err.message : String(err),
      );
      res.status(200).json({ ok: false, reason: "store_error" });
    }
    return;
  }

  // Default: patch this slot's URL to a new value (existing per-slot regen
  // persistence). Optionally accepts the OLD url so it can be stashed as the
  // undoable "previous" for later toggle. (2026-08-31)
  const url = typeof body.url === "string" ? body.url : "";
  if (!/^https?:\/\//.test(url)) {
    res.status(400).json({ ok: false, reason: "bad_input" });
    return;
  }
  const previousUrl =
    typeof body.previousUrl === "string" && /^https?:\/\//.test(body.previousUrl)
      ? body.previousUrl
      : null;
  try {
    const ok = await updateSessionSlot(token, index, url, previousUrl);
    res.status(200).json({ ok });
  } catch (err) {
    console.warn(
      "[update-session] failed:",
      err instanceof Error ? err.message : String(err),
    );
    res.status(200).json({ ok: false, reason: "store_error" });
  }
}
