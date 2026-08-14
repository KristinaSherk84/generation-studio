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
  recordPurchase,
  setLeadFoundVia,
  getLeadCallCounts,
} from "../lib/leadStore.js";
import {
  getDailyStats,
  setDailySpend,
  setDailyPeople,
  lastEtDates,
} from "../lib/dailyStats.js";

export const maxDuration = 10;

// Estimated cost of ONE image call. Gemini 3.1 Flash Image at the app's 2048px
// output is ~$0.10/image. The "Calls" column counts every billable image call
// per person (initial 6, auto identity redos, wild-card bonus shots, per-slot
// regens), so cost ≈ calls × this. Matches the ~$0.10/call Kristi used for the
// Everett estimate. (2026-08-14 — replaced the old per-batch estimate.)
const PER_CALL_COST_USD = 0.1;
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
  return `<select class="fvsel" data-email="${esc(email)}" style="font:inherit;width:132px;max-width:132px;padding:2px 4px;">${optionEls}</select>`;
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
      date?: unknown;
      spendUsd?: unknown;
      people?: unknown;
      calls?: unknown;
      costUsd?: unknown;
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
    if (body.action === "addPurchase" && typeof body.email === "string") {
      const em = body.email.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) {
        res.status(400).json({ ok: false, error: "Invalid email" });
        return;
      }
      const opts: { calls?: number; estCostUsd?: number } = {};
      const cl = Number(body.calls);
      if (Number.isFinite(cl) && cl >= 0) opts.calls = cl;
      const c = Number(body.costUsd);
      if (Number.isFinite(c) && c >= 0) opts.estCostUsd = c;
      try {
        await recordPurchase(em, opts);
        res.status(200).json({ ok: true });
      } catch (err) {
        console.error("[admin/leads] addPurchase failed:", err);
        res.status(500).json({ ok: false, error: "Failed to add" });
      }
      return;
    }
    if (body.action === "setSpend" && typeof body.date === "string") {
      const usd = Number(body.spendUsd);
      if (!Number.isFinite(usd) || usd < 0) {
        res.status(400).json({ ok: false, error: "Invalid amount" });
        return;
      }
      try {
        await setDailySpend(body.date, usd);
        res.status(200).json({ ok: true });
      } catch (err) {
        console.error("[admin/leads] setSpend failed:", err);
        res.status(500).json({ ok: false, error: "Failed to save spend" });
      }
      return;
    }
    if (body.action === "setPeople" && typeof body.date === "string") {
      // Empty string clears the override (revert to the auto email/IP count).
      const raw =
        body.people === "" || body.people == null ? null : Number(body.people);
      if (raw != null && (!Number.isFinite(raw) || raw < 0)) {
        res.status(400).json({ ok: false, error: "Invalid count" });
        return;
      }
      try {
        await setDailyPeople(body.date, raw == null ? null : Math.round(raw));
        res.status(200).json({ ok: true });
      } catch (err) {
        console.error("[admin/leads] setPeople failed:", err);
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

    // Daily activity (2026-08-14): API calls (Gemini image calls) + distinct
    // people who generated, per ET day, plus the Google spend Kristi types in.
    const dailyStats = await getDailyStats(lastEtDates(14));
    const paidFor = (email: string) =>
      paidByEmail[email.trim().toLowerCase()] ?? 0;
    // What to show in the Paid column: the Stripe amount matched by checkout
    // email, OR the $2.99 generation unlock we recorded against the email they
    // generated under (covers the "paid under a different email" case). Whichever
    // is larger — never summed, so a same-email unlock isn't double-counted.
    const paidShown = (l: { email: string; entryUnlockUsd?: number | null }) =>
      Math.max(paidFor(l.email), l.entryUnlockUsd ?? 0);
    // Real per-person image-call totals (2026-08-14): every billable call the
    // client attributed to this email. A hand-typed override wins; otherwise
    // the live counter. Old leads read 0 until they generate again (calls that
    // predate this counter can't be backfilled).
    const callCounts = await getLeadCallCounts(leads.map((l) => l.email));
    const shownCalls = (l: {
      email: string;
      callCountOverride?: number | null;
    }) =>
      l.callCountOverride != null
        ? l.callCountOverride
        : callCounts[l.email.trim().toLowerCase()] ?? 0;
    // Estimated AI cost per lead: a manual override when we set one, else the
    // real image-call count × the per-call rate.
    const estCost = (l: {
      email: string;
      callCountOverride?: number | null;
      estCostOverrideUsd?: number | null;
    }) =>
      l.estCostOverrideUsd != null
        ? l.estCostOverrideUsd
        : shownCalls(l) * PER_CALL_COST_USD;

    // ---- CSV download branch ----
    if (format === "csv") {
      const header = [
        "email",
        "createdAt (ET)",
        "lastSeenAt (ET)",
        "imageCalls",
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
          shownCalls(l),
          estCost(l).toFixed(2),
          paidShown(l).toFixed(2),
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
    // Estimated generation spend (see PER_CALL_COST_USD note).
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
        <td class="num">${esc(shownCalls(l))}</td>
        <td class="num">${esc(fmtUsd(estCost(l)))}</td>
        <td class="num">${
          paidShown(l) > 0 ? esc(fmtUsd(paidShown(l))) : "—"
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

    const dailyRowsHtml = dailyStats
      .map((d) => {
        const cpc =
          d.spendUsd != null && d.apiCalls > 0
            ? d.spendUsd / d.apiCalls
            : null;
        return `<tr>
        <td>${esc(d.date)}</td>
        <td class="num">${d.apiCalls.toLocaleString()}</td>
        <td class="num"><input class="peopleinput" data-date="${esc(
          d.date,
        )}" type="number" step="1" min="0" value="${
          d.peopleOverride != null ? d.peopleOverride : ""
        }" placeholder="${d.people.toLocaleString()}" title="${
          d.peopleOverride != null
            ? "Manual override - clear the box to go back to the automatic count"
            : "Automatic count (distinct ready-to-view emails). Type a number to override."
        }" style="width:64px;padding:4px 6px;border:1px solid ${
          d.peopleOverride != null ? "#C9A227" : "#E2E0DA"
        };border-radius:6px;font:inherit;text-align:right" /></td>
        <td class="num">$<input class="spendinput" data-date="${esc(
          d.date,
        )}" type="number" step="0.01" min="0" value="${
          d.spendUsd != null ? d.spendUsd : ""
        }" placeholder="—" style="width:78px;padding:4px 6px;border:1px solid #E2E0DA;border-radius:6px;font:inherit;text-align:right" /></td>
        <td class="num">${cpc != null ? "$" + cpc.toFixed(4) : "—"}</td>
      </tr>`;
      })
      .join("");
    const dailyTableHtml = `
  <h2 style="font-size:16px;font-weight:600;margin:24px 0 4px;color:#2C2C2A">Daily activity <span style="font-weight:400;color:#888780;font-size:13px">(ET · last 14 days)</span></h2>
  <p class="meta" style="margin:0 0 10px">API calls = Gemini image calls that hit the model (each ≈ one unit of Google spend). People generated = distinct email addresses that got a “ready to view” email that day (older days fall back to distinct IPs). The box is editable — type a number to override it, or clear the box to go back to the automatic count. Type the day's real spend from <a href="https://aistudio.google.com/spend?project=gen-lang-client-0496086422" target="_blank" rel="noopener">your Google AI Studio spend page ↗</a> and cost-per-call fills in.</p>
  <div class="tablewrap">
    <table>
      <thead><tr>
        <th>Date (ET)</th><th class="num">API calls</th><th class="num">People generated</th><th class="num">Google spend</th><th class="num">$ / call</th>
      </tr></thead>
      <tbody>${dailyRowsHtml}</tbody>
    </table>
  </div>
`;
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
  .wrap{max-width:1360px;margin:0 auto;}
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
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap;}
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

  ${dailyTableHtml}

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

  <div style="margin:18px 0;padding:14px 16px;border:1px solid #E2E0DA;border-radius:10px;background:#fff">
    <div style="font-weight:600;font-size:14px;margin-bottom:4px;color:#2C2C2A">Add a purchaser Stripe caught but the form missed</div>
    <div style="font-size:13px;color:#888780;margin-bottom:8px">Type the buyer's email (from Stripe). Creates a row marked ✅ Purchased; the paid amount fills in from Stripe automatically. Image calls &amp; est. cost are optional — set them when you know the real numbers from the logs.</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <input id="addemail" type="email" placeholder="email@example.com" style="flex:1;min-width:200px;padding:8px 10px;border:1px solid #E2E0DA;border-radius:8px;font:inherit" />
      <input id="addgens" type="number" min="0" step="1" placeholder="Image calls" title="Total image calls (optional)" style="width:104px;padding:8px 10px;border:1px solid #E2E0DA;border-radius:8px;font:inherit" />
      <input id="addcost" type="number" min="0" step="0.01" placeholder="Est. cost $" title="Estimated AI cost in dollars (optional)" style="width:118px;padding:8px 10px;border:1px solid #E2E0DA;border-radius:8px;font:inherit" />
      <button class="btn" id="addbtn">Add as purchased</button>
    </div>
  </div>

  <div class="tablewrap">
    ${
      total
        ? `<table>
      <thead><tr>
        <th>Email</th><th>First seen (ET)</th><th>Last seen (ET)</th>
        <th class="num" title="Total AI image calls made for this person - the real cost driver. Includes the 6 they see plus automatic likeness redos, bonus shots, and any regenerations (~10-13 per round). Counting started 2026-08-14.">Calls</th><th class="num">Est. $</th><th class="num">Paid</th><th>Status</th><th>Purchased (ET)</th><th>Found via</th>
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
  var addBtn = document.getElementById('addbtn');
  if (addBtn) {
    addBtn.addEventListener('click', function () {
      var em = (document.getElementById('addemail').value || '').trim();
      if (!em) { alert('Enter an email'); return; }
      var gensV = (document.getElementById('addgens').value || '').trim();
      var costV = (document.getElementById('addcost').value || '').trim();
      var payload = { action: 'addPurchase', pw: PW, email: em };
      if (gensV !== '') payload.calls = parseInt(gensV, 10);
      if (costV !== '') payload.costUsd = parseFloat(costV);
      addBtn.disabled = true; addBtn.textContent = 'Adding…';
      fetch('/api/admin/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.ok) { location.reload(); }
          else { addBtn.disabled = false; addBtn.textContent = 'Add as purchased'; alert('Failed: ' + ((d && d.error) || 'unknown')); }
        })
        .catch(function () { addBtn.disabled = false; addBtn.textContent = 'Add as purchased'; alert('Network error'); });
    });
  }
  document.querySelectorAll('.peopleinput').forEach(function (inp) {
    var prev = inp.value;
    inp.addEventListener('change', function () {
      var v = (inp.value || '').trim();
      // Empty = clear the override and revert to the automatic count.
      if (v !== '') {
        var n = parseInt(v, 10);
        if (isNaN(n) || n < 0) { alert('Enter a whole number'); inp.value = prev; return; }
      }
      inp.disabled = true;
      fetch('/api/admin/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'setPeople', pw: PW, date: inp.dataset.date, people: v }),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.ok) { location.reload(); }
          else { inp.disabled = false; inp.value = prev; alert('Failed: ' + ((d && d.error) || 'unknown')); }
        })
        .catch(function () { inp.disabled = false; inp.value = prev; alert('Network error'); });
    });
  });
  document.querySelectorAll('.spendinput').forEach(function (inp) {
    var prev = inp.value;
    inp.addEventListener('change', function () {
      var v = (inp.value || '').trim();
      if (v === '') { inp.value = prev; return; }
      var usd = parseFloat(v);
      if (isNaN(usd) || usd < 0) { alert('Enter a dollar amount'); inp.value = prev; return; }
      inp.disabled = true;
      fetch('/api/admin/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'setSpend', pw: PW, date: inp.dataset.date, spendUsd: usd }),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.ok) { location.reload(); }
          else { inp.disabled = false; inp.value = prev; alert('Failed: ' + ((d && d.error) || 'unknown')); }
        })
        .catch(function () { inp.disabled = false; inp.value = prev; alert('Network error'); });
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
