/**
 * GET /api/quota-report
 *
 * Daily quota digest emailed to Kristi. Triggered by Vercel Cron once per
 * morning (see vercel.json). Can also be hit manually via
 *   https://<deployment>/api/quota-report?key=<CRON_SECRET>
 * for on-demand checks without waiting for tomorrow's cron run.
 *
 * What it reports:
 *   1. Vercel Blob storage — total bytes + blob count, with a red banner if
 *      usage crosses 70% of the plan cap (Hobby 1 GB, Pro 100 GB).
 *   2. Resend email sends today — proxied via the count of delivery manifests
 *      written in the last 24h (1 delivery = 1 $$$-AI-Generator-Used email),
 *      with a red banner if the count crosses 50 (half the 100/day free cap).
 *
 * What it DOESN'T report (by design):
 *   - Gemini spend. Kristi has a $250/mo hard cap in Google Cloud and prefers
 *     to check that herself via a screenshot of aistudio.google.com/billing.
 *     Pulling it would require a Google Cloud service account (~20 min setup)
 *     and the cap already protects against runaway spend.
 *
 * Auth:
 *   - Vercel Cron invocations arrive with header `authorization: Bearer
 *     ${CRON_SECRET}` — we verify that header matches our env var.
 *   - Manual invocations must include `?key=${CRON_SECRET}` in the query
 *     string.
 *   - If CRON_SECRET is unset, the endpoint refuses all requests (safer
 *     default than allowing anonymous traffic to trigger emails).
 */

import { list } from "@vercel/blob";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// Listing ~2000 blobs + one Resend email send is well under this.
export const maxDuration = 30;

// ---- Thresholds (updated 2026-04-24 after Kristi upgraded to Vercel Pro) ----
// Pro plan includes 100 GB Blob storage. Warn at 70% = 70 GB used.
const BLOB_CAP_GB = 100;
const BLOB_WARN_PCT = 0.7; // red banner once usage crosses 70%
const RESEND_DAILY_CAP = 100; // free-tier limit
const RESEND_WARN_COUNT = 50; // red banner once sends cross 50/day

// ---- Helpers ----

function fmtBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Walks the entire Blob store with pagination and tallies (a) total bytes +
// count, and (b) delivery manifests written in the last 24h. Deliberately one
// pass so we don't call list() twice.
async function collectBlobStats(): Promise<{
  totalBytes: number;
  totalCount: number;
  deliveriesLast24h: number;
}> {
  let totalBytes = 0;
  let totalCount = 0;
  let deliveriesLast24h = 0;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;

  let cursor: string | undefined;
  do {
    const page: {
      blobs: Array<{ pathname: string; size: number; uploadedAt: Date }>;
      cursor?: string;
    } = await list({ cursor, limit: 1000 });
    for (const blob of page.blobs) {
      totalBytes += blob.size;
      totalCount += 1;
      if (
        blob.pathname.startsWith("deliveries/") &&
        blob.pathname.endsWith("/manifest.json") &&
        blob.uploadedAt.getTime() >= cutoff
      ) {
        deliveriesLast24h += 1;
      }
    }
    cursor = page.cursor;
  } while (cursor);

  return { totalBytes, totalCount, deliveriesLast24h };
}

// Builds the HTML email body. Red banners only render when the corresponding
// threshold is exceeded — quiet mornings stay quiet.
function buildEmailHtml(args: {
  totalBytes: number;
  totalCount: number;
  deliveriesLast24h: number;
}): string {
  const { totalBytes, totalCount, deliveriesLast24h } = args;
  const gb = totalBytes / 1024 ** 3;
  const blobPct = gb / BLOB_CAP_GB;
  const blobWarn = blobPct >= BLOB_WARN_PCT;
  const resendWarn = deliveriesLast24h >= RESEND_WARN_COUNT;

  const banner = (text: string) => `
    <div style="background:#ffe8e5;border-left:4px solid #c00;padding:12px 16px;margin:0 0 16px 0;color:#900;font-weight:500;">
      ${escapeHtml(text)}
    </div>
  `;

  const row = (label: string, value: string, note: string) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#666;">${escapeHtml(label)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:500;color:#2c2c2a;">${escapeHtml(value)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#999;font-size:12px;">${escapeHtml(note)}</td>
    </tr>
  `;

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#2c2c2a;max-width:640px;">
      <h2 style="margin:0 0 16px 0;font-weight:500;">Generation Studio — daily quota report</h2>

      ${blobWarn ? banner(`Vercel Blob usage is at ${(blobPct * 100).toFixed(0)}% of your ${BLOB_CAP_GB} GB cap. Delete old blobs or upgrade to Pro soon to avoid upload failures.`) : ""}
      ${resendWarn ? banner(`Resend sends today: ${deliveriesLast24h} / ${RESEND_DAILY_CAP}. Approaching the free-tier daily cap — consider upgrading Resend or throttling alerts.`) : ""}

      <table style="border-collapse:collapse;width:100%;margin:0 0 20px 0;">
        <tbody>
          ${row("Vercel Blob storage", `${fmtBytes(totalBytes)} (${(blobPct * 100).toFixed(1)}% of ${BLOB_CAP_GB} GB)`, `${totalCount} blobs total`)}
          ${row("Deliveries last 24h", String(deliveriesLast24h), `Proxy for Resend sends (${deliveriesLast24h}/${RESEND_DAILY_CAP} daily cap)`)}
        </tbody>
      </table>

      <p style="margin:20px 0 8px 0;font-size:13px;color:#666;">
        <strong>Gemini spend:</strong> not shown here. Check manually at
        <a href="https://aistudio.google.com/billing" style="color:#2c2c2a;">aistudio.google.com/billing</a>
        — you have a $250/mo hard cap set, so runaway spend is already blocked.
      </p>

      <p style="margin:16px 0 0 0;font-size:12px;color:#999;">
        Sent by /api/quota-report · ${new Date().toISOString()}
      </p>
    </div>
  `;
}

// ---- Handler ----

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse | void> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res
      .status(500)
      .json({ error: "CRON_SECRET env var not configured" });
  }

  // Vercel Cron passes the secret in Authorization: Bearer <secret>.
  // Manual triggers use ?key=<secret> in the query string.
  const headerAuth = req.headers.authorization;
  const queryKey =
    typeof req.query.key === "string" ? req.query.key : undefined;
  const authorized =
    headerAuth === `Bearer ${cronSecret}` || queryKey === cronSecret;
  if (!authorized) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return res
      .status(500)
      .json({ error: "RESEND_API_KEY env var not configured" });
  }

  try {
    const stats = await collectBlobStats();
    const html = buildEmailHtml(stats);

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Generation Studio Alerts <onboarding@resend.dev>",
        to: ["kristi@kristinasherk.com"],
        subject: "Daily quota report — Generation Studio",
        html,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error(
        JSON.stringify({
          type: "quota_report_email_failed",
          status: resp.status,
          body: text.slice(0, 500),
        }),
      );
      return res
        .status(502)
        .json({ error: "Email send failed", detail: text.slice(0, 200) });
    }

    return res.status(200).json({
      ok: true,
      totalBytes: stats.totalBytes,
      totalCount: stats.totalCount,
      deliveriesLast24h: stats.deliveriesLast24h,
    });
  } catch (error) {
    console.error("=== /api/quota-report FAILED ===");
    console.error(
      "Error message:",
      error instanceof Error ? error.message : String(error),
    );
    const message =
      error instanceof Error ? error.message : "Quota report failed";
    return res.status(500).json({ error: message });
  }
}
