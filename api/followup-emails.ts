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
  getEmailResumeToken,
} from "./lib/leadStore.js";
import { getSession } from "./lib/sessionStore.js";

export const maxDuration = 60;

const SITE_URL = "https://generationheadshots.com";

const MIN_AGE_MS =
  Number(process.env.FOLLOWUP_MIN_AGE_HOURS ?? "12") * 60 * 60 * 1000;
const MAX_AGE_MS =
  Number(process.env.FOLLOWUP_MAX_AGE_HOURS ?? "96") * 60 * 60 * 1000;
const MAX_PER_RUN = Number(process.env.FOLLOWUP_MAX_PER_RUN ?? "40");

// Never email ourselves / the team even if we show up as leads.
const INTERNAL_EMAILS = new Set(
  ["kristi@kristinasherk.com", "nic@kristinasherk.com"].map((e) =>
    e.toLowerCase(),
  ),
);

/** Kristi's win-back email — links the customer back to their saved grid.
 *  2026-09-06 rewrite: added subject urgency, 6 thumbnail previews of the
 *  customer's actual shots, a 10%-off pricing card with old/new totals,
 *  a "Kristina's Recommendation" callout for the Versions feature, and a
 *  ?winback=1 flag on the resume URL so checkout knows to apply 10% off. */
