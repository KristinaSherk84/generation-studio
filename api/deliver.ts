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
import { buildShareGraphic } from "./lib/compositeBeforeAfter.js";

// Bumped from 10s to 60s on 2026-05-04 to accommodate the auto-share-graphic
// pipeline. Each composite is ~1-2s on Vercel; for 6 photos worst case we
// need headroom. Vercel Pro supports up to 300s but 60s is plenty since the
// composites run in parallel.
export const maxDuration = 60;

// -------------------- Types --------------------

type Style = "corporate" | "creative" | "executive" | "urban";
type Attire = "formal" | "casual" | "keep";
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
};

type DeliveryManifest = {
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
        // onboarding@resend.dev is Resend's shared sender that works without
        // domain verification (free tier). Swap for a verified sender on
        // kristinasherk.com later when we do domain auth.
        from: "AI Generator Alerts <onboarding@resend.dev>",
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
  if (!body.attire || !["formal", "casual", "keep"].includes(body.attire)) {
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
      deliveredPhotoUrls: body.photoUrls,
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
      deliveredHeadshotUrls: body.photoUrls,
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

    return res.status(200).json({
      deliveryId,
      photoUrls: body.photoUrls,
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
