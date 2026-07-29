/**
 * GET /api/admin/leads?pw=YOUR_ADMIN_PASSWORD
 *
 * Password-protected CSV export of the captured lead list. Visit the URL in
 * a browser (with ?pw=...) and it downloads leads.csv. Uses the same
 * ADMIN_PASSWORD env var as the promo admin dashboard.
 *
 * Kept separate from the POST /api/admin/promos action-router so Kristi can
 * bookmark a single clickable link that produces a spreadsheet-ready file.
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

/** Format an ISO-8601 timestamp in US Eastern time (handles EST/EDT and DST
 *  automatically). Empty string for null/blank so the CSV cell stays empty. */
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
  const expected = process.env.ADMIN_PASSWORD ?? "";

  if (!expected || !safeEquals(pw, expected)) {
    res.status(401).send("Unauthorized");
    return;
  }

  try {
    const leads = await listLeads();
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
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="leads.csv"',
    );
    res.status(200).send(csv);
  } catch (err) {
    console.error("[admin/leads] export failed:", err);
    res.status(500).send("Export failed");
  }
}
