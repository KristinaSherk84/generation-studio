/**
 * GET /api/share-ask-emails — "share for a free headshot" ask (2026-10-07, Kristi)
 *
 * Runs on a Vercel Cron (hourly). Emails every buyer once, 5 days after their
 * purchase, asking them to email two friends (BCC Kristi) or post on LinkedIn
 * and tag the page, in exchange for a share-reward code (30 generations +
 * 1 free headshot). Kristi sends the code from the leads page ("🎁 Send
 * reward") when she sees the BCC or the tag.
 *
 * Eligibility (all must hold):
 *   - purchased, with a purchasedAt between SHARE_ASK_MIN_DAYS (5) and
 *     SHARE_ASK_MAX_DAYS (8) ago — so buyers from before launch are never
 *     blasted, and a missed hour is picked up on the next run
 *   - not already asked, not already rewarded
 *   - not unsubscribed, not on the DO_NOT_SEND list, not an internal address
 *
 * The lead is marked shareAskSentAt ONLY after Resend accepts the send.
 *
 * Auth: CRON_SECRET (Bearer header or ?key=) or ADMIN_PASSWORD (?adminpw=).
 * Modes:
 *   ?dryRun=1                 list who WOULD be emailed, send nothing
 *   ?testEmail=you@x.com      send one sample to that address, mark nothing
 *   ?testName=Kristi          name used in the test sample
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  listLeads,
  looksLikeEmail,
  isEmailUnsubscribed,
  setLeadShareFields,
} from "./lib/leadStore.js";
import { isSuppressed } from "./lib/doNotSend.js";
import { buildShareAskEmail, sendViaResend } from "./lib/shareEmails.js";

export const maxDuration = 60;

const DAY = 24 * 60 * 60 * 1000;
const MIN_AGE_MS = Number(process.env.SHARE_ASK_MIN_DAYS ?? "5") * DAY;
const MAX_AGE_MS = Number(process.env.SHARE_ASK_MAX_DAYS ?? "8") * DAY;
const MAX_PER_RUN = Number(process.env.SHARE_ASK_MAX_PER_RUN ?? "40");
const INTERNAL_EMAILS = new Set(["kristi@kristinasherk.com", "nic@kristinasherk.com"]);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cronSecret = process.env.CRON_SECRET;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const headerAuth = req.headers.authorization;
  const queryKey = typeof req.query.key === "string" ? req.query.key : "";
  const queryAdmin = typeof req.query.adminpw === "string" ? req.query.adminpw : "";
  const authorized =
    (!!cronSecret && (headerAuth === `Bearer ${cronSecret}` || queryKey === cronSecret)) ||
    (!!adminPassword && queryAdmin === adminPassword);
  if (!authorized) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Test mode: one sample to the given address, nothing marked.
  const testEmail = typeof req.query.testEmail === "string" ? req.query.testEmail.trim() : "";
  if (testEmail && looksLikeEmail(testEmail)) {
    const testName = typeof req.query.testName === "string" ? req.query.testName : "";
    const { subject, html, text } = buildShareAskEmail({ to: testEmail, name: testName });
    const sent = await sendViaResend({ to: testEmail, subject: `[TEST] ${subject}`, html, text });
    res.status(200).json({ mode: "test", to: testEmail, ...sent });
    return;
  }

  const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";
  const now = Date.now();
  let leads;
  try {
    leads = await listLeads();
  } catch (err) {
    console.error("[share-ask] listLeads failed:", err);
    res.status(500).json({ error: "Failed to load leads" });
    return;
  }

  const candidates = leads.filter((l) => {
    if (!l.purchased || !l.purchasedAt) return false;
    if (l.shareAskSentAt || l.shareRewardSentAt) return false;
    const email = (l.email ?? "").trim().toLowerCase();
    if (!looksLikeEmail(email) || INTERNAL_EMAILS.has(email) || isSuppressed(email)) return false;
    const age = now - new Date(l.purchasedAt).getTime();
    return age >= MIN_AGE_MS && age <= MAX_AGE_MS;
  });

  const eligible = [];
  for (const l of candidates) {
    try {
      if (await isEmailUnsubscribed(l.email)) continue;
    } catch {
      continue; // fail closed: never email someone we can't confirm is subscribed
    }
    eligible.push(l);
  }

  if (dryRun) {
    res.status(200).json({
      ok: true,
      mode: "dryRun",
      eligible: eligible.map((l) => ({ email: l.email, name: l.name ?? null, purchasedAt: l.purchasedAt })),
    });
    return;
  }

  let sent = 0;
  const failures: { email: string; status?: number; body?: string }[] = [];
  for (const l of eligible.slice(0, MAX_PER_RUN)) {
    const { subject, html, text } = buildShareAskEmail({ to: l.email, name: l.name });
    try {
      const r = await sendViaResend({ to: l.email, subject, html, text });
      if (r.ok) {
        await setLeadShareFields(l.email, { shareAskSentAt: new Date().toISOString() });
        sent++;
      } else {
        failures.push({ email: l.email, status: r.status, body: r.body });
      }
    } catch (err) {
      failures.push({ email: l.email, body: err instanceof Error ? err.message : String(err) });
    }
  }
  res.status(200).json({ ok: true, eligible: eligible.length, sent, failures });
}
