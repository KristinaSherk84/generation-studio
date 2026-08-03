/**
 * POST /api/session-ready-email  (2026-08-03)
 *
 * Fired by the client the moment a customer's initial 6-headshot batch
 * finishes generating. Emails them "your headshots are ready" with a link
 * back to the site — Clarity recordings show people kick off a generation,
 * wander off during the 2–3 minute wait, forget, and never come back. This
 * is the nudge that brings them back to pick + buy.
 *
 * Body: { email: string }
 * Best-effort: any failure returns { ok: false } and never blocks the UI.
 * De-duplication is handled client-side (a localStorage flag) so a given
 * browser only triggers one send per finished batch.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { looksLikeEmail } from "./lib/leadStore.js";

export const maxDuration = 10;

const SITE_URL = "https://generationheadshots.com";

function buildEmail(resumeUrl: string): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = "Your 6 headshots are ready to view 🎉";
  const intro =
    "Your headshots just finished generating and are ready to view! Come back to see them and pick your favorites — you only pay for the ones you actually love, and nothing is charged until you download.";
  const nudge =
    "Sessions don't stay open forever, so it's best to grab the ones you like now while they're fresh.";

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
    <p style="font-size:15px;line-height:1.65;margin:22px 0 0;">Thanks!<br>Kristina</p>
  </div>
  <p style="max-width:540px;margin:14px auto 0;font-size:12px;color:#9A968D;text-align:center;line-height:1.5;">
    <a href="${SITE_URL}" style="color:#6E6E6A;font-weight:600;">generationheadshots.com</a><br>
    You're getting this because you generated headshots at GenerAItion Headshots.
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
    "Thanks!",
    "Kristina",
  ].join("\n");

  return { subject, html, text };
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, reason: "method_not_allowed" });
    return;
  }

  const body = (req.body ?? {}) as { email?: unknown; resumeToken?: unknown };
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!looksLikeEmail(email)) {
    res.status(400).json({ ok: false, reason: "invalid_email" });
    return;
  }
  // If the client saved the finished grid, link straight back to it; otherwise
  // fall back to the site so the email still works.
  const resumeToken =
    typeof body.resumeToken === "string" &&
    /^[A-Za-z0-9]{16,48}$/.test(body.resumeToken)
      ? body.resumeToken
      : "";
  const resumeUrl = resumeToken
    ? `${SITE_URL}/?resume=${resumeToken}`
    : SITE_URL;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    res.status(200).json({ ok: false, reason: "no_resend_key" });
    return;
  }

  try {
    const { subject, html, text } = buildEmail(resumeUrl);
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
        // BCC Kristi on every "headshots are ready to view" email so she
        // gets a copy of exactly what each customer receives. Per Kristi
        // 2026-08-03.
        bcc: ["kristi@kristinasherk.com"],
        subject,
        html,
        text,
      }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      console.warn("[ready-email] resend failed:", resp.status, t.slice(0, 120));
      res.status(200).json({ ok: false, reason: "send_failed" });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.warn(
      "[ready-email] error:",
      err instanceof Error ? err.message : String(err),
    );
    res.status(200).json({ ok: false, reason: "error" });
  }
}
