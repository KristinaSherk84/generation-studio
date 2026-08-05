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
import {
  listLeads,
  markLeadPurchased,
  setLeadFoundVia,
} from "../lib/leadStore.js";

export const maxDuration = 10;

// Estimated generation cost of one batch (2026-08-04). Gemini 3.1 Flash Image
// at the app's 2048px output is ~$0.10/image. Each batch now renders 8 images:
// the 6 the customer picked PLUS 2 automatic "Wild Card" bonus shots fired
// after the main grid lands → ~$0.80 per batch. generateCount tracks batches,
// so cost ≈ generateCount × this. NOTE: this is an ESTIMATE — it does not
// include per-slot regenerations, the identity auto-regen, or the post-purchase
// retouch pass (Gemini 3 Pro Image), so true spend runs somewhat higher. (The
// wild-card gender-detection call uses Gemini 2.5 Flash and is negligible.)
const GEN_BATCH_COST_USD = 0.8;
const fmtUsd = (n: number) => `$${n.toFixed(2)}`;

// The same six options the customer sees in the "How did you find us?" survey
// (mirrors FOUND_VIA_OPTIONS in src/App.tsx). Kept in sync manually — this is
// a serverless admin endpoint and can't import from the client bundle.
const FOUND_VIA_OPTIONS = [
  "Referral",
  "Google Ad",
  "LinkedIn Ad",
  '"Best Generator" Article',
  "Facebook",
  "Other",
];

// Inline editable dropdown for a lead's foundVia. Lets Kristi retag a lead's
// acquisition source when she learns the real one from Clarity (2026-08-04).
// Preserves any existing custom value as its own selected option, and offers
// a "Custom…" choice that prompts for free text client-side.
function foundViaSelect(email: string, current: string | null | undefined): string {
  const cur = current ?? "";
  const inList = FOUND_VIA_OPTIONS.includes(cur);
  const optionEls = [
    `<option value=""${cur === "" ? " selected" : ""}>— unset —</option>`,
    ...FOUND_VIA_OPTIONS.map(
      (o) => `<option${o === cur ? " selected" : ""}>${esc(o)}</option>`,
    ),
    cur !== "" && !inList ? `<option selected>${esc(cur)}</option>` : "",
    `<option value="__custom__">✏️ Custom…</option>`,
  ].join("");
  return `<select class="fvsel" data-email="${esc(email)}" style="font:inherit;max-width:170px;padding:2px 4px;">${optionEls}</select>`;
}

