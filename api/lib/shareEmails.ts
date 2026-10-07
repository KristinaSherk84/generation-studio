/**
 * Share-campaign emails (2026-10-07, Kristi).
 *
 *  1. Share ASK  — sent automatically 5 days after a purchase by
 *     /api/share-ask-emails. Asks the buyer to email two friends (BCC Kristi)
 *     OR post on LinkedIn and tag the page, in exchange for a free headshot.
 *  2. Share REWARD — sent from the leads page ("🎁 Send reward") once Kristi
 *     sees the BCC or the LinkedIn tag. Carries a "share" promo code:
 *     30 generations + 1 free headshot download.
 *
 * Copy lives here so it can be edited in one place. Kristi's voice.
 */
import { unsubscribeUrl } from "./surveyEmail.js";

const SITE = "https://generationheadshots.com";
export const KRISTI_EMAIL = "kristi@kristinasherk.com";
export const FROM = "Kristi at GenerAItion Headshots <kristi@kristinasherk.com>";
export const LINKEDIN_PAGE = "https://www.linkedin.com/company/generation-headshots/";

const FRIEND_LINK = `${SITE}/?utm_source=friend&utm_medium=email&utm_campaign=share_ask`;
const LINKEDIN_LINK = `${SITE}/?utm_source=linkedin&utm_medium=social&utm_campaign=share_ask`;

export const FRIEND_EMAIL_SUBJECT = "Thought of you: headshots that actually look like you";
export const friendEmailBody = (fromName: string) =>
  `Hi,

I just updated my headshot with GenerAItion Headshots, an AI headshot app built by Kristina Sherk, a DC headshot photographer with 20 years of experience. Unlike the other AI apps I've seen, mine actually look like me.

Your first 6 are free to preview, and you only pay for the ones you keep. It took me about five minutes.

${FRIEND_LINK}

${fromName || ""}`.trim();

export const LINKEDIN_POST = `New headshot! I made it with GenerAItion Headshots, an AI headshot app built by a real headshot photographer, Kristina Sherk. It actually looks like me, which is more than I can say for the other AI apps I tried.

If yours needs an update, your first 6 are free: ${LINKEDIN_LINK}

@GenerAItion Headshots`;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const firstName = (name?: string | null) => {
  const f = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return f.length >= 2 ? f.charAt(0).toUpperCase() + f.slice(1) : "";
};
const nl2br = (s: string) => esc(s).replace(/\n/g, "<br/>");

const shell = (inner: string, to: string) => `<!doctype html><html><body style="margin:0;background:#FAF8F4;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#2C2C2A;">
<div style="max-width:560px;margin:0 auto;padding:28px 20px;">
<div style="background:#ffffff;border:1px solid #E8E4DB;border-radius:12px;padding:28px 24px;font-size:15px;line-height:1.6;">
${inner}
</div>
<p style="margin:16px 0 0;font-size:12px;color:#888780;text-align:center;">Don't want emails like this? <a href="${unsubscribeUrl(to)}" style="color:#888780;">Unsubscribe</a></p>
</div></body></html>`;

const button = (href: string, label: string) =>
  `<a href="${esc(href)}" style="display:inline-block;background:#1B4332;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 18px;border-radius:999px;margin:6px 0 2px;">${esc(label)}</a>`;

const copyBox = (title: string, body: string) =>
  `<div style="margin:14px 0 0;padding:14px 16px;background:#FAF8F4;border:1px dashed #D3D1C7;border-radius:8px;">
<div style="font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:#888780;margin-bottom:8px;">${esc(title)}</div>
<div style="font-size:14px;color:#2C2C2A;">${nl2br(body)}</div></div>`;

