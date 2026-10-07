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

// Plain, personal-looking email (2026-10-07, Kristi: "no formatting at all,
// like a regular email from a person"). Paragraphs are plain text; the only
// markup is <br> line breaks and ordinary links. No cards, buttons or boxes.
type Para = string | { text: string; href: string };
const plainHtml = (paras: Para[][], to: string) =>
  `<div>` +
  paras
    .map(
      (line) =>
        line
          .map((part) =>
            typeof part === "string"
              ? esc(part).replace(/\n/g, "<br>")
              : `<a href="${esc(part.href)}">${esc(part.text)}</a>`,
          )
          .join("") ,
    )
    .join("<br><br>") +
  `<br><br><br><span style="font-size:11px;color:#999999;">Don't want emails like this? <a href="${unsubscribeUrl(to)}" style="color:#999999;">Unsubscribe</a></span></div>`;
const plainText = (paras: Para[][], to: string) =>
  paras
    .map((line) => line.map((part) => (typeof part === "string" ? part : `${part.text} (${part.href})`)).join(""))
    .join("\n\n") + `\n\n\nUnsubscribe: ${unsubscribeUrl(to)}`;

/** The automatic "trade me a share for a free headshot" email. */
export function buildShareAskEmail(p: { to: string; name?: string | null; past?: boolean }) {
  const fn = firstName(p.name);
  const mailto =
    `mailto:?bcc=${encodeURIComponent(KRISTI_EMAIL)}` +
    `&subject=${encodeURIComponent(FRIEND_EMAIL_SUBJECT)}` +
    `&body=${encodeURIComponent(friendEmailBody(fn))}`;
  const linkedinCompose = `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(LINKEDIN_POST)}`;
  const subject = "20 seconds of help for a free headshot?";
  const paras: Para[][] = [
    [fn ? `Hi ${fn},` : "Hi there,"],
    [
      (p.past
        ? "I hope your headshot from GenerAItion Headshots has been working hard for you on LinkedIn."
        : "Since your shiny new headshot is getting you noticed on LinkedIn,") +
        " I'm wondering if I could ask for 20 seconds of your help, in exchange for a code for a free additional headshot!",
    ],
    ["Two ways to qualify:"],
    [
      `1. Email two friends the note below, and BCC me (${KRISTI_EMAIL}). They will NOT be added to an email list. Here's a shortcut that writes the email and adds the BCC for you: `,
      { text: "open the email", href: mailto },
    ],
    [
      "2. Share GenerAItion Headshots with your network on LinkedIn and tag our page, @GenerAItion Headshots (type it and pick the page from the list). Here's a shortcut with the post already written: ",
      { text: "open LinkedIn", href: linkedinCompose },
      ". Our page is here: ",
      { text: "GenerAItion Headshots on LinkedIn", href: LINKEDIN_PAGE },
    ],
    ["I've written the shareable text for you below to make it even easier."],
    ["So what do you think? Will you trade me a social share for another headshot in a different style?"],
    ["Kristina"],
    [`----------\nEmail for your friends\n\nSubject: ${FRIEND_EMAIL_SUBJECT}\n\n${friendEmailBody(fn)}`],
    [`----------\nLinkedIn post\n\n${LINKEDIN_POST}`],
  ];
  return { subject, html: plainHtml(paras, p.to), text: plainText(paras, p.to) };
}

/** The thank-you email carrying the share-reward code. */
export function buildShareRewardEmail(p: { to: string; name?: string | null; code: string }) {
  const fn = firstName(p.name);
  const code = p.code.toUpperCase();
  const subject = "Thank you! Here's your free headshot code";
  const paras: Para[][] = [
    [fn ? `Hi ${fn},` : "Hi there,"],
    ["Thank you so much for sharing. It truly helps a small, photographer-run business like mine."],
    [`Here's your code: ${code}`],
    ["It gives you 30 more headshots to generate in any style, plus 1 headshot of your choice free to download."],
    [
      "To use it, go to ",
      { text: "generationheadshots.com", href: `${SITE}/?utm_source=email&utm_medium=email&utm_campaign=share_reward` },
      ', tap "Have a promo code?" under the green button, and enter your code.',
    ],
    ["Kristina"],
  ];
  return { subject, html: plainHtml(paras, p.to), text: plainText(paras, p.to) };
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
