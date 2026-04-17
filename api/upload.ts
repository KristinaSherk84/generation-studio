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
 */

import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

// Node.js runtime required. Edge runtime rejects @vercel/blob's internals
// (undici + node:stream / node:crypto / node:tls etc. are Node-only).
// `vercel dev` has known hang issues with this pattern locally, so we test
// uploads on the deployed preview URL rather than via `vercel dev`.
export const config = { runtime: "nodejs" };

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { "content-type": "application/json" } },
    );
  }

  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => {
        // V1: no auth check yet. In Step 6 we'll require a paid session here.
        return {
          allowedContentTypes: ["image/jpeg", "image/png", "image/webp"],
          maximumSizeInBytes: 15 * 1024 * 1024, // 15 MB
          tokenPayload: JSON.stringify({}),
          addRandomSuffix: true,
        };
      },
      // NOTE: onUploadCompleted intentionally omitted.
      // Including it requires a public callback URL, which doesn't exist under
      // `vercel dev` (localhost isn't reachable from Vercel's Blob service, so
      // it refuses to issue the token at all). We'll reintroduce this in Step 6
      // when Stripe paid-session tracking actually needs it.
    });

    return Response.json(jsonResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
}
