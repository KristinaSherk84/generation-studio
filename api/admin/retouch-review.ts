/**
 * /api/admin/retouch-review — phone-friendly "Review / redo retouches" page
 * (2026-10-16, Kristi).
 *
 * The Glow Up retouch pass sometimes re-crops Polished / Glam tighter than the
 * Realistic original. Kristi checks deliveries from her phone, so this page
 * (linked from her delivery alert email) lets her:
 *   1. see Realistic / Polished / Glam side by side for each photo,
 *   2. Redo a version (same Gemini Pro pass, current prompt-editor text),
 *   3. "Use this one" to swap the new render into the delivery, and
 *   4. send the customer a personal note with the fixed photos.
 * Nothing reaches the customer until she taps Send.
 *
 * Auth: ?d=<deliveryId>&k=<per-delivery key> (see lib/reviewLink.ts).
 * GET renders the page; POST { action: "redo" | "use" | "send", d, k, ... }.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { list, put } from "@vercel/blob";
import { GoogleGenAI } from "@google/genai";
import { checkReviewKey } from "../lib/reviewLink.js";
import { faceScale, cropRatio, CROP_TIGHT_RATIO } from "../lib/cropCheck.js";
import {
  renderRetouchImage,
  type DeliveryManifest,
  type DeliveredHeadshot,
} from "../deliver.js";

export const maxDuration = 300;

type Version = "polished" | "glam";
type Revision = {
  photoIndex: number;
  version: Version;
  oldUrl: string;
  newUrl: string;
  at: string;
  sentAt?: string;
};
type Manifest = DeliveryManifest & { revisions?: Revision[] };

const KRISTI = "kristi@kristinasherk.com";

const esc = (s: string) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const manifestKey = (d: string) => `deliveries/${d}/manifest.json`;

async function loadManifest(d: string): Promise<Manifest | null> {
  const { blobs } = await list({ prefix: manifestKey(d), limit: 1 });
  const b = blobs.find((x) => x.pathname === manifestKey(d));
  if (!b) return null;
  // Cache-bust: the manifest is overwritten in place when Kristi swaps a photo.
  const r = await fetch(`${b.url}?v=${Date.now()}`, { cache: "no-store" });
  return r.ok ? ((await r.json()) as Manifest) : null;
}

async function saveManifest(d: string, m: Manifest): Promise<void> {
  await put(manifestKey(d), JSON.stringify(m, null, 2), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
  });
}

const firstName = (name?: string) => {
  const f = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return f ? f.charAt(0).toUpperCase() + f.slice(1) : "";
};
const label = (v: Version) => (v === "polished" ? "Polished" : "Glam");

/** Default note, written in Kristi's voice from the unsent fixes. */
function draftNote(m: Manifest, pending: Revision[]): string {
  const fn = firstName(m.customerName);
  const multiPhoto = m.deliveredHeadshots.filter((h) => h.tier === "deluxe").length > 1;
  const items = pending.map((r) =>
    multiPhoto ? `the ${label(r.version)} version of photo ${r.photoIndex + 1}` : `your ${label(r.version)} version`,
  );
  const what =
    items.length <= 1
      ? items[0] ?? "one of your retouched versions"
      : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  return `Hi${fn ? ` ${fn}` : ""},

I check every Glow Up delivery by hand before I call it done, and I noticed ${what} came out cropped a little tighter than your original photo. I re-ran it so the framing matches, and the updated ${pending.length > 1 ? "versions are" : "version is"} below.

Thanks so much for your order!

Kristina`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const src = req.method === "POST" ? ((req.body ?? {}) as Record<string, unknown>) : req.query;
  const d = typeof src.d === "string" ? src.d : "";
  const k = typeof src.k === "string" ? src.k : "";
  if (!/^[A-Za-z0-9T:._-]{6,80}$/.test(d) || !checkReviewKey(d, k)) {
    res.status(401).send("This review link is invalid or expired.");
    return;
  }
  const m = await loadManifest(d);
  if (!m) {
    res.status(404).send("Delivery not found.");
    return;
  }

  if (req.method === "POST") {
    const action = src.action;
    const i = Number(src.photoIndex);
    const version = src.version === "polished" || src.version === "glam" ? (src.version as Version) : null;
    const h: DeliveredHeadshot | undefined = m.deliveredHeadshots[i];

    if (action === "redo") {
      if (!h || h.tier !== "deluxe" || !version) return void res.status(400).json({ ok: false, error: "bad photo" });
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return void res.status(500).json({ ok: false, error: "GEMINI_API_KEY missing" });
      try {
        const r = await fetch(h.realistic);
        if (!r.ok) throw new Error(`Couldn't load the original (HTTP ${r.status})`);
        const buf = Buffer.from(await r.arrayBuffer());
        const out = await renderRetouchImage({
          ai: new GoogleGenAI({ apiKey }),
          sourceBytes: buf,
          sourceMime: r.headers.get("content-type") ?? "image/jpeg",
          subTier: version,
          deliveryId: d,
          photoIndex: i,
          startedAt: Date.now(),
          deadlineMs: 240_000,
        });
        if (!out) throw new Error("Google answered but sent back no image");
        const ratio = await cropRatio(await faceScale(buf).catch(() => null), out.buffer).catch(() => null);
        const blob = await put(`deliveries/${d}/redo-${i}-${version}-${Date.now()}.jpg`, out.buffer, {
          access: "public",
          contentType: out.mime,
          addRandomSuffix: false,
        });
        res.status(200).json({ ok: true, url: blob.url, ratio });
      } catch (err) {
        res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (action === "use") {
      const url = typeof src.url === "string" ? src.url : "";
      if (!h || h.tier !== "deluxe" || !version || !url.includes(`/deliveries/${d}/redo-${i}-${version}-`)) {
        return void res.status(400).json({ ok: false, error: "bad request" });
      }
      const oldUrl = h[version] ?? h.realistic;
      h[version] = url;
      h.cropFlags = (h.cropFlags ?? []).filter((f) => f.version !== version);
      // Replace any unsent fix for the same version; keep the very first old URL.
      const prior = (m.revisions ?? []).find((r) => r.photoIndex === i && r.version === version && !r.sentAt);
      m.revisions = (m.revisions ?? []).filter((r) => r !== prior);
      m.revisions.push({ photoIndex: i, version, oldUrl: prior?.oldUrl ?? oldUrl, newUrl: url, at: new Date().toISOString() });
      await saveManifest(d, m);
      const pending = m.revisions.filter((r) => !r.sentAt);
      res.status(200).json({ ok: true, note: draftNote(m, pending), pendingCount: pending.length });
      return;
    }

    if (action === "send") {
      const note = typeof src.note === "string" ? src.note.trim() : "";
      const pending = (m.revisions ?? []).filter((r) => !r.sentAt);
      if (!note || pending.length === 0) return void res.status(400).json({ ok: false, error: "nothing to send" });
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) return void res.status(500).json({ ok: false, error: "RESEND_API_KEY missing" });
      const multiPhoto = m.deliveredHeadshots.filter((x) => x.tier === "deluxe").length > 1;
      const photoHtml = pending
        .map(
          (r) => `<p style="margin:18px 0 6px;"><strong>${esc(label(r.version))}${multiPhoto ? ` (photo ${r.photoIndex + 1})` : ""}</strong></p>
<a href="${esc(r.newUrl)}"><img src="${esc(r.newUrl)}" alt="${esc(label(r.version))}" width="240" style="width:240px;max-width:100%;height:auto;border-radius:6px;border:1px solid #ddd;display:block;" /></a>
<p style="margin:6px 0 0;"><a href="${esc(r.newUrl)}">Download the updated ${esc(label(r.version))} version</a></p>`,
        )
        .join("");
      const noteHtml = esc(note).replace(/\n/g, "<br>");
      const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#2C2C2A;max-width:560px;">${noteHtml}${photoHtml}</div>`;
      const text = `${note}\n\n${pending
        .map((r) => `${label(r.version)}${multiPhoto ? ` (photo ${r.photoIndex + 1})` : ""}: ${r.newUrl}`)
        .join("\n")}`;
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Kristi at GenerAItion Headshots <kristi@kristinasherk.com>",
          to: [m.email],
          bcc: [KRISTI],
          reply_to: KRISTI,
          subject: pending.length > 1 ? "Your updated headshots" : "Your updated headshot",
          html,
          text,
        }),
      });
      if (!resp.ok) {
        const body = (await resp.text().catch(() => "")).slice(0, 300);
        return void res.status(502).json({ ok: false, error: `Email didn't send (${resp.status}) ${body}` });
      }
      const now = new Date().toISOString();
      for (const r of pending) r.sentAt = now;
      await saveManifest(d, m);
      res.status(200).json({ ok: true, sentTo: m.email, count: pending.length });
      return;
    }

    res.status(400).json({ ok: false, error: "unknown action" });
    return;
  }

  const page = renderReviewPage(m, d, k);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(page);
}

