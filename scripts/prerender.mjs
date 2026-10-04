/**
 * prerender.mjs — writes a static HTML file for every public page (2026-10-04).
 *
 * Runs after `vite build` + `vite build --ssr src/entry-prerender.tsx`.
 * For each route in src/seo.ts it renders the React app to HTML on the
 * server, drops that HTML into dist/index.html's <div id="root">, and swaps
 * the <head> tags (title, description, canonical, Open Graph, Twitter, JSON-LD)
 * for that page's own. Output: dist/<route>/index.html (home → dist/index.html).
 * Also writes dist/_routes.json for the sitemap (scripts/build-content.mjs).
 *
 * Why: Google, Bing and AI search engines were seeing one blank page with the
 * home page's title on every URL. Now each URL has its own title + real text.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const SSR = path.join(ROOT, "dist-ssr", "entry-prerender.js");

// ---- minimal browser shims so render-time code never throws in Node ----
const noop = () => {};
const storage = () => ({ getItem: () => null, setItem: noop, removeItem: noop, clear: noop, key: () => null, length: 0 });
globalThis.window ??= globalThis;
globalThis.localStorage ??= storage();
globalThis.sessionStorage ??= storage();
globalThis.navigator ??= { userAgent: "prerender", language: "en-US", languages: ["en-US"], onLine: true, maxTouchPoints: 0 };
globalThis.location ??= { pathname: "/", search: "", hash: "", href: "https://generationheadshots.com/", origin: "https://generationheadshots.com", hostname: "generationheadshots.com" };
globalThis.matchMedia ??= () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop });
globalThis.innerWidth ??= 1280; globalThis.innerHeight ??= 900;
globalThis.addEventListener ??= noop; globalThis.removeEventListener ??= noop;
globalThis.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);
globalThis.document ??= { title: "", querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, addEventListener: noop, removeEventListener: noop, createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop }), head: { appendChild: noop }, body: { appendChild: noop, style: {} }, documentElement: { style: {} }, cookie: "", visibilityState: "visible", hidden: false };

const { render, routes, ORGANIZATION } = await import(SSR);
fs.writeFileSync(path.join(DIST, "_org.json"), JSON.stringify(ORGANIZATION));
const template = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
if (!template.includes('<div id="root"></div>')) throw new Error("dist/index.html: root div not found");

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const setMeta = (html, attr, key, value) =>
  html.replace(new RegExp(`(<meta\\s+${attr}="${key}"\\s+content=")[^"]*(")`), `$1${esc(value)}$2`)
      .replace(new RegExp(`(<meta\\s+${attr}="${key}"\\s*\\n?\\s*content=")[^"]*(")`), `$1${esc(value)}$2`);

let ok = 0;
const written = [];
for (const r of routes()) {
  let body;
  try {
    body = render(r.path);
  } catch (e) {
    console.error(`  prerender FAILED for ${r.path}: ${e?.message ?? e}`);
    continue;
  }
  if (!body || body.length < 500) { console.error(`  prerender for ${r.path} came back empty; skipping`); continue; }
  const url = "https://generationheadshots.com" + (r.path === "/" ? "/" : r.path);
  let html = template;
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${esc(r.title)}</title>`);
  html = html.replace(/<meta\s+name="description"\s+content="[^"]*"\s*\/>/s, `<meta name="description" content="${esc(r.description)}" />`);
  html = html.replace(/<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${url}" />`);
  html = setMeta(html, "property", "og:title", r.title);
  html = setMeta(html, "property", "og:description", r.description);
  html = setMeta(html, "property", "og:url", url);
  html = setMeta(html, "property", "og:type", r.ogType ?? "website");
  html = setMeta(html, "name", "twitter:title", r.title);
  html = setMeta(html, "name", "twitter:description", r.description);
  if (r.schemaJson) {
    // Non-home pages get their own JSON-LD instead of the home page's product graph.
    html = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, `<script type="application/ld+json">${r.schemaJson}</script>`);
  }
  html = html.replace('<div id="root"></div>', `<div id="root">${body}</div>`);
  const out = r.path === "/" ? path.join(DIST, "index.html") : path.join(DIST, r.path.slice(1), "index.html");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  written.push({ path: r.path, title: r.title });
  ok++;
}
fs.writeFileSync(path.join(DIST, "_routes.json"), JSON.stringify(written, null, 1));
console.log(`prerendered ${ok}/${routes().length} pages`);
if (ok < routes().length) process.exit(1);
