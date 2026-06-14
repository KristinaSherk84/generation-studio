/**
 * POST /api/deliver
 *
 * Beta delivery endpoint. No payment, no email sending.
 *
 * The browser has ALREADY uploaded the clean (unwatermarked) 2K JPEGs
 * directly to Vercel Blob via the same /api/upload client-token flow used
 * for reference photos on Step 3. That's deliberate: pushing multi-MB
 * images through a serverless function hits Vercel's 4.5 MB function-payload
 * ceiling (HTTP 413 FUNCTION_PAYLOAD_TOO_LARGE) as soon as a user picks 2+
 * large headshots. Client-direct uploads bypass the function entirely.
 *
 * So all this endpoint does is:
 *
 *   1. Validate the email and the user's style selections.
 *   2. Write a deliveries/<deliveryId>/manifest.json to Vercel Blob with
 *      the user's email, selections, reference photo URLs, and the
 *      already-uploaded delivered headshot URLs.
 *   3. console.log the full manifest so Kristi gets real-time visibility
 *      in the Vercel function logs during beta.
 *   4. Return the deliveryId + the same photoUrls (echoed for convenience)
 *      so the Download screen can render one button per photo.
 *
 * The manifest is the anchor for Kristi's before/after marketing archive —
 * pull any manifest out of Blob later and you get the email, the original
 * reference selfies, and the final headshots in one place.
 *
 * Handler style: classic VercelRequest / VercelResponse — Fetch-style hangs
 * in practice on Vercel Node runtime. See /api/upload for the incident note.
 */

import { put } from "@vercel/blob";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GoogleGenAI, type Part } from "@google/genai";
import sharp from "sharp";
import { buildShareGraphic } from "./lib/compositeBeforeAfter.js";
import {
  buildRetouchPrompt,
  RETOUCH_MODEL,
  subTiersForTier,
  type RetouchTier,
  type RetouchSubTier,
} from "./lib/retouchPrompts.js";

// Bumped from 60s → 300s on 2026-05-15 (Path B launch). 2026-05-18 Glow
// Up Deluxe pivot: now each Deluxe photo fires BOTH Polished and Glam
// Pro passes in parallel — so worst case 6 photos × 2 sub-tiers = 12
// simultaneous Pro calls. Pro Tier 2 rate limits accommodate this, and
// the parallelism means total wall-clock is still dominated by the
// slowest individual call (~15-25s). Vercel Pro tier max is 300s — we
// take all of it for safety.
export const maxDuration = 300;

// -------------------- Types --------------------

type Style = "corporate" | "creative" | "executive" | "urban" | "healthcare";
type Attire = "formal" | "casual" | "keep" | "medical";
type Lighting = "studio" | "natural" | "dramatic" | "golden";
type Background =
  | "white"
  | "lightgrey"
  | "midgrey"
  | "dark"
  | "blue"
  | "green"
  | "rainbow";
type Skin = "realistic" | "polished" | "glam";

type DeliverRequest = {
  email: string;
  // Customer full name (added 2026-05-22). Required. Captured on the
  // CheckoutScreen alongside email so Kristi can track customers down by
  // name if a support request comes in — email alone isn't always enough.
  // Surfaced in the $$$-AI-Generator-Used usage-alert email + the customer
  // delivery email greeting + the on-disk manifest.
  customerName: string;
  // Public Blob URLs for the CLEAN 2K images — the browser already uploaded
  // them via @vercel/blob/client before calling this endpoint.
  photoUrls: string[];
  referencePhotoUrls: string[]; // Blob URLs from the earlier Step 3 upload
  style: Style;
  attire: Attire;
  lighting: Lighting;
  background?: Background;
  skin?: Skin; // added 2026-04-28; surfaces the Realistic/Polished choice
  // The Stripe Checkout Session ID for the $2.99 entry payment. When a
  // delivery succeeds we flip metadata.unlock_consumed to "true" on this
  // session so /api/generate stops accepting it. Optional — promo-unlock
  // users won't have one, and skipping the metadata write for them is
  // intentional (Tiffany etc. keep their unlock permanently).
  stripeSessionId?: string;
  // Per-photo retouch tier (Glow Up Deluxe pivot 2026-05-18). Same index
  // as photoUrls.
  //   "basic"  — Realistic only, no retouching. $9.99 per photo.
  //   "deluxe" — Customer receives all 3 versions of the headshot:
  //              Realistic + Polished + Glam. $14.99 per photo.
  // Optional for back-compat — a missing or empty array falls back to
  // "basic" for every photo (the safest fallback: no Pro calls, no
  // unexpected per-photo cost).
  retouchTiers?: RetouchTier[];
};

// One delivered headshot, expanded to N versions based on tier.
//   Basic  → just `realistic`. polished and glam are undefined.
//   Deluxe → all three versions populated. If Gemini Pro fails on a
//            sub-tier pass, that field falls back to the realistic URL
//            (so the customer always sees 3 download buttons for a
//            deluxe photo, even if one of the Pro passes hiccupped).
export type DeliveredHeadshot = {
  tier: RetouchTier;
  realistic: string;
  polished?: string;
  glam?: string;
};

