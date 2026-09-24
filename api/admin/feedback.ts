/**
 * /feedback  →  /api/admin/feedback?pw=ADMIN_PASSWORD   (2026-09-24)
 *
 * Kristi's survey dashboard (same password as the leads page):
 *   - Running tally of A–G answers (auto-logged replies + hand-tallied votes)
 *   - Every reply, with what they wrote; change the letter if the robot
 *     guessed wrong or couldn't tell
 *   - Unsubscribe list: add emails, undo
 *
 * POST actions (JSON body, pw required): setLetter {id, letter},
 * adjust {letter, delta}, unsubscribe {emails}, resubscribe {email}.
 * GET ?set=A:6,B:3,… overwrites the hand-tallied counts (one-time seeding).
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  listReplies,
  setReplyLetter,
  getManualCounts,
  adjustManual,
  setManualCounts,
  LETTERS,
} from "../lib/feedbackStore.js";
import {
  listUnsubscribedEmails,
  unsubscribeEmail,
  resubscribeEmail,
  looksLikeEmail,
} from "../lib/leadStore.js";
import { SURVEY_OPTIONS, SURVEY_SENT_KEY, redis, surveyReplyTo } from "../lib/surveyEmail.js";

export const maxDuration = 20;

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtET(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const expected = process.env.ADMIN_PASSWORD ?? "";

  if (req.method === "POST") {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!expected || b.pw !== expected) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    try {
      if (b.action === "setLetter" && typeof b.id === "string") {
        const L = typeof b.letter === "string" && b.letter ? b.letter : null;
        res.status(200).json({ ok: await setReplyLetter(b.id, L) });
        return;
      }
      if (b.action === "adjust" && typeof b.letter === "string") {
        await adjustManual(b.letter, Number(b.delta) === -1 ? -1 : 1);
        res.status(200).json({ ok: true });
        return;
      }
      if (b.action === "unsubscribe" && typeof b.emails === "string") {
        const list = b.emails
          .split(/[\s,;]+/)
          .map((s) => s.trim().toLowerCase())
          .filter((s) => looksLikeEmail(s));
        for (const e of list) await unsubscribeEmail(e);
        res.status(200).json({ ok: true, count: list.length });
        return;
      }
      if (b.action === "resubscribe" && typeof b.email === "string") {
        await resubscribeEmail(b.email);
        res.status(200).json({ ok: true });
        return;
      }
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
      return;
    }
    res.status(400).json({ ok: false, error: "unknown action" });
    return;
  }

  const pw = typeof req.query.pw === "string" ? req.query.pw : "";
  if (!expected || pw !== expected) {
    res.status(401).setHeader("Content-Type", "text/html").send(
      `<!doctype html><body style="font-family:sans-serif;padding:40px">Add <code>?pw=YOUR_ADMIN_PASSWORD</code> to the address to open this page.</body>`,
    );
    return;
  }

  // One-time seeding of hand-tallied counts: ?set=A:6,B:3,...
  if (typeof req.query.set === "string") {
    const counts: Record<string, number> = {};
    for (const part of req.query.set.split(",")) {
      const [k, v] = part.split(":");
      if (k) counts[k.trim().toUpperCase()] = Number(v);
    }
    await setManualCounts(counts);
    res.redirect(302, `/feedback?pw=${encodeURIComponent(pw)}`);
    return;
  }

  const [replies, manual, unsubs, sentCount] = await Promise.all([
    listReplies(),
    getManualCounts(),
    listUnsubscribedEmails().catch(() => [] as string[]),
    redis.scard(SURVEY_SENT_KEY).catch(() => 0),
  ]);

  const fromReplies: Record<string, number> = {};
  for (const L of LETTERS) fromReplies[L] = 0;
  for (const r of replies) if (r.letter) fromReplies[r.letter] = (fromReplies[r.letter] ?? 0) + 1;
  const total: Record<string, number> = {};
  for (const L of LETTERS) total[L] = (manual[L] ?? 0) + (fromReplies[L] ?? 0);
  const grand = LETTERS.reduce((s, L) => s + total[L], 0);
  const max = Math.max(1, ...LETTERS.map((L) => total[L]));
  const needsLook = replies.filter((r) => !r.letter && !r.unsubscribed).length;
  const autoReplies = replies.length;
  const replyRate =
    Number(sentCount) > 0 ? Math.round((autoReplies / Number(sentCount)) * 1000) / 10 : 0;
  const inboundReady = surveyReplyTo() !== "kristi@kristinasherk.com";

  const bars = SURVEY_OPTIONS.map((o) => {
    const n = total[o.letter];
    const pct = grand > 0 ? Math.round((n / grand) * 100) : 0;
    return `<div class="bar">
      <div class="bl"><b>${o.letter}</b> ${esc(o.label)}</div>
      <div class="bt"><div class="bf" style="width:${((n / max) * 100).toFixed(1)}%"></div></div>
      <div class="bv"><b>${n}</b> <span>${pct}%</span></div>
      <div class="adj"><button data-adj="${o.letter}" data-d="-1" title="Remove one hand-tallied vote">−</button><button data-adj="${o.letter}" data-d="1" title="Add one hand-tallied vote">+</button></div>
    </div>`;
  }).join("");

  const letterSelect = (id: string, cur: string | null) =>
    `<select class="ls" data-id="${esc(id)}">
      <option value=""${cur ? "" : " selected"}>?</option>
      ${LETTERS.map((L) => `<option${cur === L ? " selected" : ""}>${L}</option>`).join("")}
    </select>`;

  const rows = replies
    .map(
      (r) => `<tr class="${!r.letter && !r.unsubscribed ? "look" : ""}">
      <td>${esc(fmtET(r.receivedAt))}</td>
      <td class="em">${esc(r.email)}${r.unsubscribed ? ' <span class="chip">unsubscribed</span>' : ""}</td>
      <td>${letterSelect(r.id, r.letter)}</td>
      <td class="wrote">${esc(r.snippet) || '<span style="color:#aaa">(empty)</span>'}</td>
    </tr>`,
    )
    .join("");

  const unsubList = unsubs
    .sort()
    .map(
      (e) => `<span class="uchip">${esc(e)} <a href="#" data-resub="${esc(e)}" title="Undo — they can get emails again">×</a></span>`,
    )
    .join("");

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Feedback — GenerAItion Headshots</title>
<style>
  :root{--ink:#2A2A2A;--sub:#6E6E6A;--line:#E8E4DB;--cream:#FAF8F4;--forest:#1B4332;--amber:#FBF3E2;}
  *{box-sizing:border-box} body{margin:0;background:var(--cream);color:var(--ink);font-family:system-ui,-apple-system,'Segoe UI',sans-serif;padding:24px}
  .wrap{max-width:1100px;margin:0 auto} h1{font-size:22px;margin:0 0 4px} h2{font-size:16px;margin:28px 0 10px}
  .meta{font-size:13px;color:var(--sub);margin:0 0 18px}
  .cards{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:20px}
  .card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:130px}
  .card .n{font-size:24px;font-weight:700;color:var(--forest);line-height:1} .card .l{font-size:11px;color:var(--sub);text-transform:uppercase;letter-spacing:.06em;margin-top:4px}
  .panel{background:#fff;border:1px solid var(--line);border-radius:10px;padding:16px}
  .bar{display:grid;grid-template-columns:minmax(200px,340px) 1fr 80px 64px;gap:12px;align-items:center;padding:6px 0;font-size:14px}
  .bl b{color:var(--forest);margin-right:4px} .bt{background:var(--amber);border:1px solid var(--line);border-radius:6px;height:18px;overflow:hidden}
  .bf{background:var(--forest);height:100%} .bv{text-align:right} .bv span{color:var(--sub);font-size:12px}
  .adj button{border:1px solid var(--line);background:#fff;border-radius:6px;width:26px;height:26px;cursor:pointer;margin-left:4px;font-size:15px}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:13px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  th{background:#F3EEE4;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--sub)}
  td.em{font-weight:600;white-space:nowrap} td.wrote{white-space:pre-wrap;max-width:520px}
  tr.look{background:var(--amber)} .chip{background:#EDEBE6;color:#6E6E6A;border-radius:10px;padding:1px 8px;font-size:11px;font-weight:500}
  .uchip{display:inline-block;background:#fff;border:1px solid var(--line);border-radius:14px;padding:3px 10px;margin:0 6px 6px 0;font-size:12px}
  .uchip a{color:#B00020;text-decoration:none;font-weight:700;margin-left:4px}
  textarea{width:100%;height:70px;border:1px solid var(--line);border-radius:8px;padding:8px;font:inherit}
  .btn{background:var(--forest);color:#fff;border:none;border-radius:8px;padding:9px 14px;font-weight:600;cursor:pointer;margin-top:8px}
  .warn{background:#FFF7E5;border:1px solid #F3D593;color:#5A3E0A;border-radius:10px;padding:10px 14px;font-size:13px;margin-bottom:16px}
  select.ls{font:inherit;padding:2px 4px}
  @media(max-width:700px){.bar{grid-template-columns:1fr 70px 64px}.bt{grid-column:1 / -1}}
</style></head><body><div class="wrap">
<h1>Survey feedback</h1>
<p class="meta">"Why didn't you buy?" answers from non-buyers · reload to refresh · <a href="/api/admin/leads?pw=${encodeURIComponent(pw)}">Leads page →</a></p>
${inboundReady ? "" : `<div class="warn"><b>Auto-logging isn't connected yet.</b> Replies still go to your inbox. Add the SURVEY_REPLY_TO setting in Vercel (see setup steps) and new replies will show up here on their own.</div>`}
<div class="cards">
  <div class="card"><div class="n">${grand}</div><div class="l">Total answers</div></div>
  <div class="card"><div class="n">${Number(sentCount)}</div><div class="l">Surveys sent</div></div>
  <div class="card"><div class="n">${autoReplies}</div><div class="l">Auto-logged replies</div></div>
  <div class="card"><div class="n">${replyRate}%</div><div class="l">Reply rate</div></div>
  <div class="card"><div class="n">${needsLook}</div><div class="l">Need a look</div></div>
  <div class="card"><div class="n">${unsubs.length}</div><div class="l">Unsubscribed</div></div>
</div>

<h2>Running tally</h2>
<div class="panel">${bars}
<p class="meta" style="margin:10px 0 0">Includes ${LETTERS.reduce((s, L) => s + manual[L], 0)} votes you tallied by hand (use − / + to change those) plus every auto-logged reply.</p></div>

<h2>Replies${needsLook ? ` <span style="font-weight:400;color:var(--sub);font-size:13px">· highlighted rows need a letter</span>` : ""}</h2>
${replies.length ? `<table><thead><tr><th>When (ET)</th><th>Email</th><th>Letter</th><th>What they wrote</th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="panel meta" style="margin:0">No auto-logged replies yet.</div>`}

<h2>Unsubscribed (${unsubs.length})</h2>
<div class="panel">
  <div>${unsubList || '<span class="meta">Nobody yet.</span>'}</div>
  <div style="margin-top:12px;font-size:13px;color:var(--sub)">Add emails to unsubscribe (one per line or comma-separated). They can still use the app — they just never get marketing emails.</div>
  <textarea id="unsubIn" placeholder="name@example.com"></textarea>
  <button class="btn" id="unsubBtn">Unsubscribe these</button>
</div>
</div>
<script>
var PW = ${JSON.stringify(pw)};
function post(body){return fetch('/api/admin/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({pw:PW},body))}).then(function(r){return r.json()})}
document.querySelectorAll('[data-adj]').forEach(function(b){b.onclick=function(){post({action:'adjust',letter:b.dataset.adj,delta:Number(b.dataset.d)}).then(function(){location.reload()})}});
document.querySelectorAll('select.ls').forEach(function(s){s.onchange=function(){post({action:'setLetter',id:s.dataset.id,letter:s.value}).then(function(){location.reload()})}});
document.querySelectorAll('[data-resub]').forEach(function(a){a.onclick=function(e){e.preventDefault();if(!confirm('Let '+a.dataset.resub+' get emails again?'))return;post({action:'resubscribe',email:a.dataset.resub}).then(function(){location.reload()})}});
document.getElementById('unsubBtn').onclick=function(){var v=document.getElementById('unsubIn').value;if(!v.trim())return;post({action:'unsubscribe',emails:v}).then(function(d){alert('Unsubscribed '+(d.count||0)+' email(s).');location.reload()})};
</script></body></html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(html);
}
