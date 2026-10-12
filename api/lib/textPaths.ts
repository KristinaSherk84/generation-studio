/**
 * Pre-computed SVG vector paths for the share-graphic caption text.
 *
 * Why this exists: text rendered via SVG <text> elements requires the
 * compositing engine (sharp + librsvg on Vercel serverless) to have
 * the requested font installed. It usually doesn't, which means the
 * text shows up as missing-glyph squares ("font tofu"). Bundling a
 * font file works around this but adds runtime dependencies and a
 * package install.
 *
 * Instead, we pre-compute the text once (via fontTools / Liberation
 * Sans Bold) and embed the resulting glyph outlines as raw SVG <path>
 * data. librsvg renders <path> elements as pure vectors with zero font
 * dependency — same output everywhere, immune to font tofu forever.
 *
 * Current label is two-line, all-caps (2026-10-12, Kristi):
 *     CREATE YOURS
 *         NOW!
 * Regenerated with fontTools from Arial Bold, which is metric-identical to
 * Liberation Sans Bold (checked: "SCAN TO TRY IT" = 16270 font units in both).
 *
 * To change either line, regenerate the path data with the fontTools
 * Python helper that produced this (any prompt to me referencing
 * `regen_paths.py` for textPaths). Paste the new path strings + the
 * total advance width (in font units) into CAPTION_LINES below.
 */

/** Each rendered line of the caption. */
export const CAPTION_LABEL_LINES = ["CREATE YOURS", "NOW!"];

/** Font: Liberation Sans Bold. Units per em (font design grid). */
export const CAPTION_UPM = 2048;

/** Distance from baseline to top of typical glyph (font units). */
export const CAPTION_ASCENT_FU = 1854;

/** Distance from baseline to bottom of typical descender (font units). */
export const CAPTION_DESCENT_FU = 434;

/**
 * One entry per line. `inner` is the raw SVG glyph outline data in
 * font-unit coordinates (each glyph is a `<path>`, with `<g translate>`
 * wrappers placing each glyph at its cumulative x position). `widthFu`
 * is the total advance width of the line in font units.
 *
 * To render at any font size, wrap `inner` in a parent `<g transform>`:
 *     translate(originX, baselineY) scale(s, -s)
 * where s = desiredFontSize / CAPTION_UPM. The negative y-scale flips
 * the y axis (SVG y goes down, font y goes up).
 */
