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

// ---- Canvas dimensions ----
const CANVAS_W = 1200;
const CANVAS_H = 1600;

// ---- BEFORE circle ----
const CIRCLE_DIAMETER = Math.round(CANVAS_W * 0.36); // 432
const RING = 14; // white ring thickness
const INNER_DIAMETER = CIRCLE_DIAMETER - 2 * RING; // 404
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
 * Build the BEFORE inset sprite as a single PNG buffer.
 * Includes the source image (square-cropped + circular masked), the
 * white ring, the drop shadow, and the translucent BEFORE label bar.
 *
 * Returns a buffer sized so the SHADOW has room to bleed past the
 * circle — the caller composites it with offsets that account for
 * the shadow padding.
 */
async function buildBeforeSprite(beforeUrl: string): Promise<{
  buffer: Buffer;
  spriteWidth: number;
  spriteHeight: number;
  // Where the circle center sits inside the sprite, used to calculate
  // the composite offset on the main canvas.
  circleOffsetX: number;
  circleOffsetY: number;
}> {
  const beforeBuf = await fetchAsBuffer(beforeUrl);

  // 1. Square-crop + resize the source to inner diameter, top-anchored
  //    so foreheads/hair stay visible.
  const innerSrc = await sharp(beforeBuf)
    .resize(INNER_DIAMETER, INNER_DIAMETER, {
      fit: "cover",
      position: "top",
    })
    .toBuffer();

  // 2. Apply circular mask via SVG composite.
  const circularMaskSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${INNER_DIAMETER}" height="${INNER_DIAMETER}">
      <circle cx="${INNER_DIAMETER / 2}" cy="${INNER_DIAMETER / 2}" r="${INNER_DIAMETER / 2}" fill="white"/>
    </svg>`,
  );
  const circularBefore = await sharp(innerSrc)
    .composite([{ input: circularMaskSvg, blend: "dest-in" }])
    .png()
    .toBuffer();

  // 3. Build the sprite canvas — circle + shadow padding.
  const padLeft = SHADOW_BLUR;
  const padRight = SHADOW_BLUR + Math.max(SHADOW_OFFSET.x, 0);
  const padTop = SHADOW_BLUR;
  const padBottom = SHADOW_BLUR + Math.max(SHADOW_OFFSET.y, 0);
  const spriteW = CIRCLE_DIAMETER + padLeft + padRight;
  const spriteH = CIRCLE_DIAMETER + padTop + padBottom;

  // 4. Build the shadow + white ring SVG. NO label bar or BEFORE text
  //    (removed 2026-05-04 per Kristi: 'remove the black bar at the
  //    bottom of the before circle photo'). The visual is now just
  //    the photo masked into a clean circle with a white ring + soft
  //    drop shadow.
  const shadowCx = padLeft + CIRCLE_DIAMETER / 2 + SHADOW_OFFSET.x;
  const shadowCy = padTop + CIRCLE_DIAMETER / 2 + SHADOW_OFFSET.y;
  const ringCx = padLeft + CIRCLE_DIAMETER / 2;
  const ringCy = padTop + CIRCLE_DIAMETER / 2;

  const ringSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${spriteW}" height="${spriteH}">
      <defs>
        <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="${SHADOW_BLUR / 2}"/>
        </filter>
      </defs>
      <circle cx="${shadowCx}" cy="${shadowCy}" r="${CIRCLE_DIAMETER / 2}" fill="black" fill-opacity="${SHADOW_OPACITY}" filter="url(#shadow)"/>
      <circle cx="${ringCx}" cy="${ringCy}" r="${CIRCLE_DIAMETER / 2}" fill="white"/>
    </svg>`,
  );

  // 5. Composite: ring/shadow SVG as base, photo composited on top
  //    inside the ring (RING px inset from the outer circle edge).
  const sprite = await sharp(ringSvg)
    .composite([
      {
        input: circularBefore,
        top: padTop + RING,
        left: padLeft + RING,
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
 *   - Bottom-left: BEFORE circle (white ring + drop shadow, no label bar)
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
  // 1. AFTER cover-fit to 1200x1600.
  const afterBuf = await fetchAsBuffer(args.afterUrl);
  const afterImage = await sharp(afterBuf)
    .resize(CANVAS_W, CANVAS_H, { fit: "cover", position: "center" })
    .toBuffer();

  // 2. Build the BEFORE sprite (circle + ring + shadow — no label).
  const beforeSprite = await buildBeforeSprite(args.beforeUrl);

  // 3. Build the QR card sprite (QR + caption inside the same card).
  const qrSprite = await buildQrSprite(args.qrTargetUrl);

  // 4. Composite everything onto a 1200x1600 white canvas.
  // BEFORE sprite goes bottom-left at MARGIN offset.
  const beforeLeft = MARGIN - beforeSprite.circleOffsetX;
  const beforeTop = CANVAS_H - MARGIN - CIRCLE_DIAMETER - beforeSprite.circleOffsetY;
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
