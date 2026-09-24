/**
 * GET /api/survey-auto  (2026-09-24) — hourly cron (see vercel.json).
 *
 * Sends the "why didn't you buy?" survey to each non-buyer 7 days after
 * their last activity. The window is 7–14 days: 14 is a safety cap so a
 * long-dormant lead never gets a surprise email weeks later. Everyone ever
 * surveyed is remembered (SURVEY_SENT_KEY), so nobody gets it twice, and
 * buyers / unsubscribed / blocked people are always skipped.
 *
 * Vercel cron calls this with Authorization: Bearer <CRON_SECRET> (same
 * secret the win-back cron uses); the admin password also works for a
 * manual run (?pw=…). &dry=1 shows who WOULD get it without sending.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { eligibleSurveyRecipients, sendSurveyBatch } from "./lib/surveyEmail.js";

export const maxDuration = 120;

const DAY = 24 * 60 * 60 * 1000;
const MIN_AGE_MS = 7 * DAY;
const MAX_AGE_MS = 14 * DAY;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cronSecret = process.env.CRON_SECRET ?? "";
  const adminPw = process.env.ADMIN_PASSWORD ?? "";
  const auth = req.headers.authorization ?? "";
  const pw = typeof req.query.pw === "string" ? req.query.pw : "";
  const isCron = !!cronSecret && auth === `Bearer ${cronSecret}`;
  const isAdmin = !!adminPw && pw === adminPw;
  if (!isCron && !isAdmin) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    res.status(500).json({ ok: false, error: "RESEND_API_KEY missing" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");

  let data;
  try {
    data = await eligibleSurveyRecipients({ minAgeMs: MIN_AGE_MS, maxAgeMs: MAX_AGE_MS });
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    console.warn(JSON.stringify({ type: "survey_auto_skipped", reason: msg }));
    res.status(200).json({ ok: false, error: msg });
    return;
  }
  if (req.query.dry === "1") {
    res.status(200).json({ ok: true, dryRun: true, wouldSend: data.eligible, skipped: data.skipped });
    return;
  }
  if (data.eligible.length === 0) {
    res.status(200).json({ ok: true, sent: 0 });
    return;
  }
  const out = await sendSurveyBatch(apiKey, data.eligible, Date.now() + 100_000);
  console.log(JSON.stringify({ type: "survey_auto_run", eligible: data.eligible.length, ...out }));
  res.status(200).json({ ok: out.failed === 0, ...out });
}
