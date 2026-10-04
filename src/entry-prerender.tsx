/**
 * Build-time entry used by scripts/prerender.mjs (2026-10-04).
 * Renders <App /> to an HTML string for a given path so every public page
 * ships with real text in the HTML (not just an empty <div id="root">).
 * The client still takes over normally on load (src/main.tsx).
 */
import { renderToString } from "react-dom/server";
import App, { FAQ_QUESTIONS } from "./App";
import { allPages, schemaFor, ORGANIZATION, type PageMeta } from "./seo";

export { ORGANIZATION };

declare global {
  // eslint-disable-next-line no-var
  var __PRERENDER_PATH__: string | undefined;
}

export function render(path: string): string {
  globalThis.__PRERENDER_PATH__ = path;
  try {
    return renderToString(<App />);
  } finally {
    globalThis.__PRERENDER_PATH__ = undefined;
  }
}

export function routes(): (PageMeta & { schemaJson: string | null })[] {
  return allPages(FAQ_QUESTIONS).map((m) => ({ ...m, schemaJson: schemaFor(m, FAQ_QUESTIONS) }));
}
