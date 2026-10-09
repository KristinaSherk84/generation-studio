/**
 * POST /api/admin/send-report  (2026-10-09)
 *
 * Emails an HTML report to Kristi — e.g. the model side-by-side test that
 * Claude runs on her Mac. The recipient is FIXED to Kristi's address so this
 * can't be used to email anyone else. Auth: ADMIN_PASSWORD in the JSON body.
 *
 * Body: { pw, subject, html }
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sendViaResend, KRISTI_EMAIL } from "../lib/shareEmails.js";

export const maxDuration = 20;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "POST only" });
    return;
  }
  const body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {}) as {
    pw?: unknown;
    subject?: unknown;
    html?: unknown;
  };
  const expected = process.env.ADMIN_PASSWORD ?? "";
  if (!expected || body.pw !== expected) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }
  const subject = typeof body.subject === "string" ? body.subject.slice(0, 200) : "";
  const html = typeof body.html === "string" ? body.html : "";
  if (!subject || !html || html.length > 400_000) {
    res.status(400).json({ ok: false, error: "subject and html (under 400 KB) required" });
    return;
  }
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 20_000);
  const sent = await sendViaResend({ to: KRISTI_EMAIL, subject, html, text });
  res.status(sent.ok ? 200 : 502).json(sent.ok ? { ok: true, to: KRISTI_EMAIL } : { ok: false, ...sent });
}
