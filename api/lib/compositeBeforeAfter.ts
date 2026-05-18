/**
 * Build a before/after share graphic for delivery.
 *
 * V3 layout (1200x1600) — clean, vector-only text:
 *   - Full canvas: AFTER headshot, cover-fit
 *   - Bottom-left: circular BEFORE inset with white ring + drop shadow
 *     (no label bar, removed 2026-05-04 — was visually heavy and the
 *     SVG-text label rendered as missing-glyph squares on Vercel)
 *   - Bottom-right: white card containing a QR code linking to the
 *     share URL, with a "Scan to try it yourself" caption beneath
 *     the QR inside the same card. Caption is rendered from
 *     pre-computed SVG vector paths (see lib/textPaths.ts) so it's
 *     immune to the font-tofu problem that bit V1 — librsvg renders
 *     `<path>` elements as pure vectors with zero font dependency.
 */

import sharp from "sharp";
import QRCode from "qrcode";
import {
  CAPTION_ASCENT_FU,
  CAPTION_DESCENT_FU,
  CAPTION_LINES,
  CAPTION_UPM,
  renderCenteredLinesGroup,
} from "./textPaths.js";
import { detectFaceBox, type NormalizedBox } from "./detectFaceBox.js";

/** Fraction of the BEFORE-photo height the face should fill.
 *  Evolution: 0.70 (tight circle) → 0.50 (Polaroid v1) → 0.35 (current).
 *  Kristi 2026-05-06 (later that same day): even 50% was too tight on
 *  real customer photos — the Polaroid still cropped to forehead/eyes
 *  on some uploads. 0.35 gives the face roughly a third of the
 *  Polaroid height, with the rest filled by hair, shoulders, and
 *  surroundings. The "before" should read as "an actual snapshot,"
 *  not as "an aggressive face-only crop." */
const BEFORE_FACE_FILL = 0.35;

// ---- Canvas dimensions ----
const CANVAS_W = 1200;
const CANVAS_H = 1600;

// ---- BEFORE Polaroid (replaces the old BEFORE circle as of 2026-05-06) ----
//
// A Polaroid-style rectangle reads as a casual snapshot tucked into the
// bottom-left corner — like a sticker on top of the AI headshot. The
// rectangular photo area is more forgiving to imperfect face crops than
// a tight circle was: even if the face isn't dead-center, the wider
// frame keeps the surrounding context (hair, shoulders, room) visible
// instead of cropping to a forehead-and-eyes sliver.
const POLAROID_PHOTO_W = 380;
const POLAROID_PHOTO_H = 380;
const POLAROID_BORDER_SIDES = 18;
const POLAROID_BORDER_TOP = 18;
// Bottom border is intentionally thicker — that's the visual signature
// of an actual Polaroid (the white space below the photo where you'd
// hand-write a caption).
const POLAROID_BORDER_BOTTOM = 80;
const POLAROID_W = POLAROID_PHOTO_W + 2 * POLAROID_BORDER_SIDES; // 416
const POLAROID_H = POLAROID_PHOTO_H + POLAROID_BORDER_TOP + POLAROID_BORDER_BOTTOM; // 478
// Slight CCW tilt for casual scrapbook character. Set to 0 for a clean
// non-tilted look if it ever feels too playful.
const POLAROID_TILT_DEG = -4;
// Subtle rounded corners (real Polaroids have a tiny radius from the
// physical paper edge).
const POLAROID_CORNER_RADIUS = 4;

const MARGIN = 40; // offset from canvas edges
const SHADOW_OFFSET = { x: 4, y: 6 };
const SHADOW_BLUR = 20;
const SHADOW_OPACITY = 0.35;

