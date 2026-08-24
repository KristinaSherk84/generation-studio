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
import { saveSession, getSession, replaceSession } from "./lib/sessionStore.js";
import {
  looksLikeEmail,
  setLeadResumeToken,
  setEmailResumeToken,
  getEmailResumeToken,
} from "./lib/leadStore.js";

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
    const payload = {
      email,
      generatedUrls: body.generatedUrls as string[],
      referencePhotoUrls,
      selections: body.selections ?? null,
      hasWideAngle: body.hasWideAngle === true,
    };
    // One resume link per email that ACCUMULATES every batch (2026-08-24).
    // If this email already has a LIVE saved session, APPEND this batch's shots
    // to it (keeping the SAME token) instead of overwriting — so a customer who
    // generates more than one batch keeps ALL their shots on one growing link,
    // not just the latest six. `offset` is where THIS batch's shots start in the
    // merged grid; the client uses it so a later per-slot regen patches the
    // right photo. Wild cards from earlier batches are carried forward here
    // (replaceSession would otherwise wipe them) and merged again when this
    // batch's own wild cards land via /api/session-wildcards.
    //
    // Supersedes the 2026-08-17 "overwrite in place" behavior, which fixed a
    // divergent-snapshot bug (two emails, two grids, wild cards on only one) by
    // collapsing to the latest batch — but that erased a paying customer's
    // earlier batches. Accumulating keeps ONE token (so no divergence) AND all
    // the shots.
    let token: string | null = null;
    let offset = 0;
    try {
      const existing = await getEmailResumeToken(email);
      const prior = existing ? await getSession(existing) : null;
      if (existing && prior) {
        const priorUrls = Array.isArray(prior.generatedUrls)
          ? prior.generatedUrls
          : [];
        const priorSet = new Set(priorUrls);
        // Batch blob keys are unique, so normally nothing is filtered; the
        // dedupe only guards against an accidental double-save of one batch.
        const appended = (payload.generatedUrls as string[]).filter(
          (u) => !priorSet.has(u),
        );
        offset = priorUrls.length;
        const mergedRefs = Array.from(
          new Set([...(prior.referencePhotoUrls ?? []), ...referencePhotoUrls]),
        );
        const ok = await replaceSession(existing, {
          email,
          generatedUrls: [...priorUrls, ...appended],
          referencePhotoUrls: mergedRefs,
          selections: payload.selections ?? prior.selections ?? null,
          hasWideAngle: payload.hasWideAngle || prior.hasWideAngle === true,
          wildCards: prior.wildCards,
        });
        if (ok) token = existing;
      }
    } catch {
      /* fall through to a fresh save below */
    }
    if (!token) {
      offset = 0;
      token = await saveSession(payload);
    }
    // Link this session's resume token to the lead so the 12-hour win-back
    // email can point the customer straight back to their saved grid. MUST be
    // awaited: a fire-and-forget write here gets killed when Vercel suspends
    // the function right after the response, which left many leads with a live
    // saved grid but no lead.resumeToken — so the win-back could never find
    // them. Awaited + best-effort (a lead-write error still returns the token
    // so the ready-email link works). (fixed 2026-08-08)
    try {
      // Two writes, on purpose: the lead-record field (nice for the admin page)
      // AND the atomic email->token pointer (the reliable source the win-back
      // reads - immune to the lead not existing yet or a clobbering race that
      // was silently losing the token and starving the expiry email). 2026-08-15
      await Promise.all([
        setLeadResumeToken(email, token),
        setEmailResumeToken(email, token),
      ]);
    } catch {
      /* don't fail the save if a lead write hiccups */
    }
    res.status(200).json({ ok: true, token, offset });
  } catch (err) {
    console.warn(
      "[save-session] failed:",
      err instanceof Error ? err.message : String(err),
    );
    res.status(200).json({ ok: false, reason: "store_error" });
  }
}
