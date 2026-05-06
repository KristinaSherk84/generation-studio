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
 * Current label is two-line, all-caps:
 *     SCAN TO TRY IT
 *        YOURSELF
 *
 * To change either line, regenerate the path data with the fontTools
 * Python helper that produced this (any prompt to me referencing
 * `regen_paths.py` for textPaths). Paste the new path strings + the
 * total advance width (in font units) into CAPTION_LINES below.
 */

/** Each rendered line of the caption. */
export const CAPTION_LABEL_LINES = ["SCAN TO TRY IT", "YOURSELF"];

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
    widthFu: 16270,
    // Line 1: "SCAN TO TRY IT"
    inner: `<path d="M1286 406Q1286 310 1251.0 231.5Q1216 153 1142.5 97.0Q1069 41 954.5 10.5Q840 -20 682 -20Q542 -20 435.0 5.0Q328 30 251.5 79.0Q175 128 127.5 200.5Q80 273 59 367L344 414Q356 367 379.0 328.0Q402 289 442.5 260.5Q483 232 543.5 216.5Q604 201 690 201Q840 201 919.5 246.5Q999 292 999 389Q999 447 967.0 484.0Q935 521 882.0 545.0Q829 569 760.0 585.0Q691 601 616 616Q556 630 496.0 645.0Q436 660 381.5 681.0Q327 702 280.0 731.0Q233 760 198.5 802.5Q164 845 144.5 902.0Q125 959 125 1036Q125 1141 167.0 1216.0Q209 1291 283.5 1338.5Q358 1386 461.0 1408.0Q564 1430 686 1430Q824 1430 922.5 1408.5Q1021 1387 1087.5 1343.0Q1154 1299 1192.5 1232.5Q1231 1166 1249 1077L963 1038Q941 1129 873.5 1175.0Q806 1221 680 1221Q602 1221 550.5 1207.5Q499 1194 468.5 1171.0Q438 1148 425.0 1117.5Q412 1087 412 1053Q412 1001 437.0 967.5Q462 934 507.0 911.5Q552 889 614.5 873.5Q677 858 752 842Q818 828 883.0 812.5Q948 797 1007.0 776.0Q1066 755 1117.0 725.0Q1168 695 1205.5 651.5Q1243 608 1264.5 548.0Q1286 488 1286 406Z"/><g transform="translate(1366,0)"><path d="M795 212Q878 212 938.5 235.5Q999 259 1043.5 297.0Q1088 335 1117.5 383.0Q1147 431 1166 480L1423 383Q1392 307 1342.0 234.0Q1292 161 1217.0 105.0Q1142 49 1038.5 14.5Q935 -20 795 -20Q612 -20 478.0 34.5Q344 89 256.5 186.5Q169 284 126.5 418.0Q84 552 84 711Q84 876 126.5 1009.0Q169 1142 255.0 1235.5Q341 1329 472.5 1379.5Q604 1430 782 1430Q920 1430 1023.5 1401.0Q1127 1372 1202.5 1319.5Q1278 1267 1327.5 1195.5Q1377 1124 1405 1038L1145 967Q1131 1012 1102.0 1053.5Q1073 1095 1028.5 1127.0Q984 1159 924.0 1178.5Q864 1198 788 1198Q681 1198 604.0 1163.5Q527 1129 477.5 1065.0Q428 1001 404.5 911.5Q381 822 381 711Q381 601 404.5 509.5Q428 418 478.0 352.0Q528 286 606.5 249.0Q685 212 795 212Z"/></g><g transform="translate(2845,0)"><path d="M1133 0 1008 360H471L346 0H51L565 1409H913L1425 0ZM803 987Q791 1022 779.5 1057.5Q768 1093 759.5 1122.5Q751 1152 745.5 1171.0Q740 1190 739 1192Q738 1189 733.0 1170.0Q728 1151 719.5 1122.0Q711 1093 699.5 1057.5Q688 1022 676 987L537 582H942Z"/></g><g transform="translate(4324,0)"><path d="M995 0 381 1085Q386 1041 390 997Q394 959 396.5 915.0Q399 871 399 831V0H137V1409H474L1097 315Q1092 357 1088 403Q1084 442 1081.5 491.0Q1079 540 1079 590V1409H1341V0Z"/></g><g transform="translate(6372,0)"><path d="M773 1181V0H478V1181H23V1409H1229V1181Z"/></g><g transform="translate(7623,0)"><path d="M1507 711Q1507 546 1458.0 411.0Q1409 276 1317.0 180.0Q1225 84 1092.5 32.0Q960 -20 793 -20Q616 -20 483.5 34.5Q351 89 262.0 186.5Q173 284 128.5 418.0Q84 552 84 711Q84 876 130.5 1009.0Q177 1142 267.5 1235.5Q358 1329 490.5 1379.5Q623 1430 795 1430Q967 1430 1099.5 1379.0Q1232 1328 1322.5 1234.0Q1413 1140 1460.0 1007.5Q1507 875 1507 711ZM1206 711Q1206 822 1179.5 911.5Q1153 1001 1101.0 1065.0Q1049 1129 972.5 1163.5Q896 1198 795 1198Q692 1198 614.5 1163.5Q537 1129 485.0 1065.0Q433 1001 407.0 911.5Q381 822 381 711Q381 601 407.5 509.5Q434 418 486.0 352.0Q538 286 615.0 249.0Q692 212 793 212Q901 212 979.0 249.5Q1057 287 1107.5 353.5Q1158 420 1182.0 511.5Q1206 603 1206 711Z"/></g><g transform="translate(9785,0)"><path d="M773 1181V0H478V1181H23V1409H1229V1181Z"/></g><g transform="translate(11036,0)"><path d="M1105 0 778 535H432V0H137V1409H841Q973 1409 1071.5 1379.5Q1170 1350 1236.0 1295.5Q1302 1241 1334.5 1163.5Q1367 1086 1367 989Q1367 910 1343.5 844.5Q1320 779 1278.5 728.0Q1237 677 1180.0 642.5Q1123 608 1056 592L1437 0ZM1070 977Q1070 1080 1002.5 1130.0Q935 1180 810 1180H432V764H818Q884 764 931.5 779.5Q979 795 1009.5 823.5Q1040 852 1055.0 891.0Q1070 930 1070 977Z"/></g><g transform="translate(12515,0)"><path d="M831 578V0H537V578L35 1409H344L682 813L1024 1409H1333Z"/></g><g transform="translate(14450,0)"><path d="M137 0V1409H432V0Z"/></g><g transform="translate(15019,0)"><path d="M773 1181V0H478V1181H23V1409H1229V1181Z"/></g>`,
  },
  {
    widthFu: 11151,
    // Line 2: "YOURSELF"
    inner: `<path d="M831 578V0H537V578L35 1409H344L682 813L1024 1409H1333Z"/><g transform="translate(1366,0)"><path d="M1507 711Q1507 546 1458.0 411.0Q1409 276 1317.0 180.0Q1225 84 1092.5 32.0Q960 -20 793 -20Q616 -20 483.5 34.5Q351 89 262.0 186.5Q173 284 128.5 418.0Q84 552 84 711Q84 876 130.5 1009.0Q177 1142 267.5 1235.5Q358 1329 490.5 1379.5Q623 1430 795 1430Q967 1430 1099.5 1379.0Q1232 1328 1322.5 1234.0Q1413 1140 1460.0 1007.5Q1507 875 1507 711ZM1206 711Q1206 822 1179.5 911.5Q1153 1001 1101.0 1065.0Q1049 1129 972.5 1163.5Q896 1198 795 1198Q692 1198 614.5 1163.5Q537 1129 485.0 1065.0Q433 1001 407.0 911.5Q381 822 381 711Q381 601 407.5 509.5Q434 418 486.0 352.0Q538 286 615.0 249.0Q692 212 793 212Q901 212 979.0 249.5Q1057 287 1107.5 353.5Q1158 420 1182.0 511.5Q1206 603 1206 711Z"/></g><g transform="translate(2959,0)"><path d="M723 -20Q591 -20 481.0 11.5Q371 43 291.5 109.5Q212 176 167.5 280.0Q123 384 123 528V1409H418V551Q418 462 440.0 397.5Q462 333 503.0 291.5Q544 250 602.0 230.5Q660 211 731 211Q803 211 863.5 231.5Q924 252 967.5 295.0Q1011 338 1035.0 404.0Q1059 470 1059 561V1409H1354V543Q1354 398 1307.0 292.0Q1260 186 1176.0 116.5Q1092 47 976.5 13.5Q861 -20 723 -20Z"/></g><g transform="translate(4438,0)"><path d="M1105 0 778 535H432V0H137V1409H841Q973 1409 1071.5 1379.5Q1170 1350 1236.0 1295.5Q1302 1241 1334.5 1163.5Q1367 1086 1367 989Q1367 910 1343.5 844.5Q1320 779 1278.5 728.0Q1237 677 1180.0 642.5Q1123 608 1056 592L1437 0ZM1070 977Q1070 1080 1002.5 1130.0Q935 1180 810 1180H432V764H818Q884 764 931.5 779.5Q979 795 1009.5 823.5Q1040 852 1055.0 891.0Q1070 930 1070 977Z"/></g><g transform="translate(5917,0)"><path d="M1286 406Q1286 310 1251.0 231.5Q1216 153 1142.5 97.0Q1069 41 954.5 10.5Q840 -20 682 -20Q542 -20 435.0 5.0Q328 30 251.5 79.0Q175 128 127.5 200.5Q80 273 59 367L344 414Q356 367 379.0 328.0Q402 289 442.5 260.5Q483 232 543.5 216.5Q604 201 690 201Q840 201 919.5 246.5Q999 292 999 389Q999 447 967.0 484.0Q935 521 882.0 545.0Q829 569 760.0 585.0Q691 601 616 616Q556 630 496.0 645.0Q436 660 381.5 681.0Q327 702 280.0 731.0Q233 760 198.5 802.5Q164 845 144.5 902.0Q125 959 125 1036Q125 1141 167.0 1216.0Q209 1291 283.5 1338.5Q358 1386 461.0 1408.0Q564 1430 686 1430Q824 1430 922.5 1408.5Q1021 1387 1087.5 1343.0Q1154 1299 1192.5 1232.5Q1231 1166 1249 1077L963 1038Q941 1129 873.5 1175.0Q806 1221 680 1221Q602 1221 550.5 1207.5Q499 1194 468.5 1171.0Q438 1148 425.0 1117.5Q412 1087 412 1053Q412 1001 437.0 967.5Q462 934 507.0 911.5Q552 889 614.5 873.5Q677 858 752 842Q818 828 883.0 812.5Q948 797 1007.0 776.0Q1066 755 1117.0 725.0Q1168 695 1205.5 651.5Q1243 608 1264.5 548.0Q1286 488 1286 406Z"/></g><g transform="translate(7283,0)"><path d="M137 0V1409H1245V1181H432V827H1184V599H432V228H1286V0Z"/></g><g transform="translate(8649,0)"><path d="M137 0V1409H432V228H1188V0Z"/></g><g transform="translate(9900,0)"><path d="M432 1181V745H1153V517H432V0H137V1409H1176V1181Z"/></g>`,
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
