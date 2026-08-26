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

const SUBJECT = "a quick note about your headshots";

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
  // Deliberately plain — no wrapper card, no branded background, no CTA
  // button. Just paragraphs in the default email font so it reads like a
  // note Kristi typed in Gmail rather than a marketing template. The only
  // link is the site URL at the very bottom of her signature, styled to
  // match Gmail-default link color.
  const paraStyle = "margin:0 0 12px;";
  const paragraphsHtml = BODY_PARAGRAPHS.map(
    (p) => `<p style="${paraStyle}">${p}</p>`,
  ).join("\n");

  const bulletsHtml = BODY_BULLETS.map(
    (b) => `<p style="${paraStyle}"><b>${b.lead}</b> ${b.body}</p>`,
  ).join("\n");

  const closingHtml = BODY_CLOSING.map(
    (p) => `<p style="margin:0 0 4px;">${p}</p>`,
  ).join("\n");

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#222;">
${paragraphsHtml}
${bulletsHtml}
${closingHtml}
<p style="margin:0;"><a href="${SITE_URL}" style="color:#1155cc;">www.generationheadshots.com</a></p>
</div>`;

  const textLines: string[] = [];
  BODY_PARAGRAPHS.forEach((p) => textLines.push(p, ""));
  BODY_BULLETS.forEach((b) => textLines.push(`${b.lead} ${b.body}`, ""));
  BODY_CLOSING.forEach((p) => textLines.push(p));
  textLines.push("www.generationheadshots.com");

  return { subject: SUBJECT, html, text: textLines.join("\n") };
}

// Per-recipient send log. A Redis SET of every address we've successfully
// delivered to, so re-runs (e.g. after hitting Resend's daily quota) auto-skip
// people who already got the email. No duplicate sends, no manual tracking.
const redis = new Redis({
  url: process.env.KV_REST_API_URL ?? "",
  token: process.env.KV_REST_API_TOKEN ?? "",
});
const SENT_SET_KEY = "apology-blast:sent-addresses";
const RUN_LOG_KEY = "apology-blast:last-run";

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
          from: "Kristi Sherk <kristi@kristinasherk.com>",
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
    // Pull the set of addresses already delivered on prior runs (empty on
    // first run). Skip them so a re-run only hits people who never got it.
    // "?force=1" bypasses the skip and re-sends to everyone.
    let alreadySent = new Set<string>();
    if (!force) {
      try {
        const arr = (await redis.smembers(SENT_SET_KEY)) as string[] | null;
        if (arr) alreadySent = new Set(arr.map((a) => a.toLowerCase()));
      } catch {
        // Redis unreachable → treat as first run rather than block.
      }
    }

    const toSend = recipients.filter(
      (r) => !alreadySent.has(r.toLowerCase()),
    );
    const skippedAlreadySent = recipients.length - toSend.length;

    let sent = 0;
    let failed = 0;
    let quotaHit = false;
    const errors: string[] = [];
    const newlySentLower: string[] = [];
    for (const to of toSend) {
      const r = await sendOne(to);
      if (r.ok) {
        sent++;
        newlySentLower.push(to.toLowerCase());
      } else {
        failed++;
        if (errors.length < 20) errors.push(`${to}: ${r.err ?? "unknown"}`);
        // Detect Resend daily-quota errors and stop early — no point wasting
        // the remaining calls when every one will 429 the same way.
        if (r.err && /429|daily_quota_exceeded|quota/i.test(r.err)) {
          quotaHit = true;
          break;
        }
      }
      // Tiny pacing — well under Resend's 10 req/sec free-tier limit.
      await new Promise((r) => setTimeout(r, 120));
    }

    // Persist which addresses actually got the email so the next run skips them.
    if (newlySentLower.length > 0) {
      try {
        await redis.sadd(SENT_SET_KEY, ...newlySentLower);
        // Keep the record around for a long time — 90 days is plenty for any
        // realistic backfill campaign. Reset it manually (see mode=reset).
        await redis.expire(SENT_SET_KEY, 90 * 24 * 3600);
      } catch {
        /* best-effort */
      }
    }
    try {
      await redis.set(
        RUN_LOG_KEY,
        {
          at: new Date().toISOString(),
          attempted: toSend.length,
          sent,
          failed,
          skippedAlreadySent,
          quotaHit,
        },
        { ex: 90 * 24 * 3600 },
      );
    } catch {
      /* best-effort */
    }

    console.log(
      JSON.stringify({
        type: "apology_blast_send",
        recipientsTotal: recipients.length,
        skippedAlreadySent,
        attempted: toSend.length,
        sent,
        failed,
        quotaHit,
        forced: force,
      }),
    );

    res.status(200).json({
      mode: "send",
      recipientsTotal: recipients.length,
      skippedAlreadySent,
      attempted: toSend.length,
      sent,
      failed,
      quotaHit,
      remainingUnsent: Math.max(0, toSend.length - sent),
      note: quotaHit
        ? "Stopped early: Resend daily quota reached. Re-run this URL after the quota resets (24h from your first send today) and it will pick up only the people who haven't been emailed yet."
        : undefined,
      errors,
    });
    return;
  }

  // ---- status: see how many addresses have been sent so far ----
  if (mode === "status") {
    try {
      const arr = (await redis.smembers(SENT_SET_KEY)) as string[] | null;
      const last = await redis.get<Record<string, unknown>>(RUN_LOG_KEY);
      const sentSoFar = new Set((arr ?? []).map((a) => a.toLowerCase()));
      const remaining = recipients.filter(
        (r) => !sentSoFar.has(r.toLowerCase()),
      );
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({
        mode: "status",
        totalNonBuyers: recipients.length,
        alreadySent: sentSoFar.size,
        remaining: remaining.length,
        lastRun: last ?? null,
        remainingPreview: remaining.slice(0, 20),
      });
      return;
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
  }

  // ---- backfill: mark everyone in the current recipient list BEFORE the
  // first-failed address as already sent. Use this after a run that hit the
  // Resend daily quota — recipients are processed in list order, so every
  // address ahead of the first failure did go out. Idempotent. ----
  if (mode === "backfill") {
    const firstFailed =
      typeof req.query.firstFailed === "string"
        ? req.query.firstFailed.trim().toLowerCase()
        : "";
    if (!firstFailed) {
      res.status(400).json({
        error:
          "Pass &firstFailed=email@example.com — the first address that got a 429/failure in the send response.",
      });
      return;
    }
    const idx = recipients.findIndex(
      (r) => r.toLowerCase() === firstFailed,
    );
    if (idx < 0) {
      res.status(404).json({
        error:
          "firstFailed address not found in the current recipient list. Double-check the address.",
        recipientsPreview: recipients.slice(0, 10),
      });
      return;
    }
    const alreadyDone = recipients.slice(0, idx).map((r) => r.toLowerCase());
    if (alreadyDone.length === 0) {
      res.status(200).json({
        mode: "backfill",
        markedSent: 0,
        note: "firstFailed is the first recipient, nothing to backfill.",
      });
      return;
    }
    try {
      await redis.sadd(SENT_SET_KEY, ...alreadyDone);
      await redis.expire(SENT_SET_KEY, 90 * 24 * 3600);
      res.status(200).json({
        mode: "backfill",
        markedSent: alreadyDone.length,
        firstMarked: alreadyDone[0],
        lastMarked: alreadyDone[alreadyDone.length - 1],
      });
      return;
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
  }

  // ---- reset: clear the "already sent" record (rare, deliberate) ----
  if (mode === "reset") {
    if (!force) {
      res.status(400).json({
        error:
          "reset wipes the record of who has been emailed. Add &force=1 to confirm.",
      });
      return;
    }
    try {
      await redis.del(SENT_SET_KEY);
      res.status(200).json({ mode: "reset", ok: true });
      return;
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
  }

  res.status(400).json({
    error: "Unknown mode",
    valid: ["preview", "list", "test", "send"],
  });
}