export const CAPTION_LINES: Array<{ inner: string; widthFu: number }> = [
  {
    widthFu: 16272,
    // Line 1: "CREATE YOURS"
    inner: `<path d="M1087 539 1374 448Q1308 208 1154.5 91.5Q1001 -25 765 -25Q473 -25 285.0 174.5Q97 374 97 720Q97 1086 286.0 1288.5Q475 1491 783 1491Q1052 1491 1220 1332Q1320 1238 1370 1062L1077 992Q1051 1106 968.5 1172.0Q886 1238 768 1238Q605 1238 503.5 1121.0Q402 1004 402 742Q402 464 502.0 346.0Q602 228 762 228Q880 228 965.0 303.0Q1050 378 1087 539Z"/><g transform="translate(1479,0)"><path d="M150 0V1466H773Q1008 1466 1114.5 1426.5Q1221 1387 1285.0 1286.0Q1349 1185 1349 1055Q1349 890 1252.0 782.5Q1155 675 962 647Q1058 591 1120.5 524.0Q1183 457 1289 286L1468 0H1114L900 319Q786 490 744.0 534.5Q702 579 655.0 595.5Q608 612 506 612H446V0ZM446 846H665Q878 846 931.0 864.0Q984 882 1014.0 926.0Q1044 970 1044 1036Q1044 1110 1004.5 1155.5Q965 1201 893 1213Q857 1218 677 1218H446Z"/></g><g transform="translate(2958,0)"><path d="M149 0V1466H1236V1218H445V893H1181V646H445V247H1264V0Z"/></g><g transform="translate(4324,0)"><path d="M1471 0H1149L1021 333H435L314 0H0L571 1466H884ZM926 580 724 1124 526 580Z"/></g><g transform="translate(5803,0)"><path d="M479 0V1218H44V1466H1209V1218H775V0Z"/></g><g transform="translate(7054,0)"><path d="M149 0V1466H1236V1218H445V893H1181V646H445V247H1264V0Z"/></g><g transform="translate(8989,0)"><path d="M534 0V617L-3 1466H344L689 886L1027 1466H1368L829 615V0Z"/></g><g transform="translate(10355,0)"><path d="M89 724Q89 948 156 1100Q206 1212 292.5 1301.0Q379 1390 482 1433Q619 1491 798 1491Q1122 1491 1316.5 1290.0Q1511 1089 1511 731Q1511 376 1318.0 175.5Q1125 -25 802 -25Q475 -25 282.0 174.5Q89 374 89 724ZM394 734Q394 485 509.0 356.5Q624 228 801 228Q978 228 1091.5 355.5Q1205 483 1205 738Q1205 990 1094.5 1114.0Q984 1238 801 1238Q618 1238 506.0 1112.5Q394 987 394 734Z"/></g><g transform="translate(11948,0)"><path d="M147 1466H443V672Q443 483 454 427Q473 337 544.5 282.5Q616 228 740 228Q866 228 930.0 279.5Q994 331 1007.0 406.0Q1020 481 1020 655V1466H1316V696Q1316 432 1292.0 323.0Q1268 214 1203.5 139.0Q1139 64 1031.0 19.5Q923 -25 749 -25Q539 -25 430.5 23.5Q322 72 259.0 149.5Q196 227 176 312Q147 438 147 684Z"/></g><g transform="translate(13427,0)"><path d="M150 0V1466H773Q1008 1466 1114.5 1426.5Q1221 1387 1285.0 1286.0Q1349 1185 1349 1055Q1349 890 1252.0 782.5Q1155 675 962 647Q1058 591 1120.5 524.0Q1183 457 1289 286L1468 0H1114L900 319Q786 490 744.0 534.5Q702 579 655.0 595.5Q608 612 506 612H446V0ZM446 846H665Q878 846 931.0 864.0Q984 882 1014.0 926.0Q1044 970 1044 1036Q1044 1110 1004.5 1155.5Q965 1201 893 1213Q857 1218 677 1218H446Z"/></g><g transform="translate(14906,0)"><path d="M74 477 362 505Q388 360 467.5 292.0Q547 224 682 224Q825 224 897.5 284.5Q970 345 970 426Q970 478 939.5 514.5Q909 551 833 578Q781 596 596 642Q358 701 262 787Q127 908 127 1082Q127 1194 190.5 1291.5Q254 1389 373.5 1440.0Q493 1491 662 1491Q938 1491 1077.5 1370.0Q1217 1249 1224 1047L928 1034Q909 1147 846.5 1196.5Q784 1246 659 1246Q530 1246 457 1193Q410 1159 410 1102Q410 1050 454 1013Q510 966 726.0 915.0Q942 864 1045.5 809.5Q1149 755 1207.5 660.5Q1266 566 1266 427Q1266 301 1196.0 191.0Q1126 81 998.0 27.5Q870 -26 679 -26Q401 -26 252.0 102.5Q103 231 74 477Z"/></g>`,
  },
  {
    widthFu: 5687,
    // Line 2: "NOW!"
    inner: `<path d="M152 0V1466H440L1040 487V1466H1315V0H1018L427 956V0Z"/><g transform="translate(1479,0)"><path d="M89 724Q89 948 156 1100Q206 1212 292.5 1301.0Q379 1390 482 1433Q619 1491 798 1491Q1122 1491 1316.5 1290.0Q1511 1089 1511 731Q1511 376 1318.0 175.5Q1125 -25 802 -25Q475 -25 282.0 174.5Q89 374 89 724ZM394 734Q394 485 509.0 356.5Q624 228 801 228Q978 228 1091.5 355.5Q1205 483 1205 738Q1205 990 1094.5 1114.0Q984 1238 801 1238Q618 1238 506.0 1112.5Q394 987 394 734Z"/></g><g transform="translate(3072,0)"><path d="M357 0 7 1466H310L531 459L799 1466H1151L1408 442L1633 1466H1931L1575 0H1261L969 1096L678 0Z"/></g><g transform="translate(5005,0)"><path d="M257 378 184 1122V1466H488V1122L416 378ZM196 0V281H477V0Z"/></g>`,
  },
];

/**
 * Render the multi-line caption as a single SVG `<g>` element. Each
 * line is centered horizontally on `centerX`. Lines are stacked
 * vertically with `lineSpacing` pixels between baselines.
 *
 * Returns the wrapped SVG string plus the total height of the rendered
 * block (top of first line's ascent to bottom of last line's descent).
 * Caller positions the block by passing `topY` (top of the first
 * line's ascent in their coord space).
 */
export function renderCenteredLinesGroup(opts: {
  fontSize: number;
  fill: string;
  centerX: number;
  topY: number;
  /** Distance between baselines, in px. Defaults to fontSize * 1.15. */
  lineSpacing?: number;
}): { svg: string; totalHeight: number; lineSpacing: number } {
  const scale = opts.fontSize / CAPTION_UPM;
  const ascent = CAPTION_ASCENT_FU * scale;
  const descent = CAPTION_DESCENT_FU * scale;
  const lineSpacing = opts.lineSpacing ?? opts.fontSize * 1.15;

  const groups: string[] = [];
  CAPTION_LINES.forEach((line, idx) => {
    const lineWidth = line.widthFu * scale;
    const originX = opts.centerX - lineWidth / 2;
    // First line's baseline sits at topY + ascent; each subsequent line
    // sits lineSpacing px below the previous baseline.
    const baselineY = opts.topY + ascent + idx * lineSpacing;
    const transform = `translate(${originX.toFixed(2)},${baselineY.toFixed(2)}) scale(${scale.toFixed(7)},${(-scale).toFixed(7)})`;
    groups.push(`<g transform="${transform}">${line.inner}</g>`);
  });

  // Total block height = top of first ascent (== topY) → bottom of last descent.
  const totalHeight =
    ascent + (CAPTION_LINES.length - 1) * lineSpacing + descent;
  const svg = `<g fill="${opts.fill}">${groups.join("")}</g>`;
  return { svg, totalHeight, lineSpacing };
}
