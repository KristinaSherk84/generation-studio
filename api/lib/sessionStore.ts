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

/** Fetch a saved session by token, or null if missing / expired / malformed. */
export async function getSession(token: string): Promise<SavedSession | null> {
  if (!token || !/^[A-Za-z0-9]{16,48}$/.test(token)) return null;
  try {
    return (await redis.get<SavedSession>(key(token))) ?? null;
  } catch {
    return null;
  }
}
