/**
 * GET /api/followup-emails  — win-back automation (2026-08-01)
 *
 * Runs on a Vercel Cron (hourly). For every lead who GENERATED but did NOT
 * purchase, ~12 hours after their last generation, sends Kristi's personal
 * feedback-request email with a UNIQUE, single-use, unlimited promo code so
 * they can generate again for free. Marks the lead followedUp so nobody is
 * emailed twice.
 *
 * Eligibility (all must hold):
 *   - not purchased
 *   - not already followed up
 *   - last generated ≥ FOLLOWUP_MIN_AGE_HOURS ago (default 12h) — gives them
 *     time to come back on their own before we nudge
 *   - last generated ≤ FOLLOWUP_MAX_AGE_DAYS ago (default 7d) — a backlog
 *     guard so the first run doesn't blast ancient leads; stale leads are
 *     skipped permanently, not chased
 *   - not one of our own internal addresses
 *
 * Per run we cap sends at MAX_PER_RUN so a big eligible batch can't blow the
 * function timeout; the remainder are picked up on the next hourly run.
 *
 * Auth: same pattern as /api/quota-report — Vercel Cron sends
 * `Authorization: Bearer ${CRON_SECRET}`; manual runs can pass ?key=SECRET.
 * If CRON_SECRET is unset the endpoint refuses everything (fail closed).
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
import { createCode, generateCode } from "./lib/promoStore.js";

export const maxDuration = 60;

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

/** Kristi's win-back email, with the customer's unique code baked in. */
function buildEmail(code: string): { subject: string; html: string; text: string } {
  const shown = code.toUpperCase();
  const subject = "Can I get your feedback? (+ a code to try again, on me)";

  const paragraphs = [
    "Looks like you tested my headshot generating app, but didn't see any shots that you liked. Because this company is only me, and I am new at this headshot generating pivot, your feedback (even if it's negative) is of the utmost importance to me! All feedback that will help me make my app better is like gold to me at this point.",
    "Can you please let me know what you didn't like about the experience?",
    "If you'd like to try again, here is a code you can input to generate more headshots on me! I'll pay for you to try it out once more in hopes you find something you like.",
  ];

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
    <div style="margin:24px 0;padding:18px;text-align:center;background:#F3EEE4;border-radius:10px;">
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6E6E6A;margin-bottom:6px;">Your code</div>
      <div style="font-size:26px;font-weight:700;letter-spacing:.05em;color:#1B4332;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${shown}</div>
    </div>
    <p style="font-size:14px;line-height:1.6;margin:0 0 4px;">
      Enter it under &ldquo;Have a promo code?&rdquo; on the home page and
      generate as many as you like &mdash; it&rsquo;s on me.
    </p>
    <div style="text-align:center;margin:22px 0 6px;">
      <a href="https://generationheadshots.com"
         style="display:inline-block;background:#1B4332;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:13px 26px;border-radius:999px;">
        Generate my headshots &rarr;
      </a>
    </div>
    <p style="font-size:15px;line-height:1.65;margin:22px 0 0;">Thanks!<br>Kristina</p>
  </div>
  <p style="max-width:540px;margin:14px auto 0;font-size:12px;color:#9A968D;text-align:center;line-height:1.5;">
    <a href="https://generationheadshots.com" style="color:#6E6E6A;font-weight:600;">generationheadshots.com</a><br>
    You&rsquo;re getting this because you generated headshots at GenerAItion Headshots. Just reply to this email with your thoughts &mdash; it comes straight to me.
  </p>
</body></html>`;

  const text = [
    ...paragraphs,
    "",
    `CODE: ${shown}`,
    "",
    "Enter it under “Have a promo code?” on https://generationheadshots.com and generate as many as you like — it's on me.",
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

  // Optional dry run: ?dryRun=1 reports who WOULD be emailed without minting
  // codes or sending anything. Handy for a safe first look at the backlog.
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
  const errors: string[] = [];

  for (const lead of batch) {
    // Mint a unique unlimited code for this lead. Retry once on the vanishingly
    // rare collision; skip the lead (retry next run) if minting fails.
    let code: string | null = null;
    for (let attempt = 0; attempt < 2 && !code; attempt++) {
      const candidate = generateCode();
      try {
        await createCode({
          code: candidate,
          createdBy: "followup-cron",
          notes: `win-back followup: ${lead.email}`,
          // Generation-only: they can generate again free, but still pay to
          // download the ones they like (Kristi's call, 2026-08-01).
          kind: "generation",
        });
        code = candidate;
      } catch {
        // collision or KV hiccup — try once more, else give up this lead
      }
    }
    if (!code) {
      failed++;
      errors.push(`${lead.email}: could not mint code`);
      continue;
    }

    try {
      const { subject, html, text } = buildEmail(code);
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Kristi at GenerAItion Headshots <kristi@kristinasherk.com>",
          to: [lead.email],
          // BCC Kristi on every abandonment / win-back email so she has a
          // running record of who was contacted and with which code, without
          // the customer seeing it (2026-08-01).
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
        // Leave followedUp false so this lead is retried next run.
        continue;
      }
      // Only now — after a successful send — mark it so we never double-send.
      await markLeadFollowedUp(lead.email, code);
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
      remaining: Math.max(0, eligible.length - batch.length),
    }),
  );

  return res.status(200).json({
    eligible: eligible.length,
    attempted: batch.length,
    sent,
    failed,
    remaining: Math.max(0, eligible.length - batch.length),
    errors: errors.slice(0, 20),
  });
}
