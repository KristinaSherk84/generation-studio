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
 * De-duplication (2026-08-25): a multi-batch session fires this once per batch,
 * and since all batches now share ONE accumulating resume link, those repeats
 * are identical — customers were getting several copies. We claim an atomic
 * per-token (per-email fallback) key so only the FIRST send goes out within the
 * link's lifetime. Fail-OPEN on any Redis error.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { looksLikeEmail } from "./lib/leadStore.js";
import { bumpGeneratedEmail } from "./lib/dailyStats.js";
import { Redis } from "@upstash/redis";

export const maxDuration = 10;

const redis = new Redis({
  url: process.env.KV_REST_API_URL ?? "",
  token: process.env.KV_REST_API_TOKEN ?? "",
});

// One "ready to view" email per gallery link. Matches the resume-link TTL so a
// genuinely-new session (fresh token) later still gets its own email.
const READY_EMAIL_DEDUPE_TTL_SEC = 4 * 24 * 60 * 60;

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
    feedback,
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
  // UTM tags so a client CLICK shows up in GA4/Clarity as source/medium
  // email/email, campaign session_ready. The resume link is unique per
  // client, so a click = that specific client returned (2026-08-06).
  const resumeUrl = resumeToken
    ? `${SITE_URL}/?resume=${resumeToken}&utm_source=email&utm_medium=email&utm_campaign=session_ready`
    : `${SITE_URL}/?utm_source=email&utm_medium=email&utm_campaign=session_ready`;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    res.status(200).json({ ok: false, reason: "no_resend_key" });
    return;
  }

  // De-dupe the repeat sends one person triggers (see note at top). Keyed by
  // EMAIL ADDRESS, not the token: the client re-fires this endpoint on reloads
  // and — the common case — whenever a CAPPED free user re-clicks "generate"
  // (each blocked attempt re-arms the client's one-per-batch guard, restores
  // the same 6 shots, and re-sends). Those attempts can carry different/again
  // the same token, so only an email-keyed claim reliably collapses them to a
  // single send. One "ready to view" email per person per link-lifetime window.
  const dedupeKey = `readyemail:addr:${email.toLowerCase()}`;
  let claimedDedupe = false;
  // Only dedupe sends that carry a real gallery link (resumeToken). A tokenless
  // send happens when save-session failed and the email links to the bare site;
  // it must NOT claim the slot, or it could suppress the true gallery email a
  // later batch sends. The reported repeats all carry a token, so this still
  // collapses them to one.
  if (resumeToken) {
    try {
      const claim = await redis.set(dedupeKey, "1", {
        nx: true,
        ex: READY_EMAIL_DEDUPE_TTL_SEC,
      });
      if (claim === null) {
        // Already sent for this person's gallery — this call is the duplicate.
        res.status(200).json({ ok: true, reason: "deduped" });
        return;
      }
      claimedDedupe = true;
    } catch {
      /* Redis unreachable → skip dedupe and send anyway (fail-open). */
    }
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
      // Release the dedupe claim so a later batch/retry can still send.
      if (claimedDedupe) {
        try {
          await redis.del(dedupeKey);
        } catch {
          /* ignore */
        }
      }
      res.status(200).json({ ok: false, reason: "send_failed" });
      return;
    }
    // Count this recipient as a distinct person who generated today. SADD
    // dedupes, so multiple batches from the same person still count once.
    await bumpGeneratedEmail(email);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.warn(
      "[ready-email] error:",
      err instanceof Error ? err.message : String(err),
    );
    // Release the dedupe claim so a later batch/retry can still send.
    if (claimedDedupe) {
      try {
        await redis.del(dedupeKey);
      } catch {
        /* ignore */
      }
    }
    res.status(200).json({ ok: false, reason: "error" });
  }
}
