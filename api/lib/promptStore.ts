/**
 * Editable-prompt store (2026-08-10).
 *
 * Lets Kristi (and Claude) override any prompt segment used by /api/generate
 * from the /api/admin/prompts editor page WITHOUT a code deploy. Backed by the
 * same Upstash Redis as the lead/session/promo stores.
 *
 * Two keys:
 *   prompt:catalog   -> { defaults:{key:text}, meta:[{key,label,group,fires}], updatedAt }
 *                       Seeded by /api/generate on cold start from the code
 *                       constants, so it always reflects the CURRENT code
 *                       defaults. The editor reads this to know the segment
 *                       list + each default text.
 *   prompt:overrides -> { key: text }  the live edits. /api/generate merges
 *                       these over the code defaults (override wins only when
 *                       it's a non-empty string).
 *
 * FAIL-OPEN everywhere: any Redis error returns empty/no-op so image
 * generation can never break because of this layer — /api/generate falls back
 * to its hardcoded constants.
 */

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL ?? "",
  token: process.env.KV_REST_API_TOKEN ?? "",
});

const OVERRIDES_KEY = "prompt:overrides";
const CATALOG_KEY = "prompt:catalog";

export type PromptSegmentMeta = {
  key: string;
  label: string;
  group: string;
  // Recipe conditions under which this segment actually fires. Empty object =
  // always fires. Any key present must match the selected recipe value for the
  // segment to be "active" (used by the editor to grey out non-firing blocks).
  fires: {
    style?: string;
    background?: string;
    lighting?: string;
    attire?: string;
    skin?: string;
  };
  note?: string;
};

export type PromptCatalog = {
  defaults: Record<string, string>;
  meta: PromptSegmentMeta[];
  updatedAt: string;
};

/** Live edits. Fail-open to {}. */
export async function getPromptOverrides(): Promise<Record<string, string>> {
  try {
    const v = await redis.get<Record<string, string>>(OVERRIDES_KEY);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** Set (or replace) one segment's override text. Empty/blank clears it. */
export async function setPromptOverride(
  key: string,
  text: string,
): Promise<void> {
  const current = await getPromptOverrides();
  if (typeof text === "string" && text.trim().length > 0) {
    current[key] = text;
  } else {
    delete current[key];
  }
  await redis.set(OVERRIDES_KEY, current);
}

/** Remove one segment's override (revert to code default). */
export async function resetPromptOverride(key: string): Promise<void> {
  const current = await getPromptOverrides();
  if (key in current) {
    delete current[key];
    await redis.set(OVERRIDES_KEY, current);
  }
}

/** Wipe ALL overrides (revert everything to code defaults). */
export async function resetAllPromptOverrides(): Promise<void> {
  await redis.set(OVERRIDES_KEY, {});
}

/**
 * Seed/refresh the catalog (current code defaults + segment metadata) so the
 * editor can render even though it never imports the heavy generate.ts module.
 * Idempotent overwrite — called by /api/generate on cold start. Best-effort.
 */
export async function seedPromptCatalog(
  defaults: Record<string, string>,
  meta: PromptSegmentMeta[],
  nowIso: string,
): Promise<void> {
  try {
    await redis.set(CATALOG_KEY, { defaults, meta, updatedAt: nowIso });
  } catch {
    /* best-effort */
  }
}

export async function getPromptCatalog(): Promise<PromptCatalog | null> {
  try {
    return (await redis.get<PromptCatalog>(CATALOG_KEY)) ?? null;
  } catch {
    return null;
  }
}