function buildEmail(args: {
  resumeUrl: string; // already carries winback=1 + utm params
  generatedUrls: string[]; // up to 6 rendered as thumbnails
}): { subject: string; html: string; text: string } {
  const subject = "Urgent: your headshots expire soon.";

  const thumbs = args.generatedUrls
    .filter((u) => typeof u === "string" && /^https?:\/\//.test(u))
    .slice(0, 6);

  // Thumbnail cell — 3-column grid, each with 2 diagonal watermark bands
  // (per Kristi 2026-09-06: two watermarks per photo, not one).
  const thumbCell = (url: string) => `
    <td style="width:33.33%;padding:4px;vertical-align:top;">
      <div style="position:relative;width:100%;padding-bottom:133%;background:#EFECE3;border-radius:8px;overflow:hidden;">
        <img src="${url}" alt="Your headshot preview" width="160" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;object-position:center 20%;display:block;" />
        <div style="position:absolute;top:35%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:9px;color:rgba(255,255,255,0.55);letter-spacing:1;font-weight:700;white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,0.5);">INVISIBLE WATERMARKS APPLIED</div>
        <div style="position:absolute;top:70%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:9px;color:rgba(255,255,255,0.55);letter-spacing:1;font-weight:700;white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,0.5);">INVISIBLE WATERMARKS APPLIED</div>
      </div>
    </td>`;

  // Split thumbs into rows of 3 for the email table (many email clients
  // don't support CSS grid; table rows are the reliable layout).
  const rows: string[] = [];
  for (let i = 0; i < thumbs.length; i += 3) {
    const cells = thumbs
      .slice(i, i + 3)
      .map(thumbCell)
      .join("");
    // Pad the last row with empty cells so widths stay 33.33% each.
    const padding =
      i + 3 > thumbs.length
        ? '<td style="width:33.33%;padding:4px;"></td>'.repeat(
            3 - (thumbs.length - i),
          )
        : "";
    rows.push(`<tr>${cells}${padding}</tr>`);
  }
  const thumbsTable = thumbs.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:16px 0 22px;border-collapse:separate;">${rows.join("")}</table>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:#FAF8F4;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#2A2A2A;">
  <div style="max-width:540px;margin:0 auto;background:#ffffff;border:1px solid #E8E4DB;border-radius:14px;padding:28px 26px;line-height:1.65;">
    <h1 style="font-size:22px;font-weight:700;color:#7A1F1B;margin:0 0 14px;letter-spacing:-0.2px;">Urgent: your headshots expire soon.</h1>

    <p style="font-size:15px;line-height:1.65;margin:0 0 16px;">Hi there,</p>
    <p style="font-size:15px;line-height:1.65;margin:0 0 16px;">You made these but didn't grab any. They'll be deleted from my servers <strong>soon</strong> — here's one last look:</p>

    ${thumbsTable}

    <!-- 10%-off pricing card -->
    <div style="background:#FBF8F0;border:1px solid #E8E4DB;border-radius:8px;padding:16px 14px;text-align:center;margin:0 0 22px;">
      <div style="display:inline-block;background:#7A1F1B;color:#FFFFFF;font-size:11px;font-weight:700;letter-spacing:1;padding:3px 10px;border-radius:999px;margin-bottom:10px;text-transform:uppercase;">10% off · come back today</div>
      <div style="font-size:15px;color:#2A2A2A;margin:4px 0;">
        Any 1 shot · <span style="text-decoration:line-through;color:#9A968D;margin-right:6px;">$12.99</span> <span style="font-size:20px;font-weight:700;color:#C9A961;letter-spacing:-0.3px;">$11.69</span>
      </div>
      <div style="font-size:15px;color:#2A2A2A;margin:4px 0;">
        Two realistic shots · <span style="text-decoration:line-through;color:#9A968D;margin-right:6px;">$25.98</span> <span style="font-size:20px;font-weight:700;color:#C9A961;letter-spacing:-0.3px;">$23.38</span>
      </div>
    </div>

    <div style="text-align:center;margin:22px 0 6px;">
      <a href="${args.resumeUrl}"
         style="display:inline-block;background:#1B4332;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 30px;border-radius:999px;">
        Pick my favorites &rarr;
      </a>
    </div>

    <p style="font-size:13px;color:#5A5A56;text-align:center;font-style:italic;margin:8px 0 22px;">Most customers who come back on the second look end up buying — you already know what the shots look like.</p>

    <!-- Kristina's Recommendation: Versions feature -->
    <div style="background:#F5F1E8;border:1px solid #E8E4DB;border-left:4px solid #C9A961;border-radius:0 10px 10px 0;padding:16px 18px;margin:22px 0;">
      <div style="font-size:11px;letter-spacing:1.5px;color:#C9A961;font-weight:700;text-transform:uppercase;margin-bottom:8px;">Kristina's recommendation</div>
      <div style="font-size:15px;font-weight:600;color:#2A2A2A;margin-bottom:12px;line-height:1.4;">Was one ALMOST right, but needed a tweak? Try creating versions of it.</div>
      <!-- Diagram: 1 headshot frame → arrows → 2 smaller frames. Pure CSS, no images. -->
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px auto 6px;">
        <tr>
          <td style="padding:0 10px;">
            <div style="width:56px;height:70px;border:2px solid #2A2A2A;border-radius:6px;background:#FFF;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;">
              <div style="width:24px;height:24px;background:#B4B2A9;border-radius:50%;margin-bottom:2px;"></div>
              <div style="width:44px;height:22px;background:#B4B2A9;border-radius:22px 22px 0 0;"></div>
            </div>
          </td>
          <td style="padding:0 6px;vertical-align:middle;">
            <div style="font-size:20px;color:#C9A961;font-weight:700;line-height:1;">&rarr;<br/>&rarr;</div>
          </td>
          <td style="padding:0 10px;">
            <div style="display:flex;flex-direction:column;gap:8px;">
              <div style="width:40px;height:52px;border:2px solid #2A2A2A;border-radius:6px;background:#FFF;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;margin-bottom:8px;">
                <div style="width:18px;height:18px;background:#B4B2A9;border-radius:50%;margin-bottom:2px;"></div>
                <div style="width:32px;height:16px;background:#B4B2A9;border-radius:16px 16px 0 0;"></div>
              </div>
              <div style="width:40px;height:52px;border:2px solid #2A2A2A;border-radius:6px;background:#FFF;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;">
                <div style="width:18px;height:18px;background:#B4B2A9;border-radius:50%;margin-bottom:2px;"></div>
                <div style="width:32px;height:16px;background:#B4B2A9;border-radius:16px 16px 0 0;"></div>
              </div>
            </div>
          </td>
        </tr>
      </table>
      <p style="font-size:14px;color:#3D3D3A;line-height:1.55;margin:0;">Pick a shot you liked and tap <strong>"Love one? Click here to make more variations"</strong> on the grid — one free set of two variations per link. Great when you like a shot but want a wider crop or a different smile.</p>
    </div>

    <p style="font-size:15px;line-height:1.65;margin:0 0 16px;">If none feel like you, that's usually a reference-photo thing — try again with 5+ recent close-up photos. Happy to help troubleshoot, just reply.</p>

    <p style="font-size:15px;line-height:1.65;margin:18px 0 0;">Thanks!<br>Kristina</p>
  </div>
  <p style="max-width:540px;margin:14px auto 0;font-size:12px;color:#9A968D;text-align:center;line-height:1.5;">
    <a href="${SITE_URL}" style="color:#6E6E6A;font-weight:600;">generationheadshots.com</a><br>
    You&rsquo;re getting this because you generated headshots at GenerAItion Headshots. Just reply to this email with any questions &mdash; it comes straight to me.
  </p>
</body></html>`;

  const text = [
    "Urgent: your headshots expire soon.",
    "",
    "You made these but didn't grab any — they'll be deleted from my servers soon.",
    "",
    "10% OFF · come back today:",
    "  Any 1 shot · $12.99 → $11.69",
    "  Two realistic shots · $25.98 → $23.38",
    "",
    "Pick your favorites: " + args.resumeUrl,
    "",
    "KRISTINA'S RECOMMENDATION — Was one ALMOST right, but needed a tweak? Try creating versions of it.",
    "Pick a shot you liked and tap 'Love one? Click here to make more variations' on the grid — one free set of two variations per link.",
    "",
    "If none feel like you, that's usually a reference-photo thing — try again with 5+ recent close-up photos. Happy to help, just reply.",
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
  // Two accepted credentials:
  //   1. CRON_SECRET (Bearer header OR ?key=) — what Vercel Cron sends
  //      automatically every hour for the normal followup run.
  //   2. ADMIN_PASSWORD (?adminpw=) — lets Kristi trigger the reblast from
  //      Terminal without needing the CRON_SECRET value (which is often
  //      locked as a Secret env var and can't be copied). (2026-09-06)
  const cronSecret = process.env.CRON_SECRET;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!cronSecret && !adminPassword) {
    return res
      .status(500)
      .json({ error: "Neither CRON_SECRET nor ADMIN_PASSWORD configured" });
  }
  const headerAuth = req.headers.authorization;
  const queryKey = typeof req.query.key === "string" ? req.query.key : "";
  const queryAdmin = typeof req.query.adminpw === "string" ? req.query.adminpw : "";
  const authorized =
    (!!cronSecret &&
      (headerAuth === `Bearer ${cronSecret}` || queryKey === cronSecret)) ||
    (!!adminPassword && queryAdmin === adminPassword);
  if (!authorized) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "RESEND_API_KEY not configured" });
  }

  const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";
  // Reblast mode (2026-09-06, per Kristi): one-time re-send that ignores the
  // followedUp flag so EVERY eligible lead who tried but didn't buy gets the
  // new email — even if they already got the old one. Use ?reblast=1 in
  // combination with the CRON_SECRET.
  const reblast = req.query.reblast === "1" || req.query.reblast === "true";

  const now = Date.now();
  let leads;
  try {
    leads = await listLeads();
  } catch (err) {
    console.error("[followup] listLeads failed:", err);
    return res.status(500).json({ error: "Failed to load leads" });
  }

  // Cheap synchronous filters first: not purchased, not already emailed, valid
  // address, and inside the 12-96h window. The resume token is resolved AFTER,
  // because some leads need a Redis lookup (the atomic pointer) for it.
  const inWindow = leads.filter((l) => {
    if (l.purchased) return false;
    // In reblast mode, ignore the followedUp flag so every eligible lead
    // who tried but didn't buy gets the new email — even if they already
    // got the old one. (2026-09-06 per Kristi.)
    if (!reblast && l.followedUp) return false;
    if (!looksLikeEmail(l.email)) return false;
    if (INTERNAL_EMAILS.has(l.email.trim().toLowerCase())) return false;
    const seenMs = Date.parse(l.lastSeenAt || l.createdAt);
    if (!Number.isFinite(seenMs)) return false;
    const age = now - seenMs;
    return age >= MIN_AGE_MS && age <= MAX_AGE_MS;
  });

  // Resolve each candidate's resume token: prefer the lead-record field, fall
  // back to the atomic email->token pointer (the reliable source that survives
  // the races which were starving this email). Drop only leads with NEITHER -
  // we genuinely can't link those to a saved grid. (2026-08-15)
  const eligible: Array<(typeof inWindow)[number] & { resolvedToken: string }> =
    [];
  for (const l of inWindow) {
    const token =
      (typeof l.resumeToken === "string" && l.resumeToken) ||
      (await getEmailResumeToken(l.email));
    if (token) eligible.push({ ...l, resolvedToken: token });
  }

  if (dryRun) {
    return res.status(200).json({
      dryRun: true,
      eligibleCount: eligible.length,
      eligibleEmails: eligible.map((l) => l.email),
      note: `Would email these on a real run (min ${MIN_AGE_MS / 3.6e6}h / max ${
        MAX_AGE_MS / 3.6e6
      }h since last generation).`,
    });
  }

  const batch = eligible.slice(0, MAX_PER_RUN);
  let sent = 0;
  let failed = 0;
  let skippedExpired = 0;
  const errors: string[] = [];

  for (const lead of batch) {
    const token = lead.resolvedToken;
    let sessionGeneratedUrls: string[] = [];
    try {
      const session = await getSession(token);
      if (!session) {
        skippedExpired++;
        continue;
      }
      // Snapshot the customer's actual shot URLs for the thumbnail preview
      // in the email (2026-09-06). Up to 6 rendered inline as a 2×3 grid.
      sessionGeneratedUrls = Array.isArray(session.generatedUrls)
        ? session.generatedUrls
        : [];
    } catch {
      skippedExpired++;
      continue;
    }
    // UTM tags: a client CLICK shows in GA4/Clarity as email/email,
    // campaign winback. Unique per client, so a click = that client came
    // back from the win-back email (2026-08-06).
    // ?winback=1 (2026-09-06) triggers the 10% discount at checkout — the
    // client detects it on mount, stashes in localStorage, and forwards to
    // /api/create-photo-checkout-session which applies -10% to every photo.
    const resumeUrl = `${SITE_URL}/?resume=${token}&winback=1&utm_source=email&utm_medium=email&utm_campaign=winback`;

    try {
      const { subject, html, text } = buildEmail({
        resumeUrl,
        generatedUrls: sessionGeneratedUrls,
      });
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
