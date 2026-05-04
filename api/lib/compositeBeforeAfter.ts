/**
 * Build a before/after share graphic for delivery.
 *
 * TypeScript port of `before-after-headshot/scripts/composite.py` +
 * `make_share_variant.py` (Kristi's Pillow-based skill that's been used
 * to manually composite the marketing library in `Before-After Graphics/`).
 *
 * Layout (1200x1740):
 *   - Top 1200x1600: AFTER headshot, cover-fit
 *   - Bottom-left of the image: circular BEFORE inset (432px diameter)
 *     with white ring, drop shadow, and translucent BEFORE label bar
 *   - Bottom-right of the image: white card containing a QR code
 *     pointing to the share URL
 *   - Below the image (140px strip): centered "Try it yourself" CTA +
 *     URL on a hairline-bordered white strip
 *
 * Used by /api/deliver — every delivered photo gets one share graphic
 * (with the QR card) auto-generated and stored to Vercel Blob, surfaced
 * on the Download screen so the customer can post it.
 */

import sharp from "sharp";
import QRCode from "qrcode";

// ---- Canvas dimensions (match composite.py defaults) ----
const CANVAS_W = 1200;
const CANVAS_H = 1600;
const STRIP_H = 140;
const OUT_H = CANVAS_H + STRIP_H; // 1740

// ---- BEFORE circle ----
const CIRCLE_DIAMETER = Math.round(CANVAS_W * 0.36); // 432
const RING = 14; // white ring thickness
const INNER_DIAMETER = CIRCLE_DIAMETER - 2 * RING; // 404
const MARGIN = 40; // offset from canvas edges
const SHADOW_OFFSET = { x: 4, y: 6 };
const SHADOW_BLUR = 20;
const SHADOW_OPACITY = 0.35;
const LABEL_BAR_HEIGHT = Math.round(INNER_DIAMETER * 0.18); // bar height
const LABEL_BG_OPACITY = 0.75;
const LABEL_TEXT = "BEFORE";
const LABEL_FONT_SIZE = 32;
const LABEL_LETTER_SPACING = 6;

// ---- QR card (mirrors before circle on bottom-right) ----
const QR_SIZE = 220;
const QR_CARD_PADDING = 14;
const QR_CARD_SIZE = QR_SIZE + QR_CARD_PADDING * 2; // 248
const QR_CARD_RADIUS = 12;

// ---- Text strip (below the image) ----
const CTA_FONT_SIZE = 56;
const URL_FONT_SIZE = 22;
const TEXT_GAP = 10;