export type DeliveryManifest = {
  deliveryId: string;
  timestamp: string;
  email: string;
  // Customer full name (added 2026-05-22). Mirrored to the manifest so a
  // future audit / support lookup can find a customer by name from the
  // saved manifest blob without having to cross-reference the Stripe
  // customer record.
  customerName: string;
  style: Style;
  attire: Attire;
  lighting: Lighting;
  background?: Background;
  skin?: Skin;
  referencePhotoUrls: string[];
  // Structured per-photo delivery info. New shape 2026-05-18 (Glow Up
  // Deluxe pivot). Each entry has a tier + 1-3 URLs depending on tier.
  deliveredHeadshots: DeliveredHeadshot[];
  // Flattened list of all deliverable URLs in the order they appear in
  // deliveredHeadshots (realistic, polished?, glam?). Useful for legacy
  // tooling that wants a flat array; kept in sync with deliveredHeadshots.
  deliveredHeadshotUrls: string[];
  // Auto-generated share graphics, one per delivered headshot (not one
  // per URL). Same array order as deliveredHeadshots. For Basic photos
  // the share graphic uses the Realistic version; for Deluxe photos it
  // uses the Polished version (middle-tier, safest visual default).
  shareGraphicUrls?: string[];
};

// -------------------- Helpers --------------------

// Deliberately pragmatic: rejects "asdf", "foo@bar", and clearly-broken input
// without pretending to implement RFC 5322.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Only accept URLs that actually live on Vercel Blob storage — prevents a
// caller from stuffing arbitrary external links into the manifest.
const BLOB_URL_HOST_RE = /^https?:\/\/[^/]*\.public\.blob\.vercel-storage\.com\//;

// Per-attempt timeout for Gemini Pro retouch calls in runSubTier.
//
// History (2026-05-22): /api/deliver returned 504 to a customer because
// one of the 6 parallel Pro retouch calls hung silently — Promise.all
// never resolved, and the whole function timed out at Vercel's 300s
// ceiling. With this race-against-timeout pattern, a hung call gets
// killed at 90s and a retry fires. Worst case per sub-tier: 2 attempts
// × 90s + 500ms backoff = 180.5s. Six parallel sub-tiers all hitting
// worst case still stay well under the 300s function maxDuration.
const PRO_PER_ATTEMPT_TIMEOUT_MS = 90_000;

// Human-sortable, URL-safe delivery id — e.g. "2026-04-21T09-15-22-a1b2c3".
// The timestamp prefix means browsing /deliveries in the Blob dashboard lists
// newest-last (or newest-first after a simple reverse) without any metadata.
function newDeliveryId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

