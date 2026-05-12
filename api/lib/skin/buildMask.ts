/**
 * Build a grayscale "where to smooth" mask from 68-point landmarks.
 *
 * Mask values:
 *   0   = protect (don't smooth)
 *   255 = full base-strength smoothing
 *   Values in between = feathered edges
 *
 * The mask is rendered as an SVG with named polygons (face oval, eye
 * protect, lip protect, etc.) then rasterized with Sharp. We use SVG
 * because polygon-fill math is awful in raw buffers but trivial in SVG.
 *
 * A separate UNDER-EYE mask is built independently so the caller can
 * blend it in at a higher intensity than the base mask.
 *
 * All coordinates are in PIXEL space of the original (full-resolution)
 * reference photo.
 */

import sharp from "sharp";
import type { Point, Landmarks } from "./detectLandmarks.js";

// Landmark index ranges (dlib 68-point scheme — same as face-api).
const IDX = {
  JAW: [0, 16] as const,
  RIGHT_BROW: [17, 21] as const,
  LEFT_BROW: [22, 26] as const,
  NOSE_BRIDGE: [27, 30] as const,
  NOSE_BOTTOM: [31, 35] as const,
  RIGHT_EYE: [36, 41] as const,
  LEFT_EYE: [42, 47] as const,
  OUTER_LIP: [48, 59] as const,
  INNER_LIP: [60, 67] as const,
};

/** Get points within an inclusive index range. */
function slice(pts: Point[], range: readonly [number, number]): Point[] {
  return pts.slice(range[0], range[1] + 1);
}

/** Polygon string for SVG `points="x1,y1 x2,y2 ..."` attribute. */
function svgPoly(pts: Point[]): string {
  return pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}

/** Expand a polygon outward from its centroid by `factor` (1.0 = no change). */
function expandPoly(pts: Point[], factor: number): Point[] {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return pts.map((p) => ({
    x: cx + (p.x - cx) * factor,
    y: cy + (p.y - cy) * factor,
  }));
}

/** Min/max bounds of a point set. */
function bounds(pts: Point[]): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY };
}

export type MaskOptions = {
  imageWidth: number;
  imageHeight: number;
  landmarks: Landmarks;
  /** Add a beard / stubble protect zone (men). */
  protectBeard: boolean;
};

/**
 * Build the BASE smooth-zone mask. White (255) where smoothing applies to
 * general face skin (forehead, cheeks, chin, jawline). Black (0) over
 * features (eyes, brows, lips, nose, nasolabial folds) and outside the
 * face. The under-eye region is NOT included in the base mask — it's a
 * separate mask the caller layers on top at a different intensity.
 */