// Color palette
const TEXT_DARK = "#2C2C2A";
const TEXT_MEDIUM = "#888780";
const DIVIDER = "#E8E8E6";

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

  // 4. Build a single SVG containing the white-ring circle, label bar,
  //    and BEFORE text. Shadow is rendered via SVG filter.
  // Shadow circle position (offset behind the white ring).
  const shadowCx = padLeft + CIRCLE_DIAMETER / 2 + SHADOW_OFFSET.x;
  const shadowCy = padTop + CIRCLE_DIAMETER / 2 + SHADOW_OFFSET.y;
  // Ring circle position (white circle behind the photo).
  const ringCx = padLeft + CIRCLE_DIAMETER / 2;
  const ringCy = padTop + CIRCLE_DIAMETER / 2;
  // Label bar — only visible inside the inner circle (clipped via SVG).
  const barLeft = padLeft + RING;
  const barTop = padTop + RING + INNER_DIAMETER - LABEL_BAR_HEIGHT;
  const barWidth = INNER_DIAMETER;
  // Letter-spaced uppercase, white, centered horizontally within bar.
  // We approximate centering by using SVG text-anchor=middle.
  const labelX = barLeft + barWidth / 2;
  const labelY = barTop + LABEL_BAR_HEIGHT / 2 + LABEL_FONT_SIZE / 3;

  const ringAndLabelSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${spriteW}" height="${spriteH}">
      <defs>
        <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="${SHADOW_BLUR / 2}"/>
        </filter>
        <clipPath id="innerClip">
          <circle cx="${padLeft + CIRCLE_DIAMETER / 2}" cy="${padTop + CIRCLE_DIAMETER / 2}" r="${INNER_DIAMETER / 2}"/>
        </clipPath>
      </defs>
      <circle cx="${shadowCx}" cy="${shadowCy}" r="${CIRCLE_DIAMETER / 2}" fill="black" fill-opacity="${SHADOW_OPACITY}" filter="url(#shadow)"/>
      <circle cx="${ringCx}" cy="${ringCy}" r="${CIRCLE_DIAMETER / 2}" fill="white"/>
      <rect x="${barLeft}" y="${barTop}" width="${barWidth}" height="${LABEL_BAR_HEIGHT}" fill="black" fill-opacity="${LABEL_BG_OPACITY}" clip-path="url(#innerClip)"/>
      <text x="${labelX}" y="${labelY}" font-family="Helvetica, Arial, sans-serif" font-size="${LABEL_FONT_SIZE}" font-weight="bold" fill="white" text-anchor="middle" letter-spacing="${LABEL_LETTER_SPACING}">${LABEL_TEXT}</text>
    </svg>`,
  );

  // 5. Composite: ring/shadow/label SVG as base, photo composited on top
  //    inside the ring (RING px inset from circle edge).
  const sprite = await sharp(ringAndLabelSvg)
    .composite([
      {
        input: circularBefore,
        top: padTop + RING,
        left: padLeft + RING,
      },
      // Re-apply the label bar + text on top of the photo (since the
      // photo would otherwise cover them).
      {
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${spriteW}" height="${spriteH}">
            <defs>
              <clipPath id="innerClip2">
                <circle cx="${padLeft + CIRCLE_DIAMETER / 2}" cy="${padTop + CIRCLE_DIAMETER / 2}" r="${INNER_DIAMETER / 2}"/>
              </clipPath>
            </defs>
            <rect x="${barLeft}" y="${barTop}" width="${barWidth}" height="${LABEL_BAR_HEIGHT}" fill="black" fill-opacity="${LABEL_BG_OPACITY}" clip-path="url(#innerClip2)"/>
            <text x="${labelX}" y="${labelY}" font-family="Helvetica, Arial, sans-serif" font-size="${LABEL_FONT_SIZE}" font-weight="bold" fill="white" text-anchor="middle" letter-spacing="${LABEL_LETTER_SPACING}">${LABEL_TEXT}</text>
          </svg>`,
        ),
        top: 0,
        left: 0,
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
 * Build the QR card sprite — white rounded-rect card with a soft shadow
 * containing a QR-encoded link to the share URL. Mirrors the BEFORE
 * circle's bottom-left placement on the bottom-right.
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
  const spriteW = QR_CARD_SIZE + padLeft + padRight;
  const spriteH = QR_CARD_SIZE + padTop + padBottom;

  const cardCx = padLeft;
  const cardCy = padTop;

  // SVG: shadow rect (blurred) + white rounded-rect card.
  const baseSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${spriteW}" height="${spriteH}">
      <defs>
        <filter id="qrShadow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="${SHADOW_BLUR / 2}"/>
        </filter>
      </defs>
      <rect x="${cardCx + SHADOW_OFFSET.x}" y="${cardCy + SHADOW_OFFSET.y}" width="${QR_CARD_SIZE}" height="${QR_CARD_SIZE}" rx="${QR_CARD_RADIUS}" fill="black" fill-opacity="${SHADOW_OPACITY}" filter="url(#qrShadow)"/>
      <rect x="${cardCx}" y="${cardCy}" width="${QR_CARD_SIZE}" height="${QR_CARD_SIZE}" rx="${QR_CARD_RADIUS}" fill="white"/>
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

