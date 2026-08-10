/**
 * POST /api/admin/verify-fix   body: { pw }   (2026-08-10)
 *
 * Tiny yes/no check used ONLY by the client to decide whether to turn on
 * admin "damage-control fix mode" on a resume link. When Kristi opens a
 * customer's "ready to view" link with &fix=<ADMIN_PASSWORD> appended, the
 * grid calls this; a 200 { ok:true } unlocks 2 identity regens that persist to
 * the saved grid and don't touch the customer's regen budget.
 *
 * Returns { ok:false } (401) on any mismatch. Same ADMIN_PASSWORD as the other
 * admin tools. It grants no data and performs no action — it only confirms the
 * password — so exposing it here is safe.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

export const maxDuration = 5;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  const pw =
    (req.body && typeof req.body.pw === "string" && req.body.pw) ||
    (typeof req.query.pw === "string" ? req.query.pw : "") ||
    "";
  const ok =
    !!process.env.ADMIN_PASSWORD && pw === process.env.ADMIN_PASSWORD;
  res.status(ok ? 200 : 401).json({ ok });
}