// ---- QR card (bottom-right; QR + two-line caption inside one card) ----
const QR_SIZE = 220;
const QR_CARD_PADDING = 14;
const QR_CARD_W = QR_SIZE + QR_CARD_PADDING * 2; // 248
// Caption: two centered all-caps lines ("SCAN TO TRY IT" / "YOURSELF")
// rendered as vector paths from textPaths.ts. Font size tuned so the
// longer of the two lines fits inside QR_CARD_W with a comfortable
// horizontal margin.
const QR_CAPTION_FONT_SIZE = 20; // pt
const QR_CAPTION_LINE_SPACING = 22; // px between baselines
const QR_CAPTION_GAP = 14; // px between QR bottom and caption block top
// Caption block height = ascent + (lineCount - 1) * lineSpacing + descent
const QR_CAPTION_BLOCK_H =
  (CAPTION_ASCENT_FU + CAPTION_DESCENT_FU) * (QR_CAPTION_FONT_SIZE / CAPTION_UPM)
  + (CAPTION_LINES.length - 1) * QR_CAPTION_LINE_SPACING;
const QR_CARD_H =
  QR_CARD_PADDING + QR_SIZE + QR_CAPTION_GAP +
  Math.ceil(QR_CAPTION_BLOCK_H) + QR_CARD_PADDING;
const QR_CARD_RADIUS = 12;
const QR_CAPTION_FILL = "#1a1a1a"; // near-black for readable contrast

// -------------------- Helpers --------------------

async function fetchAsBuffer(url: string): Promise<Buffer> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Fetch failed (${resp.status}): ${url}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

/**
 * Build the BEFORE Polaroid sprite — a rectangular Polaroid-style
 * snapshot with the customer's BEFORE photo inside, white frame around
 * it, a thicker bottom border, a slight tilt, and a soft drop shadow.
 *
 * Returns a sprite buffer sized to fit the rotated Polaroid PLUS the
 * shadow bleed, plus the offset coordinates the caller needs to
 * composite the sprite onto the main canvas.
 */
