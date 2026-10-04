/**
 * Per-page SEO metadata (2026-10-04). One source of truth used by:
 *   - scripts/prerender.mjs  → bakes title/description/canonical/schema into
 *                              each page's static HTML at build time
 *   - src/App.tsx            → updates the browser tab + meta tags as the
 *                              customer navigates inside the app
 * Add a new route here when you add a screen. Keep titles under ~60 chars
 * and descriptions under ~155.
 */
export const SITE = "https://generationheadshots.com";
export const SITE_NAME = "GenerAItion Headshots";
const ORG_ID = `${SITE}/#organization`;

export type FaqItem = { slug: string; q: string; a: string };
export type PageMeta = {
  path: string;
  title: string;
  description: string;
  ogType?: "website" | "article";
  schema?: (ctx: { faqs: FaqItem[] }) => Record<string, unknown> | null;
};

export const ORGANIZATION = {
  "@type": [
    "Organization",
    "OnlineBusiness"
  ],
  "@id": "https://generationheadshots.com/#organization",
  "name": "GenerAItion Headshots",
  "legalName": "GenerAItion Headshots",
  "alternateName": [
    "Generation Headshots",
    "GenerationHeadshots",
    "Generaition Headshots",
    "Gen AI Headshots",
    "GenerAItion"
  ],
  "url": "https://generationheadshots.com/",
  "logo": {
    "@type": "ImageObject",
    "url": "https://generationheadshots.com/logo.png"
  },
  "image": "https://generationheadshots.com/og-image.jpg",
  "description": "AI headshot generator built by a professional headshot photographer with 20 years of experience. Upload a few selfies, get 6 realistic headshots in about a minute, and only pay for the ones that look like you.",
  "slogan": "AI headshots made by a real photographer. Only pay for what looks like you.",
  "foundingDate": "2026-04",
  "founder": {
    "@type": "Person",
    "@id": "https://generationheadshots.com/#kristina-sherk",
    "name": "Kristina Sherk",
    "jobTitle": "Professional Headshot Photographer",
    "description": "Washington, DC headshot photographer for 20 years, retouching educator, and the photographer behind GenerAItion Headshots.",
    "url": "https://www.kristinasherk.com/",
    "sameAs": [
      "https://www.linkedin.com/in/kristinasherk/",
      "https://www.kristinasherk.com/",
      "https://www.washingtondcheadshots.com/"
    ]
  },
  "sameAs": [
    "https://www.linkedin.com/company/generation-headshots/",
    "https://www.facebook.com/profile.php?id=61595110405202",
    "https://www.kristinasherk.com/ai-headshots"
  ],
  "contactPoint": {
    "@type": "ContactPoint",
    "contactType": "customer service",
    "email": "kristi@kristinasherk.com",
    "availableLanguage": "English"
  },
  "areaServed": "Worldwide",
  "knowsAbout": [
    "AI headshots",
    "professional headshot photography",
    "LinkedIn headshots",
    "corporate headshots",
    "portrait retouching"
  ],
  "priceRange": "$14.99-$17.99",
  "brand": {
    "@type": "Brand",
    "name": "GenerAItion Headshots"
  }
};

const org = { "@id": ORG_ID };
const person = ORGANIZATION.founder;
const breadcrumb = (items: [string, string][]) => ({
  "@type": "BreadcrumbList",
  itemListElement: items.map(([name, path], i) => ({
    "@type": "ListItem", position: i + 1, name, item: SITE + path,
  })),
});
const faqPage = (faqs: FaqItem[]) => ({
  "@type": "FAQPage",
  mainEntity: faqs.map((f) => ({
    "@type": "Question", name: f.q,
    acceptedAnswer: { "@type": "Answer", text: f.a },
  })),
});

