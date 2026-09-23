/**
 * GET /api/admin/survey-blast  (2026-09-23)
 *
 * One-time "why didn't you buy?" survey email to every NON-buyer lead.
 * Three modes, all behind ADMIN_PASSWORD:
 *
 *   ?pw=…                          PREVIEW (default). Sends nothing. Returns
 *                                  who would get it + counts of who's skipped.
 *   ?pw=…&test=you@example.com     Sends ONE copy (subject prefixed [TEST]).
 *   ?pw=…&send=1&confirm=<N>       Sends to everyone eligible. N must equal
 *                                  the eligible count from the preview, so a
 *                                  stray click can't fire a blast.
 *
 * Who is skipped: anyone marked purchased, anyone with a $ generation
 * unlock, anyone who paid in Stripe (checkout email, incl. aliases),
 * blacklisted emails, Kristi's own addresses, and anyone already sent this
 * survey (so re-running never double-sends).
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import {
  listLeads,
  isEmailBlacklisted,
  getEmailAliasMap,
  looksLikeEmail,
  isEmailUnsubscribed,
} from "../lib/leadStore.js";

export const maxDuration = 300;

const redis = new Redis({
  url: process.env.KV_REST_API_URL ?? "",
  token: process.env.KV_REST_API_TOKEN ?? "",
});

const SENT_KEY = "survey:nonbuyer-2026-09:sent";
const FROM = "Kristi at GenerAItion Headshots <kristi@kristinasherk.com>";
const REPLY_TO = "kristi@kristinasherk.com";
const SITE_LINK = "https://generationheadshots.com";
const INTERNAL = new Set([
  "kristi@kristinasherk.com",
  "nic@kristinasherk.com",
]);

const SUBJECT = "Can I ask you one quick question?";

const OPTIONS = [
  "A. They didn't look like me.",
  "B. I didn't know I had to pay for them.",
  "C. The skin didn't look nice.",
  "D. I didn't like what I was wearing.",
  "E. They looked like AI.",
  "F. I was curious. I don't need headshots right now.",
  "G. Something else (a few words is plenty!).",
];

function buildText(): string {
  return [
    "Hi!",
    "",
    "You're one of the brave folks who tried my brand new headshot app, but you didn't end up buying any headshots. Could you take 2.5 seconds and just reply to this email with the letter that comes closest to why?",
    "",
    ...OPTIONS,
    "",
    "I'm only one person trying to pivot my business in this AI world, and I need all the feedback I can get, especially from people who didn't buy. Your answer is truly invaluable to me right now.",
    "",
    "Thank you so much,",
    "Kristi",
    SITE_LINK,
    "",
    "(Don't want emails like this? Just reply \"unsubscribe\" and I'll take you off my list.)",
  ].join("\n");
}

function buildHtml(): string {
  const opts = OPTIONS.map(
    (o) => `<div style="margin:0 0 6px;">${o.replace(/^([A-G]\.)/, "<strong>$1</strong>")}</div>`,
  ).join("");
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#ffffff;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#2C2C2A;">
<div style="max-width:560px;">
<p style="margin:0 0 14px;">Hi!</p>
<p style="margin:0 0 14px;">You're one of the brave folks who tried my brand new headshot app, but you didn't end up buying any headshots. Could you take 2.5 seconds and just reply to this email with the <strong>letter</strong> that comes closest to why?</p>
<div style="margin:0 0 16px;">${opts}</div>
<p style="margin:0 0 14px;">I'm only one person trying to pivot my business in this AI world, and I need all the feedback I can get, especially from people who didn't buy. Your answer is truly invaluable to me right now.</p>
<p style="margin:0 0 2px;">Thank you so much,</p>
<p style="margin:0 0 2px;">Kristi</p>
<p style="margin:0 0 22px;"><a href="${SITE_LINK}" style="color:#1B4332;">generationheadshots.com</a></p>
<p style="margin:0;font-size:12px;color:#888780;">Don't want emails like this? Just reply "unsubscribe" and I'll take you off my list.</p>
</div></body></html>`;
}

/** Every email that completed a paid Stripe checkout (lowercased). */
async function stripePaidEmails(): Promise<Set<string> | null> {
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

async function eligibleRecipients(exclude: Set<string>) {
  const leads = await listLeads();
  const paid = await stripePaidEmails();
  if (paid === null) {
    // Fail closed: without Stripe we can't be sure who paid.
    throw new Error("stripe_unavailable");
  }
  // Fold aliases: a lead whose alias paid counts as a buyer.
  const aliasMap = await getEmailAliasMap();
  const paidCanonical = new Set<string>();
  for (const e of paid) paidCanonical.add((aliasMap[e] ?? e).toLowerCase());

  let alreadySent: string[] = [];
  try {
    alreadySent = ((await redis.smembers(SENT_KEY)) as string[] | null) ?? [];
  } catch {
    alreadySent = [];
  }
  const sentSet = new Set(alreadySent.map((e) => e.toLowerCase()));

  const skipped = {
    excludedByKristi: 0,
    unsubscribed: 0,
    purchased: 0,
    paidInStripe: 0,
    blacklisted: 0,
    internal: 0,
    alreadySent: 0,
    invalid: 0,
  };
  const eligible: string[] = [];
  const seen = new Set<string>();
  for (const l of leads) {
    const e = (l.email ?? "").trim().toLowerCase();
    if (!e || seen.has(e)) continue;
    seen.add(e);
    if (!looksLikeEmail(e)) { skipped.invalid++; continue; }
    if (INTERNAL.has(e)) { skipped.internal++; continue; }
    if (exclude.has(e)) { skipped.excludedByKristi++; continue; }
    if (l.purchased || (l.entryUnlockUsd ?? 0) > 0) { skipped.purchased++; continue; }
    if (paid.has(e) || paidCanonical.has(e)) { skipped.paidInStripe++; continue; }
    if (sentSet.has(e)) { skipped.alreadySent++; continue; }
    if (await isEmailBlacklisted(e)) { skipped.blacklisted++; continue; }
    if (await isEmailUnsubscribed(e)) { skipped.unsubscribed++; continue; }
    eligible.push(e);
  }
  return { totalLeads: leads.length, eligible, skipped };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const text = buildText();
  const html = buildHtml();

  // ---- TEST: one copy to one address ----
  const test = typeof req.query.test === "string" ? req.query.test.trim() : "";
  if (test) {
    if (!looksLikeEmail(test)) {
      res.status(400).json({ ok: false, error: "bad test email" });
      return;
    }
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: [test],
        reply_to: REPLY_TO,
        subject: `[TEST] ${SUBJECT}`,
        html,
        text,
      }),
    });
    res.status(200).json({ ok: r.ok, mode: "test", to: test, status: r.status });
    return;
  }

  // ?exclude=a@x.com,b@y.com — hand-picked people to leave out this run.
  const exclude = new Set(
    (typeof req.query.exclude === "string" ? req.query.exclude : "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

  let data;
  try {
    data = await eligibleRecipients(exclude);
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err instanceof Error ? err.message : err) });
    return;
  }

  // ---- PREVIEW (default) ----
  if (req.query.send !== "1") {
    res.status(200).json({
      ok: true,
      mode: "preview",
      subject: SUBJECT,
      totalLeads: data.totalLeads,
      eligibleCount: data.eligible.length,
      skipped: data.skipped,
      firstTen: data.eligible.slice(0, 10),
      textPreview: text,
    });
    return;
  }

  // ---- SEND: confirm must match the eligible count ----
  const confirm = Number(req.query.confirm);
  if (!Number.isInteger(confirm) || confirm !== data.eligible.length) {
    res.status(400).json({
      ok: false,
      error: "confirm must equal eligibleCount",
      eligibleCount: data.eligible.length,
    });
    return;
  }

  let sent = 0;
  let failed = 0;
  const failures: string[] = [];
  const t0 = Date.now();
  for (let i = 0; i < data.eligible.length; i += 100) {
    if (Date.now() - t0 > 270_000) break; // leave headroom; re-run sends the rest
    const chunk = data.eligible.slice(i, i + 100);
    const r = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(
        chunk.map((to) => ({ from: FROM, to: [to], reply_to: REPLY_TO, subject: SUBJECT, html, text })),
      ),
    });
    if (r.ok) {
      sent += chunk.length;
      try {
        await redis.sadd(SENT_KEY, chunk[0], ...chunk.slice(1));
      } catch {
        /* dedupe marker is best-effort */
      }
    } else {
      failed += chunk.length;
      const body = await r.text().catch(() => "");
      failures.push(`batch ${i / 100 + 1}: ${r.status} ${body.slice(0, 160)}`);
    }
    await sleep(700); // stay under Resend's per-second limit
  }
  const remaining = data.eligible.length - sent - failed;
  console.log(JSON.stringify({ type: "survey_blast", sent, failed, remaining }));
  res.status(200).json({ ok: failed === 0, mode: "send", sent, failed, remaining, failures });
}
