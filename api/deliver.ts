/**
 * POST /api/deliver
 *
 * Beta delivery endpoint. No payment, no email sending. The user has picked
 * their favorites on the Grid screen; this endpoint:
 *
 *   1. Uploads the CLEAN 2K files (no watermark — the watermark on the thumbnail
 *      is a client-side CSS overlay, the underlying bytes returned from
 *      /api/generate are already unwatermarked) to Vercel Blob storage.
 *   2. Writes a per-delivery manifest.json containing the user's email, their
 *      style/attire/lighting/background selections, the URLs of the reference
 *      photos they uploaded, and the URLs of the delivered headshots.
 *   3. Logs the full manifest to Vercel function logs so Kristi gets real-time
 *      visibility during beta.
 *   4. Returns the public Blob URLs so the Download screen can render one
 *      download button per photo.
 *
 * The manifest is the anchor for Kristi's before/after marketing archive — pull
 * it up in Vercel Blob later and you get the email + original selfies + final
 * headshots in one bundle.
 *
 * Storage layout (slash-separated keys simulate folders in Blob's dashboard):
 *   deliveries/<deliveryId>/manifest.json
 *   deliveries/<deliveryId>/photo-1.jpg
 *   deliveries/<deliveryId>/photo-2.jpg
 *   ...
 *
 * Handler style: classic VercelRequest / VercelResponse — same reason as
 * /api/generate and /api/upload. Fetch-style handler hangs in practice.
 */

import { put } from "@vercel/blob";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// Uploads can be chunky (six 2K JPEGs at ~1-3 MB each) but each put() is fast,
// and we do them in parallel. 60s is a comfortable ceiling even on Hobby.
export const maxDuration = 60;

// -------------------- Types --------------------

type Style = "corporate" | "creative" | "executive";
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

type DeliverRequest = {
  email: string;
  images: string[]; // base64 data URLs of the selected headshots
  referencePhotoUrls: string[]; // Blob URLs from the earlier upload step
  style: Style;
  attire: Attire;
  lighting: Lighting;
  background?: Background;
};

type DeliveryManifest = {
  deliveryId: string;
  timestamp: string;
  email: string;
  style: Style;
  attire: Attire;
  lighting: Lighting;
  background?: Background;
  referencePhotoUrls: string[];
  deliveredHeadshotUrls: string[];
};

// -------------------- Helpers --------------------

// Deliberately pragmatic: rejects "asdf", "foo@bar", and clearly-broken input
// without pretending to implement RFC 5322.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Pull the raw bytes out of a "data:image/jpeg;base64,XXXX" URL.
function decodeDataUrl(dataUrl: string): { mime: string; buffer: Buffer } {
  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!match) {
    throw new Error("One of the selected images is not a recognizable image data URL.");
  }
  const [, mime, base64] = match;
  return { mime, buffer: Buffer.from(base64, "base64") };
}

function mimeToExt(mime: string): string {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "bin";
}

// Human-sortable, URL-safe delivery id — e.g. "2026-04-21T09-15-22-a1b2c3".
// The timestamp prefix means browsing /deliveries in the Blob dashboard lists
// newest-last (or newest-first after a simple reverse) without any metadata.
function newDeliveryId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
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
  if (!Array.isArray(body.images) || body.images.length === 0 || body.images.length > 6) {
    return res
      .status(400)
      .json({ error: "Pick between 1 and 6 photos to deliver." });
  }
  if (!Array.isArray(body.referencePhotoUrls)) {
    return res.status(400).json({ error: "referencePhotoUrls must be an array" });
  }
  if (!body.style || !["corporate", "creative", "executive"].includes(body.style)) {
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

  const deliveryId = newDeliveryId();
  const timestamp = new Date().toISOString();

  try {
    // ---- Upload every selected image to Blob in parallel. ----
    // Each put() returns a `url` that's public and permanent (no expiry). We
    // intentionally disable addRandomSuffix so our slash-separated keys stay
    // predictable inside a delivery folder — Kristi can bookmark a manifest
    // and know the photos sit right next to it.
    const photoUrls = await Promise.all(
      body.images.map(async (dataUrl, i) => {
        const { mime, buffer } = decodeDataUrl(dataUrl);
        const ext = mimeToExt(mime);
        const key = `deliveries/${deliveryId}/photo-${i + 1}.${ext}`;
        const blob = await put(key, buffer, {
          access: "public",
          contentType: mime,
          addRandomSuffix: false,
        });
        return blob.url;
      }),
    );

    // ---- Write the manifest JSON next to the photos. ----
    const manifest: DeliveryManifest = {
      deliveryId,
      timestamp,
      email: body.email,
      style: body.style,
      attire: body.attire,
      lighting: body.lighting,
      background: body.background,
      referencePhotoUrls: body.referencePhotoUrls,
      deliveredHeadshotUrls: photoUrls,
    };
    const manifestKey = `deliveries/${deliveryId}/manifest.json`;
    await put(manifestKey, JSON.stringify(manifest, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    // ---- Mirror the manifest into function logs so Kristi can watch
    //      beta activity live in the Vercel dashboard. The "type" field
    //      makes it easy to grep if logs ever get noisy. ----
    console.log(JSON.stringify({ type: "delivery", ...manifest }));

    return res.status(200).json({ deliveryId, photoUrls });
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
