/**
 * POST /api/upload
 *
 * Issues a short-lived, signed upload token so the browser can PUT a file
 * directly to Vercel Blob storage. The BLOB_READ_WRITE_TOKEN never leaves
 * this function — the client only gets a one-time token scoped to one upload.
 *
 * Guardrails (intentionally conservative for V1):
 *   - Only JPEG / PNG / WebP images are accepted
 *   - Max 15 MB per file
 *   - Random suffix added to every stored file name (so URLs are unguessable)
 *
 * Later (after Stripe is wired up in Step 6) we will also verify a paid session
 * ID inside onBeforeGenerateToken — no paid session, no token, no upload.
 *
 * Note on handler style:
 *   This uses Vercel's classic Node.js serverless function signature
 *   (req: VercelRequest, res: VercelResponse). Earlier we tried the newer
 *   Fetch-style handler (`(request: Request) => Response`), but that caused
 *   requests to hang for 5 minutes until Vercel's 300s timeout killed them —
 *   `await request.json()` never resolved under Node.js runtime with the
 *   Fetch-style adapter. Classic style uses Vercel's pre-parsed `req.body`
 *   and avoids the problem entirely.
 */

import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse | void> {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Vercel has already parsed the JSON body into `req.body` for us.
  const body = req.body as HandleUploadBody;

  // handleUpload expects a Web-API Request. Build one from the incoming
  // VercelRequest so the library can read headers / URL consistently.
  const protocol = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = req.headers.host || "localhost";
  const fullUrl = `${protocol}://${host}${req.url ?? "/api/upload"}`;
  const webRequest = new Request(fullUrl, {
    method: "POST",
    headers: new Headers(
      Object.entries(req.headers).reduce<Record<string, string>>(
        (acc, [k, v]) => {
          if (typeof v === "string") acc[k] = v;
          else if (Array.isArray(v)) acc[k] = v.join(", ");
          return acc;
        },
        {},
      ),
    ),
    body: JSON.stringify(body),
  });

  try {
    const jsonResponse = await handleUpload({
      body,
      request: webRequest,
      onBeforeGenerateToken: async () => {
        // V1: no auth check yet. In Step 6 we'll require a paid session here.
        return {
          allowedContentTypes: ["image/jpeg", "image/png", "image/webp"],
          maximumSizeInBytes: 15 * 1024 * 1024, // 15 MB
          tokenPayload: JSON.stringify({}),
          addRandomSuffix: true,
        };
      },
      // NOTE: onUploadCompleted intentionally omitted. It requires a public
      // callback URL; we'll reintroduce it in Step 6 when Stripe paid-session
      // tracking actually needs it.
    });

    return res.status(200).json(jsonResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    return res.status(400).json({ error: message });
  }
}
