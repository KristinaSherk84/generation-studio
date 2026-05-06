/**
 * Face bounding-box detection via Gemini's vision API.
 *
 * Why this exists: Sharp's `strategy.attention` is salience-based, not
 * face-aware. On portrait photos with high-contrast hair or clothing
 * (white lab coats, busy backgrounds), it routinely picks regions that
 * aren't the face — the share graphics end up showing a forehead and
 * eyebrows or an empty chest with no face. We need actual face
 * coordinates.
 *
 * This module asks Gemini 2.5 Flash for a tight bbox around the main
 * face in the image. Gemini was trained to emit normalized bounding
 * boxes when prompted with the standard "[y_min, x_min, y_max, x_max]
 * scaled to 0-1000" pattern, so the output is reliable and parseable
 * with a single JSON.parse + light validation.
 *
 * Cost / latency budget:
 *   - Model: gemini-2.5-flash (text+vision, no image generation)
 *   - Cost:  ~$0.0001 per call on Tier 1
 *   - Latency: ~1-2 seconds per BEFORE photo
 *   - One BEFORE per delivery is reused across all 6 share graphics,
 *     so we detect once and cache (see compositeBeforeAfter.ts caller).
 */

import { GoogleGenAI } from "@google/genai";

/** Bounding box in normalized [0..1] coordinates relative to the image. */
export type NormalizedBox = {
  /** Top-left corner X, normalized 0..1 (0 = left edge). */
  xMin: number;
  /** Top-left corner Y, normalized 0..1 (0 = top edge). */
  yMin: number;
  /** Bottom-right corner X, normalized 0..1. */
  xMax: number;
  /** Bottom-right corner Y, normalized 0..1. */
  yMax: number;
};

/**
 * Ask Gemini for a tight bounding box around the largest/most-prominent
 * face in `imageBytes`. Returns null if no face is detected, or if the
 * model returns a parsing failure / out-of-range coordinates / an
 * unrecoverable API error. The caller should treat null as "no usable
 * face data" and fall back to a heuristic crop.
 *
 * The function never throws — every failure mode is logged and returns
 * null so a flaky face-detect call can't break a paid delivery.
 */
export async function detectFaceBox(
  imageBytes: Buffer,
  mimeType: string,
): Promise<NormalizedBox | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("[detectFaceBox] GEMINI_API_KEY missing; skipping face detection");
    return null;
  }

  // Standard Gemini bbox prompt. The model expects to emit
  // box_2d = [y_min, x_min, y_max, x_max] with each value in [0, 1000].
  // We keep the request tight so the response is short + cheap.
  const prompt =
    "Detect the bounding box around the head and face (forehead to chin, " +
    "ear to ear) of the main person in this photo. Return ONLY a JSON " +
    'object of the form {"box_2d": [y_min, x_min, y_max, x_max]} where ' +
    "each value is an integer in the range 0 to 1000 (image coordinates " +
    "normalized to 1000). If there is no clear face, return " +
    '{"box_2d": null}. Do not include any other text, markdown, or ' +
    "explanation.";

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType,
                data: imageBytes.toString("base64"),
              },
            },
          ],
        },
      ],
      config: {
        // Force JSON output so we don't have to strip markdown fences.
        responseMimeType: "application/json",
        // No need for long output; bbox JSON is ~50 tokens.
        maxOutputTokens: 100,
        // Deterministic output for the same image.
        temperature: 0,
      },
    });

    const candidate = response.candidates?.[0];
    const textPart = candidate?.content?.parts?.find(
      (p) => typeof p.text === "string",
    );
    const text = textPart?.text?.trim();
    if (!text) {
      console.warn("[detectFaceBox] empty response");
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      console.warn("[detectFaceBox] could not parse JSON:", text);
      return null;
    }

    const box = (parsed as { box_2d?: number[] | null } | null)?.box_2d;
    if (!Array.isArray(box) || box.length !== 4) {
      // Either no face, or unexpected shape.
      return null;
    }

    const [yMin, xMin, yMax, xMax] = box.map(Number);
    if (
      ![yMin, xMin, yMax, xMax].every(
        (v) => Number.isFinite(v) && v >= 0 && v <= 1000,
      )
    ) {
      console.warn("[detectFaceBox] out-of-range coords:", box);
      return null;
    }
    if (xMax <= xMin || yMax <= yMin) {
      console.warn("[detectFaceBox] degenerate box:", box);
      return null;
    }

    return {
      xMin: xMin / 1000,
      yMin: yMin / 1000,
      xMax: xMax / 1000,
      yMax: yMax / 1000,
    };
  } catch (err) {
    // Never let a face-detect failure abort a delivery.
    console.warn(
      "[detectFaceBox] API call failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
