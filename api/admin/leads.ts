/**
 * GET /api/admin/leads?pw=YOUR_ADMIN_PASSWORD
 *
 * Password-protected view of the captured lead list ("abandoned sessions" =
 * people who generated but haven't purchased). Uses the same ADMIN_PASSWORD
 * env var as the promo admin dashboard.
 *
 * Default: renders an HTML WEBPAGE you can bookmark and open daily — no
 * download. Reload the page to refresh.
 * ?format=csv : downloads leads.csv (spreadsheet-ready) instead.
 *
 * (Webpage view added 2026-07-31; CSV download preserved.)
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { listLeads } from "../lib/leadStore.js";

export const maxDuration = 10;

function safeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function csvCell(v: string | number | boolean | null): string {
  const s = v === null ? "" : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

/** Escape a value for safe insertion into HTML (emails/source are user input). */
function esc(v: string | number | boolean | null): string {
  const s = v === null ? "" : String(v);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Format an ISO-8601 timestamp in US Eastern time (handles EST/EDT and DST
 *  automatically). Empty string for null/blank. */
function formatET(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  const pw =
    typeof req.query.pw === "string"
      ? req.query.pw
      : Array.isArray(req.query.pw)
        ? req.query.pw[0]
        : "";
  const format =
    typeof req.query.format === "string" ? req.query.format : "";
  const expected = process.env.ADMIN_PASSWORD ?? "";

  if (!expected || !safeEquals(pw, expected)) {
    res.status(401).send("Unauthorized");
    return;
  }

  try {
    const leads = await listLeads();

    // ---- CSV download branch (unchanged behavior) ----
    if (format === "csv") {
      const header = [
        "email",
        "createdAt (ET)",
        "lastSeenAt (ET)",
        "generateCount",
        "purchased",
        "purchasedAt (ET)",
        "followedUp",
        "source",
      ];
      const rows = leads.map((l) =>
        [
          l.email,
          formatET(l.createdAt),
          formatET(l.lastSeenAt),
          l.generateCount,
          l.purchased,
          formatET(l.purchasedAt),
          l.followedUp,
          l.source,
        ]
          .map(csvCell)
          .join(","),
      );
      const csv = [header.join(","), ...rows].join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="leads.csv"');
      res.status(200).send(csv);
      return;
    }

    // ---- HTML webpage branch (default) ----
    const total = leads.length;
    const purchasedCount = leads.filter((l) => l.purchased).length;
    const abandoned = leads.filter((l) => !l.purchased);
    const abandonedEmails = abandoned.map((l) => l.email).join(", ");
    const pwParam = encodeURIComponent(pw);
    const nowET = formatET(new Date().toISOString());

    const rowsHtml = leads
      .map(
        (l) => `<tr class="${l.purchased ? "bought" : "aband"}">
        <td class="email">${esc(l.email)}</td>
        <td>${esc(formatET(l.createdAt))}</td>
        <td>${esc(formatET(l.lastSeenAt))}</td>
        <td class="num">${esc(l.generateCount)}</td>
        <td class="status">${l.purchased ? "✅ Purchased" : "—"}</td>
        <td>${esc(formatET(l.purchasedAt))}</td>
        <td>${esc(l.source)}</td>
      </tr>`,
      )
      .join("");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Leads — GenerAItion Headshots</title>
<style>
  :root{--ink:#2A2A2A;--sub:#6E6E6A;--line:#E8E4DB;--cream:#FAF8F4;--forest:#1B4332;--amber:#FBF3E2;}
  *{box-sizing:border-box;}
  body{margin:0;background:var(--cream);color:var(--ink);
    font-family:system-ui,-apple-system,'Segoe UI',Inter,sans-serif;padding:24px;}
  .wrap{max-width:1100px;margin:0 auto;}
  h1{font-size:22px;margin:0 0 4px;}
  .meta{font-size:13px;color:var(--sub);margin:0 0 18px;}
  .cards{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:20px;}
  .card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:130px;}
  .card .n{font-size:24px;font-weight:700;color:var(--forest);line-height:1;}
  .card .l{font-size:11px;color:var(--sub);text-transform:uppercase;letter-spacing:.06em;margin-top:4px;}
  .bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:14px;}
  .btn{display:inline-block;background:var(--forest);color:#fff;text-decoration:none;
    font-size:13px;font-weight:600;padding:9px 14px;border:none;border-radius:8px;cursor:pointer;}
  .btn.sec{background:#fff;color:var(--ink);border:1px solid var(--line);}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:13px;}
  th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap;}
  th{background:#F3EEE4;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--sub);position:sticky;top:0;}
  td.email{font-weight:600;white-space:normal;}
  td.num,th.num{text-align:right;}
  tr.aband{background:var(--amber);}
  tr.bought td.status{color:var(--forest);font-weight:600;}
  .tablewrap{overflow:auto;border-radius:10px;}
  details{margin-bottom:18px;background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 16px;}
  summary{cursor:pointer;font-weight:600;font-size:14px;}
  textarea{width:100%;height:90px;margin-top:10px;font-size:12px;padding:8px;border:1px solid var(--line);border-radius:8px;font-family:ui-monospace,monospace;}
  .empty{padding:40px;text-align:center;color:var(--sub);}
</style>
</head>
<body>
<div class="wrap">
  <h1>Leads &amp; abandoned sessions</h1>
  <p class="meta">GenerAItion Headshots · as of ${esc(nowET)} ET · reload this page to refresh</p>

  <div class="cards">
    <div class="card"><div class="n">${total}</div><div class="l">Total leads</div></div>
    <div class="card"><div class="n">${abandoned.length}</div><div class="l">Not purchased</div></div>
    <div class="card"><div class="n">${purchasedCount}</div><div class="l">Purchased</div></div>
  </div>

  <div class="bar">
    <button class="btn" onclick="location.reload()">↻ Refresh</button>
    <a class="btn sec" href="/api/admin/leads?format=csv&amp;pw=${pwParam}">⬇ Download CSV</a>
  </div>

  ${
    abandoned.length
      ? `<details>
    <summary>Copy the ${abandoned.length} not-yet-purchased email${abandoned.length === 1 ? "" : "s"} (for follow-up)</summary>
    <textarea id="ab" readonly onclick="this.select()">${esc(abandonedEmails)}</textarea>
    <button class="btn" style="margin-top:8px" onclick="const t=document.getElementById('ab');t.select();document.execCommand('copy');this.textContent='Copied!';setTimeout(()=>this.textContent='Copy emails',1500)">Copy emails</button>
  </details>`
      : ""
  }

  <div class="tablewrap">
    ${
      total
        ? `<table>
      <thead><tr>
        <th>Email</th><th>First seen (ET)</th><th>Last seen (ET)</th>
        <th class="num">Gens</th><th>Status</th><th>Purchased (ET)</th><th>Source</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`
        : `<div class="empty">No leads captured yet.</div>`
    }
  </div>
</div>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(html);
  } catch (err) {
    console.error("[admin/leads] view failed:", err);
    res.status(500).send("Failed to load leads");
  }
}
