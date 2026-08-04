/**
 * POST /api/detect-gender  (2026-08-03)
 * Body: { photoUrls: string[] }  — the customer's reference photo Blob URLs.
 * Returns: { gender: "male" | "female" | null }
 *
 * A tiny one-word Gemini vision classification used ONLY to pick which
 * "Wild Card" preview styles to fire after the main batch (men vs women get
 * different wild cards). Best-effort: any failure returns { gender: null } and
 * the client falls back to the men's wild-card set. Deliberately NOT used for
 * anything identity- or attire-related — the generation model still infers
 * apparent gender on its own for attire.
 *
 * Reuses the same @google/genai client + GEMINI_API_KEY as /api/generate, so
 * there's no fragile face-api / model-weight dependency.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GoogleGenAI } from "@google/genai";

export const maxDuration = 20;

async function fetchInline(
  url: string,
): Promise<{ mimeType: string; data: string } | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const ab = await r.arrayBuffer();
    const mimeType = r.headers.get("content-type") || "image/jpeg";
    return { mimeType, data: Buffer.from(ab).toString("base64") };
  } catch {
    return null;
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== "POST") {
    return res.status(405).json({ gender: null });
  }
  const body = req.body as { photoUrls?: unknown };
  const urls = Array.isArray(body.photoUrls)
    ? (body.photoUrls.filter((u) => typeof u === "string") as string[])
    : [];
  if (urls.length === 0) {
    return res.status(200).json({ gender: null });
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(200).json({ gender: null });
  }

  try {
    const img = await fetchInline(urls[0]);
    if (!img) return res.status(200).json({ gender: null });

    const ai = new GoogleGenAI({ apiKey });
    const resp = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                'Reply with EXACTLY one lowercase word — "male" or "female" — ' +
                "describing the apparent gender presentation of the primary person " +
                "in this photo. No punctuation, no other words.",
            },
            { inlineData: { mimeType: img.mimeType, data: img.data } },
          ],
        },
      ],
    });

    const parts =
      (resp as { candidates?: { content?: { parts?: { text?: string }[] } }[] })
        ?.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("")
      .toLowerCase();
    // Order matters: "female" contains "male", so test female first.
    const gender = text.includes("female")
      ? "female"
      : text.includes("male")
        ? "male"
        : null;

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ gender });
  } catch (err) {
    console.warn(
      "[wildcard] /api/detect-gender failed:",
      err instanceof Error ? err.message : String(err),
    );
    return res.status(200).json({ gender: null });
  }
}
