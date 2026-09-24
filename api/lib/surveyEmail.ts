/**
 * Non-buyer "why didn't you buy?" survey email (2026-09-24).
 * Shared by the one-time blast (/api/admin/survey-blast) and the automatic
 * 7-days-later send (/api/survey-auto).
 *
 * Replies go to SURVEY_REPLY_TO — a Resend receiving address. Resend
 * forwards each reply to /api/feedback-inbound, which logs the letter on
 * the /feedback page. If SURVEY_REPLY_TO isn't set yet, replies fall back
 * to Kristi's inbox (the old behavior).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Redis } from "@upstash/redis";
import {
  listLeads,
  isEmailBlacklisted,
  isEmailUnsubscribed,
  getEmailAliasMap,
  looksLikeEmail,
} from "./leadStore.js";

export const redis = new Redis({
  url: process.env.KV_REST_API_URL ?? "",
  token: process.env.KV_REST_API_TOKEN ?? "",
});

/** Everyone who has ever been sent the survey (blast or auto). */
export const SURVEY_SENT_KEY = "survey:nonbuyer-2026-09:sent";

export const SURVEY_FROM =
  "Kristi at GenerAItion Headshots <kristi@kristinasherk.com>";
export const SURVEY_SUBJECT = "Can I ask you one quick question?";
const SITE = (process.env.SITE_URL || "https://generationheadshots.com").replace(/\/$/, "");

export function surveyReplyTo(): string {
  const r = (process.env.SURVEY_REPLY_TO ?? "").trim();
  return r || "kristi@kristinasherk.com";
}

export const SURVEY_OPTIONS: { letter: string; label: string }[] = [
  { letter: "A", label: "They didn't look like me." },
  { letter: "B", label: "I didn't know I had to pay for them." },
  { letter: "C", label: "The skin didn't look nice." },
  { letter: "D", label: "I didn't like what I was wearing." },
  { letter: "E", label: "They looked like AI." },
  { letter: "F", label: "I was curious. I don't need headshots right now." },
  { letter: "G", label: "Something else (a few words is plenty!)." },
];

// ---- One-click unsubscribe links (signed so nobody can unsubscribe others) ----
function unsubSecret(): string {
  return process.env.UNSUB_SECRET || process.env.ADMIN_PASSWORD || "gh-unsub";
}
export function signUnsub(email: string): string {
  return createHmac("sha256", unsubSecret())
    .update(email.trim().toLowerCase())
    .digest("hex")
    .slice(0, 32);
}
export function verifyUnsub(email: string, sig: string): boolean {
  const want = Buffer.from(signUnsub(email));
  const got = Buffer.from(String(sig || ""));
  return want.length === got.length && timingSafeEqual(want, got);
}
export function unsubscribeUrl(email: string): string {
  const e = email.trim().toLowerCase();
  return `${SITE}/api/unsubscribe-link?e=${encodeURIComponent(e)}&s=${signUnsub(e)}`;
}

export function buildSurveyText(email: string): string {
  return [
    "Hi!",
    "",
    "You're one of the brave folks who tried my brand new headshot app, but you didn't end up buying any headshots. Could you take 2.5 seconds and just reply to this email with the letter that comes closest to why?",
    "",
    ...SURVEY_OPTIONS.map((o) => `${o.letter}. ${o.label}`),
    "",
    "I'm only one person trying to pivot my business in this AI world, and I need all the feedback I can get, especially from people who didn't buy. Your answer is truly invaluable to me right now.",
    "",
    "Thank you so much,",
    "Kristi",
    SITE,
    "",
    `Unsubscribe: ${unsubscribeUrl(email)}`,
  ].join("\n");
}

