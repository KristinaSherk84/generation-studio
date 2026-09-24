/**
 * GET/POST /api/unsubscribe-link?e=<email>&s=<signature>  (2026-09-24)
 *
 * The "Unsubscribe" link at the bottom of marketing emails. One click and
 * they're off the list — no login, no form. The signature (made from a
 * server secret) means nobody can unsubscribe someone else by editing the
 * link. POST is supported too, for Gmail/Apple's one-click unsubscribe
 * button (List-Unsubscribe-Post).
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { unsubscribeEmail, looksLikeEmail } from "./lib/leadStore.js";
import { verifyUnsub } from "./lib/surveyEmail.js";

export const maxDuration = 10;

function page(title: string, msg: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head>
<body style="margin:0;background:#FAF8F4;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#2C2C2A;">
<div style="max-width:440px;margin:80px auto;padding:28px;background:#fff;border:1px solid #E8E4DB;border-radius:12px;text-align:center;">
<h1 style="font-size:20px;font-weight:600;margin:0 0 10px;">${title}</h1>
<p style="font-size:15px;line-height:1.55;margin:0;color:#5F5E5A;">${msg}</p>
</div></body></html>`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const e = typeof req.query.e === "string" ? req.query.e.trim().toLowerCase() : "";
  const s = typeof req.query.s === "string" ? req.query.s : "";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (!looksLikeEmail(e) || !verifyUnsub(e, s)) {
    res
      .status(400)
      .send(page("Link didn't work", "This unsubscribe link looks incomplete. Just reply to the email with \"unsubscribe\" and I'll take you off the list."));
    return;
  }
  try {
    await unsubscribeEmail(e);
  } catch {
    res.status(500).send(page("Something went wrong", "Please reply to the email with \"unsubscribe\" and I'll take you off the list."));
    return;
  }
  res
    .status(200)
    .send(page("You're unsubscribed", `${e} won't get any more emails like this. Thanks for trying the app!<br><br>— Kristi`));
}
