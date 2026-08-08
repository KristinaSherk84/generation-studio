/**
 * GET /api/admin/backfill-tokens?pw=ADMIN_PASSWORD[&dryRun=1]
 *
 * One-time repair (2026-08-08). `save-session` used to attach the resume token
 * to the lead with a fire-and-forget write, which Vercel often killed when the
 * function suspended right after responding. Result: many leads have a LIVE
 * saved grid (session:{token} exists, the "ready to view" resume link works)
 * but no `lead.resumeToken` — and the 12h win-back REQUIRES that field, so it
 * silently skips them (they got the ready email but never the expiry email).
 *
 * This scans every saved session, reads its email + token, and writes the
 * token back onto the matching lead when the lead isn't purchased and has no
 * token yet. Afterwards the normal hourly win-back cron picks them up and
 * sends the real "your headshots are about to expire" email (with a working
 * resume link), BCC'ing Kristi.
 *
 * ?dryRun=1 lists who WOULD be repaired without writing anything.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import { listLeads, setLeadResumeToken } from "../lib/leadStore.js";

export const maxDuration = 60;

const redis = new Redis({
  url: process.env.KV_REST_API_URL ?? "",
  token: process.env.KV_REST_API_TOKEN ?? "",
});

type SessionRec = { email?: string; createdAt?: string };

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  const pw = typeof req.query.pw === "string" ? req.query.pw : "";
  if (!process.env.ADMIN_PASSWORD || pw !== process.env.ADMIN_PASSWORD) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";

  let leads;
  try {
    leads = await listLeads();
  } catch (err) {
    res.status(500).json({ ok: false, error: "listLeads failed: " + String(err) });
    return;
  }
  const byEmail = new Map(leads.map((l) => [l.email.trim().toLowerCase(), l]));

  const plan: { email: string; token: string }[] = [];
  const seen = new Set<string>();
  const skipped = { purchased: 0, hasToken: 0, noLead: 0, noEmail: 0 };
  let scanned = 0;
  let cursor = 0;

  try {
    do {
      const result = (await redis.scan(cursor, {
        match: "session:*",
        count: 200,
      })) as [string | number, string[]];
      const next = result[0];
      const keys = result[1] ?? [];
      cursor = typeof next === "string" ? parseInt(next, 10) : (next as number);
      for (const k of keys) {
        scanned++;
        const token = k.slice("session:".length);
        let rec: SessionRec | null = null;
        try {
          rec = await redis.get<SessionRec>(k);
        } catch {
          continue;
        }
        const email = rec?.email?.trim().toLowerCase();
        if (!email) {
          skipped.noEmail++;
          continue;
        }
        const lead = byEmail.get(email);
        if (!lead) {
          skipped.noLead++;
          continue;
        }
        if (lead.purchased) {
          skipped.purchased++;
          continue;
        }
        if (lead.resumeToken) {
          skipped.hasToken++;
          continue;
        }
        if (seen.has(email)) continue;
        seen.add(email);
        plan.push({ email: lead.email, token });
      }
    } while (cursor !== 0);
  } catch (err) {
    res.status(500).json({ ok: false, error: "scan failed: " + String(err) });
    return;
  }

  let repaired = 0;
  if (!dryRun) {
    for (const p of plan) {
      try {
        await setLeadResumeToken(p.email, p.token);
        repaired++;
      } catch {
        /* best effort */
      }
    }
  }

  res.status(200).json({
    ok: true,
    dryRun,
    sessionsScanned: scanned,
    wouldRepair: plan.length,
    repaired: dryRun ? 0 : repaired,
    emails: plan.map((p) => p.email),
    skipped,
  });
}