async function buildBeforeSprite(beforeUrl: string): Promise<{
  buffer: Buffer;
  spriteWidth: number;
  spriteHeight: number;
  // The (x, y) inside the sprite where the rotated Polaroid's bounding
  // box starts. Used to calculate the canvas-level paste offset so the
  // visible Polaroid lands at MARGIN from the canvas edges, not the
  // shadow padding.
  circleOffsetX: number;
  circleOffsetY: number;
}> {
  const beforeBuf = await fetchAsBuffer(beforeUrl);

  // 1. Auto-orient the source. .rotate() with no args reads EXIF
  //    Orientation and applies it — without this, iPhone photos (which
  //    encode landscape pixels + a "rotate 90 CW" tag) come out
  //    sideways.
  const oriented = await sharp(beforeBuf).rotate().toBuffer();
  const orientedMeta = await sharp(oriented).metadata();
  const srcW = orientedMeta.width ?? 0;
  const srcH = orientedMeta.height ?? 0;

  // 2. Build the photo content for inside the Polaroid (square,
  //    POLAROID_PHOTO_W × POLAROID_PHOTO_H).
  //
  // Cropping rule (per Kristi 2026-05-15, replacing the prior
  // face-detected face-centered crop):
  //   - WIDTH: use the full width of the uploaded photo as the crop's
  //     width. No face-relative zoom-in.
  //   - HEIGHT: position the crop top-weighted — the crop's top edge
  //     sits 5% of the source height below the top of the photo. This
  //     captures the face area for typical portrait headshots (where
  //     the face sits in the upper third) without needing a face
  //     detector. The 5% nudge avoids cropping straight off the very
  //     edge of the image.
  //   - The crop is square (POLAROID_PHOTO_W × POLAROID_PHOTO_H is
  //     square at 380×380). If the source width is wider than the
  //     source height (landscape upload), the crop height is capped at
  //     srcH and the top is anchored to 0 so we don't overflow.
  //
  // Face detection is no longer used here. We dropped the detectFaceBox
  // call because the top-weighted full-width crop is simpler, faster
  // (no Gemini Vision round-trip), and per Kristi produces a more
  // recognizable BEFORE for the share graphic.
  let photo: Buffer;
  if (srcW > 0 && srcH > 0) {
    // The crop is a square of side `cropSize`. Start with the source
    // width — Kristi's "use the full width of the uploaded shot."
    let cropSize = srcW;
    // If the source is landscape (or very wide), the square can't be
    // wider than the source height either. Cap to srcH so .extract()
    // doesn't fail.
    cropSize = Math.min(cropSize, srcH);
    // Left position: center horizontally (anchored on the middle of the
    // source). For typical portrait sources where cropSize === srcW,
    // this becomes 0. For landscape sources where cropSize < srcW,
    // this picks the horizontal middle so faces aren't sliced off.
    const left = Math.max(0, Math.round((srcW - cropSize) / 2));
    // Top position: 5% of srcH below the top edge — the "nudge down"
    // Kristi specified. Clamped so the crop doesn't extend past the
    // bottom of the source (which can happen on extreme landscape
    // uploads where cropSize == srcH and we'd want top=0).
    const nudge = Math.round(srcH * 0.05);
    const top = Math.max(0, Math.min(nudge, srcH - cropSize));
    photo = await sharp(oriented)
      .extract({ left, top, width: cropSize, height: cropSize })
      .resize(POLAROID_PHOTO_W, POLAROID_PHOTO_H, { fit: "cover" })
      .toBuffer();
  } else {
    // Metadata read failed — fall back to salience-based attention crop.
    // Should be extremely rare (Sharp returns dimensions for any
    // decodable image), but defensively keep a fallback path so a
    // missing srcW/srcH can't break the whole delivery.
    const ZOOM_FACTOR = 1.3;
    const wideTarget = Math.round(POLAROID_PHOTO_W * ZOOM_FACTOR);
    const wideCrop = await sharp(oriented)
      .resize(wideTarget, wideTarget, {
        fit: "cover",
        position: sharp.strategy.attention,
      })
      .toBuffer();
    const inset = Math.round((wideTarget - POLAROID_PHOTO_W) / 2);
    photo = await sharp(wideCrop)
      .extract({
        left: inset,
        top: inset,
        width: POLAROID_PHOTO_W,
        height: POLAROID_PHOTO_H,
      })
      .toBuffer();
  }

  // 4. Build the unrotated white Polaroid frame with the photo set
  //    inside the photo well. The frame is one solid white rectangle;
  //    the photo gets composited on top in the photo well region.
  const frameSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${POLAROID_W}" height="${POLAROID_H}">
      <rect x="0" y="0" width="${POLAROID_W}" height="${POLAROID_H}" rx="${POLAROID_CORNER_RADIUS}" fill="white"/>
    </svg>`,
  );
  const flatPolaroid = await sharp(frameSvg)
    .composite([
      {
        input: photo,
        top: POLAROID_BORDER_TOP,
        left: POLAROID_BORDER_SIDES,
      },
    ])
    .png()
    .toBuffer();

  // 5. Tilt the entire Polaroid by POLAROID_TILT_DEG. Sharp's .rotate()
  //    expands the canvas to fit the rotated content; we'll account
  //    for the new bounding-box dimensions when sizing the sprite.
  const tiltedBuffer = await sharp(flatPolaroid)
    .rotate(POLAROID_TILT_DEG, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const tiltedMeta = await sharp(tiltedBuffer).metadata();
  const tiltedW = tiltedMeta.width ?? POLAROID_W;
  const tiltedH = tiltedMeta.height ?? POLAROID_H;

  // 6. Build the sprite canvas — tilted Polaroid only, no shadow.
  //    Kristi 2026-05-06: removed the drop shadow because it rendered
  //    as a visible gray rectangle behind the Polaroid in production
  //    rather than reading as a soft glow. A clean Polaroid against
  //    the AFTER background reads better. We still pad slightly so
  //    the rotated bounding box isn't clipped, but no shadow bleed.
  const SPRITE_PAD = 8;
  const padLeft = SPRITE_PAD;
  const padRight = SPRITE_PAD;
  const padTop = SPRITE_PAD;
  const padBottom = SPRITE_PAD;
  const spriteW = tiltedW + padLeft + padRight;
  const spriteH = tiltedH + padTop + padBottom;

  // 7. Compose: blank canvas + tilted Polaroid centered in it.
  const sprite = await sharp({
    create: {
      width: spriteW,
      height: spriteH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: tiltedBuffer,
        top: padTop,
        left: padLeft,
      },
    ])
    .png()
    .toBuffer();

  return {
    buffer: sprite,
    spriteWidth: spriteW,
    spriteHeight: spriteH,
    circleOffsetX: padLeft,
    circleOffsetY: padTop,
  };
}

/**
 * Build the QR card sprite — white rounded-rect card with a soft drop
 * shadow, containing a QR code on top and a "Scan to try it yourself"
 * caption beneath it. Both QR and caption live inside the same card
 * for a single visual unit.
 *
 * The caption is rendered via pre-computed SVG `<path>` glyph outlines
 * (see lib/textPaths.ts). This sidesteps the SVG-font-rendering
 * problem on Vercel's serverless runtime, where missing fonts cause
 * `<text>` elements to render as squares ("font tofu").
 */
async function buildQrSprite(qrTargetUrl: string): Promise<{
  buffer: Buffer;
  spriteWidth: number;
  spriteHeight: number;
  cardOffsetX: number;
  cardOffsetY: number;
}> {
  // Generate the QR PNG (high error correction so the card padding can
  // be tight without breaking scans).
  const qrPng = await QRCode.toBuffer(qrTargetUrl, {
    errorCorrectionLevel: "H",
    margin: 0,
    width: QR_SIZE,
    color: { dark: "#000000", light: "#FFFFFF" },
  });

  const padLeft = SHADOW_BLUR;
  const padRight = SHADOW_BLUR + Math.max(SHADOW_OFFSET.x, 0);
  const padTop = SHADOW_BLUR;
  const padBottom = SHADOW_BLUR + Math.max(SHADOW_OFFSET.y, 0);
  const spriteW = QR_CARD_W + padLeft + padRight;
  const spriteH = QR_CARD_H + padTop + padBottom;

  const cardCx = padLeft;
  const cardCy = padTop;

  // Two-line caption sits below the QR, each line centered horizontally
  // inside the card. The renderer handles per-line centering and the
  // vertical line stacking; we just feed it the card center and the
  // top-y of the caption block (in sprite coords).
  const captionTopWithinCard =
    QR_CARD_PADDING + QR_SIZE + QR_CAPTION_GAP;
  const caption = renderCenteredLinesGroup({
    fontSize: QR_CAPTION_FONT_SIZE,
    fill: QR_CAPTION_FILL,
    centerX: cardCx + QR_CARD_W / 2,
    topY: cardCy + captionTopWithinCard,
    lineSpacing: QR_CAPTION_LINE_SPACING,
  });

  // SVG: shadow rect (blurred) + white rounded-rect card + caption
  // glyph paths overlaid in the lower band of the card.
  const baseSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${spriteW}" height="${spriteH}">
      <defs>
        <filter id="qrShadow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="${SHADOW_BLUR / 2}"/>
        </filter>
      </defs>
      <rect x="${cardCx + SHADOW_OFFSET.x}" y="${cardCy + SHADOW_OFFSET.y}" width="${QR_CARD_W}" height="${QR_CARD_H}" rx="${QR_CARD_RADIUS}" fill="black" fill-opacity="${SHADOW_OPACITY}" filter="url(#qrShadow)"/>
      <rect x="${cardCx}" y="${cardCy}" width="${QR_CARD_W}" height="${QR_CARD_H}" rx="${QR_CARD_RADIUS}" fill="white"/>
      ${caption.svg}
    </svg>`,
  );

  const sprite = await sharp(baseSvg)
    .composite([
      {
        input: qrPng,
        top: padTop + QR_CARD_PADDING,
        left: padLeft + QR_CARD_PADDING,
      },
    ])
    .png()
    .toBuffer();

  return {
    buffer: sprite,
    spriteWidth: spriteW,
    spriteHeight: spriteH,
    cardOffsetX: padLeft,
    cardOffsetY: padTop,
  };
}

