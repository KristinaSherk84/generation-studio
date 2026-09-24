/**
 * POST /api/feedback-inbound  (2026-09-24)
 *
 * Resend "email.received" webhook. Fires when someone replies to the
 * non-buyer survey (the survey's reply-to is SURVEY_REPLY_TO, a Resend
 * receiving address). For each reply we:
 *   1. Fetch the full email from Resend's API (the webhook only carries
 *      metadata). We trust ONLY what Resend's API returns for this id, so
 *      a forged webhook can't inject fake votes.
 *   2. Pull out the letter (A–G) → logged on the /feedback page.
 *   3. If they asked to stop, unsubscribe them automatically.
 *   4. Forward a short copy to Kristi's inbox so she still sees replies.
 *
 * Always answers 200 quickly so Resend doesn't retry forever; problems are
 * logged, never thrown.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { saveReply, parseLetter, wantsUnsubscribe, replyTop } from "./lib/feedbackStore.js";
import { unsubscribeEmail, looksLikeEmail } from "./lib/leadStore.js";
import { surveyReplyTo, SURVEY_FROM } from "./lib/surveyEmail.js";

export const maxDuration = 30;

const KRISTI_INBOX = "kristi@kristinasherk.com";

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "\n>")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

/** "Jane Doe <jane@x.com>" → "jane@x.com" */
function bareAddress(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1] : from).trim().toLowerCase();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false });
    return;
  }
  const apiKey = process.env.RESEND_API_KEY;
  const event = (req.body ?? {}) as {
    type?: string;
    data?: { email_id?: string; to?: string[] };
  };
  if (event.type !== "email.received" || !event.data?.email_id || !apiKey) {
    res.status(200).json({ ok: true, ignored: true });
    return;
  }

  // Only handle mail sent to the survey reply address (other inbound mail
  // on the same Resend account is left alone).
  const replyAddr = surveyReplyTo().toLowerCase();
  const toList = (event.data.to ?? []).map((t) => bareAddress(t));
  if (toList.length > 0 && !toList.includes(replyAddr)) {
    res.status(200).json({ ok: true, ignored: "not_survey_address" });
    return;
  }

  const id = event.data.email_id;
  try {
    const r = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!r.ok) {
      console.warn(JSON.stringify({ type: "feedback_fetch_failed", id, status: r.status }));
      res.status(200).json({ ok: false });
      return;
    }
    const mail = (await r.json()) as {
      from?: string;
      subject?: string;
      text?: string | null;
      html?: string | null;
      created_at?: string;
    };
    const email = bareAddress(mail.from ?? "");
    const body = mail.text || (mail.html ? stripHtml(mail.html) : "");
    const letter = parseLetter(body);
    const unsub = wantsUnsubscribe(body);
    const top = replyTop(body);

    if (unsub && looksLikeEmail(email)) {
      await unsubscribeEmail(email);
    }
    await saveReply({
      id,
      email,
      letter,
      snippet: top.slice(0, 300),
      receivedAt: mail.created_at ?? new Date().toISOString(),
      unsubscribed: unsub,
    });
    console.log(JSON.stringify({ type: "feedback_reply", email, letter, unsub }));

    // Forward a short copy so replies still show up in Kristi's inbox.
    // Skipped when the reply address IS her inbox (no loop).
    if (replyAddr !== KRISTI_INBOX) {
      const tag = letter ? `answered ${letter}` : unsub ? "unsubscribed" : "needs a look";
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: SURVEY_FROM,
          to: [KRISTI_INBOX],
          reply_to: email || undefined,
          subject: `Survey reply from ${email} (${tag})`,
          text: `${email} ${tag}.\n\nWhat they wrote:\n\n${top.slice(0, 2000)}\n\nSee all answers: https://generationheadshots.com/feedback`,
        }),
      }).catch(() => {});
    }
    res.status(200).json({ ok: true, letter, unsubscribed: unsub });
  } catch (err) {
    console.warn(
      "[feedback-inbound] failed:",
      err instanceof Error ? err.message : String(err),
    );
    res.status(200).json({ ok: false });
  }
}