// Live Stripe revenue — total AND per-customer, keyed by the email the
// customer used at checkout. The app already talks to Stripe via its REST API
// with STRIPE_SECRET_KEY, so we reuse that here — no SDK. We read Checkout
// Sessions (not raw charges) because each carries the customer's email in
// customer_details, which is what we match leads against. Amounts are the paid
// session totals in dollars (gross of any refunds). Returns null if the key is
// missing or the call fails (the page still renders, showing "—"). Sessions are
// paginated with a hard page cap so this stays bounded. Per Kristi 2026-08-03.
async function fetchStripePayments(): Promise<{
  byEmail: Record<string, number>;
  total: number;
} | null> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  try {
    const centsByEmail: Record<string, number> = {};
    let totalCents = 0;
    let startingAfter: string | undefined;
    for (let page = 0; page < 10; page++) {
      const url = new URL("https://api.stripe.com/v1/checkout/sessions");
      url.searchParams.set("limit", "100");
      if (startingAfter) url.searchParams.set("starting_after", startingAfter);
      const resp = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as {
        data?: Array<{
          id: string;
          payment_status?: string;
          amount_total?: number | null;
          customer_details?: { email?: string | null } | null;
          customer_email?: string | null;
        }>;
        has_more?: boolean;
      };
      const sessions = data.data ?? [];
      for (const s of sessions) {
        if (s.payment_status !== "paid") continue;
        const cents = s.amount_total ?? 0;
        if (cents <= 0) continue;
        totalCents += cents;
        const email = (s.customer_details?.email ?? s.customer_email ?? "")
          .trim()
          .toLowerCase();
        if (email) centsByEmail[email] = (centsByEmail[email] ?? 0) + cents;
      }
      if (!data.has_more || sessions.length === 0) break;
      startingAfter = sessions[sessions.length - 1].id;
    }
    const byEmail: Record<string, number> = {};
    for (const [email, cents] of Object.entries(centsByEmail)) {
      byEmail[email] = cents / 100;
    }
    return { byEmail, total: totalCents / 100 };
  } catch {
    return null;
  }
}

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
  // ---- POST: manually mark a lead as purchased (2026-08-02). Auto-marking
  // keys off the email the customer types at checkout; if that differs from
  // the email they generated with, the lead is never flipped and they'd get a
  // win-back email despite having bought. This lets Kristi correct it in one
  // click from the leads page. Same ADMIN_PASSWORD auth. ----
  if (req.method === "POST") {
    const body = (req.body ?? {}) as {
      pw?: unknown;
      email?: unknown;
      action?: unknown;
      foundVia?: unknown;
    };
    const bpw = typeof body.pw === "string" ? body.pw : "";
    const expectedPw = process.env.ADMIN_PASSWORD ?? "";
    if (!expectedPw || !safeEquals(bpw, expectedPw)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
    if (body.action === "markPurchased" && typeof body.email === "string") {
      try {
        await markLeadPurchased(body.email);
        res.status(200).json({ ok: true });
      } catch (err) {
        console.error("[admin/leads] markPurchased failed:", err);
        res.status(500).json({ ok: false, error: "Failed to mark" });
      }
      return;
    }
    if (body.action === "setFoundVia" && typeof body.email === "string") {
      const fv = typeof body.foundVia === "string" ? body.foundVia : "";
      try {
        await setLeadFoundVia(body.email, fv);
        res.status(200).json({ ok: true });
      } catch (err) {
        console.error("[admin/leads] setFoundVia failed:", err);
        res.status(500).json({ ok: false, error: "Failed to save" });
      }
      return;
    }
    res.status(400).json({ ok: false, error: "Bad request" });
    return;
  }

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

    // Live Stripe payments keyed by checkout email — powers the per-lead
    // "Paid" column, the CSV amountPaidUsd, and the Total revenue card.
    const stripePayments = await fetchStripePayments();
    const paidByEmail = stripePayments ? stripePayments.byEmail : {};
    const revenueUsd = stripePayments ? stripePayments.total : null;
    const paidFor = (email: string) =>
      paidByEmail[email.trim().toLowerCase()] ?? 0;

    // ---- CSV download branch ----
    if (format === "csv") {
      const header = [
        "email",
        "createdAt (ET)",
        "lastSeenAt (ET)",
        "generateCount",
        "estGenCostUsd",
        "amountPaidUsd",
        "purchased",
        "purchasedAt (ET)",
        "followedUp",
        "foundVia",
      ];
      const rows = leads.map((l) =>
        [
          l.email,
          formatET(l.createdAt),
          formatET(l.lastSeenAt),
          l.generateCount,
          ((l.generateCount ?? 0) * GEN_BATCH_COST_USD).toFixed(2),
          paidFor(l.email).toFixed(2),
          l.purchased,
          formatET(l.purchasedAt),
          l.followedUp,
          l.foundVia ?? "",
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
    // Conversion rate = purchasers / everyone who generated (2026-08-03).
    const conversionPct =
      total > 0 ? Math.round((purchasedCount / total) * 1000) / 10 : 0;
    // Estimated generation spend (see GEN_BATCH_COST_USD note).
    const estCost = (l: (typeof leads)[number]) =>
      (l.generateCount ?? 0) * GEN_BATCH_COST_USD;
    const totalEstCost = leads.reduce((s, l) => s + estCost(l), 0);
    const costPerPurchase =
      purchasedCount > 0 ? totalEstCost / purchasedCount : 0;
    const abandonedEmails = abandoned.map((l) => l.email).join(", ");
    const pwParam = encodeURIComponent(pw);
    const nowET = formatET(new Date().toISOString());

    // "How did you find us?" breakdown (2026-08-02) — counts per answer.
    const foundViaCounts: Record<string, number> = {};
    for (const l of leads) {
      if (l.foundVia) {
        foundViaCounts[l.foundVia] = (foundViaCounts[l.foundVia] ?? 0) + 1;
      }
    }
    const foundViaEntries = Object.entries(foundViaCounts).sort(
      (a, b) => b[1] - a[1],
    );
    const foundViaAnswered = foundViaEntries.reduce((s, [, n]) => s + n, 0);
    const foundViaHtml = foundViaEntries.length
      ? `<div class="fv">
        <div class="fvh">How they found us <span style="font-weight:400;color:var(--sub)">(${foundViaAnswered} answered)</span></div>
        <div class="fvpills">${foundViaEntries
          .map(
            ([k, n]) =>
              `<span class="fvpill">${esc(k)} <b>${n}</b></span>`,
          )
          .join("")}</div>
      </div>`
      : "";

    const rowsHtml = leads
      .map(
        (l) => `<tr class="${l.purchased ? "bought" : "aband"}">
        <td class="email">${esc(l.email)}</td>
        <td>${esc(formatET(l.createdAt))}</td>
        <td>${esc(formatET(l.lastSeenAt))}</td>
        <td class="num">${esc(l.generateCount)}</td>
        <td class="num">${esc(fmtUsd(estCost(l)))}</td>
        <td class="num">${
          paidFor(l.email) > 0 ? esc(fmtUsd(paidFor(l.email))) : "—"
        }</td>
        <td class="status">${
          l.purchased
            ? "✅ Purchased"
            : `<button class="mkbtn" data-email="${esc(l.email)}">Mark purchased</button>`
        }</td>
        <td>${esc(formatET(l.purchasedAt))}</td>
        <td>${foundViaSelect(l.email, l.foundVia)}</td>
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
  .mkbtn{background:#fff;color:var(--forest);border:1px solid var(--forest);border-radius:6px;
    font-size:11px;font-weight:600;padding:4px 9px;cursor:pointer;white-space:nowrap;}
  .mkbtn:disabled{opacity:.6;cursor:default;}
  .fv{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin-bottom:20px;}
  .fvh{font-size:13px;font-weight:700;color:var(--ink);margin-bottom:8px;}
  .fvpills{display:flex;flex-wrap:wrap;gap:8px;}
  .fvpill{background:var(--amber);border:1px solid var(--line);border-radius:20px;padding:5px 12px;font-size:12.5px;color:var(--ink);}
  .fvpill b{color:var(--forest);margin-left:2px;}
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
    <div class="card"><div class="n">${conversionPct}%</div><div class="l">Conversion</div></div>
    <div class="card"><div class="n">${
      revenueUsd != null ? fmtUsd(revenueUsd) : "—"
    }</div><div class="l">Total revenue</div></div>
    <div class="card"><div class="n">${fmtUsd(totalEstCost)}</div><div class="l">Est. gen spend</div></div>
    <div class="card"><div class="n">${
      costPerPurchase > 0 ? fmtUsd(costPerPurchase) : "—"
    }</div><div class="l">Est. cost / purchase</div></div>
  </div>
  <p class="meta" style="margin:-10px 0 18px">Est. spend = batches × ~$0.60 (6 images at 2K). Rough — excludes per-slot regens, identity auto-regen, and the post-purchase retouch pass, so real spend runs higher.</p>

  ${foundViaHtml}

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
        <th class="num">Gens</th><th class="num">Est. $</th><th class="num">Paid</th><th>Status</th><th>Purchased (ET)</th><th>Found via</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`
        : `<div class="empty">No leads captured yet.</div>`
    }
  </div>
</div>
<script>
  var PW = ${JSON.stringify(pw)};
  document.querySelectorAll('.mkbtn').forEach(function (b) {
    b.addEventListener('click', function () {
      if (!confirm('Mark ' + b.dataset.email + ' as purchased? They will stop receiving win-back emails.')) return;
      b.disabled = true; b.textContent = 'Saving…';
      fetch('/api/admin/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'markPurchased', pw: PW, email: b.dataset.email }),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.ok) { location.reload(); }
          else { b.disabled = false; b.textContent = 'Mark purchased'; alert('Failed: ' + ((d && d.error) || 'unknown')); }
        })
        .catch(function () { b.disabled = false; b.textContent = 'Mark purchased'; alert('Network error'); });
    });
  });
  document.querySelectorAll('.fvsel').forEach(function (sel) {
    var prev = sel.value;
    sel.addEventListener('change', function () {
      var val = sel.value;
      if (val === '__custom__') {
        val = prompt('Enter the source for ' + sel.dataset.email + ' (from Clarity, etc.):', '');
        if (val === null) { sel.value = prev; return; }
      }
      sel.disabled = true;
      fetch('/api/admin/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'setFoundVia', pw: PW, email: sel.dataset.email, foundVia: val }),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.ok) { location.reload(); }
          else { sel.disabled = false; sel.value = prev; alert('Failed: ' + ((d && d.error) || 'unknown')); }
        })
        .catch(function () { sel.disabled = false; sel.value = prev; alert('Network error'); });
    });
  });
</script>
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