// Basic HTML escaper so customer email / selections can't smuggle markup into
// the alert email body. Small enough to inline rather than pull in a library.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Fires the "$$$-AI-Generator-Used" alert email to Kristi after a successful
// delivery. Deliberately side-effect only: any failure is swallowed so a Resend
// outage never blocks a customer's delivery. The subject line starts with "$$$"
// so Kristi can filter/star these in Gmail without reading body.
//
// Email design goals:
//   - She can scan it on her phone in 5 seconds and know who used the app.
//   - Thumbnails of both reference photos AND delivered headshots are embedded
//     so she has a visual before/after right in her inbox (useful for
//     marketing, and a preview of the V2 auto-composited share graphic).
//   - A direct link to the manifest JSON on Blob is included for audit / later
//     pairing with the before-after-headshot skill.
async function sendUsageAlertEmail(args: {
  manifest: DeliveryManifest;
  manifestUrl: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // No key set → silently skip. The delivery still succeeds. Log once so
    // future-me can tell the difference between "alert sent" and "alert
    // skipped because env var missing" when watching Vercel logs.
    console.log(
      JSON.stringify({ type: "alert_skipped", reason: "no_resend_api_key" }),
    );
    return;
  }

  const { manifest, manifestUrl } = args;

  // Small thumbnail strip helper — renders a flex-wrap row of <img> tags with
  // fixed max sizes. Email clients strip most CSS, so keep styling inline and
  // conservative (no flexbox — fall back to table-like wrapping via inline-block).
  const imgStrip = (urls: string[], alt: string) =>
    urls
      .map(
        (u) =>
          `<img src="${escapeHtml(u)}" alt="${escapeHtml(alt)}" style="width:120px;height:150px;object-fit:cover;border-radius:6px;margin:4px;display:inline-block;border:1px solid #ddd;" />`,
      )
      .join("");

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#2c2c2a;max-width:640px;">
      <h2 style="margin:0 0 8px 0;font-weight:500;">Someone just used the AI Generator</h2>
      <p style="margin:0 0 16px 0;color:#666;">
        <strong>Name:</strong> ${escapeHtml(manifest.customerName)}<br/>
        <strong>Email:</strong> ${escapeHtml(manifest.email)}<br/>
        <strong>When:</strong> ${escapeHtml(manifest.timestamp)}<br/>
        <strong>Delivery ID:</strong> ${escapeHtml(manifest.deliveryId)}
      </p>
      <p style="margin:0 0 16px 0;color:#666;">
        <strong>Style:</strong> ${escapeHtml(manifest.style)} &nbsp;·&nbsp;
        <strong>Attire:</strong> ${escapeHtml(manifest.attire)} &nbsp;·&nbsp;
        <strong>Lighting:</strong> ${escapeHtml(manifest.lighting)}
        ${manifest.background ? `&nbsp;·&nbsp; <strong>Background:</strong> ${escapeHtml(manifest.background)}` : ""}
        ${manifest.skin ? `&nbsp;·&nbsp; <strong>Skin:</strong> ${escapeHtml(manifest.skin)}` : ""}
      </p>

      <h3 style="margin:20px 0 8px 0;font-size:14px;text-transform:uppercase;letter-spacing:1px;color:#999;">Before (reference photos)</h3>
      <div>${imgStrip(manifest.referencePhotoUrls, "Reference photo")}</div>

      <h3 style="margin:20px 0 8px 0;font-size:14px;text-transform:uppercase;letter-spacing:1px;color:#999;">After (delivered headshots)</h3>
      <div>${imgStrip(manifest.deliveredHeadshotUrls, "Delivered headshot")}</div>

      <p style="margin:24px 0 0 0;font-size:13px;color:#666;">
        <a href="${escapeHtml(manifestUrl)}" style="color:#2c2c2a;">View full delivery manifest (JSON)</a>
      </p>
    </div>
  `;

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Sends from the verified kristinasherk.com Resend domain (same as
        // the customer email below) so deliverability is consistent and
        // these don't trip spam on Kristi's own inbox.
        from: "AI Generator Alerts <kristi@kristinasherk.com>",
        to: ["kristi@kristinasherk.com"],
        // Subject includes the customer name so Kristi can see at a glance
        // in her Gmail list who used the generator without opening the
        // email. Kept the "$$$" prefix so existing filter rules still match.
        subject: `$$$-AI-Generator-Used — ${manifest.customerName}`,
        html,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error(
        JSON.stringify({
          type: "alert_failed",
          status: resp.status,
          body: text.slice(0, 500),
        }),
      );
    } else {
      console.log(
        JSON.stringify({
          type: "alert_sent",
          deliveryId: manifest.deliveryId,
        }),
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "alert_failed",
        reason: error instanceof Error ? error.message : "unknown",
      }),
    );
  }
}

// -------------------- Customer delivery email --------------------
//
// Sends the photos + share graphics + heartstrings note to the customer's
// email address. Triggered after the manifest is written and share graphics
// are composited. Replaces the earlier flow where these all lived on the
// Download screen — moving them to email keeps the Download screen focused
// on "give me my photos" and uses the email channel for the relationship-
// building moment (the heartstrings ask + share-graphic delivery).
//
// Sender: currently `onboarding@resend.dev` (Resend's free shared sender,
// no domain verification needed). Once kristinasherk.com (or
// generationheadshots.com) is verified in Resend's domain settings, swap
// to a branded sender like `kristi@generationheadshots.com` for better
// deliverability and trust. The reply_to header points to Kristi's real
// inbox so customers can reply directly.
//
// BCC: kristi@kristinasherk.com receives a copy of every customer email,
// per roadmap item #9 — gives Kristi a zero-effort audit log she can use
// to pull marketing content from real customer deliveries.
export async function sendCustomerDeliveryEmail(args: {
  manifest: DeliveryManifest;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(
      JSON.stringify({
        type: "customer_email_skipped",
        reason: "no_resend_api_key",
      }),
    );
    return;
  }

  const { manifest } = args;
  const hasShareGraphics =
    manifest.shareGraphicUrls?.some((u) => !!u) ?? false;

  // Share-graphic download row — small thumbnail next to a forest-green
  // "Download" pill link. Inline styles only because email clients strip
  // <style> blocks.
  const shareRow = (url: string, i: number) => `
    <tr>
      <td style="padding: 8px; vertical-align: middle; width: 80px;">
        <a href="${escapeHtml(url)}" style="text-decoration: none;">
          <img src="${escapeHtml(url)}" alt="Share image ${i + 1}" style="width: 72px; height: 100px; object-fit: cover; border-radius: 6px; border: 1px solid #E2DFD8; display: block;" />
        </a>
      </td>
      <td style="padding: 8px 8px 8px 16px; vertical-align: middle;">
        <a href="${escapeHtml(url)}" style="display: inline-block; background: #1B4332; color: #FFFFFF; padding: 12px 22px; border-radius: 999px; text-decoration: none; font-size: 14px; font-weight: 500; letter-spacing: 0.4px;">
          Download share image ${i + 1}
        </a>
      </td>
    </tr>`;

  const shareTable = hasShareGraphics
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; max-width: 600px; margin: 0 auto;">
        ${(manifest.shareGraphicUrls ?? [])
          .map((url, i) => (url ? shareRow(url, i) : ""))
          .join("")}
      </table>`
    : "";

  // Per-version photo download row (Glow Up Deluxe layout 2026-05-18).
  // Each delivered version (Realistic, Polished, Glam) renders as its
  // own rectangular card matching the app's download-screen pattern:
  // photo on the left, label + one-liner in the middle, Download button
  // on the right.
  const versionRow = (args: {
    url: string;
    label: string;
    blurb: string;
    photoIndex: number;
  }) => `
    <tr><td style="padding: 6px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; border: 1px solid #E2DFD8; border-radius: 8px;">
        <tr>
          <td style="padding: 10px; width: 76px; vertical-align: middle;">
            <a href="${escapeHtml(args.url)}" style="text-decoration: none;">
              <img src="${escapeHtml(args.url)}" alt="${escapeHtml(args.label)} version of photo ${args.photoIndex + 1}" style="width: 64px; height: 80px; object-fit: cover; border-radius: 6px; display: block;" />
            </a>
          </td>
          <td style="padding: 10px 14px; vertical-align: middle;">
            <div style="font-size: 14px; font-weight: 500; color: #2A2A2A; line-height: 1.3;">${escapeHtml(args.label)}</div>
            <div style="font-size: 12px; color: #888; line-height: 1.4; margin-top: 2px;">${escapeHtml(args.blurb)}</div>
          </td>
          <td style="padding: 10px; vertical-align: middle; text-align: right; white-space: nowrap;">
            <a href="${escapeHtml(args.url)}" style="display: inline-block; color: #C9A961; font-size: 13px; text-decoration: none; padding: 6px 14px; border: 1px solid #C9A961; border-radius: 6px;">
              Download
            </a>
          </td>
        </tr>
      </table>
    </td></tr>`;

  // One photo block — wraps one (Basic) or three (Deluxe) versionRows
  // under a single photo header with a tier badge.
  const photoBlock = (h: DeliveredHeadshot, i: number) => {
    const isDeluxe = h.tier === "deluxe";
    const tierBadge = isDeluxe
      ? `<span style="display: inline-block; font-size: 11px; font-weight: 500; color: #185FA5; background: #E6F1FB; padding: 2px 10px; border-radius: 6px; margin-left: 8px; letter-spacing: 0.3px;">Glow Up Deluxe</span>`
      : `<span style="display: inline-block; font-size: 11px; color: #888; background: #F1EFE8; padding: 2px 10px; border-radius: 6px; margin-left: 8px; letter-spacing: 0.3px;">Basic</span>`;
    const deluxeSub = isDeluxe
      ? `<p style="font-size: 12px; color: #888; line-height: 1.5; margin: 0 0 10px;">Three versions of the same headshot — keep them all or pick your favorite.</p>`
      : "";

    const rows: string[] = [
      versionRow({
        url: h.realistic,
        label: "Realistic",
        blurb: isDeluxe ? "No retouching. As generated." : "Your headshot exactly as generated.",
        photoIndex: i,
      }),
    ];
    if (h.polished) {
      rows.push(
        versionRow({
          url: h.polished,
          label: "Polished",
          blurb: "Light retouching. Magazine-profile finish.",
          photoIndex: i,
        }),
      );
    }
    if (h.glam) {
      rows.push(
        versionRow({
          url: h.glam,
          label: "Glam",
          blurb: "Editorial beauty-campaign retouching.",
          photoIndex: i,
        }),
      );
    }

    return `
      <div style="margin: 22px 0 0;">
        <div style="margin: 0 0 8px;">
          <span style="font-size: 13px; font-weight: 500; color: #2A2A2A;">Photo ${i + 1}</span>${tierBadge}
        </div>
        ${deluxeSub}
        <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; max-width: 540px; margin: 0; border-spacing: 0;">
          ${rows.join("")}
        </table>
      </div>
    `;
  };

  const photoTable =
    manifest.deliveredHeadshots.length > 0
      ? manifest.deliveredHeadshots.map(photoBlock).join("")
      : "";

  // The customer already downloaded their full-resolution headshots on
  // the Download screen at purchase time. This email's only NEW value
  // is the share-ready graphics with QR code + Kristi's heartstrings
  // ask. Per Kristi 2026-05-04: 'It should say "Your sharable headshot
  // graphic"' — the email is purely about the share asset.
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #2C2C2A; max-width: 640px; margin: 0 auto; background: #FFFFFF; padding: 32px 24px;">

      <!-- Wordmark header -->
      <div style="text-align: center; padding-bottom: 28px; border-bottom: 1px solid #EFEAE0;">
        <span style="font-family: Georgia, 'Times New Roman', serif; font-size: 22px; color: #2A2A2A; letter-spacing: 0.2px;">
          Gener<span style="color: #C9A961; font-style: italic; font-weight: 600;">AI</span>tion <span style="font-weight: 500;">Headshots</span>
        </span>
      </div>

      <!-- Heartstrings card FIRST — sets the tone (gratitude + share ask)
           before the share-graphic download. New title 'Help me spread the
           word!' and new opening 'Thanks for purchasing...' per Kristi
           2026-05-04 (was 'A note from Kristi' / 'Let's face it'). -->
      <div style="margin: 32px 0; padding: 28px 24px; background: #FFFFFF; border: 1px solid #E8E5DD; border-top: 3px solid #C9A961; border-radius: 8px;">
        <h2 style="font-family: Georgia, 'Times New Roman', serif; font-size: 24px; font-weight: 400; font-style: italic; color: #C9A961; margin: 0 0 18px; text-align: center;">
          Help me spread the word!
        </h2>
        <p style="font-size: 14px; line-height: 1.7; color: #2A2A2A; margin: 0 0 12px;">
          Thanks for purchasing your new generated headshots! AI is changing how headshots get made. I built this generator because I'd rather lead the change than be left behind by it. There's no team of engineers behind this — just me, one photographer, leaning into new tools to keep doing this. Your purchase didn't just buy you a headshot — it supported an independent artist and her small business doing what she loves in a changing world.
        </p>
        <p style="font-size: 14px; line-height: 1.7; color: #2A2A2A; margin: 0;">
          If you'd share one of these images on social, you'd help me reach the next person who needs a headshot but doesn't know I exist yet. I see every share. I'm grateful for every one. Enjoy your new, snazzy headshot!
        </p>
      </div>

      ${
        hasShareGraphics
          ? `
        <h1 style="font-family: Georgia, 'Times New Roman', serif; font-size: 24px; font-weight: 400; color: #2A2A2A; margin: 36px 0 10px; text-align: center;">
          Your sharable headshot graphic
        </h1>
        <p style="font-size: 14px; line-height: 1.6; color: #555; margin: 0 0 24px; text-align: center; max-width: 480px; margin-left: auto; margin-right: auto;">
          Ready-to-post before/after with a QR code linking back to me. If a friend scans, they'll land at the same generator.
        </p>
        ${shareTable}
      `
          : `
        <p style="font-size: 14px; line-height: 1.6; color: #555; margin: 32px 0; text-align: center;">
          (Your share graphic didn't generate this time — Kristi has been notified and will follow up.)
        </p>
      `
      }

      <!-- High-res photo backup links — secondary section so customers who
           lose their downloads (cleared cache, switched devices, etc.) can
           re-download from this email instead of opening a support ticket.
           Smaller styling than the share-graphic pills above — these are
           insurance, not the primary action. Added 2026-05-04. -->
      ${
        manifest.deliveredHeadshots.length > 0
          ? `
        <div style="margin: 48px 0 0; padding: 24px 0 0; border-top: 1px solid #EFEAE0;">
          <h3 style="font-size: 13px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: #888; margin: 0 0 16px; text-align: center;">
            Your purchased headshots
          </h3>
          ${photoTable}
        </div>
      `
          : ""
      }

      <!-- Footer -->
      <div style="margin-top: 40px; padding-top: 24px; border-top: 1px solid #EFEAE0; text-align: center; font-size: 12px; color: #888;">
        Questions? Just reply to this email — I read every one.<br/>
        <span style="color: #2C2C2A;">— Kristi</span>
      </div>

    </div>
  `;

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Sender uses kristinasherk.com — Kristi's already-verified Resend
        // domain (free tier: one verified domain only). Earlier draft used
        // Resend's shared 'onboarding@resend.dev' which works but trips spam
        // filters and reads as untrustworthy to recipients.
        // Future migration to generationheadshots.com is desired (matches
        // the new brand) but requires either a paid Resend plan to verify
        // a second domain, OR swapping out the kristinasherk.com domain
        // first and re-verifying. Tracked for V1.x cleanup.
        from: "Kristi at GenerAItion Headshots <kristi@kristinasherk.com>",
        to: [manifest.email],
        // BCC Kristi per roadmap item #9 — gives her a zero-effort audit
        // log of every delivery she can pull marketing content from.
        bcc: ["kristi@kristinasherk.com"],
        // reply_to lands customer replies in Kristi's real inbox even
        // though the from-address is the shared Resend sender.
        reply_to: "kristi@kristinasherk.com",
        subject: "Your sharable headshot graphic",
        html,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error(
        JSON.stringify({
          type: "customer_email_failed",
          status: resp.status,
          body: text.slice(0, 500),
        }),
      );
    } else {
      console.log(
        JSON.stringify({
          type: "customer_email_sent",
          deliveryId: manifest.deliveryId,
          to: manifest.email,
        }),
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "customer_email_failed",
        reason: error instanceof Error ? error.message : "unknown",
      }),
    );
  }
}

// -------------------- Share-graphic generation --------------------

// QR code on every share graphic points to the marketing site so a poster's
// followers can scan and arrive at the funnel's first conversion surface.
const SHARE_QR_URL = "https://generationheadshots.com";

// Cryptographically-meh shuffle is fine here — we just want unbiased order
// for sample-without-replacement on a tiny array. Fisher-Yates.
function shuffleArrayInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * Generate one before/after share graphic per delivered photo. Random
 * reference picking, sample-without-replacement so each delivered photo
 * gets a different "before." If the pool runs out (more delivered photos
 * than reference photos), reshuffles to refill.
 *
 * Returns an array same-length as deliveredPhotoUrls — each entry is the
 * Vercel Blob URL of the share graphic, or empty string if compositing
 * failed for that photo. Frontend renders the share UI per photo only
 * when the URL is non-empty.
 */
async function generateShareGraphics(args: {
  deliveryId: string;
  deliveredPhotoUrls: string[];
  referencePhotoUrls: string[];
}): Promise<string[]> {
  const { deliveryId, deliveredPhotoUrls, referencePhotoUrls } = args;

  // Build the per-photo "before" pool. Refill by reshuffling when exhausted.
  if (referencePhotoUrls.length === 0) {
    return deliveredPhotoUrls.map(() => "");
  }
  let pool = [...referencePhotoUrls];
  shuffleArrayInPlace(pool);
  const beforeAssignments: string[] = deliveredPhotoUrls.map(() => {
    if (pool.length === 0) {
      pool = [...referencePhotoUrls];
      shuffleArrayInPlace(pool);
    }
    return pool.shift() as string;
  });

  // Composite all in parallel and upload to Blob.
  const results = await Promise.all(
    deliveredPhotoUrls.map(async (afterUrl, index) => {
      try {
        const buf = await buildShareGraphic({
          beforeUrl: beforeAssignments[index],
          afterUrl,
          qrTargetUrl: SHARE_QR_URL,
        });
        const key = `deliveries/${deliveryId}/share-${index + 1}.jpg`;
        const blob = await put(key, buf, {
          access: "public",
          contentType: "image/jpeg",
          addRandomSuffix: false,
        });
        return blob.url;
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "share_graphic_failed",
            index,
            deliveryId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return "";
      }
    }),
  );

  return results;
}

// -------------------- Per-photo retouch (Glow Up Deluxe) --------------------
//
// For each photo with tier "deluxe", fan out into TWO parallel Gemini Pro
// Image Preview passes — one Polished, one Glam — using the prompts in
// api/lib/retouchPrompts.ts. The customer receives all three versions
// (Realistic + Polished + Glam) as separate download links in the email.
//
// For tier "basic", no Pro call is needed. The photo passes through with
// just the Realistic URL.
//
// Failure mode per sub-tier: if either Pro call fails (429, 5xx, no image,
// timeout), the failed sub-tier falls back to the Realistic URL. The
// customer still gets 3 download buttons for a deluxe photo — one of
// them will just be a duplicate Realistic. Logged loudly so the failure
// pattern is visible without breaking customer delivery.
//
// Parallelism: every sub-tier call across every deluxe photo fires
// concurrently via Promise.all. For 6 all-deluxe photos that's 12
// simultaneous Pro calls. Tier 2 rate limits accommodate this. Total
// wall-clock is dominated by the slowest individual call (~15-25s).
async function applyRetouchPass(
  photoUrls: string[],
  tiers: RetouchTier[],
  deliveryId: string,
): Promise<DeliveredHeadshot[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn(
      "[deliver] retouch skipped — GEMINI_API_KEY missing; shipping basics",
    );
    return photoUrls.map((url) => ({ tier: "basic", realistic: url }));
  }
  const ai = new GoogleGenAI({ apiKey });

  // Run one sub-tier (polished or glam) Pro pass against a single photo.
  // Returns the Blob URL of the retouched image, or the original URL on
  // any failure path.
  async function runSubTier(
    sourceUrl: string,
    sourceBytes: Buffer,
    sourceMime: string,
    subTier: RetouchSubTier,
    photoIndex: number,
  ): Promise<string> {
    try {
      // Age band is unknown server-side (we don't collect age from the
      // customer) — default to "mature" for the more conservative
      // under-eye treatment. Glam ignores the age band entirely.
      const prompt = buildRetouchPrompt(subTier, "mature");
      const parts: Part[] = [
        { text: prompt },
        {
          inlineData: {
            mimeType: sourceMime,
            data: sourceBytes.toString("base64"),
          },
        },
      ];
      // Pro Image Preview can occasionally hang silently. Race each call
      // against a hard timeout (PRO_PER_ATTEMPT_TIMEOUT_MS) and retry once.
      // imageConfig.aspectRatio "3:4" is kept (prevents recompose); imageSize
      // is intentionally NOT set — see 2026-05-22 finding in
      // feedback_gemini_pro_imageconfig that pinning size constrained the
      // model's retouching aggressiveness.
      let resp: Awaited<
        ReturnType<typeof ai.models.generateContent>
      > | null = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const apiCall = ai.models.generateContent({
            model: RETOUCH_MODEL,
            contents: [{ role: "user", parts }],
            config: { imageConfig: { aspectRatio: "3:4" } },
          });
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(
              () =>
                reject(
                  new Error(
                    `Pro timeout after ${PRO_PER_ATTEMPT_TIMEOUT_MS}ms (attempt ${attempt})`,
                  ),
                ),
              PRO_PER_ATTEMPT_TIMEOUT_MS,
            );
          });
          resp = await Promise.race([apiCall, timeoutPromise]);
          break;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn(
            JSON.stringify({
              type: "retouch_attempt_failed",
              deliveryId,
              photoIndex,
              subTier,
              attempt,
              error: errMsg,
            }),
          );
          if (attempt >= 2) throw err;
          // Brief backoff before retry — a transient hang sometimes
          // clears if the second call routes to a different worker.
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (!resp) {
        // Unreachable in practice (the loop either sets resp or throws),
        // but TypeScript needs the guard before we deref candidates.
        return sourceUrl;
      }

      const candidates = resp.candidates ?? [];
      for (const c of candidates) {
        const cParts = c.content?.parts ?? [];
        for (const p of cParts) {
          const inline = (
            p as { inlineData?: { mimeType?: string; data?: string } }
          ).inlineData;
          if (inline?.data && inline.mimeType) {
            const rawBuffer = Buffer.from(inline.data, "base64");

            // Upscale to 1792x2400 with lanczos3. Background: dropping
            // imageSize "2K" from Gemini Pro's imageConfig on 2026-05-22
            // got us better retouching aesthetic but shrunk the output to
            // ~896x1200 — half the resolution of the Realistic photo in
            // the Deluxe bundle. Lanczos3 is the highest-quality
            // photographic upscaling kernel sharp ships with, and a 2x
            // upscale on a clean retouched portrait is within its sweet
            // spot. Soft-degrade to the raw Pro output on sharp failure
            // so a transient processing error never fails a delivery.
            let outputBuffer: Buffer;
            let outputMime: string;
            try {
              outputBuffer = await sharp(rawBuffer)
                .resize(1792, 2400, {
                  kernel: sharp.kernel.lanczos3,
                  fit: "cover",
                })
                .jpeg({ quality: 92, mozjpeg: true })
                .toBuffer();
              outputMime = "image/jpeg";
            } catch (sharpErr) {
              console.warn(
                JSON.stringify({
                  type: "retouch_upscale_failed",
                  deliveryId,
                  photoIndex,
                  subTier,
                  error:
                    sharpErr instanceof Error
                      ? sharpErr.message
                      : String(sharpErr),
                }),
              );
              outputBuffer = rawBuffer;
              outputMime = inline.mimeType;
            }

            const ext = outputMime === "image/png" ? "png" : "jpg";
            const retouchedKey = `deliveries/${deliveryId}/retouched-${photoIndex}-${subTier}.${ext}`;
            const blob = await put(retouchedKey, outputBuffer, {
              access: "public",
              contentType: outputMime,
              allowOverwrite: true,
            });
            return blob.url;
          }
        }
      }
      console.warn(
        JSON.stringify({
          type: "retouch_no_image_returned",
          deliveryId,
          photoIndex,
          subTier,
        }),
      );
      return sourceUrl;
    } catch (err) {
      console.warn(
        JSON.stringify({
          type: "retouch_threw",
          deliveryId,
          photoIndex,
          subTier,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return sourceUrl;
    }
  }

  const tasks = photoUrls.map(
    async (url, i): Promise<DeliveredHeadshot> => {
      const tier = tiers[i] ?? "basic";

      if (tier === "basic") {
        // No Pro call needed. Just return the original Realistic URL.
        return { tier: "basic", realistic: url };
      }

      // Deluxe: fetch the source bytes ONCE, then run both sub-tier
      // passes in parallel against those bytes. Fetching the original
      // twice would double the Blob bandwidth for no reason.
      try {
        const fetchResp = await fetch(url);
        if (!fetchResp.ok) {
          console.warn(
            JSON.stringify({
              type: "retouch_fetch_failed",
              deliveryId,
              photoIndex: i,
              status: fetchResp.status,
            }),
          );
          // Soft-fall: deluxe degrades to basic if we can't even fetch
          // the source. Customer gets the Realistic version 3x. Better
          // than failing the whole delivery.
          return {
            tier: "deluxe",
            realistic: url,
            polished: url,
            glam: url,
          };
        }
        const buf = Buffer.from(await fetchResp.arrayBuffer());
        const mimeType =
          fetchResp.headers.get("content-type") ?? "image/jpeg";

        // Parallel Polished + Glam.
        const subTiers = subTiersForTier("deluxe"); // ["polished", "glam"]
        const [polished, glam] = await Promise.all(
          subTiers.map((s) => runSubTier(url, buf, mimeType, s, i)),
        );

        return {
          tier: "deluxe",
          realistic: url,
          polished,
          glam,
        };
      } catch (err) {
        console.warn(
          JSON.stringify({
            type: "retouch_deluxe_outer_threw",
            deliveryId,
            photoIndex: i,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        // Catastrophic fall: deluxe photo degrades to all-realistic.
        return {
          tier: "deluxe",
          realistic: url,
          polished: url,
          glam: url,
        };
      }
    },
  );

  return Promise.all(tasks);
}

// -------------------- Handler --------------------

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse | void> {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body as Partial<DeliverRequest>;

  // ---- Validate inputs (fail fast before we touch Blob) ----
  if (
    !body.email ||
    typeof body.email !== "string" ||
    !EMAIL_REGEX.test(body.email)
  ) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }
  // Customer name (added 2026-05-22). Required, trimmed, soft length cap.
  // Trim first so "  " or whitespace-only inputs are rejected. 2-char floor
  // matches the client-side gate; 120-char ceiling is generous (longest
  // realistic full name is ~80 chars) and just stops absurd payloads.
  const customerNameTrimmed =
    typeof body.customerName === "string" ? body.customerName.trim() : "";
  if (customerNameTrimmed.length < 2 || customerNameTrimmed.length > 120) {
    return res.status(400).json({ error: "Please enter your full name." });
  }
  if (
    !Array.isArray(body.photoUrls) ||
    body.photoUrls.length === 0 ||
    body.photoUrls.length > 6 ||
    !body.photoUrls.every(
      (u) => typeof u === "string" && BLOB_URL_HOST_RE.test(u),
    )
  ) {
    return res
      .status(400)
      .json({ error: "photoUrls must be 1–6 Vercel Blob URLs." });
  }
  if (!Array.isArray(body.referencePhotoUrls)) {
    return res.status(400).json({ error: "referencePhotoUrls must be an array" });
  }
  if (!body.style || !["corporate", "creative", "executive", "urban", "healthcare"].includes(body.style)) {
    return res.status(400).json({ error: "Invalid style" });
  }
  if (
    !body.attire ||
    !["formal", "casual", "keep", "medical"].includes(body.attire)
  ) {
    return res.status(400).json({ error: "Invalid attire" });
  }
  if (
    !body.lighting ||
    !["studio", "natural", "dramatic", "golden"].includes(body.lighting)
  ) {
    return res.status(400).json({ error: "Invalid lighting" });
  }
  if (
    body.background &&
    !["white", "lightgrey", "midgrey", "dark", "blue", "green", "rainbow"].includes(
      body.background,
    )
  ) {
    return res.status(400).json({ error: "Invalid background" });
  }
  if (body.skin && !["realistic", "polished", "glam"].includes(body.skin)) {
    return res.status(400).json({ error: "Invalid skin" });
  }

  const deliveryId = newDeliveryId();
  const timestamp = new Date().toISOString();

  try {
    // ---- Per-photo retouch pass (Glow Up Deluxe 2026-05-18) ----
    //
    // Each photo has tier "basic" or "deluxe". Basic photos skip the
    // Pro pass entirely. Deluxe photos fan out into Polished + Glam
    // sub-tier passes in parallel, producing 3 deliverable URLs each.
    //
    // If retouchTiers is missing, malformed, or length-mismatched (e.g.
    // back-compat with old client versions still deployed during the
    // rollout), every photo defaults to "basic" — no Pro calls, safest
    // fallback both for cost and behavior.
    const incomingTiers: RetouchTier[] =
      Array.isArray(body.retouchTiers) &&
      body.retouchTiers.length === body.photoUrls.length &&
      body.retouchTiers.every(
        (t) => t === "basic" || t === "deluxe",
      )
        ? (body.retouchTiers as RetouchTier[])
        : body.photoUrls.map(() => "basic" as RetouchTier);
    const deliveredHeadshots = await applyRetouchPass(
      body.photoUrls,
      incomingTiers,
      deliveryId,
    );

    // ---- Generate one before/after share graphic per delivered photo. ----
    //
    // Share graphic source per photo:
    //   basic  → use the Realistic URL (it's all the customer has)
    //   deluxe → use the Polished URL (middle tier, safest visual default;
    //            per Kristi's spec 2026-05-18 — Polished reads as polished
    //            without the more dramatic Glam reshape risk for shares)
    //
    // Random reference picking, sample-without-replacement so each
    // delivered photo gets a different "before." Per Kristi 2026-05-04:
    // "I dont mind if the before's look bad. cause it makes my product
    // look better." QR points to generationheadshots.com.
    const shareSourceUrls: string[] = deliveredHeadshots.map((h) =>
      h.tier === "deluxe" ? (h.polished ?? h.realistic) : h.realistic,
    );
    const shareGraphicUrls = await generateShareGraphics({
      deliveryId,
      deliveredPhotoUrls: shareSourceUrls,
      referencePhotoUrls: body.referencePhotoUrls,
    });

    // ---- Flatten the structured headshot list into a flat URL array
    //      for manifest back-compat with any external tooling. ----
    const flatDeliveredUrls: string[] = [];
    for (const h of deliveredHeadshots) {
      flatDeliveredUrls.push(h.realistic);
      if (h.polished) flatDeliveredUrls.push(h.polished);
      if (h.glam) flatDeliveredUrls.push(h.glam);
    }

    const manifest: DeliveryManifest = {
      deliveryId,
      timestamp,
      email: body.email,
      customerName: customerNameTrimmed,
      style: body.style,
      attire: body.attire,
      lighting: body.lighting,
      background: body.background,
      skin: body.skin,
      referencePhotoUrls: body.referencePhotoUrls,
      deliveredHeadshots,
      deliveredHeadshotUrls: flatDeliveredUrls,
      shareGraphicUrls,
    };
    const manifestKey = `deliveries/${deliveryId}/manifest.json`;
    const manifestBlob = await put(
      manifestKey,
      JSON.stringify(manifest, null, 2),
      {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: false,
      },
    );

    // ---- Mirror the manifest into function logs so Kristi can watch beta
    //      activity live in the Vercel dashboard. The "type" field makes it
    //      easy to grep if logs ever get noisy. ----
    console.log(JSON.stringify({ type: "delivery", ...manifest }));

    // ---- Fire the $$$-AI-Generator-Used alert email. Awaited (not
    //      fire-and-forget) because serverless functions may terminate before
    //      unawaited promises resolve on Vercel. Resend is typically <500ms
    //      and sendUsageAlertEmail swallows its own errors so a mail blip
    //      cannot fail the delivery response. ----
    await sendUsageAlertEmail({
      manifest,
      manifestUrl: manifestBlob.url,
    });

    // ---- Customer delivery email (NEW 2026-05-04). Sends the photo
    //      download links + share graphic links + heartstrings note to
    //      the customer's email address. This used to all live on the
    //      Download screen; moving it to email keeps that screen focused
    //      on the immediate "give me my photos" goal and uses the email
    //      channel for the relationship-building moment.
    //      BCC'd to kristi@kristinasherk.com per roadmap #9. ----
    await sendCustomerDeliveryEmail({ manifest });

    // ---- Unlock burn DEFERRED (2026-06-12) ----
    //
    // The unlock burn used to happen here, immediately after delivery
    // succeeded. That killed the bonus "regenerate in another style"
    // teaser on the Download screen — it fires its own /api/generate
    // request to show a watermarked preview in a different style, but
    // the sessionId it passes was already burned by this very endpoint
    // so the call returned 402. Bug had been live for months.
    //
    // Fix: defer the burn to the customer's first download click on the
    // Download screen. The frontend fires POST /api/burn-unlock with the
    // sessionId on the first photo download. This matches the original
    // unlock-model intent ("$2.99 buys access until first download or
    // 4h, whichever first") and lets the bonus teaser slip through
    // naturally because it fires on mount, BEFORE any download click.
    //
    // Edge case: a customer who downloads NOTHING never burns the
    // unlock. Acceptable — the 4h TTL is the backstop, and the
    // population of "customers who paid but never downloaded" is
    // basically zero in practice.

    return res.status(200).json({
      deliveryId,
      // Structured per-photo delivery info. Each entry has tier +
      // realistic + optional polished + optional glam. Frontend uses
      // this to render the new Download screen with per-version cards
      // for deluxe photos.
      deliveredHeadshots,
      // Flattened URL list for legacy callers / tooling that just wants
      // a simple array of every downloadable file. Same content as
      // deliveredHeadshots but flattened.
      photoUrls: flatDeliveredUrls,
      shareGraphicUrls,
    });
  } catch (error) {
    console.error("=== /api/deliver FAILED ===");
    console.error("Error type:", error?.constructor?.name);
    console.error(
      "Error message:",
      error instanceof Error ? error.message : String(error),
    );
    if (error && typeof error === "object") {
      console.error(
        "Error JSON:",
        JSON.stringify(error, Object.getOwnPropertyNames(error)),
      );
    }
    const message = error instanceof Error ? error.message : "Delivery failed";
    return res.status(500).json({ error: message });
  }
}
