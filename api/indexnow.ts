/**
 * GET /api/indexnow — tell Bing (and other IndexNow engines) about our pages
 * (2026-10-13, Kristi: "prioritize being referenced by the chat bots").
 *
 * ChatGPT's web search runs on Bing, and Bing had indexed only the home page.
 * IndexNow is Bing's "ping me when pages change" API. This endpoint reads our
 * live sitemap and submits every URL in it.
 *
 * Runs weekly on a Vercel Cron (vercel.json) so new pages added to the sitemap
 * reach Bing within a week. Run it by hand right after publishing a page.
 *
 * The key below is public by design: IndexNow verifies ownership by fetching
 * https://generationheadshots.com/<key>.txt (public/<key>.txt), which must
 * contain the key.
 *
 * Auth: CRON_SECRET (Bearer header or ?key=) or ADMIN_PASSWORD (?adminpw=).
 *   ?adminpw=…&dryRun=1   list the URLs it would submit, submit nothing
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";

const HOST = "generationheadshots.com";
const INDEXNOW_KEY = "0b7847ddc211ca3a621013b91363a604";
const KEY_LOCATION = `https://${HOST}/${INDEXNOW_KEY}.txt`;
const SITEMAP_URL = `https://${HOST}/sitemap.xml`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cronSecret = process.env.CRON_SECRET;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const queryKey = typeof req.query.key === "string" ? req.query.key : "";
  const queryAdmin = typeof req.query.adminpw === "string" ? req.query.adminpw : "";
  const authorized =
    (!!cronSecret &&
      (req.headers.authorization === `Bearer ${cronSecret}` || queryKey === cronSecret)) ||
    (!!adminPassword && queryAdmin === adminPassword);
  if (!authorized) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  let urls: string[];
  try {
    const xml = await (await fetch(SITEMAP_URL)).text();
    urls = Array.from(xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g), (m) => m[1]).filter(
      (u) => u.startsWith(`https://${HOST}/`),
    );
  } catch (err) {
    res.status(500).json({ error: "Could not read sitemap", detail: String(err) });
    return;
  }
  if (urls.length === 0) {
    res.status(500).json({ error: "Sitemap had no URLs" });
    return;
  }

  if (req.query.dryRun === "1") {
    res.status(200).json({ ok: true, mode: "dryRun", count: urls.length, urls });
    return;
  }

  const resp = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: HOST, key: INDEXNOW_KEY, keyLocation: KEY_LOCATION, urlList: urls }),
  });
  const body = (await resp.text().catch(() => "")).slice(0, 300);
  // 200 = received, 202 = received (key check pending). Anything else is a failure.
  res.status(resp.status === 200 || resp.status === 202 ? 200 : 502).json({
    ok: resp.status === 200 || resp.status === 202,
    indexNowStatus: resp.status,
    submitted: urls.length,
    body,
  });
}
