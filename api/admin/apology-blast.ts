/**
 * GET /api/admin/apology-blast?pw=YOUR_ADMIN_PASSWORD&mode=X
 *
 * One-shot "sorry about the glitches, please come back" email to every lead
 * who generated but never purchased. Same ADMIN_PASSWORD as the other admin
 * endpoints. Kristi-authored copy is baked in below — edit BODY_PARAGRAPHS to
 * change it. (Added 2026-08-26.)
 *
 * Modes (choose one, all password-gated):
 *   ?mode=preview   → returns the rendered HTML in the browser so you can
 *                     eyeball it. No sending.
 *   ?mode=list      → returns the list of non-buyer emails that WOULD be sent
 *                     (JSON). No sending.
 *   ?mode=test      → sends ONE copy to TEST_ADDRESS (kristi@kristinasherk.com)
 *                     and stops. Nobody else gets it.
 *   ?mode=send      → the real thing — sends to every non-buyer in the leads
 *                     store. Idempotency guard: this endpoint refuses to run a
 *                     real send twice unless you also pass ?force=1, so an
 *                     accidental reload doesn't blast the list a second time.
 *
 * Notes:
 * - Sender + reply-to = kristi@kristinasherk.com (same as follow-up sender).
 * - Every real send is BCC'd to kristi@kristinasherk.com for a paper trail.
 * - Skips internal addresses (kristi@ / nic@).
 * - Skips leads with a bad-looking email string.
 * - Sends serially with a tiny delay to stay well under Resend's rate limits;
 *   the whole run is bounded by maxDuration.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { listLeads, looksLikeEmail } from "../lib/leadStore.js";
import { Redis } from "@upstash/redis";

export const maxDuration = 60;

const TEST_ADDRESS = "kristi@kristinasherk.com";
const SITE_URL = "https://generationheadshots.com";
const INTERNAL_EMAILS = new Set(
  ["kristi@kristinasherk.com", "nic@kristinasherk.com"].map((e) =>
    e.toLowerCase(),
  ),
);

const SUBJECT = "A note from the photographer behind the app 💛";

// Kristi's copy — edit here if you want to change the message.
const BODY_PARAGRAPHS: string[] = [
  "Hey!",
  "First off, thank you for trying out my new app. As a solo photographer transitioning to AI headshots, it means the world to me that you would support me like that.",
  "Because it's new, I know there were some glitches and completely understand if you got frustrated and abandoned your session.",
  "A few notes on feedback I've heard:",
];

// Rendered as bolded lead-in + body per bullet.
const BODY_BULLETS: Array<{ lead: string; body: string }> = [
  {
    lead: "Outfits:",
    body: "not everyone likes the clothing generated. Choosing \"Keep my outfit\" will generate your headshots in the outfit from your first uploaded reference photo. I've also added a \"Pick your own color polo shirt\" option in case your company has a uniform.",
  },
  {
    lead: "One didn't look like you:",
    body: "refresh the headshots that are a tiny bit off. Your email address is allowed another 6 free generations plus 2 \"redo re-generations\" — all on me. I will pay for it.",
  },
];

const BODY_CLOSING = [
  "If you have any other ideas that will help me improve this experience for future users, please let me know. I'm not a coder or developer, I'm a photographer — so any feedback you have (good or bad) is like gold and would help me tremendously.",
  "With gratitude,",
  "Kristi",
];

function safeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function buildEmail(): { subject: string; html: string; text: string } {
  const paragraphsHtml = BODY_PARAGRAPHS.map(
    (p) =>
      `<p style="font-size:15px;line-height:1.65;margin:0 0 14px;">${p}</p>`,
  ).join("\n    ");

  const bulletsHtml = BODY_BULLETS.map(
    (b) =>
      `<p style="font-size:15px;line-height:1.65;margin:0 0 14px;"><b>${b.lead}</b> ${b.body}</p>`,
  ).join("\n    ");

  const closingHtml = BODY_CLOSING.map(
    (p) => `<p style="font-size:15px;line-height:1.65;margin:0 0 6px;">${p}</p>`,
  ).join("\n    ");

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:#FAF8F4;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#2A2A2A;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #E8E4DB;border-radius:14px;padding:28px 26px;">
    ${paragraphsHtml}
    ${bulletsHtml}
    ${closingHtml}
    <div style="text-align:center;margin:22px 0 6px;">
      <a href="${SITE_URL}"
         style="display:inline-block;background:#1B4332;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:13px 28px;border-radius:999px;">
        Come back &amp; try again &rarr;
      </a>
    </div>
  </div>
  <p style="max-width:560px;margin:14px auto 0;font-size:12px;color:#9A968D;text-align:center;line-height:1.5;">
    <a href="${SITE_URL}" style="color:#6E6E6A;font-weight:600;">generationheadshots.com</a><br>
    You&rsquo;re getting this because you tried GenerAItion Headshots. Just reply to this email with any feedback &mdash; it comes straight to me.
  </p>
</body></html>`;

  const textLines: string[] = [];
  BODY_PARAGRAPHS.forEach((p) => {
    textLines.push(p, "");
  });
  BODY_BULLETS.forEach((b) => {
    textLines.push(`${b.lead} ${b.body}`, "");
  });
  BODY_CLOSING.forEach((p) => textLines.push(p));
  textLines.push("", SITE_URL);

  return { subject: SUBJECT, html, text: textLines.join("\n") };
}

// Send-lock: keeps a real "?mode=send" from firing twice unless ?force=1.
const redis = new Redis({
  url: process.env.KV_REST_API_URL ?? "",
  token: process.env.KV_REST_API_TOKEN ?? "",
});
const SEND_LOCK_KEY = "apology-blast:sent";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  const pw =
    typeof req.query.pw === "string"
      ? req.query.pw
      : Array.isArray(req.query.pw)
        ? req.query.pw[0]
        : "";
  const expected = process.env.ADMIN_PASSWORD ?? "";
  if (!expected || !safeEquals(pw, expected)) {
    res.status(401).send("Unauthorized");
    return;
  }

  const mode =
    typeof req.query.mode === "string" ? req.query.mode : "preview";
  const force = req.query.force === "1" || req.query.force === "true";

  const apiKey = process.env.RESEND_API_KEY;

  // ---- preview: eyeball the rendered HTML in the browser ----
  if (mode === "preview") {
    const { html } = buildEmail();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(html);
    return;
  }

  // Gather non-buyer recipients once — used by list / test / send.
  let leads;
  try {
    leads = await listLeads();
  } catch (err) {
    console.error("[apology-blast] listLeads failed:", err);
    res.status(500).json({ error: "Failed to load leads" });
    return;
  }
  const recipients = leads
    .filter((l) => !l.purchased)
    .filter((l) => looksLikeEmail(l.email))
    .filter((l) => !INTERNAL_EMAILS.has(l.email.trim().toLowerCase()))
    .map((l) => l.email.trim());

  // ---- list: dry-run, return who WOULD receive ----
  if (mode === "list") {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      mode: "list",
      count: recipients.length,
      recipients,
    });
    return;
  }

  if (!apiKey) {
    res.status(500).json({ error: "RESEND_API_KEY not configured" });
    return;
  }

  const { subject, html, text } = buildEmail();

  async function sendOne(to: string): Promise<{ ok: boolean; err?: string }> {
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Kristi at GenerAItion Headshots <kristi@kristinasherk.com>",
          to: [to],
          bcc: [TEST_ADDRESS],
          reply_to: TEST_ADDRESS,
          subject,
          html,
          text,
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, err: `${resp.status} ${body.slice(0, 160)}` };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        err: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ---- test: single copy to Kristi, then stop ----
  if (mode === "test") {
    const result = await sendOne(TEST_ADDRESS);
    res.setHeader("Cache-Control", "no-store");
    res.status(result.ok ? 200 : 500).json({
      mode: "test",
      sentTo: TEST_ADDRESS,
      ok: result.ok,
      error: result.err,
      wouldSendToCount: recipients.length,
    });
    return;
  }

  // ---- send: the real thing ----
  if (mode === "send") {
    // Idempotency guard. Refuse a second real send unless ?force=1 is passed.
    if (!force) {
      try {
        const prev = await redis.get<{ at: string; count: number }>(
          SEND_LOCK_KEY,
        );
        if (prev) {
          res.status(409).json({
            error: "Already sent",
            note:
              "This blast has already been fired. Pass &force=1 to send AGAIN (risk: recipients get a duplicate).",
            previous: prev,
          });
          return;
        }
      } catch {
        // Redis unreachable → fall through and send. The lock is a convenience,
        // not a hard guarantee.
      }
    }

    let sent = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const to of recipients) {
      const r = await sendOne(to);
      if (r.ok) sent++;
      else {
        failed++;
        if (errors.length < 20) errors.push(`${to}: ${r.err ?? "unknown"}`);
      }
      // Tiny pacing — well under Resend's 10 req/sec free-tier limit.
      await new Promise((r) => setTimeout(r, 120));
    }

    try {
      await redis.set(
        SEND_LOCK_KEY,
        { at: new Date().toISOString(), count: sent },
        { ex: 30 * 24 * 3600 },
      );
    } catch {
      /* best-effort */
    }

    console.log(
      JSON.stringify({
        type: "apology_blast_send",
        attempted: recipients.length,
        sent,
        failed,
        forced: force,
      }),
    );

    res.status(200).json({
      mode: "send",
      attempted: recipients.length,
      sent,
      failed,
      errors,
    });
    return;
  }

  res.status(400).json({
    error: "Unknown mode",
    valid: ["preview", "list", "test", "send"],
  });
}