export function buildSurveyHtml(email: string): string {
  const opts = SURVEY_OPTIONS.map(
    (o) => `<div style="margin:0 0 6px;"><strong>${o.letter}.</strong> ${o.label}</div>`,
  ).join("");
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#ffffff;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#2C2C2A;">
<div style="max-width:560px;">
<p style="margin:0 0 14px;">Hi!</p>
<p style="margin:0 0 14px;">You're one of the brave folks who tried my brand new headshot app, but you didn't end up buying any headshots. Could you take 2.5 seconds and just reply to this email with the <strong>letter</strong> that comes closest to why?</p>
<div style="margin:0 0 16px;">${opts}</div>
<p style="margin:0 0 14px;">I'm only one person trying to pivot my business in this AI world, and I need all the feedback I can get, especially from people who didn't buy. Your answer is truly invaluable to me right now.</p>
<p style="margin:0 0 2px;">Thank you so much,</p>
<p style="margin:0 0 2px;">Kristi</p>
<p style="margin:0 0 22px;"><a href="${SITE}" style="color:#1B4332;">generationheadshots.com</a></p>
<p style="margin:0;font-size:12px;color:#888780;">Don't want emails like this? <a href="${unsubscribeUrl(email)}" style="color:#888780;">Unsubscribe</a>.</p>
</div></body></html>`;
}

/** Resend payload for one survey email. */
export function surveyPayload(to: string, subjectPrefix = "") {
  return {
    from: SURVEY_FROM,
    to: [to],
    reply_to: surveyReplyTo(),
    subject: `${subjectPrefix}${SURVEY_SUBJECT}`,
    html: buildSurveyHtml(to),
    text: buildSurveyText(to),
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl(to)}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

/** Every email that completed a paid Stripe checkout (lowercased), or
 *  null if Stripe couldn't be read (callers must then fail closed). */
export async function stripePaidEmails(): Promise<Set<string> | null> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const out = new Set<string>();
  let startingAfter: string | undefined;
  try {
    for (let page = 0; page < 20; page++) {
      const url = new URL("https://api.stripe.com/v1/checkout/sessions");
      url.searchParams.set("limit", "100");
      if (startingAfter) url.searchParams.set("starting_after", startingAfter);
      const r = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!r.ok) return null;
      const d = (await r.json()) as {
        data?: Array<{
          id: string;
          payment_status?: string;
          customer_details?: { email?: string | null } | null;
          customer_email?: string | null;
        }>;
        has_more?: boolean;
      };
      const rows = d.data ?? [];
      for (const s of rows) {
        if (s.payment_status !== "paid") continue;
        const e = (s.customer_details?.email ?? s.customer_email ?? "")
          .trim()
          .toLowerCase();
        if (e) out.add(e);
      }
      if (!d.has_more || rows.length === 0) break;
      startingAfter = rows[rows.length - 1].id;
    }
    return out;
  } catch {
    return null;
  }
}

const INTERNAL = new Set(["kristi@kristinasherk.com", "nic@kristinasherk.com"]);

/**
 * Who should get the survey. Skips buyers (lead flag, $ unlock, or Stripe
 * under any alias), blocked, unsubscribed, internal, already-surveyed, and
 * hand-excluded emails. Optional age window on the lead's last activity
 * (used by the automatic 7-days-later send). Throws "stripe_unavailable"
 * if Stripe can't be read — we never risk surveying a buyer.
 */
export async function eligibleSurveyRecipients(opts: {
  exclude?: Set<string>;
  minAgeMs?: number;
  maxAgeMs?: number;
}) {
  const exclude = opts.exclude ?? new Set<string>();
  const leads = await listLeads();
  const paid = await stripePaidEmails();
  if (paid === null) throw new Error("stripe_unavailable");
  const aliasMap = await getEmailAliasMap();
  const paidCanonical = new Set<string>();
  for (const e of paid) paidCanonical.add((aliasMap[e] ?? e).toLowerCase());

  let alreadySent: string[] = [];
  try {
    alreadySent = ((await redis.smembers(SURVEY_SENT_KEY)) as string[] | null) ?? [];
  } catch {
    // Can't confirm who already got it → send to nobody this run.
    throw new Error("sent_list_unavailable");
  }
  const sentSet = new Set(alreadySent.map((e) => e.toLowerCase()));

  const skipped = {
    excludedByKristi: 0,
    outsideTimeWindow: 0,
    unsubscribed: 0,
    purchased: 0,
    paidInStripe: 0,
    blacklisted: 0,
    internal: 0,
    alreadySent: 0,
    invalid: 0,
  };
  const now = Date.now();
  const eligible: string[] = [];
  const seen = new Set<string>();
  for (const l of leads) {
    const e = (l.email ?? "").trim().toLowerCase();
    if (!e || seen.has(e)) continue;
    seen.add(e);
    if (!looksLikeEmail(e)) { skipped.invalid++; continue; }
    if (INTERNAL.has(e)) { skipped.internal++; continue; }
    if (exclude.has(e)) { skipped.excludedByKristi++; continue; }
    if (sentSet.has(e)) { skipped.alreadySent++; continue; }
    if (l.purchased || (l.entryUnlockUsd ?? 0) > 0) { skipped.purchased++; continue; }
    if (paid.has(e) || paidCanonical.has(e)) { skipped.paidInStripe++; continue; }
    if (opts.minAgeMs !== undefined || opts.maxAgeMs !== undefined) {
      const seenMs = Date.parse(l.lastSeenAt || l.createdAt);
      const age = Number.isFinite(seenMs) ? now - seenMs : -1;
      if (
        age < 0 ||
        (opts.minAgeMs !== undefined && age < opts.minAgeMs) ||
        (opts.maxAgeMs !== undefined && age > opts.maxAgeMs)
      ) {
        skipped.outsideTimeWindow++;
        continue;
      }
    }
    if (await isEmailBlacklisted(e)) { skipped.blacklisted++; continue; }
    if (await isEmailUnsubscribed(e)) { skipped.unsubscribed++; continue; }
    eligible.push(e);
  }
  return { totalLeads: leads.length, eligible, skipped };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Send the survey to a list, 100 per Resend batch call. Marks each
 *  successful recipient in SURVEY_SENT_KEY so nobody gets it twice. */
export async function sendSurveyBatch(
  apiKey: string,
  recipients: string[],
  deadlineMs: number,
): Promise<{ sent: number; failed: number; failures: string[] }> {
  let sent = 0;
  let failed = 0;
  const failures: string[] = [];
  for (let i = 0; i < recipients.length; i += 100) {
    if (Date.now() > deadlineMs) break;
    const chunk = recipients.slice(i, i + 100);
    const r = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(chunk.map((to) => surveyPayload(to))),
    });
    if (r.ok) {
      sent += chunk.length;
      try {
        await redis.sadd(SURVEY_SENT_KEY, chunk[0], ...chunk.slice(1));
      } catch {
        /* dedupe marker is best-effort */
      }
    } else {
      failed += chunk.length;
      const body = await r.text().catch(() => "");
      failures.push(`batch ${i / 100 + 1}: ${r.status} ${body.slice(0, 160)}`);
    }
    await sleep(700);
  }
  return { sent, failed, failures };
}
