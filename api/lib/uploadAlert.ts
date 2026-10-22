/**
 * Upload alert by country (2026-10-22, Kristi). A man rotated VPNs and emails
 * for free batches; his VPNs exited in the UK. Kristi asked to see the selfies
 * of ANY UK visitor the moment they upload. /api/check-marks receives all of a
 * visitor's photos a few seconds after upload, so it calls this: if Vercel's
 * country header matches UPLOAD_ALERT_COUNTRIES (default "GB"; "off" turns it
 * off, no redeploy), email Kristi the photos she hasn't been sent yet (each
 * photo once, so adding a photo doesn't resend the rest).
 *
 * Best-effort: never throws, never slows the mirror check by much.
 */
import type { VercelRequest } from "@vercel/node";
import { Redis } from "@upstash/redis";
import { emailsThatUsedPhotos, isEmailBlacklisted } from "./leadStore.js";

const redis = new Redis({
  url: process.env.KV_REST_API_URL ?? "",
  token: process.env.KV_REST_API_TOKEN ?? "",
});

const KRISTI = "kristi@kristinasherk.com";

const esc = (s: string) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const header = (req: VercelRequest, name: string): string => {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? "";
};

export async function alertCountryUpload(req: VercelRequest, urls: string[]): Promise<void> {
  try {
    const setting = (process.env.UPLOAD_ALERT_COUNTRIES ?? "GB").trim().toUpperCase();
    if (!setting || setting === "OFF") return;
    const countries = setting.split(",").map((c) => c.trim()).filter(Boolean);
    const country = header(req, "x-vercel-ip-country").toUpperCase();
    if (!country || !countries.includes(country)) return;
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey || urls.length === 0) return;

    // Each photo is sent once.
    const fresh: string[] = [];
    for (const u of urls) {
      const added = await redis.set(`upalert:${u}`, 1, { nx: true, ex: 3 * 86400 });
      if (added) fresh.push(u);
    }
    if (fresh.length === 0) return;

    const ip = header(req, "x-forwarded-for").split(",")[0]?.trim() || header(req, "x-real-ip");
    let city = header(req, "x-vercel-ip-city");
    try {
      city = decodeURIComponent(city);
    } catch {
      /* keep raw */
    }
    const where = [city, country].filter(Boolean).join(", ");
    const when = new Date().toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      month: "short",
      day: "numeric",
    });

    // Same exact selfie files used before under an email? (Exact-file match.)
    const usedBy = await emailsThatUsedPhotos(urls);
    const usedRows = await Promise.all(
      usedBy.map(async (e) => {
        const blocked = await isEmailBlacklisted(e).catch(() => false);
        return `${esc(e)}${blocked ? " <strong style=\"color:#7A1F1B;\">(blocked)</strong>" : ""}`;
      }),
    );
    const usedNote = usedRows.length
      ? `<p style="background:#FBEAEA;padding:10px 12px;border-radius:6px;">⚠️ These exact selfie files were already used by: ${usedRows.join(", ")}</p>`
      : "";

    const imgs = fresh
      .map(
        (u) =>
          `<a href="${esc(u)}"><img src="${esc(u)}" width="160" style="width:160px;height:auto;border-radius:6px;border:1px solid #ddd;margin:0 6px 6px 0;" alt="upload"></a>`,
      )
      .join("");
    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.55;color:#2C2C2A;max-width:560px;">
<p><strong>${fresh.length} new selfie${fresh.length === 1 ? "" : "s"}</strong> uploaded from <strong>${esc(where)}</strong> at ${esc(when)} ET.</p>
<p style="color:#888780;">IP ${esc(ip || "unknown")} · they haven't generated yet, so there's no email address yet.</p>
${usedNote}
<div>${imgs}</div>
</div>`;
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "GenerAItion Headshots <kristi@kristinasherk.com>",
        to: [KRISTI],
        subject: `${country === "GB" ? "🇬🇧 UK" : country} upload: ${fresh.length} selfie${fresh.length === 1 ? "" : "s"} — ${where}`,
        html,
      }),
    }).catch(() => null);
    console.log(JSON.stringify({ type: "upload_alert", country, city, ip, photos: fresh.length, sent: !!resp?.ok, usedBy }));
  } catch (err) {
    console.warn("[uploadAlert] failed:", err instanceof Error ? err.message : String(err));
  }
}
