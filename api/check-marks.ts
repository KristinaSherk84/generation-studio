/**
 * POST /api/check-marks  (2026-10-16, Kristi)
 * Body: { urls: string[] }  — the customer's uploaded reference photos (2–8)
 * Returns: { ok, inconsistent, what, sides, flagged }
 *
 * Mirror-image check for reference photos. Jenny (Oct 16) uploaded 5 photos
 * where a mole sat on one side of her mouth in 3 and on the OTHER side in 2
 * (two were mirror images), so the headshots put the mole on both sides.
 *
 * One cheap Gemini Flash vision call looks at all the photos together, finds
 * the most distinctive permanent mark (mole, beauty mark, scar), and reports
 * which side of each IMAGE it appears on. If the photos disagree, the upload
 * screen asks the customer to flip the odd ones out (we never flip for them).
 *
 * Best-effort: any failure returns { ok:false } and the upload screen shows
 * nothing.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GoogleGenAI, type Part } from "@google/genai";
import sharp from "sharp";

export const maxDuration = 30;

const BLOB_URL_RE = /^https:\/\/[^/]*\.public\.blob\.vercel-storage\.com\//;

type Side = "left" | "right" | null;

// Asking for "left/right" directly was unreliable (Jenny's 5 photos all came
// back "left"), so we ask for boxes and compare the mark to the nose
// ourselves. Gemini is much better at coordinates than at left/right words.
const PROMPT = (n: number) => `These ${n} photos all show the same person (photo 1 to photo ${n}, in order).

Find ONE distinctive permanent mark on the face that shows up in most of the photos: a mole, beauty mark, birthmark or scar. Ignore piercings, jewelry, makeup, freckles spread across the face and temporary blemishes.

For each photo give two bounding boxes as [ymin, xmin, ymax, xmax] on a 0-1000 scale of that photo:
- "mark": the box around that mark, or null if it isn't visible in that photo
- "nose": the box around the nose

Reply with JSON only, exactly this shape:
{"what": "short plain description of the mark, e.g. mole above the lip", "photos": [{"mark": [..] | null, "nose": [..] | null}, ...one entry per photo]}
If there is no such mark, reply {"what": "", "photos": []}.`;

type Box = [number, number, number, number];
const isBox = (b: unknown): b is Box =>
  Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === "number");
const centerX = (b: Box) => (b[1] + b[3]) / 2;

/** Which side of the IMAGE the mark sits on, relative to the nose. */
function sideOf(mark: unknown, nose: unknown): Side {
  if (!isBox(mark) || !isBox(nose)) return null;
  const noseW = Math.max(1, nose[3] - nose[1]);
  const dx = centerX(mark) - centerX(nose);
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
    const parts: Part[] = [{ text: PROMPT(urls.length) }];
    images.forEach((data, i) => {
      parts.push({ text: `Photo ${i + 1}:` });
      parts.push({ inlineData: { mimeType: "image/jpeg", data } });
    });
    const ai = new GoogleGenAI({ apiKey });
    const resp = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts }],
      config: { responseMimeType: "application/json", temperature: 0 },
    });
    const parsed = JSON.parse(resp.text ?? "{}") as {
      what?: string;
      photos?: { mark?: unknown; nose?: unknown }[];
    };
    const sides: Side[] = urls.map((_, i) => sideOf(parsed.photos?.[i]?.mark, parsed.photos?.[i]?.nose));
    const left = sides.filter((s) => s === "left").length;
    const right = sides.filter((s) => s === "right").length;
    const inconsistent = left > 0 && right > 0;
    // Flag the outnumbered side. On a tie we can't tell which is real, so
    // flag nothing and let the banner ask the customer to make them match.
    const minority: Side = !inconsistent || left === right ? null : left < right ? "left" : "right";
    const flagged = minority ? sides.flatMap((s, i) => (s === minority ? [i] : [])) : [];
    console.log(JSON.stringify({ type: "check_marks", n: urls.length, what: parsed.what, sides, inconsistent }));
    res.status(200).json({ ok: true, inconsistent, what: (parsed.what ?? "").slice(0, 80), sides, flagged });
  } catch (err) {
    console.warn("[check-marks] failed:", err instanceof Error ? err.message : String(err));
    res.status(200).json({ ok: false });
  }
}
