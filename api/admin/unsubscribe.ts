/**
 * GET /api/admin/unsubscribe  (2026-09-23)
 *
 *   ?pw=…&emails=a@x.com,b@y.com            unsubscribe these
 *   ?pw=…&emails=a@x.com&action=remove      undo (re-subscribe)
 *   ?pw=…&action=list                       show everyone unsubscribed
 *
 * Unsubscribed people can still use the app; they just never get
 * marketing email (win-back reminders, survey blasts, future mass sends).
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  unsubscribeEmail,
  resubscribeEmail,
  listUnsubscribedEmails,
  looksLikeEmail,
} from "../lib/leadStore.js";

export const maxDuration = 20;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const expected = process.env.ADMIN_PASSWORD ?? "";
  const pw = typeof req.query.pw === "string" ? req.query.pw : "";
  if (!expected || pw !== expected) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  const action = typeof req.query.action === "string" ? req.query.action : "add";

  if (action === "list") {
    const list = await listUnsubscribedEmails();
    res.status(200).json({ ok: true, count: list.length, unsubscribed: list.sort() });
    return;
  }

  const raw = typeof req.query.emails === "string" ? req.query.emails : "";
  const emails = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const done: string[] = [];
  const invalid: string[] = [];
  for (const e of emails) {
    if (!looksLikeEmail(e)) {
      invalid.push(e);
      continue;
    }
    if (action === "remove") await resubscribeEmail(e);
    else await unsubscribeEmail(e);
    done.push(e);
  }
  res.status(200).json({
    ok: invalid.length === 0,
    action: action === "remove" ? "resubscribed" : "unsubscribed",
    done,
    invalid,
  });
}
