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

// Two steps (2026-10-16): asking for left/right words, or for boxes in all
// photos at once, was unreliable on Jenny's photos. Step 1 names the mark
// using all photos together; step 2 locates it in each photo on its own
// (bounding boxes), and the side is decided in code from mark vs nose.
const NAME_PROMPT = (n: number) => `These ${n} photos all show the same person.

Is there ONE distinctive permanent mark on the face that shows up in most of the photos: a mole, beauty mark, birthmark or scar? Ignore piercings, jewelry, makeup, freckles spread across the face and temporary blemishes.

Reply with JSON only: {"what": "short plain description of where the mark is on the face, WITHOUT the words left or right, e.g. mole just above the upper lip"} or {"what": ""} if there is no such mark.`;

const LOCATE_PROMPT = (what: string) => `Find this person's ${what} in this photo, and their nose.

Give bounding boxes as [ymin, xmin, ymax, xmax] on a 0-1000 scale of this photo.
Reply with JSON only: {"mark": [..] or null if it isn't visible, "nose": [..]}`;

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
    const ai = new GoogleGenAI({ apiKey });
    const askJson = async <T,>(parts: Part[]): Promise<T | null> => {
      try {
        const resp = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [{ role: "user", parts }],
          config: { responseMimeType: "application/json", temperature: 0 },
        });
        return JSON.parse(resp.text ?? "null") as T;
      } catch {
        return null;
      }
    };
    const img = (data: string): Part => ({ inlineData: { mimeType: "image/jpeg", data } });

    // Step 1: what is the mark (all photos together)?
    const named = await askJson<{ what?: string }>([
      { text: NAME_PROMPT(urls.length) },
      ...images.flatMap((data, i) => [{ text: `Photo ${i + 1}:` } as Part, img(data)]),
    ]);
    const what = (named?.what ?? "").trim();
    if (!what) {
      res.status(200).json({ ok: true, inconsistent: false, what: "", sides: urls.map(() => null), flagged: [] });
      return;
    }
    // Step 2: where is it in each photo (one photo per call, in parallel)?
    const located = await Promise.all(
      images.map((data) => askJson<{ mark?: unknown; nose?: unknown }>([{ text: LOCATE_PROMPT(what) }, img(data)])),
    );
    const sides: Side[] = located.map((l) => sideOf(l?.mark, l?.nose));
    const parsed = { what };
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
