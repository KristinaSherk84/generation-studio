/**
 * GET /api/admin/survey-blast  (2026-09-23, refactored 2026-09-24)
 *
 * One-time "why didn't you buy?" survey email to every NON-buyer lead.
 * (New non-buyers now get it automatically 7 days later via
 * /api/survey-auto — this is for manual sends.) Behind ADMIN_PASSWORD:
 *
 *   ?pw=…                          PREVIEW (default). Sends nothing.
 *   ?pw=…&test=you@example.com     Sends ONE copy (subject prefixed [TEST]).
 *   ?pw=…&send=1&confirm=<N>       Sends to everyone eligible. N must equal
 *                                  the eligible count from the preview.
 *   &exclude=a@x.com,b@y.com       Leave specific people out.
 *
 * Who's skipped + the email itself live in lib/surveyEmail.ts.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { looksLikeEmail } from "../lib/leadStore.js";
import {
  eligibleSurveyRecipients,
  sendSurveyBatch,
  surveyPayload,
  buildSurveyText,
  SURVEY_SUBJECT,
} from "../lib/surveyEmail.js";

export const maxDuration = 300;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const expected = process.env.ADMIN_PASSWORD ?? "";
  const pw = typeof req.query.pw === "string" ? req.query.pw : "";
  if (!expected || pw !== expected) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    res.status(500).json({ ok: false, error: "RESEND_API_KEY missing" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");

  const test = typeof req.query.test === "string" ? req.query.test.trim() : "";
  if (test) {
    if (!looksLikeEmail(test)) {
      res.status(400).json({ ok: false, error: "bad test email" });
      return;
    }
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(surveyPayload(test, "[TEST] ")),
    });
    res.status(200).json({ ok: r.ok, mode: "test", to: test, status: r.status });
    return;
  }

  const exclude = new Set(
    (typeof req.query.exclude === "string" ? req.query.exclude : "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  let data;
  try {
    data = await eligibleSurveyRecipients({ exclude });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err instanceof Error ? err.message : err) });
    return;
  }

  if (req.query.send !== "1") {
    res.status(200).json({
      ok: true,
      mode: "preview",
      subject: SURVEY_SUBJECT,
      totalLeads: data.totalLeads,
      eligibleCount: data.eligible.length,
      skipped: data.skipped,
      firstTen: data.eligible.slice(0, 10),
      textPreview: buildSurveyText("preview@example.com"),
    });
    return;
  }

  const confirm = Number(req.query.confirm);
  if (!Number.isInteger(confirm) || confirm !== data.eligible.length) {
    res.status(400).json({
      ok: false,
      error: "confirm must equal eligibleCount",
      eligibleCount: data.eligible.length,
    });
    return;
  }
  const out = await sendSurveyBatch(apiKey, data.eligible, Date.now() + 270_000);
  const remaining = data.eligible.length - out.sent - out.failed;
  console.log(JSON.stringify({ type: "survey_blast", ...out, remaining }));
  res.status(200).json({ ok: out.failed === 0, mode: "send", ...out, remaining });
}
