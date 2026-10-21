/**
 * /api/admin/crop-check?d=<deliveryId>&k=<per-delivery key>  (2026-10-20, Kristi)
 *
 * Crop check for Glow Up deliveries, run AFTER the customer already has their
 * email. It used to run inside /api/deliver before the email went out, but
 * measuring faces takes ~15s each on the server's processor, so a 6-photo
 * Glow Up order (18 measurements) ran past the 300s limit and the customer got
 * nothing (Melissa Zerfoss, Oct 20). Now /api/deliver sends the customer email
 * first and then kicks off this separate function, which:
 *   1. compares the face size in each Polished / Glam version with the
 *      Realistic original (a face >8% bigger = cropped tighter),
 *   2. saves any flags on the delivery manifest, and
 *   3. emails Kristi a second "✂️ Crop check" email with the result and the
 *      "Review / redo retouches" button.
 * Nothing goes to the customer from here.
 *
 * Auth: the same per-delivery key as the review page (lib/reviewLink.ts).
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { list, put } from "@vercel/blob";
import { checkReviewKey, reviewUrl } from "../lib/reviewLink.js";
import { faceScale, cropRatio, CROP_TIGHT_RATIO } from "../lib/cropCheck.js";
import type { DeliveryManifest } from "../deliver.js";

export const maxDuration = 300;

// Stop measuring with enough time left to save the results and send the email.
const CHECK_BUDGET_MS = 240_000;
const KRISTI = "kristi@kristinasherk.com";

type Version = "polished" | "glam";

const esc = (s: string) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const manifestKey = (d: string) => `deliveries/${d}/manifest.json`;

async function loadManifest(d: string): Promise<DeliveryManifest | null> {
  const { blobs } = await list({ prefix: manifestKey(d), limit: 1 });
  const b = blobs.find((x) => x.pathname === manifestKey(d));
  if (!b) return null;
  const r = await fetch(`${b.url}?v=${Date.now()}`, { cache: "no-store" });
  return r.ok ? ((await r.json()) as DeliveryManifest) : null;
}

async function bytes(url: string): Promise<Buffer | null> {
  const r = await fetch(url).catch(() => null);
  return r && r.ok ? Buffer.from(await r.arrayBuffer()) : null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const startedAt = Date.now();
  const d = typeof req.query.d === "string" ? req.query.d : "";
  const k = typeof req.query.k === "string" ? req.query.k : "";
  if (!/^[A-Za-z0-9T:._-]{6,80}$/.test(d) || !checkReviewKey(d, k)) {
    res.status(401).json({ ok: false });
    return;
  }
  const m = await loadManifest(d);
  if (!m) {
    res.status(404).json({ ok: false, error: "delivery not found" });
    return;
  }

  // ---- 1. Measure ----
  const flagged: { i: number; v: Version; ratio: number; url: string }[] = [];
  let checked = 0;
  let skipped = 0;
  for (const [i, h] of m.deliveredHeadshots.entries()) {
    if (h.tier !== "deluxe") continue;
    const versions = (["polished", "glam"] as Version[]).filter((v) => h[v] && h[v] !== h.realistic);
    if (Date.now() - startedAt > CHECK_BUDGET_MS) {
      skipped += versions.length;
      continue;
    }
    const orig = await bytes(h.realistic);
    const scale = orig ? await faceScale(orig).catch(() => null) : null;
    const flags: { version: Version; ratio: number }[] = [];
    for (const v of versions) {
      if (Date.now() - startedAt > CHECK_BUDGET_MS) {
        skipped++;
        continue;
      }
      const buf = await bytes(h[v]!);
      const ratio = buf ? await cropRatio(scale, buf).catch(() => null) : null;
      checked++;
      if (ratio != null && ratio > CROP_TIGHT_RATIO) {
        const r = Math.round(ratio * 100) / 100;
        flags.push({ version: v, ratio: r });
        flagged.push({ i, v, ratio: r, url: h[v]! });
      }
    }
    if (flags.length) h.cropFlags = flags;
  }
  console.log(JSON.stringify({ type: "crop_check", deliveryId: d, checked, skipped, flagged: flagged.length, secs: Math.round((Date.now() - startedAt) / 1000) }));

  // ---- 2. Save the flags on the delivery ----
  if (flagged.length) {
    // Re-read first so a swap Kristi made on the review page meanwhile isn't lost.
    const fresh = (await loadManifest(d)) ?? m;
    for (const [i, h] of fresh.deliveredHeadshots.entries()) {
      const f = m.deliveredHeadshots[i]?.cropFlags;
      if (f?.length) h.cropFlags = f.filter((x) => h[x.version] === m.deliveredHeadshots[i]![x.version]);
    }
    await put(manifestKey(d), JSON.stringify(fresh, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
    }).catch((err) => console.warn("[crop-check] manifest save failed:", err));
  }

  // ---- 3. Email Kristi ----
  const apiKey = process.env.RESEND_API_KEY;
  const name = m.customerName || m.email;
  const label = (v: Version) => (v === "polished" ? "Polished" : "Glam");
  const rows = flagged
    .map((f) => {
      const real = m.deliveredHeadshots[f.i]!.realistic;
      return `<p style="margin:18px 0 6px;"><strong>Photo ${f.i + 1} — ${label(f.v)}</strong> · face ${Math.round((f.ratio - 1) * 100)}% bigger than the original</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:8px;text-align:center;font-size:12px;color:#888780;"><a href="${esc(real)}"><img src="${esc(real)}" width="200" style="width:200px;height:auto;border-radius:6px;border:1px solid #ddd;display:block;" alt="Realistic"></a>Realistic</td>
<td style="text-align:center;font-size:12px;color:#888780;"><a href="${esc(f.url)}"><img src="${esc(f.url)}" width="200" style="width:200px;height:auto;border-radius:6px;border:1px solid #ddd;display:block;" alt="${label(f.v)}"></a>${label(f.v)}</td>
</tr></table>`;
    })
    .join("");
  const summary = flagged.length
    ? `<p><strong>${flagged.length} version${flagged.length === 1 ? "" : "s"} may be cropped tighter</strong> than the Realistic original. ${esc(name)} already has their email; nothing has been sent to them about this.</p>`
    : `<p><strong>All clear.</strong> Every Polished and Glam version I measured keeps the same framing as the Realistic original.</p>`;
  const skippedNote = skipped
    ? `<p style="color:#888780;">${skipped} version${skipped === 1 ? " wasn't" : "s weren't"} measured (ran out of time) — give ${skipped === 1 ? "it" : "them"} a quick look.</p>`
    : "";
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.55;color:#2C2C2A;max-width:560px;">
<p>Crop check for <strong>${esc(name)}</strong> (${esc(m.email)}).</p>
${summary}${skippedNote}${rows}
<p style="margin-top:22px;"><a href="${esc(reviewUrl(d))}" style="display:inline-block;background:#1B4332;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;font-size:14px;font-weight:600;">Review / redo retouches →</a></p>
</div>`;
  const subject = flagged.length
    ? `✂️ Crop check: ${flagged.length} to look at — ${name}`
    : `✅ Crop check: all clear — ${name}`;
  if (apiKey) {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "GenerAItion Headshots <kristi@kristinasherk.com>",
        to: [KRISTI],
        subject,
        html,
      }),
    }).catch(() => null);
    if (!resp || !resp.ok) console.warn("[crop-check] alert email failed", resp?.status);
  }
  res.status(200).json({ ok: true, checked, skipped, flagged: flagged.length });
}
