/**
 * POST /api/admin/salvage-session  (2026-09-09)
 *
 * Backfill a customer's session with orphan regeneration shots recovered
 * from Vercel Blob storage. Solves the "customer regenerated the same slot
 * 30 times, previousUrls only kept the last one, other 28 lost from
 * state" problem — the blobs are still in Vercel Blob, we just weren't
 * remembering them in the session record.
 *
 * The scanner works on time-window + filename-pattern matching:
 *   1. Load the target session, note its createdAt
 *   2. List ALL `session/` prefix blobs (Vercel Blob has no server-side
 *      time filter, so we paginate through everything)
 *   3. Keep blobs uploaded within [createdAt - 30min, createdAt + windowHours]
 *   4. Keep filenames matching the regen pattern `regen-`
 *   5. Dedupe against everything already in the session record
 *
 * Time-window overlap: if two customers regenerated simultaneously their
 * blobs will overlap. This is a best-effort recovery tool for support
 * cases (Lawrence-style), not a bulletproof attribution. Kristi should
 * review the returned URLs before applying.
 *
 * Auth: ADMIN_PASSWORD (via ?pw=… or Authorization: Bearer …).
 *
 * Modes:
 *   GET / no body       → dry-run, returns candidates (no writes)
 *   POST with apply=1   → dry-run scan, then appends candidates to
 *                         allGeneratedUrls on the session record
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { list } from "@vercel/blob";
import { getSession, appendSessionAllUrls } from "../lib/sessionStore.js";

export const maxDuration = 60;

function unauthorized(res: VercelResponse) {
  res.status(401).json({ ok: false, error: "unauthorized" });
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  // --- auth ---
  const expected = process.env.ADMIN_PASSWORD ?? "";
  if (!expected) {
    res.status(500).json({ ok: false, error: "admin password not configured" });
    return;
  }
  const pwFromQuery =
    typeof req.query.pw === "string" ? req.query.pw : "";
  const auth = req.headers.authorization ?? "";
  const pwFromHeader = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const provided = pwFromQuery || pwFromHeader;
  if (provided !== expected) return unauthorized(res);

  // --- inputs ---
  const q = req.query;
  const b = (req.body ?? {}) as {
    token?: unknown;
    windowHours?: unknown;
    apply?: unknown;
    prefix?: unknown;
  };
  const token =
    typeof q.token === "string"
      ? q.token
      : typeof b.token === "string"
      ? b.token
      : "";
  if (!token || !/^[A-Za-z0-9]{16,48}$/.test(token)) {
    res.status(400).json({ ok: false, error: "missing or bad token" });
    return;
  }
  const windowHours = Math.max(
    1,
    Math.min(
      48,
      Number(
        typeof q.windowHours === "string"
          ? q.windowHours
          : typeof b.windowHours === "number"
          ? b.windowHours
          : 12,
      ) || 12,
    ),
  );
  const prefix =
    typeof q.prefix === "string" && q.prefix.length > 0
      ? q.prefix
      : typeof b.prefix === "string" && b.prefix.length > 0
      ? b.prefix
      : "session/";
  const applyFlag =
    (typeof q.apply === "string" && (q.apply === "1" || q.apply === "true")) ||
    b.apply === true ||
    b.apply === "1";

  // --- load session ---
  const session = await getSession(token);
  if (!session) {
    res.status(404).json({ ok: false, error: "session not found" });
    return;
  }
  const createdAt = new Date(session.createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    res.status(500).json({ ok: false, error: "session createdAt invalid" });
    return;
  }
  const windowStart = new Date(createdAt.getTime() - 30 * 60 * 1000); // 30 min pre-buffer
  const windowEnd = new Date(
    createdAt.getTime() + windowHours * 60 * 60 * 1000,
  );

  // --- known URLs (dedupe target) ---
  const known = new Set<string>();
  for (const u of session.generatedUrls ?? []) known.add(u);
  for (const u of session.previousUrls ?? []) if (u) known.add(u);
  for (const w of session.wildCards ?? []) known.add(w.url);
  for (const u of session.versionShots ?? []) known.add(u);
  for (const u of session.allGeneratedUrls ?? []) known.add(u);

  // --- scan Vercel Blob ---
  const candidates: {
    url: string;
    pathname: string;
    uploadedAt: string;
    size: number;
  }[] = [];
  let cursor: string | undefined;
  let scanned = 0;
  const scanStart = Date.now();
  const SCAN_TIME_BUDGET_MS = 50_000; // leave head room under maxDuration:60
  do {
    if (Date.now() - scanStart > SCAN_TIME_BUDGET_MS) break;
    const page: {
      blobs: Array<{
        url: string;
        pathname: string;
        size: number;
        uploadedAt: Date;
      }>;
      cursor?: string;
    } = await list({ prefix, cursor, limit: 1000 });
    for (const blob of page.blobs) {
      scanned += 1;
      const t = blob.uploadedAt.getTime();
      if (t < windowStart.getTime() || t > windowEnd.getTime()) continue;
      // Only files that look like regenerations (skip reference uploads
      // etc.). Regen blob keys always contain "regen-" in the filename.
      if (!/regen-/i.test(blob.pathname)) continue;
      if (known.has(blob.url)) continue;
      candidates.push({
        url: blob.url,
        pathname: blob.pathname,
        uploadedAt: blob.uploadedAt.toISOString(),
        size: blob.size,
      });
    }
    cursor = page.cursor;
  } while (cursor);

  // Sort chronologically so the "story" reads in order.
  candidates.sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));

  // --- optional apply ---
  let applied = false;
  if (applyFlag && candidates.length > 0) {
    try {
      applied = await appendSessionAllUrls(
        token,
        candidates.map((c) => c.url),
      );
    } catch {
      applied = false;
    }
  }

  res.status(200).json({
    ok: true,
    token,
    session: {
      createdAt: session.createdAt,
      email: session.email,
      generatedUrlCount: (session.generatedUrls ?? []).length,
      previousUrlCount: (session.previousUrls ?? []).filter(Boolean).length,
      wildCardCount: (session.wildCards ?? []).length,
      versionShotCount: (session.versionShots ?? []).length,
      allGeneratedUrlCount: (session.allGeneratedUrls ?? []).length,
    },
    scan: {
      prefix,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      windowHours,
      blobsScanned: scanned,
      candidatesFound: candidates.length,
    },
    apply: applyFlag ? { requested: true, ok: applied } : { requested: false },
    candidates,
  });
}