/**
 * Build the bottom text strip (CTA + URL on a white strip with a
 * hairline divider on top).
 */
function buildTextStripSvg(cta: string, url: string): Buffer {
  // Vertical centering of the two-line text block.
  const blockHeight = CTA_FONT_SIZE + TEXT_GAP + URL_FONT_SIZE;
  const blockTop = (STRIP_H - blockHeight) / 2;
  const ctaY = blockTop + CTA_FONT_SIZE * 0.85;
  const urlY = blockTop + CTA_FONT_SIZE + TEXT_GAP + URL_FONT_SIZE * 0.85;

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${STRIP_H}">
      <rect x="0" y="0" width="${CANVAS_W}" height="1" fill="${DIVIDER}"/>
      <text x="${CANVAS_W / 2}" y="${ctaY}" font-family="Helvetica, Arial, sans-serif" font-size="${CTA_FONT_SIZE}" font-weight="bold" fill="${TEXT_DARK}" text-anchor="middle">${cta}</text>
      <text x="${CANVAS_W / 2}" y="${urlY}" font-family="Helvetica, Arial, sans-serif" font-size="${URL_FONT_SIZE}" fill="${TEXT_MEDIUM}" text-anchor="middle">${url}</text>
    </svg>`,
  );
}

// -------------------- Main --------------------

export type ShareGraphicArgs = {
  beforeUrl: string;
  afterUrl: string;
  qrTargetUrl: string;
  // CTA + URL shown on the strip below the image.
  cta?: string;
  urlText?: string;
};

/**
 * Build a complete before/after share graphic and return its JPEG buffer.
 * Matches the visual style of the manual `composite.py` output so the
 * customer's auto-generated graphic looks identical to the pieces in
 * Kristi's existing marketing library.
 */
export async function buildShareGraphic(
  args: ShareGraphicArgs,
): Promise<Buffer> {
  const cta = args.cta ?? "Try it yourself";
  const urlText = args.urlText ?? "generationheadshots.com";

  // 1. AFTER cover-fit to 1200x1600.
  const afterBuf = await fetchAsBuffer(args.afterUrl);
  const afterImage = await sharp(afterBuf)
    .resize(CANVAS_W, CANVAS_H, { fit: "cover", position: "center" })
    .toBuffer();

  // 2. Build the BEFORE sprite (circle + ring + shadow + label).
  const beforeSprite = await buildBeforeSprite(args.beforeUrl);

  // 3. Build the QR card sprite.
  const qrSprite = await buildQrSprite(args.qrTargetUrl);

  // 4. Build the text strip SVG.
  const textStrip = buildTextStripSvg(cta, urlText);

  // 5. Composite everything onto a 1200x1740 white canvas.
  // BEFORE sprite goes bottom-left at MARGIN offset.
  const beforeLeft = MARGIN - beforeSprite.circleOffsetX;
  const beforeTop = CANVAS_H - MARGIN - CIRCLE_DIAMETER - beforeSprite.circleOffsetY;
  // QR card goes bottom-right at MARGIN offset.
  const qrLeft = CANVAS_W - MARGIN - QR_CARD_SIZE - qrSprite.cardOffsetX;
  const qrTop = CANVAS_H - MARGIN - QR_CARD_SIZE - qrSprite.cardOffsetY;

  const finalImage = await sharp({
    create: {
      width: CANVAS_W,
      height: OUT_H,
      channels: 3,
      background: "white",
    },
  })
    .composite([
      { input: afterImage, top: 0, left: 0 },
      { input: beforeSprite.buffer, top: beforeTop, left: beforeLeft },
      { input: qrSprite.buffer, top: qrTop, left: qrLeft },
      { input: textStrip, top: CANVAS_H, left: 0 },
    ])
    .jpeg({ quality: 90, progressive: true })
    .toBuffer();

  return finalImage;
}