export const PAGES: PageMeta[] = [
  {
    path: "/",
    title: "AI Headshot Generator | GenerAItion Headshots",
    description: "Professional AI headshots made by a real headshot photographer. First 6 free. Only pay for what truly looks like you.",
    // The home page keeps the full @graph that already lives in index.html.
  },
  {
    path: "/about",
    title: "About Kristina Sherk, the Photographer Behind GenerAItion Headshots",
    description: "20 years of headshot photography in Washington, DC, 400+ five-star reviews, and why a real photographer built an AI headshot generator.",
    schema: () => ({ "@type": "AboutPage", mainEntity: person, breadcrumb: breadcrumb([["Home", "/"], ["About", "/about"]]) }),
  },
  {
    path: "/how-it-works",
    title: "How It Works: AI Headshots in About a Minute | GenerAItion Headshots",
    description: "Upload 5 to 8 selfies, pick a style, and get 6 professional AI headshots in about a minute. Free to try. Pay only for the ones that look like you.",
    schema: () => ({
      "@type": "HowTo",
      name: "How to get a professional AI headshot with GenerAItion Headshots",
      totalTime: "PT5M",
      step: [
        { "@type": "HowToStep", name: "Upload a few selfies", text: "Upload 5 to 8 recent photos with your face clearly visible, in different angles and lighting." },
        { "@type": "HowToStep", name: "Choose your style", text: "Pick Corporate, Creative, Executive, Healthcare or IT/Tech, plus attire, lighting and background." },
        { "@type": "HowToStep", name: "Download your headshots", text: "Six headshots arrive in about a minute. Pick your favorites and download full-resolution 2K files." },
      ],
      breadcrumb: breadcrumb([["Home", "/"], ["How it works", "/how-it-works"]]),
    }),
  },
  {
    path: "/headshot-generator-gallery",
    title: "AI Headshot Examples: Before and After Gallery | GenerAItion Headshots",
    description: "Real before-and-after examples from the AI headshot generator built by a professional photographer. See the selfie that went in and the headshot that came out.",
    schema: () => ({ "@type": "ImageGallery", name: "AI headshot before and after gallery", breadcrumb: breadcrumb([["Home", "/"], ["Examples", "/headshot-generator-gallery"]]) }),
  },
  {
    path: "/faq",
    title: "AI Headshot FAQ: Cost, Likeness, Privacy and More | GenerAItion Headshots",
    description: "Answers from a professional headshot photographer: how it works, what it costs, whether the headshots look like you, privacy, and usage rights.",
    schema: ({ faqs }) => ({ ...faqPage(faqs), breadcrumb: breadcrumb([["Home", "/"], ["FAQ", "/faq"]]) }),
  },
  {
    path: "/healthcare",
    title: "AI Headshots for Healthcare Professionals | GenerAItion Headshots",
    description: "Professional headshots for doctors, nurses, residents and medical staff in about a minute. Built by a 20-year photographer. Free to try.",
    schema: () => ({
      "@type": "Service", name: "AI headshots for healthcare professionals", serviceType: "AI headshot generation",
      provider: org, areaServed: "Worldwide", audience: { "@type": "Audience", audienceType: "Healthcare professionals" },
      breadcrumb: breadcrumb([["Home", "/"], ["Healthcare", "/healthcare"]]),
    }),
  },
  {
    path: "/teams",
    title: "AI Headshots for Teams and Companies | GenerAItion Headshots",
    description: "Consistent, professional AI headshots for your whole team without scheduling a photo day. Built by a real headshot photographer.",
    schema: () => ({
      "@type": "Service", name: "AI headshots for teams and companies", serviceType: "AI headshot generation",
      provider: org, areaServed: "Worldwide", audience: { "@type": "Audience", audienceType: "Businesses and teams" },
      breadcrumb: breadcrumb([["Home", "/"], ["Teams", "/teams"]]),
    }),
  },
];

const trim = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…");

export function faqPageMeta(f: FaqItem): PageMeta {
  return {
    path: `/faq/${f.slug}`,
    title: trim(`${f.q} | ${SITE_NAME}`, 70),
    description: trim(f.a, 155),
    ogType: "article",
    schema: () => ({ ...faqPage([f]), breadcrumb: breadcrumb([["Home", "/"], ["FAQ", "/faq"], [f.q, `/faq/${f.slug}`]]) }),
  };
}

export function allPages(faqs: FaqItem[]): PageMeta[] {
  return [...PAGES, ...faqs.map(faqPageMeta)];
}

export function seoForPath(path: string, faqs: FaqItem[]): PageMeta | null {
  const p = path.replace(/\/+$/, "") || "/";
  return allPages(faqs).find((m) => m.path === p) ?? null;
}

/** Full JSON-LD document for a page (null for the home page, which keeps its own). */
export function schemaFor(meta: PageMeta, faqs: FaqItem[]): string | null {
  if (!meta.schema) return null;
  const page = meta.schema({ faqs });
  if (!page) return null;
  const doc = {
    "@context": "https://schema.org",
    "@graph": [
      ORGANIZATION,
      { "@type": "WebPage", "@id": SITE + meta.path, url: SITE + meta.path, name: meta.title, description: meta.description, isPartOf: { "@type": "WebSite", url: SITE + "/", name: SITE_NAME }, about: org },
      page,
    ],
  };
  return JSON.stringify(doc);
}
