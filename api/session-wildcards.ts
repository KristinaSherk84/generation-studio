/**
 * POST /api/session-wildcards  body: { token, wildCards:[{url,label}] }  (2026-08-10)
 *
 * Attaches the finished Wild Card previews to an already-saved session so they
 * show on the "your headshots are ready" resume link (they generate after the
 * main grid is saved, so they're patched in here). Best-effort.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { setSessionWildCards } from "./lib/sessionStore.js";

export const maxDuration = 10;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false });
    return;
  }
  const body = (req.body ?? {}) as { token?: unknown; wildCards?: unknown };
  const token = typeof body.token === "string" ? body.token : "";
  const wildCards = Array.isArray(body.wildCards)
    ? (body.wildCards as {
        url?: unknown;
        label?: unknown;
        style?: unknown;
        lighting?: unknown;
        variationIndex?: unknown;
      }[])
        .filter(
          (w) =>
            w &&
            typeof w.url === "string" &&
            /^https?:\/\//.test(w.url as string),
        )
        .map((w) => ({
          url: w.url as string,
          label: typeof w.label === "string" ? w.label : "",
          // Optional regen metadata (2026-09-03). Persisted only when
          // present so a resumed session can re-fire /api/generate for the
          // correct style/lighting/variationIndex combo. Older clients
          // that don't send these fields still work — they just save
          // records without the metadata (same as before).
          style: typeof w.style === "string" ? w.style : undefined,
          lighting: typeof w.lighting === "string" ? w.lighting : undefined,
          variationIndex:
            typeof w.variationIndex === "number" &&
            Number.isFinite(w.variationIndex)
              ? w.variationIndex
              : undefined,
        }))
    : [];
  if (!token || wildCards.length === 0) {
    res.status(400).json({ ok: false, reason: "bad_input" });
    return;
  }
  try {
    const ok = await setSessionWildCards(token, wildCards);
    res.status(200).json({ ok });
  } catch (err) {
    console.warn(
      "[session-wildcards] failed:",
      err instanceof Error ? err.message : String(err),
    );
    res.status(200).json({ ok: false, reason: "store_error" });
  }
}
