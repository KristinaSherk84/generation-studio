/**
 * POST /api/check-marks  (2026-10-16, Kristi)
 * Body: { urls: string[], cameras?: ("front"|"rear"|null)[] } — the
 *       customer's uploaded reference photos (2–8) and, when the browser could
 *       read it from EXIF, which phone camera took each one.
 * Returns: { ok, inconsistent, what, sides, flagged, flip }
 *   flip = photos to mirror so they all match the real face (2026-10-21).
 *
 * Mirror-image check for reference photos. Jenny (Oct 16) uploaded 5 photos
 * where a mole sat on one side of her mouth in 3 and on the OTHER side in 2
 * (two were mirror images), so the headshots put the mole on both sides.
 *
 * One cheap Gemini Flash vision call looks at all the photos together, finds
 * the most distinctive permanent mark (mole, beauty mark, scar), and reports
 * which side of each IMAGE it appears on. If the photos disagree, the upload
 * screen flips the wrong-way photos quietly (2026-10-21, Kristi: asking the
 * customer to flip was too confusing). Which way is "real" is decided by
 * trusting photos someone else probably took — back camera, waist-up or
 * wider framing, other people in the shot — over arm's-length selfies, which
 * some phones and apps save mirrored.
 *
 * Best-effort: any failure returns { ok:false } and the upload screen shows
 * nothing.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GoogleGenAI, type Part } from "@google/genai";
import sharp from "sharp";
import { alertCountryUpload } from "./lib/uploadAlert.js";

export const maxDuration = 30;

// Vision model for the mark check. Overridable without a deploy; Google no
// longer offers gemini-2.5-flash to NEW API keys (2026-10-21), so a new key
// would need MARKS_MODEL set to a current Flash model.
const MARKS_MODEL = process.env.MARKS_MODEL?.trim() || "gemini-2.5-flash";

const BLOB_URL_RE = /^https:\/\/[^/]*\.public\.blob\.vercel-storage\.com\//;

type Side = "left" | "right" | null;

// How it works (2026-10-16, after several tries on Jenny's photos): asking
// for left/right words, for boxes in all photos at once, or naming the mark
// first were all unreliable. Now each photo is checked ON ITS OWN for its
// single most noticeable mole/mark plus the nose box; the side is decided in
// code, and only marks at about the same height on the face (relative to the
// nose) are compared, so a different mark in one photo doesn't count.
const LOCATE_PROMPT = `Look at this person's face. Find the single most noticeable mole, beauty mark, birthmark or scar on the face (not freckles, not blemishes, not piercings or jewelry).

Give bounding boxes as [ymin, xmin, ymax, xmax] on a 0-1000 scale of this photo.
Also describe the photo itself:
- "people": how many people are visible, counting anyone partly in the frame.
- "framing": how much of this person shows — "close-up", "head and shoulders", "waist up" or "full body".
- "selfie": true if the person took this photo of themselves (arm's-length angle, their arm or phone visible, or a mirror); false if someone else took it.

Reply with JSON only: {"mark": [..] or null if there is no such mark, "what": "short plain description of where it is, WITHOUT the words left or right", "nose": [..], "mouth": [..], "people": 1, "framing": "head and shoulders", "selfie": true}`;

type Box = [number, number, number, number];
type Camera = "front" | "rear" | null;
type Located = {
  mark?: unknown;
  nose?: unknown;
  mouth?: unknown;
  what?: string;
  people?: unknown;
  framing?: unknown;
  selfie?: unknown;
};

/**
 * How much to trust one photo's left/right (2026-10-21, Kristi). Photos
 * someone else probably took are almost never mirrored, so they count more:
 * a back-camera EXIF tag, waist-up or wider framing, or other people in the
 * shot. Arm's-length selfies and front-camera photos count less, because some
 * phones and apps (Samsung, Snapchat, Instagram…) save them mirrored.
 */
function trustWeight(l: Located | null, camera: Camera): number {
  let w = 1;
  if (camera === "rear") w += 3;
  const people = typeof l?.people === "number" ? l.people : 1;
  if (people >= 2) w += 2;
  const framing = typeof l?.framing === "string" ? l.framing.toLowerCase() : "";
  if (framing.includes("waist") || framing.includes("full")) w += 2;
  if (camera === "front") w *= 0.5;
  else if (l?.selfie === true && camera !== "rear") w *= 0.6;
  return w;
}
const isBox = (b: unknown): b is Box =>
  Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === "number");
const centerX = (b: Box) => (b[1] + b[3]) / 2;

/**
 * Which side of the IMAGE the mark sits on, relative to the face's center
 * line. The center line is the midpoint of the nose and mouth centers, which
 * holds up better than the nose alone when the face is slightly turned.
 */