// -------------------- Main --------------------

export type ShareGraphicArgs = {
  beforeUrl: string;
  afterUrl: string;
  qrTargetUrl: string;
};

/**
 * Build a complete before/after share graphic and return its JPEG buffer.
 *
 * Layout (1200x1600):
 *   - Full canvas: AI-generated AFTER headshot, cover-fit
 *   - Bottom-left: BEFORE Polaroid — rectangular white-framed snapshot
 *     with a slight tilt and soft drop shadow. Replaces the previous
 *     circular inset (changed 2026-05-06 because the tight circle was
 *     unforgiving of imperfect face crops on real customer photos)
 *   - Bottom-right: QR card with QR code + "Scan to try it yourself"
 *     caption rendered as SVG vector paths (so it renders identically
 *     across all environments without needing the right system fonts)
 *
 * The QR code is the CTA; the caption tells the viewer what to do
 * with it.
 */
export async function buildShareGraphic(
  args: ShareGraphicArgs,
): Promise<Buffer> {
  // 1. AFTER cover-fit to 1200x1600. .rotate() with no args auto-applies
  //    EXIF Orientation as a safety measure — Gemini outputs don't ship
  //    with EXIF so this is normally a no-op, but a future model swap
  //    or a human-edited input shouldn't break us silently.
  const afterBuf = await fetchAsBuffer(args.afterUrl);
  const afterImage = await sharp(afterBuf)
    .rotate()
    .resize(CANVAS_W, CANVAS_H, { fit: "cover", position: "center" })
    .toBuffer();

  // 2. Build the BEFORE Polaroid sprite (white frame, tilted, with
  //    drop shadow). Returns a sprite that's bigger than the visible
  //    Polaroid — the extra padding holds the tilted bounding box and
  //    the shadow bleed.
  const beforeSprite = await buildBeforeSprite(args.beforeUrl);

  // 3. Build the QR card sprite (QR + caption inside the same card).
  const qrSprite = await buildQrSprite(args.qrTargetUrl);

  // 4. Composite everything onto a 1200x1600 white canvas.
  //    BEFORE sprite goes bottom-left at MARGIN offset. The sprite is
  //    sized to its tilted bounding box; placing it so the bounding-box
  //    bottom-left sits at (MARGIN, CANVAS_H - MARGIN) keeps the visible
  //    Polaroid roughly the same MARGIN distance from the canvas edges.
  const beforeLeft = MARGIN - beforeSprite.circleOffsetX;
  const beforeTop = CANVAS_H - MARGIN - beforeSprite.spriteHeight + beforeSprite.circleOffsetY;
  // QR card goes bottom-right at MARGIN offset.
  const qrLeft = CANVAS_W - MARGIN - QR_CARD_W - qrSprite.cardOffsetX;
  const qrTop = CANVAS_H - MARGIN - QR_CARD_H - qrSprite.cardOffsetY;

  const finalImage = await sharp({
    create: {
      width: CANVAS_W,
      height: CANVAS_H,
      channels: 3,
      background: "white",
    },
  })
    .composite([
      { input: afterImage, top: 0, left: 0 },
      { input: beforeSprite.buffer, top: beforeTop, left: beforeLeft },
      { input: qrSprite.buffer, top: qrTop, left: qrLeft },
    ])
    .jpeg({ quality: 90, progressive: true })
    .toBuffer();

  return finalImage;
}