export async function buildBaseSmoothMask(
  opts: MaskOptions,
): Promise<Buffer> {
  const { imageWidth: W, imageHeight: H, landmarks, protectBeard } = opts;
  const pts = landmarks.points;
  const face = landmarks.faceBox;
  const fh = face.height;
  const fw = face.width;

  // ---- SMOOTH ZONES (white) ----

  // 1) Face oval — use the jawline (0-16) as the bottom contour, projected
  //    UP for the forehead since dlib's 68 points don't cover the forehead.
  //    We extrapolate a forehead arc from the eyebrow line up by ~50% of
  //    the eye-to-brow distance.
  const jawline = slice(pts, IDX.JAW); // 17 points
  const rightBrow = slice(pts, IDX.RIGHT_BROW);
  const leftBrow = slice(pts, IDX.LEFT_BROW);
  const allBrows = [...rightBrow, ...leftBrow];

  // Top-of-forehead estimate: project brow-line up by (brow-to-eye-distance × 3.0).
  // That's empirically about where the hairline sits on most faces.
  const eyeLineY = [...slice(pts, IDX.RIGHT_EYE), ...slice(pts, IDX.LEFT_EYE)]
    .reduce((s, p) => s + p.y, 0) /
    (IDX.RIGHT_EYE[1] - IDX.RIGHT_EYE[0] + IDX.LEFT_EYE[1] - IDX.LEFT_EYE[0] + 2);
  const browLineY = allBrows.reduce((s, p) => s + p.y, 0) / allBrows.length;
  const browToEye = eyeLineY - browLineY;
  const foreheadTopY = browLineY - browToEye * 3.0;

  // Forehead arc — same x extent as the brow span, projecting up.
  // Use the leftmost and rightmost brow points as anchors.
  const browLeftX = Math.min(...allBrows.map((p) => p.x));
  const browRightX = Math.max(...allBrows.map((p) => p.x));
  const browCenterX = (browLeftX + browRightX) / 2;

  // Forehead polygon: 5 points forming an arch above the brows
  const foreheadArc: Point[] = [
    { x: browLeftX, y: browLineY - browToEye * 0.5 },
    { x: browLeftX + (browRightX - browLeftX) * 0.20, y: foreheadTopY },
    { x: browCenterX, y: foreheadTopY - browToEye * 0.4 },
    { x: browLeftX + (browRightX - browLeftX) * 0.80, y: foreheadTopY },
    { x: browRightX, y: browLineY - browToEye * 0.5 },
  ];

  // Face skin polygon: forehead arc on top + jawline on bottom, going clockwise
  const facePoly: Point[] = [
    ...foreheadArc,
    // jawline runs left-ear → chin → right-ear which is x=low → x=high
    // We want to traverse clockwise so the polygon closes properly
    ...jawline.slice().reverse(),
  ];

  // ---- PROTECT ZONES (black) ----

  // Eyes — slightly expanded so lashes + immediate eye-skin are protected
  const rightEyePoly = expandPoly(slice(pts, IDX.RIGHT_EYE), 1.6);
  const leftEyePoly = expandPoly(slice(pts, IDX.LEFT_EYE), 1.6);

  // Eyebrows — expand outward and slightly upward
  const rightBrowExpanded = expandPoly(rightBrow, 1.3);
  const leftBrowExpanded = expandPoly(leftBrow, 1.3);
  // Push the brow protection up so we cover the brow hair, not just the line
  const browLift = (eyeLineY - browLineY) * 0.6;
  const rightBrowPoly = rightBrowExpanded.map((p) => ({ x: p.x, y: p.y - browLift }));
  const leftBrowPoly = leftBrowExpanded.map((p) => ({ x: p.x, y: p.y - browLift }));

  // Lips — outer lip polygon expanded slightly
  const lipPoly = expandPoly(slice(pts, IDX.OUTER_LIP), 1.15);

  // Nose bottom — points 31-35 form the nostrils + tip
  const noseBottomPoly = expandPoly(slice(pts, IDX.NOSE_BOTTOM), 1.20);

  // Nasolabial folds — narrow strips from outer nostril (31, 35) to outer
  // mouth corners (48, 54)
  const nostrilL = pts[31]; // subject's right nostril (left in image)
  const nostrilR = pts[35]; // subject's left nostril (right in image)
  const mouthL = pts[48];
  const mouthR = pts[54];
  const foldHalfWidth = browToEye * 0.4;
  const leftFoldPoly: Point[] = [
    { x: nostrilL.x - foldHalfWidth, y: nostrilL.y },
    { x: nostrilL.x + foldHalfWidth, y: nostrilL.y },
    { x: mouthL.x + foldHalfWidth, y: mouthL.y },
    { x: mouthL.x - foldHalfWidth, y: mouthL.y },
  ];
  const rightFoldPoly: Point[] = [
    { x: nostrilR.x - foldHalfWidth, y: nostrilR.y },
    { x: nostrilR.x + foldHalfWidth, y: nostrilR.y },
    { x: mouthR.x + foldHalfWidth, y: mouthR.y },
    { x: mouthR.x - foldHalfWidth, y: mouthR.y },
  ];

  // Beard zone (men only) — bottom 40% of the face from jawline up to lip-bottom
  let beardPoly: Point[] = [];
  if (protectBeard) {
    const lipBottomY = pts[57].y; // lower lip
    // Take jawline lower 11 points (subset that's near the chin)
    const lowerJaw = jawline.slice(3, 14);
    beardPoly = [
      { x: lowerJaw[0].x, y: lipBottomY },
      ...lowerJaw,
      { x: lowerJaw[lowerJaw.length - 1].x, y: lipBottomY },
    ];
  }

  // ---- Render to SVG ----

  // Feather radius scales with face size — bigger faces need more feathering
  // to keep the transition between smooth zones and protect zones invisible.
  const feather = Math.max(4, Math.round(fw * 0.012));

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <filter id="feather" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="${feather}"/>
      </filter>
    </defs>
    <g filter="url(#feather)">
      <!-- BASE: black canvas + white face oval -->
      <rect width="${W}" height="${H}" fill="black"/>
      <polygon points="${svgPoly(facePoly)}" fill="white"/>
      <!-- PROTECT: features painted back to black -->
      <polygon points="${svgPoly(rightEyePoly)}" fill="black"/>
      <polygon points="${svgPoly(leftEyePoly)}" fill="black"/>
      <polygon points="${svgPoly(rightBrowPoly)}" fill="black"/>
      <polygon points="${svgPoly(leftBrowPoly)}" fill="black"/>
      <polygon points="${svgPoly(lipPoly)}" fill="black"/>
      <polygon points="${svgPoly(noseBottomPoly)}" fill="black"/>
      <polygon points="${svgPoly(leftFoldPoly)}" fill="black"/>
      <polygon points="${svgPoly(rightFoldPoly)}" fill="black"/>
      ${protectBeard ? `<polygon points="${svgPoly(beardPoly)}" fill="black"/>` : ""}
    </g>
  </svg>`;

  // Rasterize to a single-channel grayscale buffer
  return await sharp(Buffer.from(svg))
    .grayscale()
    .toColorspace("b-w")
    .raw()
    .toBuffer();
}

/**
 * Build the UNDER-EYE smooth-zone mask. White only in the narrow band
 * directly beneath each eye. Used for Glam-woman, layered at a higher
 * intensity than the base mask.
 *
 * The under-eye zone spans from the bottom-eye landmarks (39-41 right,
 * 45-47 left) down by ~80% of eye height — that's the area where
 * crow's feet, tear-trough hollows, and under-eye crepey texture live.
 * Width spans from the inner eye corner to slightly past the outer
 * corner to include early crow's-feet.
 */
export async function buildUnderEyeMask(
  opts: MaskOptions,
): Promise<Buffer> {
  const { imageWidth: W, imageHeight: H, landmarks } = opts;
  const pts = landmarks.points;
  const fw = landmarks.faceBox.width;

  const rightEye = slice(pts, IDX.RIGHT_EYE);
  const leftEye = slice(pts, IDX.LEFT_EYE);

  function underEyeZone(eyePts: Point[]): Point[] {
    const b = bounds(eyePts);
    const eyeHeight = b.maxY - b.minY;
    const yTop = b.maxY + eyeHeight * 0.10; // start just below lower lash
    const yBottom = b.maxY + eyeHeight * 2.0; // extend down ~2x eye height
    // Extend slightly past outer corner for crow's feet
    const xLeft = b.minX - (b.maxX - b.minX) * 0.10;
    const xRight = b.maxX + (b.maxX - b.minX) * 0.20;
    return [
      { x: xLeft, y: yTop },
      { x: xRight, y: yTop },
      { x: xRight, y: yBottom },
      { x: xLeft, y: yBottom },
    ];
  }

  const rightZone = underEyeZone(rightEye);
  const leftZone = underEyeZone(leftEye);

  const feather = Math.max(4, Math.round(fw * 0.015));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <filter id="feather" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="${feather}"/>
      </filter>
    </defs>
    <g filter="url(#feather)">
      <rect width="${W}" height="${H}" fill="black"/>
      <polygon points="${svgPoly(rightZone)}" fill="white"/>
      <polygon points="${svgPoly(leftZone)}" fill="white"/>
    </g>
  </svg>`;

  return await sharp(Buffer.from(svg))
    .grayscale()
    .toColorspace("b-w")
    .raw()
    .toBuffer();
}
