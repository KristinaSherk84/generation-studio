/**
 * POST /api/client-error  (2026-08-05)
 *
 * Tiny sink for client-side React crashes caught by the app's ErrorBoundary.
 * A render crash in the browser never hits a serverless function on its own,
 * so these were invisible — this makes them show up in the Vercel runtime logs
 * (as a console.error line) with the message, stack, page URL, and user agent,
 * so we can find and fix the root cause. Always returns 200; never blocks.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";

export const maxDuration = 5;

const s = (v: unknown, n: number): string =>
  typeof v === "string" ? v.slice(0, n) : "";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false });
    return;
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  console.error(
    "[client-crash]",
    JSON.stringify({
      type: "client_crash",
      message: s(b.message, 500),
      stack: s(b.stack, 3000),
      componentStack: s(b.componentStack, 3000),
      url: s(b.url, 500),
      ua: s(b.ua, 400),
    }),
  );
  res.status(200).json({ ok: true });
}
