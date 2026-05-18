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
import { buildShareGraphic } from "./lib/compositeBeforeAfter.js";
import {
  buildRetouchPrompt,
  RETOUCH_MODEL,
  type RetouchTier,
} from "./lib/retouchPrompts.js";

// Bumped from 60s → 300s on 2026-05-15 (Path B launch). The new retouch
// pass runs Gemini Pro Image Preview on every non-Realistic-tier photo
// before the share-graphic step. Pro takes ~10-15s per image. For 6
// photos worst case (all Glam) we need ~90s headroom for the parallel
// retouches plus ~10s for the composites plus a safety buffer.
// Vercel Pro tier max is 300s — we take all of it for safety.
export const maxDuration = 300;

// -------------------- Types --------------------

type Style = "corporate" | "creative" | "executive" | "urban";
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
  // Per-photo retouch tier (Path B 2026-05-15). Same index as photoUrls.
  // "realistic" = no retouch, ship the input photo as-is. "polished" /
  // "glam" = Pro retouching pass via Gemini 3 Pro Image Preview using
  // the prompts in api/lib/retouchPrompts.ts. Optional for back-compat —
  // a missing or empty array falls back to "realistic" for every photo.
  retouchTiers?: ("realistic" | "polished" | "glam")[];
};

export type DeliveryManifest = {
  deliveryId: string;
  timestamp: string;
  email: string;
  style: Style;
  attire: Attire;
  lighting: Lighting;
  background?: Background;
  skin?: Skin;
  referencePhotoUrls: string[];
  deliveredHeadshotUrls: string[];
  // Auto-generated share graphics, one per delivered photo. Same array
  // order as deliveredHeadshotUrls so [i] in one corresponds to [i] in
  // the other. Added 2026-05-04.
  shareGraphicUrls?: string[];
};

// -------------------- Helpers --------------------

// Deliberately pragmatic: rejects "asdf", "foo@bar", and clearly-broken input
// without pretending to implement RFC 5322.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Only accept URLs that actually live on Vercel Blob storage — prevents a
// caller from stuffing arbitrary external links into the manifest.
const BLOB_URL_HOST_RE = /^https?:\/\/[^/]*\.public\.blob\.vercel-storage\.com\//;

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
        <strong>Customer:</strong> ${escapeHtml(manifest.email)}<br/>
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
        subject: "$$$-AI-Generator-Used",
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

  // Backup high-res photo download row — minimal styling (small thumbnail
  // + gold-underline text link), intentionally less prominent than the
  // share-graphic forest-green pills above. Customer already downloaded
  // these on the Download screen at purchase time; this section is purely
  // re-download insurance to cut "I lost my files" support tickets.
  const photoRow = (url: string, i: number) => `
    <tr>
      <td style="padding: 6px; vertical-align: middle; width: 64px;">
        <a href="${escapeHtml(url)}" style="text-decoration: none;">
          <img src="${escapeHtml(url)}" alt="Headshot ${i + 1}" style="width: 56px; height: 70px; object-fit: cover; border-radius: 4px; border: 1px solid #E2DFD8; display: block;" />
        </a>
      </td>
      <td style="padding: 6px 6px 6px 14px; vertical-align: middle;">
        <a href="${escapeHtml(url)}" style="color: #2A2A2A; font-size: 13px; text-decoration: none; border-bottom: 1px solid #C9A961; padding-bottom: 2px;">
          Re-download headshot ${i + 1}
        </a>
      </td>
    </tr>`;

  const photoTable =
    manifest.deliveredHeadshotUrls.length > 0
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; max-width: 480px; margin: 0 auto;">
          ${manifest.deliveredHeadshotUrls.map(photoRow).join("")}
        </table>`
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
        manifest.deliveredHeadshotUrls.length > 0
          ? `
        <div style="margin: 48px 0 0; padding: 24px 0 0; border-top: 1px solid #EFEAE0;">
          <h3 style="font-size: 13px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: #888; margin: 0 0 8px; text-align: center;">
            Your purchased headshots
          </h3>
          <p style="font-size: 13px; line-height: 1.55; color: #888; margin: 0 0 18px; text-align: center; max-width: 440px; margin-left: auto; margin-right: auto;">
            Already saved to your device — these links are here if you need to re-download later.
          </p>
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

