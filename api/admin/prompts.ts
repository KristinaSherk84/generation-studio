/**
 * GET  /api/admin/prompts?pw=ADMIN_PASSWORD   -> live prompt editor webpage
 * POST /api/admin/prompts (pw + {action:"save"|"reset", key, text})
 *
 * Edit any prompt segment used by /api/generate and have it go live instantly
 * (no deploy). Reads the catalog (current code defaults + metadata) that
 * /api/generate seeds into Redis on cold start, layers the saved overrides on
 * top, and lets Kristi (or Claude) edit/reset each one. generate.ts falls back
 * to the code default whenever an override is missing or blank, so this can
 * never break generation. (2026-08-10)
 *
 * Recipe bar: pick a style/background/lighting/attire/skin and the blocks that
 * don't fire for that recipe grey out, leaving only the active ones editable.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getPromptOverrides,
  setPromptOverride,
  resetPromptOverride,
  type PromptSegmentMeta,
} from "../lib/promptStore.js";
import { PROMPT_DEFAULTS, PROMPT_SEGMENTS } from "../generate.js";
import {
  RETOUCH_PROMPT_DEFAULTS,
  RETOUCH_PROMPT_SEGMENTS,
} from "../lib/retouchPrompts.js";

export const maxDuration = 15;

function esc(v: string): string {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const RECIPE_DIMS: { key: string; label: string; options: string[] }[] = [
  { key: "style", label: "Style", options: ["corporate", "creative", "executive", "urban", "healthcare"] },
  { key: "background", label: "Background", options: ["white", "lightgrey", "dark", "black", "blue", "bluebright", "green", "red"] },
  { key: "lighting", label: "Lighting", options: ["studio", "dramatic", "golden"] },
  { key: "attire", label: "Attire", options: ["formal", "casual", "polo", "keep", "medical"] },
  { key: "skin", label: "Skin", options: ["realistic"] },
];
const DEFAULT_RECIPE: Record<string, string> = {
  style: "executive",
  background: "dark",
  lighting: "studio",
  attire: "formal",
  skin: "realistic",
};

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  const pw =
    (typeof req.query.pw === "string" && req.query.pw) ||
    (req.body && typeof req.body.pw === "string" && req.body.pw) ||
    "";
  if (!process.env.ADMIN_PASSWORD || pw !== process.env.ADMIN_PASSWORD) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  if (req.method === "POST") {
    const body = (req.body ?? {}) as { action?: string; key?: string; text?: string };
    const key = typeof body.key === "string" ? body.key : "";
    if (!key) {
      res.status(400).json({ ok: false, error: "missing key" });
      return;
    }
    try {
      if (body.action === "reset") {
        await resetPromptOverride(key);
      } else {
        await setPromptOverride(key, typeof body.text === "string" ? body.text : "");
      }
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
    return;
  }

  // Read the block list DIRECTLY from the deployed code (no Redis seed step),
  // so the editor is always in sync the instant a deploy finishes — no need to
  // generate a headshot first. Overrides still layer on top per segment.
  const catalog = {
    defaults: { ...PROMPT_DEFAULTS, ...RETOUCH_PROMPT_DEFAULTS },
    meta: [...PROMPT_SEGMENTS, ...RETOUCH_PROMPT_SEGMENTS],
    updatedAt: "live (read directly from deployed code)",
  };
  const overrides = await getPromptOverrides();

  const groups: string[] = [];
  const seen = new Set<string>();
  for (const m of catalog.meta) {
    if (!seen.has(m.group)) {
      seen.add(m.group);
      groups.push(m.group);
    }
  }

  // A saved (non-blank) override, or null.
  const savedOverride = (key: string): string | null => {
    const ov = overrides[key];
    return typeof ov === "string" && ov.trim().length > 0 ? ov : null;
  };

  // Ordinary (non-gendered) segment card.
  const singleCard = (g: string, m: PromptSegmentMeta): string => {
    const def = catalog.defaults[m.key] ?? "";
    const alwaysOn = g.startsWith("Retouch");
    const ov = savedOverride(m.key);
    const isOverridden = ov !== null;
    const value = isOverridden ? ov : def;
    const firesAttr = esc(JSON.stringify(m.fires ?? {}));
    const note = m.note ? `<div class="note">${esc(m.note)}</div>` : "";
    const badge = isOverridden
      ? `<span class="badge edited">Edited</span>`
      : `<span class="badge def">Default</span>`;
    return `
        <div class="card" data-key="${esc(m.key)}" data-fires='${firesAttr}'${alwaysOn ? ' data-always="1"' : ''}>
          <div class="chead">
            <div class="ctitle">${esc(m.label)} ${badge}</div>
            <div class="ckey">${esc(m.key)}</div>
          </div>
          ${note}
          <textarea id="ta_${esc(m.key)}" rows="6" spellcheck="false">${esc(value)}</textarea>
          <div class="cbtns">
            <button class="save" onclick="save('${esc(m.key)}')">Save (go live)</button>
            <button class="reset" onclick="reset('${esc(m.key)}')">Reset to default</button>
            <span class="status" id="st_${esc(m.key)}"></span>
          </div>
        </div>`;
  };

  // Gendered Men/Women tabbed card. Each tab seeds from its own saved override,
  // then the (legacy) ungendered override, then the code default — so both tabs
  // start out showing exactly what's live today.
  const genderCard = (
    g: string,
    pair: string,
    female: PromptSegmentMeta | undefined,
    male: PromptSegmentMeta | undefined,
  ): string => {
    const any = female ?? male;
    if (!any) return "";
    const firesAttr = esc(JSON.stringify(any.fires ?? {}));
    const alwaysOn = g.startsWith("Retouch");
    const baseTitle = any.label.replace(/\s—\s(Men|Women)$/, "");
    const pane = (m: PromptSegmentMeta | undefined, show: boolean): string => {
      if (!m) return "";
      const gkey = m.key;
      const gv = savedOverride(gkey);
      const bv = savedOverride(pair);
      const value =
        gv ?? bv ?? catalog.defaults[gkey] ?? catalog.defaults[pair] ?? "";
      const isOverridden = gv !== null;
      const badge = isOverridden
        ? `<span class="badge edited">Edited</span>`
        : `<span class="badge def">Default</span>`;
      const note = m.note ? `<div class="note">${esc(m.note)}</div>` : "";
      return `<div class="gpane" id="pane_${esc(pair)}_${esc(m.gender ?? "")}"${show ? "" : ' style="display:none"'}>
          <div style="margin-top:6px">${badge}</div>
          ${note}
          <textarea id="ta_${esc(gkey)}" rows="6" spellcheck="false">${esc(value)}</textarea>
          <div class="cbtns">
            <button class="save" onclick="save('${esc(gkey)}')">Save (go live)</button>
            <button class="reset" onclick="reset('${esc(gkey)}')">Reset to default</button>
            <span class="status" id="st_${esc(gkey)}"></span>
          </div>
        </div>`;
    };
    return `
        <div class="card" data-key="${esc(pair)}" data-fires='${firesAttr}'${alwaysOn ? ' data-always="1"' : ''}>
          <div class="chead">
            <div class="ctitle">${esc(baseTitle)} · Men / Women</div>
            <div class="ckey">${esc(pair)} · gendered</div>
          </div>
          <div class="gtabs">
            <button class="gtab on" id="gt_${esc(pair)}_female" onclick="gtab('${esc(pair)}','female')">Women</button>
            <button class="gtab" id="gt_${esc(pair)}_male" onclick="gtab('${esc(pair)}','male')">Men</button>
          </div>
          ${pane(female, true)}
          ${pane(male, false)}
        </div>`;
  };

  const cards = groups
    .map((g) => {
      const metas = catalog.meta.filter((m) => m.group === g);
      const seenPairs = new Set<string>();
      const rendered: string[] = [];
      for (const m of metas) {
        if (m.genderPair) {
          if (seenPairs.has(m.genderPair)) continue;
          seenPairs.add(m.genderPair);
          const female = metas.find(
            (x) => x.genderPair === m.genderPair && x.gender === "female",
          );
          const male = metas.find(
            (x) => x.genderPair === m.genderPair && x.gender === "male",
          );
          rendered.push(genderCard(g, m.genderPair, female, male));
        } else {
          rendered.push(singleCard(g, m));
        }
      }
      return `<section><h3>${esc(g)}</h3>${rendered.join("")}</section>`;
    })
    .join("");

  const recipeBar = RECIPE_DIMS.map((d) => {
    const opts = d.options
      .map(
        (o) =>
          `<button class="opt${DEFAULT_RECIPE[d.key] === o ? " on" : ""}" data-dim="${d.key}" data-val="${o}" onclick="pick('${d.key}','${o}')">${o}</button>`,
      )
      .join("");
    return `<div class="dim"><span class="dlabel">${d.label}</span>${opts}</div>`;
  }).join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prompt editor · GenerAItion</title>
<style>
  :root{--dark:#2C2C2A;--med:#888780;--line:#E8E8E6;--bg:#F4F3EF;--accent:#0B7;--edit:#C77}
  *{box-sizing:border-box}
  body{font:15px/1.5 system-ui,-apple-system,Segoe UI,Helvetica,Arial;color:var(--dark);background:var(--bg);margin:0;padding:0 0 80px}
  header{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--line);padding:14px 20px;z-index:10}
  h1{font-size:18px;margin:0 0 4px}
  .sub{font-size:12px;color:var(--med);margin-bottom:10px}
  .dim{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin:4px 0}
  .dlabel{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--med);width:96px;flex:0 0 96px}
  .opt{font:12px system-ui;padding:3px 9px;border:1px solid var(--line);border-radius:20px;background:#fff;cursor:pointer;color:var(--dark)}
  .opt.on{background:var(--dark);color:#fff;border-color:var(--dark)}
  main{max-width:920px;margin:0 auto;padding:18px 20px}
  section{margin-bottom:26px}
  h3{font-size:13px;text-transform:uppercase;letter-spacing:.6px;color:var(--med);border-bottom:1px solid var(--line);padding-bottom:6px;margin:0 0 12px}
  .card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:12px;transition:opacity .15s}
  .card.dim-off{opacity:.32}
  .chead{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
  .ctitle{font-weight:600;font-size:14px}
  .ckey{font:11px ui-monospace,monospace;color:var(--med)}
  .badge{font-size:10px;padding:1px 7px;border-radius:10px;vertical-align:middle}
  .badge.edited{background:#F6E7E3;color:#9A4B3B}
  .badge.def{background:#EEF0EC;color:#7A7A73}
  .note{font-size:12px;color:var(--med);margin:4px 0 0}
  textarea{width:100%;margin-top:8px;padding:9px 11px;border:1px solid var(--line);border-radius:8px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;background:#fff;color:var(--dark)}
  .cbtns{display:flex;align-items:center;gap:8px;margin-top:8px}
  button.save{background:var(--accent);color:#fff;border:none;border-radius:7px;padding:7px 13px;font:600 12px system-ui;cursor:pointer}
  button.reset{background:#fff;color:var(--dark);border:1px solid var(--line);border-radius:7px;padding:7px 13px;font:12px system-ui;cursor:pointer}
  .status{font-size:12px;color:var(--accent)}
  .gtabs{display:flex;gap:6px;margin:6px 0 4px}
  .gtab{padding:6px 16px;border:1px solid var(--line);background:#fff;border-radius:8px;cursor:pointer;font:600 13px system-ui;color:var(--dark)}
  .gtab.on{background:var(--dark);color:#fff;border-color:var(--dark)}
  .gpane{margin-top:2px}
</style></head>
<body>
<header>
  <h1>Prompt editor</h1>
  <div class="sub">Edit a block and hit Save — it goes live on the next generation. Reset reverts to the code default. Pick a recipe below to grey out blocks that don't fire for it. Last synced from code: ${esc(catalog.updatedAt)}</div>
  ${recipeBar}
</header>
<main>${cards}</main>
<script>
  var PW=${JSON.stringify(pw)};
  var recipe=${JSON.stringify(DEFAULT_RECIPE)};
  function applyGrey(){
    document.querySelectorAll('.card').forEach(function(c){
      if(c.getAttribute('data-always')==='1'){c.classList.remove('dim-off');return;}
      var f={};try{f=JSON.parse(c.getAttribute('data-fires')||'{}')}catch(e){}
      var active=true;
      for(var k in f){ if(f[k]!==recipe[k]){active=false;break;} }
      c.classList.toggle('dim-off',!active);
    });
  }
  function gtab(pair,g){
    ['female','male'].forEach(function(x){
      var pane=document.getElementById('pane_'+pair+'_'+x);
      var btn=document.getElementById('gt_'+pair+'_'+x);
      if(pane) pane.style.display=(x===g?'':'none');
      if(btn) btn.classList.toggle('on',x===g);
    });
  }
  function pick(dim,val){
    recipe[dim]=val;
    document.querySelectorAll('.opt[data-dim="'+dim+'"]').forEach(function(b){
      b.classList.toggle('on',b.getAttribute('data-val')===val);
    });
    applyGrey();
  }
  function post(payload,cb){
    payload.pw=PW;
    fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
      .then(function(r){return r.json()}).then(cb).catch(function(){cb({ok:false})});
  }
  function save(key){
    var st=document.getElementById('st_'+key); st.textContent='Saving…';
    var text=document.getElementById('ta_'+key).value;
    post({action:'save',key:key,text:text},function(r){
      st.textContent=r&&r.ok?'Saved — live':'Error'; setTimeout(function(){st.textContent=''},2500);
      if(r&&r.ok){var b=document.querySelector('.card[data-key="'+key+'"] .badge');if(b){var edited=text.trim().length>0;b.className='badge '+(edited?'edited':'def');b.textContent=edited?'Edited':'Default';}}
    });
  }
  function reset(key){
    var st=document.getElementById('st_'+key); st.textContent='Resetting…';
    post({action:'reset',key:key},function(r){
      st.textContent=r&&r.ok?'Reset — reload to see default':'Error'; setTimeout(function(){st.textContent=''},3000);
      if(r&&r.ok){var b=document.querySelector('.card[data-key="'+key+'"] .badge');if(b){b.className='badge def';b.textContent='Default';}}
    });
  }
  applyGrey();
</script>
</body></html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(html);
}
