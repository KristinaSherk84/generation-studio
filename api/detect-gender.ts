/**
 * POST /api/detect-gender   body: { photoUrls: string[] }   (2026-08-10)
 *
 * Classifies the person in the reference photos as "male" | "female", or
 * "unknown" when it can't tell (ambiguous, not a person, or any error). The
 * client calls this ONCE at the start of a batch and passes the result into
 * each /api/generate call, so the server can send men's shots only the men's
 * wording and women's only the women's (shorter, more focused prompts).
 *
 * FAIL-OPEN: any problem returns { gender: "unknown" }, and generation falls
 * back to today's behavior (both gender branches sent). This can never block
 * or break a batch.
 *
 * GET /api/detect-gender?photoUrl=...  → same, for quick manual testing.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GoogleGenAI } from "@google/genai";

export const maxDuration = 20;

// Fast, cheap vision model for a one-word classification. If this model id is
// ever unavailable on the account, detection simply returns "unknown" and
// generation keeps working exactly as before.
const CLASSIFIER_MODEL = "gemini-2.5-flash";

type Gender = "male" | "female" | "unknown";

async function urlToInline(
  url: string,
): Promise<{ mimeType: string; data: string } | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const mimeType = r.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await r.arrayBuffer());
    return { mimeType, data: buf.toString("base64") };
  } catch {
    return null;
  }
}

function parseGender(text: string): Gender {
  const t = (text || "").trim().toLowerCase();
  // Check FEMALE first — the word "female" contains "male", so a naive male
  // check would misfire on it.
  if (t.includes("female") || t === "f" || t.includes("woman")) return "female";
  if (t.includes("male") || t === "m" || t.includes("man")) return "male";
  return "unknown";
}

async function classify(photoUrls: string[]): Promise<Gender> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return "unknown";
  const urls = photoUrls.slice(0, 3);
  const inline = (await Promise.all(urls.map(urlToInline))).filter(
    (x): x is { mimeType: string; data: string } => !!x,
  );
  if (inline.length === 0) return "unknown";

  const ai = new GoogleGenAI({ apiKey });
  const parts: unknown[] = [
    {
      text:
        "These are reference photos of one person for a professional headshot. " +
        "Reply with EXACTLY ONE word describing their apparent presentation for " +
        "attire/styling purposes: MALE or FEMALE. If you genuinely cannot tell, " +
        "or the subject is not a human, reply UNKNOWN. One word only.",
    },
    ...inline.map((img) => ({
      inlineData: { mimeType: img.mimeType, data: img.data },
    })),
  ];

  try {
    const resp = await ai.models.generateContent({
      model: CLASSIFIER_MODEL,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      contents: [{ role: "user", parts: parts as any }],
    });
    const text =
      (resp as { text?: string }).text ??
      (resp as { candidates?: { content?: { parts?: { text?: string }[] } }[] })
        .candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join(" ") ??
      "";
    return parseGender(text);
  } catch {
    return "unknown";
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  let photoUrls: string[] = [];
  if (req.method === "POST") {
    const body = (req.body ?? {}) as { photoUrls?: unknown };
    if (Array.isArray(body.photoUrls)) {
      photoUrls = body.photoUrls.filter(
        (u): u is string => typeof u === "string" && /^https?:\/\//.test(u),
      );
    }
  } else if (typeof req.query.photoUrl === "string") {
    photoUrls = [req.query.photoUrl];
  }

  if (photoUrls.length === 0) {
    res.status(200).json({ gender: "unknown", reason: "no_photos" });
    return;
  }

  const gender = await classify(photoUrls);
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ gender });
}