function sideOf(mark: unknown, nose: unknown, mouth?: unknown): Side {
  if (!isBox(mark) || !isBox(nose)) return null;
  const mid = isBox(mouth) ? (centerX(nose) + centerX(mouth)) / 2 : centerX(nose);
  const noseW = Math.max(1, nose[3] - nose[1]);
  const dx = centerX(mark) - mid;
  // Too close to the face's center line to call (e.g. a mark right under the
  // middle of the nose) — skip rather than guess.
  if (Math.abs(dx) < noseW * 0.15) return null;
  return dx < 0 ? "left" : "right";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false });
    return;
  }
  const raw: unknown[] = Array.isArray(req.body?.urls) ? req.body.urls : [];
  const urls: string[] = raw.filter(
    (u): u is string => typeof u === "string" && BLOB_URL_RE.test(u),
  );
  const rawCams: unknown[] = Array.isArray(req.body?.cameras) ? req.body.cameras : [];
  // Only trust the camera list when it lines up 1:1 with the photos.
  const cameras: Camera[] = urls.map((_, i) =>
    raw.length === urls.length && (rawCams[i] === "front" || rawCams[i] === "rear")
      ? (rawCams[i] as Camera)
      : null,
  );
  // Blocked-person upload alert to Kristi (see lib/uploadAlert.ts). Before the size check
  // so 9+ photos still alert.
  await alertCountryUpload(req, urls);
  if (urls.length < 2 || urls.length > 8) {
    res.status(400).json({ ok: false, error: "need 2-8 photo urls" });
    return;
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(200).json({ ok: false });
    return;
  }
  try {
    // Small copies are plenty to see a mole and keep the call cheap/fast.
    const images = await Promise.all(
      urls.map(async (u) => {
        const r = await fetch(u);
        if (!r.ok) throw new Error(`fetch ${r.status}`);
        const buf = await sharp(Buffer.from(await r.arrayBuffer()))
          .rotate()
          .resize(768, 768, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
        return buf.toString("base64");
      }),
    );
    const ai = new GoogleGenAI({ apiKey });
    const askJson = async <T,>(parts: Part[]): Promise<T | null> => {
      try {
        const resp = await ai.models.generateContent({
          model: MARKS_MODEL,
          contents: [{ role: "user", parts }],
          config: { responseMimeType: "application/json", temperature: 0 },
        });
        return JSON.parse(resp.text ?? "null") as T;
      } catch {
        return null;
      }
    };
    const img = (data: string): Part => ({ inlineData: { mimeType: "image/jpeg", data } });

    // Each photo is looked at TWICE (2026-10-21). Photos are now flipped
    // silently, so a one-off misread (a "mole" where there is none) must not
    // count: a photo's side only counts when both looks agree.
    const locateAll = () =>
      Promise.all(images.map((data) => askJson<Located>([{ text: LOCATE_PROMPT }, img(data)])));
    const [located, located2] = await Promise.all([locateAll(), locateAll()]);
    // Height of each mark relative to the nose (in nose-heights below the nose
    // center). Keep only marks near the most common height = the same mark.
    const sidesFor = (runs: (Located | null)[]) => {
      const rel = runs.map((l) => {
        if (!isBox(l?.mark) || !isBox(l?.nose)) return null;
        const noseH = Math.max(1, l.nose[2] - l.nose[0]);
        return ((l.mark[0] + l.mark[2]) / 2 - (l.nose[0] + l.nose[2]) / 2) / noseH;
      });
      const known = rel.filter((r): r is number => r !== null).sort((a, b) => a - b);
      const median = known.length ? known[Math.floor(known.length / 2)] : 0;
      const sides: Side[] = runs.map((l, i) =>
        rel[i] !== null && Math.abs((rel[i] as number) - median) <= 0.6 ? sideOf(l?.mark, l?.nose, l?.mouth) : null,
      );
      return { rel, median, sides };
    };
    const first = sidesFor(located);
    const second = sidesFor(located2);
    const sides: Side[] = first.sides.map((s, i) => (s && s === second.sides[i] ? s : null));
    const { rel, median } = first;
    const whatIdx = rel.findIndex((r) => r !== null && Math.abs(r - median) <= 0.6);
    const parsed = { what: whatIdx >= 0 ? (located[whatIdx]?.what ?? "") : "" };
    const left = sides.filter((s) => s === "left").length;
    const right = sides.filter((s) => s === "right").length;
    const inconsistent = left > 0 && right > 0;
    // Decide which side is real by trust weight (see trustWeight); a clear
    // lead (25%+) wins. Otherwise fall back to the photo count, and on a true
    // tie flip nothing — a wrong flip is worse than none.
    const weights = located.map((l, i) => trustWeight(l, cameras[i] ?? null));
    const wLeft = sides.reduce((t, s, i) => t + (s === "left" ? weights[i] : 0), 0);
    const wRight = sides.reduce((t, s, i) => t + (s === "right" ? weights[i] : 0), 0);
    let real: Side = null;
    if (inconsistent) {
      if (wLeft >= wRight * 1.25) real = "left";
      else if (wRight >= wLeft * 1.25) real = "right";
      else if (left !== right) real = left > right ? "left" : "right";
    }
    const wrong: Side = real === "left" ? "right" : real === "right" ? "left" : null;
    const flip = wrong ? sides.flatMap((s, i) => (s === wrong ? [i] : [])) : [];
    // Back-compat name for the same list (the old banner flagged these).
    const flagged = flip;
    console.log(
      JSON.stringify({
        type: "check_marks",
        n: urls.length,
        what: parsed.what,
        sides,
        inconsistent,
        weights: weights.map((w) => Math.round(w * 10) / 10),
        cameras,
        framing: located.map((l) => (typeof l?.framing === "string" ? l.framing : null)),
        people: located.map((l) => (typeof l?.people === "number" ? l.people : null)),
        selfie: located.map((l) => (typeof l?.selfie === "boolean" ? l.selfie : null)),
        flip,
      }),
    );
    res.status(200).json({ ok: true, inconsistent, what: (parsed.what ?? "").slice(0, 80), sides, flagged, flip });
  } catch (err) {
    console.warn("[check-marks] failed:", err instanceof Error ? err.message : String(err));
    res.status(200).json({ ok: false });
  }
}
