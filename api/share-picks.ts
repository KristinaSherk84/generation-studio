/**
 * POST /api/share-picks  (2026-10-22, Kristi)
 *
 * "Share for approval": a company employee picks headshots, then sends those
 * picks to their manager (or whoever pays). This makes (or reuses) a private
 * link to /approve/<id> that shows ONLY the shots in the employee's cart, and
 * can email that link to the manager.
 *
 * Body: {
 *   token: string,           // the gallery (resume) token
 *   urls?: string[],         // the cart as the screen shows it right now
 *   approverEmail?: string,  // optional — we email them the link
 * }
 * Returns { ok: true, url, count, emailed, emailNote? } or { ok:false, reason }.
 *
 * The link id is random and unguessable; the gallery token never leaves the
 * employee's browser. Approver emails are capped per link per day.
 */

import { randomBytes } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getSession,
  setSessionCart,
  ensureShareId,
  bumpShareEmailCount,
} from "./lib/sessionStore.js";
import { looksLikeEmail, isEmailBlacklisted } from "./lib/leadStore.js";
import { isSuppressed } from "./lib/doNotSend.js";

export const maxDuration = 15;

const SITE = "https://generationheadshots.com";
const MAX_EMAILS_PER_DAY = 5;
const KRISTI = "kristi@kristinasherk.com";

const BASE62 =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
// 20 chars of base62 from crypto bytes (~119 bits). The tiny modulo bias
// doesn't matter at this length.
function newShareId(): string {
  const bytes = randomBytes(20);
  let s = "";
  for (let i = 0; i < 20; i++) s += BASE62[bytes[i] % BASE62.length];
  return s;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendApproverEmail(args: {
  to: string;
  ownerEmail: string;
  url: string;
  picks: string[];
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(JSON.stringify({ type: "approval_email_skipped", reason: "no_resend_api_key" }));
    return false;
  }
  const { to, ownerEmail, url, picks } = args;
  const n = picks.length;
  const thumbs = picks
    .slice(0, 8)
    .map(
      (u) =>
        `<a href="${esc(url)}"><img src="${esc(u)}" alt="Headshot" width="140" style="width:140px;height:auto;border-radius:6px;margin:4px;display:inline-block;border:1px solid #E8E8E6;vertical-align:top;" /></a>`,
    )
    .join("");
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#2C2C2A;max-width:600px;margin:0 auto;padding:24px 20px;">
      <p style="font-size:16px;line-height:1.6;margin:0 0 18px;">
        <strong>${esc(ownerEmail)}</strong> chose ${n} headshot${n === 1 ? "" : "s"} and would like you to review and approve ${n === 1 ? "it" : "them"}.
      </p>
      <p style="margin:0 0 22px;">
        <a href="${esc(url)}" style="display:inline-block;background:#1B4332;color:#FFFFFF;padding:13px 26px;border-radius:999px;text-decoration:none;font-size:15px;font-weight:600;">Review &amp; approve &rarr;</a>
      </p>
      <div style="margin:0 0 20px;">${thumbs}</div>
      <p style="font-size:13px;line-height:1.6;color:#888780;margin:0;">
        When you buy, you and ${esc(ownerEmail)} both get the finished photos by email.
        Questions? Just reply — I read every email.<br/>— Kristi, GenerAItion Headshots
      </p>
    </div>
  `;
  const text = `${ownerEmail} chose ${n} headshot${n === 1 ? "" : "s"} and would like you to review and approve ${n === 1 ? "it" : "them"}.\n\nReview & approve: ${url}\n\nWhen you buy, you and ${ownerEmail} both get the finished photos by email.\n— Kristi, GenerAItion Headshots`;
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Kristi at GenerAItion Headshots <kristi@kristinasherk.com>",
        to: [to],
        reply_to: KRISTI,
        subject: `${ownerEmail} picked headshots for your approval`,
        html,
        text,
      }),
    });
    if (!resp.ok) {
      const body = (await resp.text().catch(() => "")).slice(0, 300);
      console.error(JSON.stringify({ type: "approval_email_failed", status: resp.status, body }));
      return false;
    }
    console.log(JSON.stringify({ type: "approval_email_sent", to, owner: ownerEmail, count: n }));
    return true;
  } catch (err) {
    console.error(
      JSON.stringify({
        type: "approval_email_failed",
        reason: err instanceof Error ? err.message : "unknown",
      }),
    );
    return false;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false });
    return;
  }
  const body = (req.body ?? {}) as {
    token?: unknown;
    urls?: unknown;
    approverEmail?: unknown;
  };
  const token = typeof body.token === "string" ? body.token : "";
  if (!/^[A-Za-z0-9]{16,48}$/.test(token)) {
    res.status(400).json({ ok: false, reason: "bad_input" });
    return;
  }
  const approverEmail =
    typeof body.approverEmail === "string" ? body.approverEmail.trim() : "";
  if (approverEmail && !looksLikeEmail(approverEmail)) {
    res.status(400).json({ ok: false, reason: "invalid_email" });
    return;
  }

  try {
    // Save the cart the screen shows right now first, so the link matches
    // even if the background cart save hasn't landed yet.
    if (Array.isArray(body.urls)) await setSessionCart(token, body.urls);
    const session = await getSession(token);
    if (!session) {
      res.status(404).json({ ok: false, reason: "not_found" });
      return;
    }
    const ownerEmail = typeof session.email === "string" ? session.email : "";
    if (ownerEmail && (await isEmailBlacklisted(ownerEmail).catch(() => false))) {
      res.status(403).json({ ok: false, reason: "blocked" });
      return;
    }
    const bought = new Set(session.purchasedUrls ?? []);
    const picks = (session.cartUrls ?? []).filter((u) => !bought.has(u));
    if (picks.length === 0) {
      res.status(400).json({ ok: false, reason: "empty_cart" });
      return;
    }
    const id = await ensureShareId(token, newShareId());
    if (!id) {
      res.status(404).json({ ok: false, reason: "not_found" });
      return;
    }
    const url = `${SITE}/approve/${id}`;

    let emailed = false;
    let emailNote: string | undefined;
    if (approverEmail) {
      if (isSuppressed(approverEmail)) {
        emailNote = "suppressed";
      } else if ((await bumpShareEmailCount(id)) > MAX_EMAILS_PER_DAY) {
        emailNote = "rate_limited";
      } else {
        emailed = await sendApproverEmail({
          to: approverEmail,
          ownerEmail: ownerEmail || "Your team member",
          url,
          picks,
        });
        if (!emailed) emailNote = "send_failed";
      }
    }
    console.log(
      JSON.stringify({ type: "share_picks", owner: ownerEmail, count: picks.length, emailed, emailNote }),
    );
    res.status(200).json({ ok: true, url, count: picks.length, emailed, emailNote });
  } catch (err) {
    console.warn(
      "[share-picks] failed:",
      err instanceof Error ? err.message : String(err),
    );
    res.status(200).json({ ok: false, reason: "store_error" });
  }
}
