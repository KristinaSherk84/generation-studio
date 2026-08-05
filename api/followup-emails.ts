/**
 * GET /api/followup-emails  — win-back automation (2026-08-01, rewritten 2026-08-05)
 *
 * Runs on a Vercel Cron (hourly). For every lead who GENERATED but did NOT
 * purchase, ~12 hours after their last generation, sends Kristi's "your
 * headshots are about to expire" email with a link back to their SAVED grid
 * (?resume=token) so they can preview their shots one last time and regenerate
 * up to 2 more. Marks the lead followedUp so nobody is emailed twice.
 *
 * Eligibility (all must hold):
 *   - not purchased
 *   - not already followed up
 *   - last generated >= FOLLOWUP_MIN_AGE_HOURS ago (default 12h)
 *   - last generated <= FOLLOWUP_MAX_AGE_DAYS ago (default 7d)
 *   - has a saved-session resume token (so we can link them to their grid)
 *   - not one of our own internal addresses
 * ...and, per lead at send time, the saved session must still exist (else the
 * preview link would 404 — those are skipped rather than emailed a dead link).
 *
 * Per run we cap sends at MAX_PER_RUN so a big eligible batch can't blow the
 * function timeout; the remainder are picked up on the next hourly run.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`; manual runs
 * can pass ?key=SECRET. If CRON_SECRET is unset the endpoint refuses everything.
 *
 * Idempotency: the lead is marked followedUp ONLY after Resend accepts the
 * send, so a transient email failure retries next hour instead of silently
 * dropping the customer.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  listLeads,
  markLeadFollowedUp,
  looksLikeEmail,
} from "./lib/leadStore.js";
import { getSession } from "./lib/sessionStore.js";

export const maxDuration = 60;

const SITE_URL = "https://generationheadshots.com";

const MIN_AGE_MS =
  Number(process.env.FOLLOWUP_MIN_AGE_HOURS ?? "12") * 60 * 60 * 1000;
const MAX_AGE_MS =
  Number(process.env.FOLLOWUP_MAX_AGE_DAYS ?? "7") * 24 * 60 * 60 * 1000;
const MAX_PER_RUN = Number(process.env.FOLLOWUP_MAX_PER_RUN ?? "40");

// Never email ourselves / the team even if we show up as leads.
const INTERNAL_EMAILS = new Set(
  ["kristi@kristinasherk.com", "nic@kristinasherk.com"].map((e) =>
    e.toLowerCase(),
  ),
);

/** Kristi's win-back email — links the customer back to their saved grid. */
function buildEmail(resumeUrl: string): { subject: string; html: string; text: string } {
  const subject = "Your generated headshots are about to expire";

  const paragraphs = [
    "Hello! Earlier today you tried generating some amazing headshots, but left before purchasing. I wanted to let you know those headshots are about to be deleted from our servers — I don't keep images people don't buy.",
    "Here's your last link to preview the shots we made earlier. If you feel one doesn't look like you, you can regenerate two more headshots to see if that gives you a better result. And if it was the style itself that didn't feel right, head back and try a completely different look — there are several styles to choose from.",
    "If you didn't feel like ANY of them looked like you, this is almost always a reference-photo issue — the photos may not have been high enough resolution, weren't cropped in tight enough, or didn't have enough variety.",
  ];
  const closing =
    "And even if you don't buy, thank you for trying it! This app is very new, and I'm still learning.";

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:#FAF8F4;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#2A2A2A;">
  <div style="max-width:540px;margin:0 auto;background:#ffffff;border:1px solid #E8E4DB;border-radius:14px;padding:28px 26px;">
    ${paragraphs
      .map(
        (p) =>
          `<p style="font-size:15px;line-height:1.65;margin:0 0 16px;">${p}</p>`,
      )
      .join("\n    ")}
    <div style="text-align:center;margin:24px 0 8px;">
      <a href="${resumeUrl}"
         style="display:inline-block;background:#1B4332;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:13px 28px;border-radius:999px;">
        Preview my headshots &rarr;
      </a>
    </div>
    <p style="font-size:13px;line-height:1.6;margin:6px 0 18px;text-align:center;color:#6E6E6A;">
      Here&rsquo;s the link to access your headshots one last time.
    </p>
    <p style="font-size:15px;line-height:1.65;margin:0;">${closing}</p>
    <p style="font-size:15px;line-height:1.65;margin:18px 0 0;">Thanks!<br>Kristina</p>
  </div>
  <p style="max-width:540px;margin:14px auto 0;font-size:12px;color:#9A968D;text-align:center;line-height:1.5;">
    <a href="${SITE_URL}" style="color:#6E6E6A;font-weight:600;">generationheadshots.com</a><br>
    You&rsquo;re getting this because you generated headshots at GenerAItion Headshots. Just reply to this email with any questions &mdash; it comes straight to me.
  </p>
</body></html>`;

  const text = [
    ...paragraphs,
    "",
    "Preview your headshots (last chance): " + resumeUrl,
    "",
    closing,
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
  // ---- Auth (fail closed) ----
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res
      .status(500)
      .json({ error: "CRON_SECRET env var not configured" });
  }
  const headerAuth = req.headers.authorization;
  const queryKey = typeof req.query.key === "string" ? req.query.key : "";
  const authorized =
    headerAuth === `Bearer ${cronSecret}` || queryKey === cronSecret;
  if (!authorized) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "RESEND_API_KEY not configured" });
  }

  const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";

  const now = Date.now();
  let leads;
  try {
    leads = await listLeads();
  } catch (err) {
    console.error("[followup] listLeads failed:", err);
    return res.status(500).json({ error: "Failed to load leads" });
  }

  const eligible = leads.filter((l) => {
    if (l.purchased) return false;
    if (l.followedUp) return false;
    if (!looksLikeEmail(l.email)) return false;
    if (INTERNAL_EMAILS.has(l.email.trim().toLowerCase())) return false;
    if (!l.resumeToken) return false;
    const seenMs = Date.parse(l.lastSeenAt || l.createdAt);
    if (!Number.isFinite(seenMs)) return false;
    const age = now - seenMs;
    return age >= MIN_AGE_MS && age <= MAX_AGE_MS;
  });

  if (dryRun) {
    return res.status(200).json({
      dryRun: true,
      eligibleCount: eligible.length,
      eligibleEmails: eligible.map((l) => l.email),
      note: `Would email these on a real run (min ${MIN_AGE_MS / 3.6e6}h / max ${
        MAX_AGE_MS / 8.64e7
      }d since last generation).`,
    });
  }

  const batch = eligible.slice(0, MAX_PER_RUN);
  let sent = 0;
  let failed = 0;
  let skippedExpired = 0;
  const errors: string[] = [];

  for (const lead of batch) {
    const token = lead.resumeToken as string;
    try {
      const session = await getSession(token);
      if (!session) {
        skippedExpired++;
        continue;
      }
    } catch {
      skippedExpired++;
      continue;
    }
    const resumeUrl = `${SITE_URL}/?resume=${token}`;

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
          to: [lead.email],
          bcc: ["kristi@kristinasherk.com"],
          reply_to: "kristi@kristinasherk.com",
          subject,
          html,
          text,
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        failed++;
        errors.push(`${lead.email}: resend ${resp.status} ${body.slice(0, 120)}`);
        continue;
      }
      await markLeadFollowedUp(lead.email, "");
      sent++;
    } catch (err) {
      failed++;
      errors.push(
        `${lead.email}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(
    JSON.stringify({
      type: "followup_run",
      eligible: eligible.length,
      attempted: batch.length,
      sent,
      failed,
      skippedExpired,
      remaining: Math.max(0, eligible.length - batch.length),
    }),
  );

  return res.status(200).json({
    eligible: eligible.length,
    attempted: batch.length,
    sent,
    failed,
    skippedExpired,
    remaining: Math.max(0, eligible.length - batch.length),
    errors: errors.slice(0, 20),
  });
}
