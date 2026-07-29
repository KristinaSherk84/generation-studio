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
      "createdAt",
      "lastSeenAt",
      "generateCount",
      "purchased",
      "purchasedAt",
      "followedUp",
      "source",
    ];
    const rows = leads.map((l) =>
      [
        l.email,
        l.createdAt,
        l.lastSeenAt,
        l.generateCount,
        l.purchased,
        l.purchasedAt,
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
