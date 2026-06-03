/**
 * POST /api/admin/promos
 *
 * Single admin endpoint for the /admin dashboard. Action-routed via the
 * `action` field on the JSON body. All actions require an `adminPassword`
 * field that matches the ADMIN_PASSWORD env var. No JWT, no session — the
 * dashboard re-sends the password on every request (it's kept in
 * sessionStorage on the client). One env var, one password, two humans
 * (Kristi + husband) share it.
 *
 * Actions:
 *   { action: "list" }                              → { codes: PromoRecord[] }
 *   { action: "create", notes?: string }            → { code: PromoRecord }
 *   { action: "revoke", code: string }              → { code: PromoRecord | null }
 *
 * If you forget the password, rotate ADMIN_PASSWORD in Vercel and update
 * the dashboard login.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  createCode,
  generateCode,
  listCodes,
  revokeCode,
  type PromoRecord,
} from "../lib/promoStore.js";

export const maxDuration = 10;

// Constant-time string compare. Same pattern as verify-promo.ts.
function safeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

type ListReq = { action: "list"; adminPassword: string };
type CreateReq = { action: "create"; adminPassword: string; notes?: string };
type RevokeReq = { action: "revoke"; adminPassword: string; code: string };
type AdminReq = ListReq | CreateReq | RevokeReq;

function isAdminReq(body: unknown): body is AdminReq {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.adminPassword !== "string") return false;
  return b.action === "list" || b.action === "create" || b.action === "revoke";
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse | void> {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body as unknown;
  if (!isAdminReq(body)) {
    return res.status(400).json({ error: "Bad request" });
  }

  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    console.warn(
      JSON.stringify({
        type: "admin_password_env_missing",
        msg: "ADMIN_PASSWORD env var not set — admin endpoints inaccessible",
      }),
    );
    return res.status(503).json({ error: "Admin not configured" });
  }

  if (!safeEquals(body.adminPassword, expected)) {
    // Generic 401 — don't reveal whether the action was understood.
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    if (body.action === "list") {
      const codes = await listCodes();
      return res.status(200).json({ codes });
    }

    if (body.action === "create") {
      // Auto-generate until we find one not already in the index. With a
      // 30^6 alphabet a collision is effectively impossible; this loop is
      // belt-and-suspenders for the case where the index somehow gets
      // very dense.
      let attempt: PromoRecord | null = null;
      for (let i = 0; i < 5 && !attempt; i++) {
        try {
          attempt = await createCode({
            code: generateCode(),
            createdBy: "admin", // could split when we have separate logins
            notes: typeof body.notes === "string" ? body.notes : "",
          });
        } catch (e) {
          // Code already exists — retry with a different one
          if (i === 4) throw e;
        }
      }
      return res.status(200).json({ code: attempt });
    }

    if (body.action === "revoke") {
      const result = await revokeCode(body.code);
      return res.status(200).json({ code: result });
    }
  } catch (err) {
    console.error("admin/promos error:", err);
    return res.status(500).json({ error: "Server error" });
  }

  return res.status(400).json({ error: "Unknown action" });
}