/** The automatic "trade me a share for a free headshot" email. */
export function buildShareAskEmail(p: { to: string; name?: string | null }) {
  const fn = firstName(p.name);
  const hi = fn ? `Hi ${esc(fn)},` : "Hi there,";
  const mailto =
    `mailto:?bcc=${encodeURIComponent(KRISTI_EMAIL)}` +
    `&subject=${encodeURIComponent(FRIEND_EMAIL_SUBJECT)}` +
    `&body=${encodeURIComponent(friendEmailBody(fn))}`;
  const linkedinCompose = `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(LINKEDIN_POST)}`;
  const subject = "20 seconds of help for a free headshot?";
  const html = shell(
    `<p style="margin:0 0 14px;">${hi}</p>
<p style="margin:0 0 14px;">Since your shiny new headshot is getting you noticed on LinkedIn, I'm wondering if I could ask for 20 seconds of your help, <strong>in exchange for a code for a free additional headshot!</strong></p>
<p style="margin:18px 0 6px;font-weight:600;">Two ways to qualify:</p>
<p style="margin:0 0 4px;"><strong>1. Email two friends</strong> the note below, and BCC me. They will NOT be added to an email list.</p>
${button(mailto, "Open the email, ready to send")}
<p style="margin:4px 0 16px;font-size:12.5px;color:#888780;">The button fills in the note and BCCs me for you. Just add two friends.</p>
<p style="margin:0 0 4px;"><strong>2. Share GenerAItion Headshots on LinkedIn</strong> and tag our page, @GenerAItion Headshots.</p>
${button(linkedinCompose, "Open LinkedIn with the post ready")}
<p style="margin:4px 0 0;font-size:12.5px;color:#888780;">To tag us, type @GenerAItion Headshots and pick the page from the list. Adding your new headshot to the post makes it shine. <a href="${LINKEDIN_PAGE}" style="color:#888780;">Our LinkedIn page</a></p>
<p style="margin:20px 0 0;">I've written the shareable text for you below to make it even easier.</p>
${copyBox("Email for your friends", `Subject: ${FRIEND_EMAIL_SUBJECT}\n\n${friendEmailBody(fn)}`)}
${copyBox("LinkedIn post", LINKEDIN_POST)}
<p style="margin:20px 0 0;">So what do you think? Will you trade me a social share for another headshot in a different style?</p>
<p style="margin:18px 0 0;">Kristina</p>`,
    p.to,
  );
  const text = `${fn ? `Hi ${fn},` : "Hi there,"}

Since your shiny new headshot is getting you noticed on LinkedIn, I'm wondering if I could ask for 20 seconds of your help, in exchange for a code for a free additional headshot!

Two ways to qualify:
1. Email two friends the note below, and BCC me (${KRISTI_EMAIL}). They will NOT be added to an email list.
2. Share GenerAItion Headshots on LinkedIn and tag our page, @GenerAItion Headshots: ${LINKEDIN_PAGE}

I've written the shareable text for you to make it even easier.

--- Email for your friends ---
Subject: ${FRIEND_EMAIL_SUBJECT}

${friendEmailBody(fn)}

--- LinkedIn post ---
${LINKEDIN_POST}

So what do you think? Will you trade me a social share for another headshot in a different style?

Kristina

Unsubscribe: ${unsubscribeUrl(p.to)}`;
  return { subject, html, text };
}

/** The thank-you email carrying the share-reward code. */
export function buildShareRewardEmail(p: { to: string; name?: string | null; code: string }) {
  const fn = firstName(p.name);
  const code = p.code.toUpperCase();
  const subject = "Thank you! Here's your free headshot code";
  const html = shell(
    `<p style="margin:0 0 14px;">${fn ? `Hi ${esc(fn)},` : "Hi there,"}</p>
<p style="margin:0 0 14px;">Thank you so much for sharing. It truly helps a small, photographer-run business like mine.</p>
<p style="margin:0 0 6px;">Here's your code:</p>
<div style="font-family:Menlo,Consolas,monospace;font-size:24px;font-weight:700;letter-spacing:2px;background:#F1FAEC;border:1px solid #CFE6C4;border-radius:8px;padding:12px 16px;text-align:center;margin:0 0 16px;">${esc(code)}</div>
<p style="margin:0 0 6px;">It gives you:</p>
<ul style="margin:0 0 16px;padding-left:20px;">
<li><strong>30 more headshots</strong> to generate, in any style</li>
<li><strong>1 headshot of your choice, free</strong> to download</li>
</ul>
<p style="margin:0 0 14px;">To use it, go to <a href="${SITE}/?utm_source=email&utm_medium=email&utm_campaign=share_reward" style="color:#1B4332;">generationheadshots.com</a>, tap <strong>"Have a promo code?"</strong> under the green button, and enter your code.</p>
<p style="margin:18px 0 0;">Kristina</p>`,
    p.to,
  );
  const text = `${fn ? `Hi ${fn},` : "Hi there,"}

Thank you so much for sharing. It truly helps a small, photographer-run business like mine.

Your code: ${code}

It gives you:
- 30 more headshots to generate, in any style
- 1 headshot of your choice, free to download

To use it, go to ${SITE}, tap "Have a promo code?" under the green button, and enter your code.

Kristina

Unsubscribe: ${unsubscribeUrl(p.to)}`;
  return { subject, html, text };
}

/** Send one email through Resend. Returns true when Resend accepts it. */
export async function sendViaResend(p: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<{ ok: boolean; status?: number; body?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, body: "RESEND_API_KEY not configured" };
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM,
      to: [p.to],
      reply_to: KRISTI_EMAIL,
      subject: p.subject,
      html: p.html,
      text: p.text,
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl(p.to)}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });
  if (resp.ok) return { ok: true };
  return { ok: false, status: resp.status, body: (await resp.text().catch(() => "")).slice(0, 300) };
}
