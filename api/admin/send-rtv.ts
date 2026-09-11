/**
 * POST /api/admin/send-rtv  (2026-09-11)
 *
 * Manually send a "ready to view" email to a customer whose client
 * dropped mid-batch so save-session + session-ready-email never fired
 * (Brian-style case: /api/generate succeeded server-side, no session
 * record exists in Redis, no RTV email went out). Given an email + a
 * batchId, this endpoint:
 *   1. Pulls the shots out of /api/recover-batch's underlying store
 *   2. Creates a session record with those shots (so the resume link
 *      opens the customer's actual grid)
 *   3. Fires the same RTV email the client would have fired
 *
 * Auth: ADMIN_PASSWORD (via ?pw= or Authorization: Bearer).
 *
 * Both GET and POST are supported — GET so it can be triggered from a
 * browser tab in a pinch.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { saveSession } from "../lib/sessionStore.js";
import {
  looksLikeEmail,
  setLeadResumeToken,
  setEmailResumeToken,
} from "../lib/leadStore.js";
import { getBatch } from "../lib/batchStore.js";

export const maxDuration = 20;

const SITE_URL = "https://generationheadshots.com";

function buildEmail(resumeUrl: string): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = "Your headshots are ready to view 🎉";
  const intro =
    "Your headshots just finished generating and are ready to view! Come back to see them and pick your favorites — you only pay for the ones you actually love, and nothing is charged until you download.";
  const nudge =
    "Sessions don't stay open forever, so it's best to grab the ones you like now while they're fresh.";
  const feedback =
    "One last thing — I'm just one person building this, so your feedback means the world to me. Good or bad (honestly, the bad helps me the most!), pretty pretty please hit reply and tell me what you thought. Every note comes straight to me.";
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:#FAF8F4;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#2A2A2A;">
  <div style="max-width:540px;margin:0 auto;background:#ffffff;border:1px solid #E8E4DB;border-radius:14px;padding:28px 26px;">
    <h1 style="font-size:22px;margin:0 0 14px;color:#1B4332;">Your headshots are ready to view 🎉</h1>
    <p style="font-size:15px;line-height:1.65;margin:0 0 16px;">${intro}</p>
    <p style="font-size:15px;line-height:1.65;margin:0 0 4px;">${nudge}</p>
    <div style="text-align:center;margin:22px 0 6px;">
      <a href="${resumeUrl}"
         style="display:inline-block;background:#1B4332;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:13px 26px;border-radius:999px;">
        Pick my headshots &rarr;
      </a>
    </div>
    <p style="font-size:14px;line-height:1.65;margin:22px 0 0;color:#5A5A56;">${feedback}</p>
    <p style="font-size:15px;line-height:1.65;margin:16px 0 0;">Thanks!<br>Kristina</p>
  </div>
  <p style="max-width:540px;margin:14px auto 0;font-size:12px;color:#9A968D;text-align:center;line-height:1.5;">
    <a href="${SITE_URL}" style="color:#6E6E6A;font-weight:600;">generationheadshots.com</a>
  </p>
</body></html>`;
  const text = [
    "Your headshots are ready to view!",
    "",
    intro,
    "",
    nudge,
    "",
    `Pick your headshots: ${resumeUrl}`,
    "",
    feedback,
    "",
    "Kristina",
  ].join("\n");
  return { subject, html, text };
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  const expected = process.env.ADMIN_PASSWORD ?? "";
  if (!expected) {
    res.status(500).json({ ok: false, error: "admin password not configured" });
    return;
  }
  const pwFromQuery =
    typeof req.query.pw === "string" ? req.query.pw : "";
  const auth = req.headers.authorization ?? "";
  const pwFromHeader = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if ((pwFromQuery || pwFromHeader) !== expected) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  const emailRaw =
    typeof req.query.email === "string"
      ? req.query.email
      : typeof (req.body as { email?: string })?.email === "string"
      ? ((req.body as { email?: string }).email as string)
      : "";
  const email = emailRaw.trim();
  if (!looksLikeEmail(email)) {
    res.status(400).json({ ok: false, error: "invalid email" });
    return;
  }
  const batchId =
    typeof req.query.batchId === "string"
      ? req.query.batchId.trim()
      : typeof (req.body as { batchId?: string })?.batchId === "string"
      ? ((req.body as { batchId?: string }).batchId as string).trim()
      : "";
  if (!batchId) {
    res.status(400).json({ ok: false, error: "missing batchId" });
    return;
  }

  // Pull the shots from the batch store — the same store /api/recover-batch
  // reads from. This is the SOURCE OF TRUTH for shots the server generated
  // even when the client dropped its responses.
  const batch = await getBatch(batchId);
  if (!batch || !Array.isArray(batch.images) || batch.images.length === 0) {
    res.status(404).json({ ok: false, error: "batch not found or empty" });
    return;
  }
  const generatedUrls = batch.images
    .map((im: { url: string }) => im.url)
    .filter((u: string): u is string => typeof u === "string" && !!u);
  const referencePhotoUrls: string[] = Array.isArray(batch.referencePhotoUrls)
    ? (batch.referencePhotoUrls as string[])
    : [];

  // Create the session record so /?resume=<token> restores the grid.
  const token = await saveSession({
    email,
    generatedUrls,
    referencePhotoUrls,
    selections: batch.selections ?? null,
    hasWideAngle: batch.hasWideAngle === true,
  });
  try {
    await Promise.all([
      setLeadResumeToken(email, token),
      setEmailResumeToken(email, token),
    ]);
  } catch {
    /* non-fatal */
  }

  const resumeUrl = `${SITE_URL}/?resume=${token}&utm_source=email&utm_medium=email&utm_campaign=session_ready_manual`;

  // Fire the email via Resend.
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    res
      .status(200)
      .json({ ok: false, error: "no resend key configured", token, resumeUrl });
    return;
  }
  const { subject, html, text } = buildEmail(resumeUrl);
  let sendOk = false;
  let sendStatus: number | null = null;
  let sendBody = "";
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Kristi at GenerAItion Headshots <kristi@kristinasherk.com>",
        to: [email],
        reply_to: "kristi@kristinasherk.com",
        bcc: ["kristi@kristinasherk.com"],
        subject,
        html,
        text,
      }),
    });
    sendOk = resp.ok;
    sendStatus = resp.status;
    if (!resp.ok) sendBody = (await resp.text().catch(() => "")).slice(0, 400);
  } catch (err) {
    sendBody = err instanceof Error ? err.message : String(err);
  }

  res.status(200).json({
    ok: sendOk,
    email,
    batchId,
    token,
    resumeUrl,
    shotsCount: generatedUrls.length,
    resend: { ok: sendOk, status: sendStatus, body: sendBody },
  });
}
