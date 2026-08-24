/**
 * Session store (2026-08-03).
 *
 * Saves a customer's finished 6-headshot grid so the "your headshots are
 * ready" email can link them straight back to their actual shots — on ANY
 * device — instead of an empty landing page. Backed by the same Upstash Redis
 * as the lead/promo stores.
 *
 * Each saved session lives at key `session:{token}` with a 7-day TTL,
 * so temporary preview images don't accumulate. The token is a 24-char
 * unguessable string embedded in the email link (?resume=token).
 *
 * Privacy: the generated images are already public (unguessable) Blob URLs;
 * this only pairs them with an opaque token so the recipient — and only the
 * recipient, via their emailed link — can pull their own grid back.
 */

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL ?? "",
  token: process.env.KV_REST_API_TOKEN ?? "",
});

export type SavedSession = {
  email: string;
  // Public Blob URLs of the 6 generated (watermarked preview) headshots.
  generatedUrls: string[];
  // The customer's reference-photo Blob URLs — needed later by /api/deliver.
  referencePhotoUrls: string[];
  // The StyleSelections the grid/checkout/deliver flow needs (stored opaque).
  selections: unknown;
  hasWideAngle: boolean;
  createdAt: string;
  // The two "Wild Card" bonus previews (Paper/color batches only), persisted so
  // they survive a reload and show on the "your headshots are ready" email link
  // instead of vanishing with the live tab. Added post-save via a patch, since
  // they usually finish generating after the main grid is saved. (2026-08-10)
  wildCards?: { url: string; label: string }[];
};

const TTL_SECONDS = 4 * 24 * 60 * 60; // 4 days (safe cushion; win-back fires ~12h after generation, so the resume link is always alive)
const key = (token: string) => `session:${token}`;

const TOKEN_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function makeToken(): string {
  let s = "";
  for (let i = 0; i < 24; i++) {
    s += TOKEN_ALPHABET[Math.floor(Math.random() * TOKEN_ALPHABET.length)];
  }
  return s;
}

/** Save a session; returns the token to embed in the email link. */
export async function saveSession(
  data: Omit<SavedSession, "createdAt">,
): Promise<string> {
  const token = makeToken();
  const rec: SavedSession = { ...data, createdAt: new Date().toISOString() };
  await redis.set(key(token), rec, { ex: TTL_SECONDS });
  return token;
}

/**
 * Overwrite an existing saved session's grid IN PLACE, keeping the SAME token
 * and refreshing the TTL. Used by /api/save-session so a customer who generates
 * more than one batch keeps ONE stable resume link that always shows their
 * latest shots — instead of accumulating multiple divergent tokens where the
 * wild cards / likeness regen only ever landed on one of them. (2026-08-17)
 */
export async function replaceSession(
  token: string,
  data: Omit<SavedSession, "createdAt">,
): Promise<boolean> {
  if (!token || !/^[A-Za-z0-9]{16,48}$/.test(token)) return false;
  const rec: SavedSession = { ...data, createdAt: new Date().toISOString() };
  await redis.set(key(token), rec, { ex: TTL_SECONDS });
  return true;
}

/** Fetch a saved session by token, or null if missing / expired / malformed. */
export async function getSession(token: string): Promise<SavedSession | null> {
  if (!token || !/^[A-Za-z0-9]{16,48}$/.test(token)) return null;
  try {
    return (await redis.get<SavedSession>(key(token))) ?? null;
  } catch {
    return null;
  }
}

/**
 * Replace ONE slot's image URL in an already-saved session, keeping every
 * other field intact, and refresh the TTL. Used by /api/update-session so a
 * per-slot regeneration done from the "ready to view" resume link STICKS when
 * the link is reopened (e.g. fixing a bad-likeness shot before the customer
 * sees it). Returns false if the session is gone/expired or the input is bad.
 */
export async function updateSessionSlot(
  token: string,
  index: number,
  url: string,
): Promise<boolean> {
  if (!token || !/^[A-Za-z0-9]{16,48}$/.test(token)) return false;
  // Cap raised from 7 to 63 (2026-08-24) so accumulated multi-batch grids can
  // persist a per-slot regen beyond the first 8 shots. The real bound is the
  // `index >= rec.generatedUrls.length` guard below.
  if (!Number.isInteger(index) || index < 0 || index > 63) return false;
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) return false;
  let rec: SavedSession | null;
  try {
    rec = (await redis.get<SavedSession>(key(token))) ?? null;
  } catch {
    return false;
  }
  if (!rec || !Array.isArray(rec.generatedUrls)) return false;
  if (index >= rec.generatedUrls.length) return false;
  rec.generatedUrls[index] = url;
  await redis.set(key(token), rec, { ex: TTL_SECONDS });
  return true;
}

/**
 * Attach the finished Wild Card previews to a saved session so the resume link
 * shows them. Patches the existing record (keeps the grid + refreshes TTL).
 * Returns false if the session is gone. (2026-08-10)
 */
export async function setSessionWildCards(
  token: string,
  wildCards: { url: string; label: string }[],
): Promise<boolean> {
  if (!token || !/^[A-Za-z0-9]{16,48}$/.test(token)) return false;
  let rec: SavedSession | null;
  try {
    rec = (await redis.get<SavedSession>(key(token))) ?? null;
  } catch {
    return false;
  }
  if (!rec) return false;
  const incoming = (Array.isArray(wildCards) ? wildCards : [])
    .filter(
      (w) => w && typeof w.url === "string" && /^https?:\/\//.test(w.url),
    )
    .map((w) => ({
      url: w.url,
      label: typeof w.label === "string" ? w.label.slice(0, 160) : "",
    }));
  // Merge with wild cards already saved from earlier batches (accumulate,
  // 2026-08-24) instead of replacing — a multi-batch customer keeps ALL their
  // bonus shots on the one growing resume grid. Dedupe by URL (newest kept,
  // in first-seen order), capped so the record stays bounded.
  const priorWc = Array.isArray(rec.wildCards) ? rec.wildCards : [];
  const seenWc = new Set<string>();
  const mergedWc: { url: string; label: string }[] = [];
  for (const w of [...priorWc, ...incoming]) {
    if (seenWc.has(w.url)) continue;
    seenWc.add(w.url);
    mergedWc.push(w);
  }
  rec.wildCards = mergedWc.slice(0, 24);
  await redis.set(key(token), rec, { ex: TTL_SECONDS });
  return true;
}
