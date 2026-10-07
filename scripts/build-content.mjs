/**
 * build-content.mjs — turns the plain-text files in /content into real,
 * crawlable HTML pages inside /dist (2026-10-04).
 *
 *   content/pages/<slug>.md  ->  dist/<slug>/index.html        (SEO landing pages)
 *   content/blog/<slug>.md   ->  dist/blog/<slug>/index.html   (optional; only if the folder exists)
 *
 * Each file starts with a short header between two "---" lines:
 *   title, description, date (YYYY-MM-DD), updated, author, image, tags, draft
 * then the article in Markdown. Runs after `vite build` (see package.json),
 * and alone via `npm run content` for fast previews. Also rewrites
 * dist/sitemap.xml so every page is listed. Vercel serves these static files
 * before it consults the rewrites in vercel.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT = path.join(ROOT, "content");
const DIST = path.join(ROOT, "dist");
const SITE = "https://generationheadshots.com";
const SITE_NAME = "GenerAItion Headshots";
// Drafts show in the local preview but never on Vercel (production).
const INCLUDE_DRAFTS = process.env.INCLUDE_DRAFTS === "1" || process.env.VERCEL !== "1";

if (!fs.existsSync(DIST)) {
  console.error("dist/ not found — run `vite build` first.");
  process.exit(1);
}

// ---------- tiny front-matter parser (no YAML dependency) ----------
function parseFrontMatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if (/^\[.*\]$/.test(val)) {
      val = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else {
      val = val.replace(/^["']|["']$/g, "");
      if (val === "true") val = true;
      else if (val === "false") val = false;
    }
    meta[key] = val;
  }
  return { meta, body: m[2] };
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmtDate = (d) => d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : "";
const words = (s) => s.replace(/[#*_>`|\-]/g, " ").split(/\s+/).filter(Boolean).length;

function readDir(sub) {
  const dir = path.join(CONTENT, sub);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => {
    const raw = fs.readFileSync(path.join(dir, f), "utf8");
    const { meta, body } = parseFrontMatter(raw);
    const slug = f.replace(/\.md$/, "");
    return { slug, meta, body, html: marked.parse(body), words: words(body) };
  }).filter((p) => INCLUDE_DRAFTS || !p.meta.draft)
    .sort((a, b) => String(b.meta.date ?? "").localeCompare(String(a.meta.date ?? "")));
}

// ---------- shared chrome: matches LandingV2 in src/App.tsx ----------
const CSS = `
:root{--green:#1B4332;--green-hover:#143025;--gold:#C9A961;--charcoal:#2A2A2A;--cream:#FAF8F4;--white:#fff;--sub:#6E6E6A;--rule:#EFEAE0;
--serif:'Tiempos Headline','Cormorant Garamond','Didot',Georgia,'Times New Roman',serif;--sans:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:var(--sans);font-size:17px;line-height:1.65;color:var(--charcoal);background:var(--cream);-webkit-font-smoothing:antialiased}
a{color:var(--green)}
.nav{height:64px;background:var(--white);border-bottom:1px solid var(--rule);display:flex;align-items:center;justify-content:space-between;padding:0 24px;gap:16px}
.wordmark{font-family:var(--serif);font-size:20px;letter-spacing:.2px;color:var(--charcoal);text-decoration:none;white-space:nowrap}
.wordmark em{font-style:italic;color:var(--gold);font-weight:600}
.wordmark b{font-weight:500}
.navlinks{display:flex;gap:22px;align-items:center;font-size:14px}
.navlinks a{color:var(--charcoal);text-decoration:none}
.navlinks a:hover{color:var(--green)}
.pill{display:inline-block;white-space:nowrap;background:var(--green);color:#fff!important;border-radius:999px;padding:12px 24px;font-size:14px;font-weight:500;letter-spacing:.6px;text-transform:uppercase;text-decoration:none;box-shadow:0 1px 2px rgba(0,0,0,.08);transition:background 160ms ease,transform 80ms ease}
.pill:hover{background:var(--green-hover);transform:translateY(-1px)}
.pill.lg{padding:16px 32px;font-size:16px}
.wrap{max-width:720px;margin:0 auto;padding:0 20px}
.hero{padding:56px 0 24px;text-align:left}
.eyebrow{font-size:12px;letter-spacing:1.6px;text-transform:uppercase;color:var(--sub);margin:0 0 14px}
h1{font-family:var(--serif);font-weight:500;font-size:clamp(30px,4.6vw,44px);line-height:1.15;margin:0 0 18px;color:var(--charcoal)}
.meta{font-size:14px;color:var(--sub);display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.meta .dot{opacity:.5}
.lede{font-size:19px;color:#3d3d3a;margin:18px 0 0}
.card{background:var(--white);border:1px solid var(--rule);border-radius:12px;padding:36px 36px 40px;margin:28px 0 48px}
.article h2{font-family:var(--serif);font-weight:500;font-size:28px;line-height:1.25;margin:40px 0 12px;color:var(--charcoal)}
.article h3{font-size:19px;font-weight:600;margin:30px 0 8px}
.article p{margin:0 0 18px}
.article ul,.article ol{padding-left:24px;margin:0 0 18px}
.article li{margin:6px 0}
.article blockquote{margin:22px 0;padding:14px 20px;border-left:3px solid var(--gold);background:var(--cream);color:#3d3d3a;font-style:italic;border-radius:0 8px 8px 0}
.article img{max-width:100%;height:auto;border-radius:8px;display:block;margin:20px auto}
.article hr{border:0;border-top:1px solid var(--rule);margin:36px 0}
.article table{width:100%;border-collapse:collapse;font-size:15px;margin:18px 0 24px;display:block;overflow-x:auto}
.article th,.article td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--rule);vertical-align:top}
.article th{font-size:12px;letter-spacing:1.2px;text-transform:uppercase;color:var(--sub);font-weight:600;background:var(--cream)}
.article code{background:var(--cream);padding:2px 6px;border-radius:4px;font-size:.92em}
.cta{background:var(--white);border:1px solid var(--rule);border-radius:12px;padding:34px 32px;text-align:center;margin:0 0 56px}
.cta h2{font-family:var(--serif);font-weight:500;font-size:26px;margin:0 0 8px}
.cta p{color:var(--sub);margin:0 0 20px;font-size:15px}
.author{display:flex;gap:16px;align-items:center;margin:0 0 40px;padding:20px 22px;background:var(--white);border:1px solid var(--rule);border-radius:12px}
.author img{width:64px;height:64px;border-radius:50%;object-fit:cover;flex-shrink:0}
.author .who{font-size:14px;color:var(--sub);line-height:1.5}
.author .who b{color:var(--charcoal);font-weight:600;display:block;font-size:15px}
.author .who a{color:var(--green)}
.heroimg{width:auto;max-width:100%;height:auto;max-height:600px;border-radius:12px;margin:28px auto 0;display:block}
.list{display:grid;gap:18px;margin:28px 0 56px}
.post{background:var(--white);border:1px solid var(--rule);border-radius:12px;padding:26px 28px;text-decoration:none;color:inherit;display:block;transition:transform 80ms ease,border-color 160ms ease}
.post:hover{transform:translateY(-1px);border-color:var(--gold)}
.post h2{font-family:var(--serif);font-weight:500;font-size:24px;line-height:1.25;margin:6px 0 8px}
.post p{margin:0;color:#3d3d3a;font-size:16px}
.post .meta{margin-top:12px}
footer{padding:40px 24px 56px;text-align:center;background:var(--white);border-top:1px solid var(--rule)}
footer .copy{margin-top:18px;font-size:12px;color:var(--sub);letter-spacing:.3px}
footer .links{margin-top:12px;display:flex;justify-content:center;gap:24px;font-size:12px;flex-wrap:wrap}
footer .links a{color:var(--sub);text-decoration:none}
@media (max-width:600px){.navlinks .hide-m{display:none}.nav{padding:0 16px}.wordmark{font-size:17px}.nav .pill{padding:9px 14px;font-size:12px;letter-spacing:.4px}.hero .pill.lg{width:100%;text-align:center;padding:14px 18px;font-size:14px}.card{padding:26px 20px 30px}.hero{padding:40px 0 16px}body{font-size:16px}}
`;

const ANALYTICS = `
<script type="text/javascript">(function(){var h=location.hostname;var on=/(^|\\.)generationheadshots\\.com$/.test(h)||/(^|\\.)generaitionheadshots\\.com$/.test(h);try{var q=new URLSearchParams(location.search).get("notrack");if(q==="1")localStorage.setItem("gh_notrack","1");if(q==="0")localStorage.removeItem("gh_notrack");if(localStorage.getItem("gh_notrack")==="1")on=false;}catch(e){}try{if(navigator.webdriver||/HeadlessChrome|PhantomJS|Lighthouse|PageSpeed|Google-InspectionTool|Googlebot|bingbot|BingPreview|YandexBot|DuckDuckBot|Baiduspider|AhrefsBot|SemrushBot|MJ12bot|DotBot|PetalBot|facebookexternalhit|LinkedInBot|Slackbot|Twitterbot|Applebot|GPTBot|ClaudeBot|PerplexityBot|crawler|spider/i.test(navigator.userAgent||""))on=false;}catch(e){}window.__ghTrack=on;})();</script>
<script type="text/javascript">(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};if(!c.__ghTrack)return;t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window, document, "clarity", "script", "le4fbqvztl");</script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}if(window.__ghTrack){var g=document.createElement("script");g.async=true;g.src="https://www.googletagmanager.com/gtag/js?id=G-4ZHCF8TYLX";document.head.appendChild(g);gtag('js',new Date());gtag('config','G-4ZHCF8TYLX');}</script>
<script type="text/javascript">_linkedin_partner_id="9735570";window._linkedin_data_partner_ids=window._linkedin_data_partner_ids||[];window._linkedin_data_partner_ids.push(_linkedin_partner_id);</script>
<script type="text/javascript">(function(l){if(!l){window.lintrk=function(a,b){window.lintrk.q.push([a,b])};window.lintrk.q=[]}if(!window.__ghTrack)return;var s=document.getElementsByTagName("script")[0];var b=document.createElement("script");b.type="text/javascript";b.async=true;b.src="https://snap.licdn.com/li.lms-analytics/insight.min.js";s.parentNode.insertBefore(b,s);})(window.lintrk);</script>`;

const WORDMARK = `<a class="wordmark" href="/">Gener<em>AI</em>tion <b>Headshots</b></a>`;

function layout({ title, description, canonical, image, jsonLd, body, ogType = "website" }) {
  const img = image?.startsWith("http") ? image : SITE + (image || "/og-image.jpg");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<meta name="author" content="Kristina Sherk" />
<link rel="canonical" href="${canonical}" />
<meta property="og:type" content="${ogType}" />
<meta property="og:site_name" content="${SITE_NAME}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${canonical}" />
<meta property="og:image" content="${img}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(description)}" />
<meta name="twitter:image" content="${img}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&display=swap" rel="stylesheet" />
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>${CSS}</style>
${ANALYTICS}
</head>
<body>
<nav class="nav">
  ${WORDMARK}
  <div class="navlinks">
    <a class="hide-m" href="/how-it-works">How it works</a>
    <a class="hide-m" href="/headshot-generator-gallery">Examples</a>
    <a class="hide-m" href="/faq">FAQ</a>
    <a class="pill" href="/">Try it free</a>
  </div>
</nav>
${body}
<footer>
  ${WORDMARK.replace('class="wordmark"', 'class="wordmark" style="font-size:16px"')}
  <div class="copy">© 2026 GenerAItion Headshots · A Kristina Sherk project</div>
  <div class="links">
    <a href="/privacy">Privacy</a><a href="/terms">Terms</a>
    <a href="https://www.linkedin.com/company/generation-headshots/" target="_blank" rel="noopener noreferrer">LinkedIn</a>
    <a href="https://www.facebook.com/profile.php?id=61595110405202" target="_blank" rel="noopener noreferrer">Facebook</a>
    <a href="/about">About</a>
  </div>
</footer>
</body>
</html>`;
}

const CTA = `<section class="cta">
  <h2>See what you look like in 60 seconds.</h2>
  <p>Your first 6 AI headshots are free. Made by a real headshot photographer. Only pay for what looks like you.</p>
  <a class="pill lg" href="/">Generate my free headshots</a>
</section>`;

const AUTHOR = `<aside class="author">
  <img src="/marketing/ai-headshot-photographer-kristi-sherk.png" alt="Kristina Sherk, headshot photographer" width="64" height="64" />
  <div class="who"><b>Kristina Sherk</b>Professional headshot photographer in Washington, DC for 20 years. 400+ five-star Google reviews. Built GenerAItion Headshots so the AI version actually looks like you. <a href="https://www.kristinasherk.com/" target="_blank" rel="noopener">KristinaSherk.com</a></div>
</aside>`;

// Same Organization block as every app page (written by scripts/prerender.mjs from src/seo.ts).
const orgFile = path.join(DIST, "_org.json");
const ORG = fs.existsSync(orgFile)
  ? JSON.parse(fs.readFileSync(orgFile, "utf8"))
  : { "@type": "Organization", "@id": `${SITE}/#organization`, "name": SITE_NAME, "url": SITE + "/", "logo": `${SITE}/logo.png` };
const PERSON = { "@type": "Person", "name": "Kristina Sherk", "url": "https://www.kristinasherk.com/", "jobTitle": "Professional Headshot Photographer" };

function writeFile(rel, html) {
  const out = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log("  wrote", rel);
}

// ---------- blog posts ----------
const posts = readDir("blog");
const urls = [];
for (const p of posts) {
  const url = `${SITE}/blog/${p.slug}/`;
  const title = `${p.meta.title} | ${SITE_NAME}`;
  const mins = Math.max(1, Math.round(p.words / 230));
  const jsonLd = { "@context": "https://schema.org", "@graph": [
    { "@type": "BlogPosting", "@id": url + "#article", "headline": p.meta.title, "description": p.meta.description,
      "image": SITE + (p.meta.image || "/og-image.jpg"), "datePublished": p.meta.date, "dateModified": p.meta.updated || p.meta.date,
      "author": PERSON, "publisher": ORG, "mainEntityOfPage": url, "wordCount": p.words, "keywords": Array.isArray(p.meta.tags) ? p.meta.tags.join(", ") : undefined },
    { "@type": "BreadcrumbList", "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": SITE + "/" },
      { "@type": "ListItem", "position": 2, "name": "Blog", "item": SITE + "/blog/" },
      { "@type": "ListItem", "position": 3, "name": p.meta.title, "item": url } ] } ] };
  const body = `<main class="wrap">
  <header class="hero">
    <p class="eyebrow">From the photographer's desk</p>
    <h1>${esc(p.meta.title)}</h1>
    <div class="meta"><span>By ${esc(p.meta.author || "Kristina Sherk")}</span><span class="dot">·</span><span>${fmtDate(p.meta.date)}</span><span class="dot">·</span><span>${mins} min read</span></div>
    ${p.meta.description ? `<p class="lede">${esc(p.meta.description)}</p>` : ""}
  </header>
  <article class="card article">${p.html}</article>
  ${AUTHOR}
  ${CTA}
</main>`;
  writeFile(`blog/${p.slug}/index.html`, layout({ title, description: p.meta.description, canonical: url, image: p.meta.image, jsonLd, body, ogType: "article" }));
  urls.push({ loc: url, lastmod: p.meta.updated || p.meta.date });
}

// ---------- blog index (only when posts exist) ----------
if (posts.length) {
  const url = `${SITE}/blog/`;
  const items = posts.map((p) => `<a class="post" href="/blog/${p.slug}/">
    <div class="meta"><span>${fmtDate(p.meta.date)}</span><span class="dot">·</span><span>${Math.max(1, Math.round(p.words / 230))} min read</span></div>
    <h2>${esc(p.meta.title)}</h2>
    <p>${esc(p.meta.description || "")}</p>
  </a>`).join("\n");
  const jsonLd = { "@context": "https://schema.org", "@type": "Blog", "@id": url, "name": `${SITE_NAME} Blog`, "url": url, "publisher": ORG,
    "blogPost": posts.map((p) => ({ "@type": "BlogPosting", "headline": p.meta.title, "url": `${SITE}/blog/${p.slug}/`, "datePublished": p.meta.date })) };
  const body = `<main class="wrap">
  <header class="hero">
    <p class="eyebrow">Blog</p>
    <h1>Honest notes on AI headshots, from a photographer who shoots real ones.</h1>
    <p class="lede">What works, what doesn't, and how to get a headshot that actually looks like you.</p>
  </header>
  <div class="list">${items || "<p>First post coming soon.</p>"}</div>
  ${CTA}
</main>`;
  writeFile("blog/index.html", layout({ title: `Blog | ${SITE_NAME}`, description: "Honest notes on AI headshots from a 20-year professional headshot photographer: tests, tips, and what actually looks like you.", canonical: url, jsonLd, body }));
  urls.unshift({ loc: url, lastmod: posts[0]?.meta.updated || posts[0]?.meta.date });
}

// ---------- standalone pages ----------
for (const p of readDir("pages")) {
  const url = `${SITE}/${p.slug}/`;
  // FAQ schema from "**Question?** answer" paragraphs in the page body.
  const faqs = [...p.html.matchAll(/<p><strong>([^<]*\?)<\/strong>\s*([\s\S]*?)<\/p>/g)]
    .map((m) => ({ q: m[1].trim(), a: m[2].replace(/<[^>]+>/g, "").trim() }));
  const faqNode = faqs.length ? { "@type": "FAQPage", "mainEntity": faqs.map((f) => ({ "@type": "Question", "name": f.q, "acceptedAnswer": { "@type": "Answer", "text": f.a } })) } : null;
  const jsonLd = { "@context": "https://schema.org", "@graph": [
    ORG,
    ...(faqNode ? [faqNode] : []),
    { "@type": "WebPage", "@id": url, "name": p.meta.title, "description": p.meta.description, "url": url, "isPartOf": { "@type": "WebSite", "name": SITE_NAME, "url": SITE + "/" }, "about": { "@id": `${SITE}/#organization` }, "author": PERSON, "dateModified": p.meta.updated || p.meta.date,
      "breadcrumb": { "@type": "BreadcrumbList", "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": SITE + "/" },
        { "@type": "ListItem", "position": 2, "name": p.meta.title, "item": url } ] } } ] };
  const body = `<main class="wrap">
  <header class="hero">${p.meta.eyebrow ? `<p class="eyebrow">${esc(p.meta.eyebrow)}</p>` : ""}<h1>${esc(p.meta.title)}</h1>${p.meta.description ? `<p class="lede">${esc(p.meta.description)}</p>` : ""}
    <p style="margin:26px 0 0"><a class="pill lg" href="/">${esc(p.meta.cta || "Generate my free headshots")}</a></p>
  </header>
  ${p.meta.image ? `<img class="heroimg" src="${esc(p.meta.image)}" alt="${esc(p.meta.imageAlt || p.meta.title)}" />` : ""}
  <article class="card article">${p.html}</article>
  ${CTA}
</main>`;
  writeFile(`${p.slug}/index.html`, layout({ title: `${p.meta.title} | ${SITE_NAME}`, description: p.meta.description, canonical: url, image: p.meta.image, jsonLd, body }));
  urls.push({ loc: url, lastmod: p.meta.updated || p.meta.date });
}

// ---------- sitemap: app routes + every content page ----------
// App routes come from the prerender step (dist/_routes.json, includes every
// /faq/<slug> page); fall back to the known list if it hasn't run.
const FALLBACK_ROUTES = ["/", "/about", "/how-it-works", "/headshot-generator-gallery", "/faq", "/healthcare", "/teams"];
const routesFile = path.join(DIST, "_routes.json");
const APP_ROUTES = fs.existsSync(routesFile) ? JSON.parse(fs.readFileSync(routesFile, "utf8")).map((r) => r.path) : FALLBACK_ROUTES;
const today = new Date().toISOString().slice(0, 10);
const all = [...APP_ROUTES.map((r) => ({ loc: SITE + (r === "/" ? "/" : r), lastmod: today })), ...urls];
const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  all.map((u) => `  <url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`).join("\n") + `\n</urlset>\n`;
fs.writeFileSync(path.join(DIST, "sitemap.xml"), xml);
console.log(`  wrote sitemap.xml (${all.length} URLs)`);
// ---------- local-only side-by-side preview (never shipped: skipped on Vercel) ----------
if (process.env.VERCEL !== "1") {
  const pages = [
    ...readDir("pages").map((p) => ({ title: p.meta.title, path: `/${p.slug}/` })),
    ...posts.map((p) => ({ title: p.meta.title, path: `/blog/${p.slug}/` })),
    { title: "Home (app)", path: "/" },
  ];
  const tpl = fs.readFileSync(path.join(ROOT, "scripts", "preview.html"), "utf8").replace("__PAGES__", JSON.stringify(pages));
  writeFile("_preview/index.html", tpl);
  // Local stub of /api/config so the static preview shows the same free-tier
  // wording as production (the real endpoint is a Vercel function).
  writeFile("api/config", JSON.stringify({ entryFeeEnabled: false, identityCheckEnabled: true }));
}
console.log(`content build done: ${posts.length} post(s)`);