/** The review page HTML (exported so it can be previewed locally). */
export function renderReviewPage(m: Manifest, d: string, k: string): string {
  const pending = (m.revisions ?? []).filter((r) => !r.sentAt);
  const sent = (m.revisions ?? []).filter((r) => r.sentAt);
  const tile = (url: string, cap: string, extra = "") =>
    `<figure><a href="${esc(url)}" target="_blank"><img src="${esc(url)}" alt="${esc(cap)}" loading="lazy"></a><figcaption>${esc(cap)}${extra}</figcaption></figure>`;
  const rows = m.deliveredHeadshots
    .map((h, i) => {
      if (h.tier !== "deluxe") {
        return `<section class="photo"><h2>Photo ${i + 1} <small>Basic (no retouch)</small></h2><div class="trio one">${tile(h.realistic, "Realistic")}</div></section>`;
      }
      const flag = (v: Version) => {
        const f = h.cropFlags?.find((x) => x.version === v);
        return f ? ` <span class="warn">✂️ ${Math.round((f.ratio - 1) * 100)}% tighter</span>` : "";
      };
      const versionCol = (v: Version) => {
        const url = h[v] ?? h.realistic;
        const failed = url === h.realistic;
        return `<div class="col">${tile(url, label(v), failed ? ` <span class="warn">failed</span>` : flag(v))}
          <button class="redo" data-i="${i}" data-v="${v}">↻ Redo</button>
          <div class="cand" id="cand-${i}-${v}"></div></div>`;
      };
      return `<section class="photo"><h2>Photo ${i + 1}</h2>
        <div class="trio"><div class="col">${tile(h.realistic, "Original")}</div>${versionCol("polished")}${versionCol("glam")}</div></section>`;
    })
    .join("");

  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review Retouches</title>
<style>
:root{--bg:#F5F5F3;--text:#2C2C2A;--mid:#888780;--line:#E8E8E6;--green:#1B4332;--warn:#9A5B00;--warnbg:#FFF6E5}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,-apple-system,system-ui,sans-serif;font-size:15px}
.wrap{max-width:760px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:4px 0}.meta{color:var(--mid);font-size:13px;margin:0 0 14px}
.photo{background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px;margin:0 0 14px}
h2{font-size:15px;margin:0 0 10px}h2 small{color:var(--mid);font-weight:400}
.trio{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;align-items:start}.col{display:flex;flex-direction:column}figcaption{min-height:32px}.trio.one{grid-template-columns:1fr 1fr 1fr}
figure{margin:0}figure img{width:100%;aspect-ratio:3/4;object-fit:contain;background:var(--line);border-radius:6px;display:block}
figcaption{font-size:12px;color:var(--mid);margin-top:4px;line-height:1.3}
.warn{color:var(--warn);background:var(--warnbg);border-radius:4px;padding:0 4px;font-weight:600;white-space:nowrap}
.good{color:#1B6B4C;font-weight:600}
button{font:inherit;border-radius:999px;border:1px solid var(--green);background:#fff;color:var(--green);padding:8px 10px;width:100%;margin-top:6px;font-size:13px;font-weight:600}
button.primary{background:var(--green);color:#fff}button:disabled{opacity:.5}
.cand{margin-top:8px}.cand .busy{font-size:12px;color:var(--mid)}
.note{background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px;margin:18px 0 40px}
textarea{width:100%;min-height:210px;font:inherit;font-size:15px;line-height:1.5;padding:10px;border:1px solid var(--line);border-radius:6px}
.msg{font-size:14px;margin-top:8px}
</style></head><body><div class="wrap">
<h1>Review retouches</h1>
<p class="meta">${esc(m.customerName)} · ${esc(m.email)} · ${esc(m.timestamp.slice(0, 16).replace("T", " "))} UTC<br>Tap a photo to see it full size. A redo takes about 20–60 seconds. Nothing reaches the customer until you tap Send.</p>
${rows}
<div class="note" id="note" ${pending.length ? "" : 'style="display:none"'}>
  <h2>Note to ${esc(firstName(m.customerName) || m.email)}</h2>
  <textarea id="noteText">${esc(pending.length ? draftNote(m, pending) : "")}</textarea>
  <button class="primary" id="send">Send fixed photos to ${esc(m.email)}</button>
  <div class="msg" id="sendMsg"></div>
</div>
${sent.length ? `<p class="meta">Already sent: ${sent.map((r) => `${label(r.version)} (photo ${r.photoIndex + 1}) on ${esc((r.sentAt ?? "").slice(0, 10))}`).join(", ")}</p>` : ""}
</div>
<script>
const D=${JSON.stringify(d)},K=${JSON.stringify(k)},TIGHT=${CROP_TIGHT_RATIO};
async function post(body){const r=await fetch(location.pathname,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(Object.assign({d:D,k:K},body))});return r.json();}
function ratioText(r){if(r==null)return "";const p=Math.round((r-1)*100);return r>TIGHT?' <span class="warn">✂️ '+p+'% tighter</span>':' <span class="good">framing OK</span>';}
document.querySelectorAll("button.redo").forEach(function(b){b.addEventListener("click",async function(){
  const i=+b.dataset.i,v=b.dataset.v,box=document.getElementById("cand-"+i+"-"+v);
  b.disabled=true;box.innerHTML='<div class="busy">Re-running… about 20–60 seconds</div>';
  try{const j=await post({action:"redo",photoIndex:i,version:v});
    if(!j.ok)throw new Error(j.error||"failed");
    box.innerHTML='<figure><a href="'+j.url+'" target="_blank"><img src="'+j.url+'"></a><figcaption>New version'+ratioText(j.ratio)+'</figcaption></figure><button class="primary use">✓ Use this one</button>';
    box.querySelector("button.use").addEventListener("click",async function(){
      this.disabled=true;const u=await post({action:"use",photoIndex:i,version:v,url:j.url});
      if(!u.ok){this.disabled=false;alert(u.error||"Couldn't save");return;}
      const col=box.parentElement;col.querySelector("figure img").src=j.url;col.querySelector("figure a").href=j.url;
      col.querySelector("figcaption").innerHTML=v==="polished"?"Polished <span class=good>✓ updated</span>":"Glam <span class=good>✓ updated</span>";
      box.innerHTML="";document.getElementById("note").style.display="";document.getElementById("noteText").value=u.note;
      document.getElementById("note").scrollIntoView({behavior:"smooth"});});
  }catch(e){box.innerHTML='<div class="busy">Didn\\'t work: '+e.message+'. Try again.</div>';}
  b.disabled=false;b.textContent="↻ Redo again";});});
document.getElementById("send").addEventListener("click",async function(){
  const msg=document.getElementById("sendMsg"),note=document.getElementById("noteText").value;
  if(!confirm("Send this note and the fixed photos to ${esc(m.email)}?"))return;
  this.disabled=true;msg.textContent="Sending…";
  const j=await post({action:"send",note:note});
  if(j.ok){msg.innerHTML='<span class="good">Sent to '+j.sentTo+' ✓</span> (you were BCC\\'d)';}else{this.disabled=false;msg.textContent="Didn't send: "+(j.error||"error");}});
</script></body></html>`;
  return page;
}