// -------------------- Per-photo retouch (Path B) --------------------
//
// For each photo whose retouchTier is "polished" or "glam", fetch the
// original from Blob, run Gemini 3 Pro Image Preview with the matching
// retouching prompt, and upload the retouched bytes back to Blob. The
// returned array is the same length and order as the input photoUrls,
// with each non-Realistic entry replaced by the URL of its retouched
// version. Realistic entries are passed through unchanged.
//
// Failure mode: any single photo's retouch failure (Gemini Pro 429, 5xx,
// no image returned, timeout) falls back to the original photo URL for
// that index. The customer still gets their initial-generation photo —
// the email isn't blocked on Pro retouch failures. Logged loudly so the
// pattern of failures is visible without breaking customer delivery.
//
// Parallelism: all retouches fire concurrently via Promise.allSettled.
// Pro Image Preview's Tier 2 rate limits allow this comfortably for up
// to 6 simultaneous photos. Total wall-clock is dominated by the slowest
// of the parallel calls (~15-20s typical, up to 30s long tail).
async function applyRetouchPass(
  photoUrls: string[],
  tiers: RetouchTier[],
  deliveryId: string,
): Promise<string[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn(
      "[deliver] retouch skipped — GEMINI_API_KEY missing; shipping originals",
    );
    return photoUrls;
  }
  const ai = new GoogleGenAI({ apiKey });

  const tasks = photoUrls.map(async (url, i): Promise<string> => {
    const tier = tiers[i] ?? "realistic";
    if (tier === "realistic") {
      return url; // pass through unchanged
    }
    try {
      // Fetch original bytes from Blob
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
        return url;
      }
      const buf = Buffer.from(await fetchResp.arrayBuffer());
      const mimeType = fetchResp.headers.get("content-type") ?? "image/jpeg";

      // Build the prompt. Age band is unknown server-side (we don't
      // collect age from the customer) — default to "mature" for the
      // more conservative under-eye treatment. Glam ignores age band.
      const prompt = buildRetouchPrompt(tier, "mature");

      const parts: Part[] = [
        { text: prompt },
        {
          inlineData: { mimeType, data: buf.toString("base64") },
        },
      ];
      const resp = await ai.models.generateContent({
        model: RETOUCH_MODEL,
        contents: [{ role: "user", parts }],
      });

      // Find the first inline image in the response.
      const candidates = resp.candidates ?? [];
      for (const c of candidates) {
        const cParts = c.content?.parts ?? [];
        for (const p of cParts) {
          const inline = (
            p as { inlineData?: { mimeType?: string; data?: string } }
          ).inlineData;
          if (inline?.data && inline.mimeType) {
            // Upload retouched bytes back to Blob with a distinct path
            // so the original and retouched versions don't collide.
            const ext = inline.mimeType === "image/png" ? "png" : "jpg";
            const retouchedKey = `deliveries/${deliveryId}/retouched-${i}-${tier}.${ext}`;
            const blob = await put(
              retouchedKey,
              Buffer.from(inline.data, "base64"),
              {
                access: "public",
                contentType: inline.mimeType,
                allowOverwrite: true,
              },
            );
            return blob.url;
          }
        }
      }
      console.warn(
        JSON.stringify({
          type: "retouch_no_image_returned",
          deliveryId,
          photoIndex: i,
          tier,
        }),
      );
      return url;
    } catch (err) {
      console.warn(
        JSON.stringify({
          type: "retouch_threw",
          deliveryId,
          photoIndex: i,
          tier,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return url;
    }
  });

  // Promise.all is fine — each task is wrapped in its own try/catch and
  // never throws, so we can't lose the partial results.
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
  if (!body.style || !["corporate", "creative", "executive", "urban"].includes(body.style)) {
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
    // ---- Per-photo retouch pass (Path B, 2026-05-15) ----
    //
    // For each photo whose retouchTier is "polished" or "glam", run
    // Gemini 3 Pro Image Preview with the corresponding retouching
    // prompt and replace the photo's URL with the retouched version.
    // Realistic-tier photos pass through unchanged.
    //
    // If retouchTiers is missing or empty (back-compat with old client
    // versions still deployed during the rollout), every photo is
    // treated as Realistic — no retouch, ship as-is.
    const incomingTiers: RetouchTier[] =
      Array.isArray(body.retouchTiers) &&
      body.retouchTiers.length === body.photoUrls.length
        ? body.retouchTiers
        : body.photoUrls.map(() => "realistic" as RetouchTier);
    const finalPhotoUrls = await applyRetouchPass(
      body.photoUrls,
      incomingTiers,
      deliveryId,
    );

    // ---- Write the manifest JSON. ----
    // Tiny payload (a few KB at most) so we happily do this server-side — no
    // 413 risk here; the bulky image bytes are already in Blob by the time
    // this endpoint is called.
    // ---- Generate one before/after share graphic per delivered photo. ----
    //
    // Random reference picking, sample-without-replacement so each delivered
    // photo gets a different "before." If the customer bought more photos than
    // they uploaded references (rare), refill the pool by reshuffling. The
    // randomness intentionally leans toward unflattering befores — most
    // uploaded references are casual phone selfies, so a random pick will
    // usually land on something rough enough to make the AFTER pop. Per
    // Kristi's spec on 2026-05-04: "I dont mind if the before's look bad.
    // cause it makes my product look better."
    //
    // QR code points to generationheadshots.com (the marketing site).
    //
    // Compositing happens IN PARALLEL across all photos to keep the deliver
    // round-trip fast — sharp + qrcode are both fast in absolute terms (~1-2s
    // per graphic) but serial would scale poorly. Errors on individual photos
    // are caught and logged; missing share graphics show up as undefined in
    // the result array and the frontend gracefully omits the share UI for
    // those photos.
    const shareGraphicUrls = await generateShareGraphics({
      deliveryId,
      // Use the RETOUCHED URLs for the share graphic AFTERs so the
      // customer (and anyone they share the graphic with) sees the
      // editorial version, not the un-retouched initial generation.
      deliveredPhotoUrls: finalPhotoUrls,
      referencePhotoUrls: body.referencePhotoUrls,
    });

    const manifest: DeliveryManifest = {
      deliveryId,
      timestamp,
      email: body.email,
      style: body.style,
      attire: body.attire,
      lighting: body.lighting,
      background: body.background,
      skin: body.skin,
      referencePhotoUrls: body.referencePhotoUrls,
      // The manifest stores the FINAL (retouched, where applicable) URLs
      // — that's what the customer downloads, what the share graphics
      // reference, and what we'd serve again if Kristi later replays a
      // delivery for support reasons.
      deliveredHeadshotUrls: finalPhotoUrls,
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

    // ---- Burn the $2.99 unlock token (2026-05-15) ----
    //
    // The unlock model: $2.99 buys 2 hours of /api/generate access OR
    // until the customer downloads their first photo (whichever first).
    // This is the "until they download" half: flip metadata.unlock_consumed
    // to "true" on the Stripe Checkout Session so the unlock token can't
    // be reused for a second batch of generations. Customers who want
    // another try pay $2.99 again.
    //
    // Only applies when the client passed stripeSessionId — promo-unlock
    // customers (Tiffany etc.) don't have one, and we intentionally leave
    // their unlock alone so they can come back and use the promo again.
    //
    // Failure mode is non-blocking: if the Stripe metadata write fails
    // for any reason, we still return success to the user — they paid,
    // they got their photo, we'll just have a slightly leaky unlock
    // that the 4h TTL will eventually clean up.
    if (body.stripeSessionId && body.stripeSessionId.startsWith("cs_")) {
      const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
      if (stripeSecretKey) {
        try {
          const formBody = new URLSearchParams();
          formBody.append("metadata[unlock_consumed]", "true");
          const burnResp = await fetch(
            `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(body.stripeSessionId)}`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${stripeSecretKey}`,
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: formBody.toString(),
            },
          );
          if (!burnResp.ok) {
            const errText = await burnResp.text().catch(() => "");
            console.warn(
              JSON.stringify({
                type: "unlock_burn_failed",
                status: burnResp.status,
                sessionId: body.stripeSessionId,
                body: errText.slice(0, 300),
              }),
            );
          }
        } catch (err) {
          console.warn(
            "unlock burn threw:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }

    return res.status(200).json({
      deliveryId,
      // Return the FINAL (retouched) URLs to the client. The download
      // screen renders these directly — customer downloads the
      // retouched version, not the un-retouched initial generation.
      photoUrls: finalPhotoUrls,
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
