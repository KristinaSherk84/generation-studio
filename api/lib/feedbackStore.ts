/**
 * Survey feedback store (2026-09-24) — powers the /feedback page.
 *
 * - feedback:replies  HASH  replyId -> JSON FeedbackReply (one per email
 *                     reply received; webhook retries overwrite the same id)
 * - feedback:manual   HASH  letter -> count. Votes Kristi tallied by hand
 *                     (replies that came in before auto-logging existed).
 *
 * The tally shown on the page = manual counts + one vote per reply that
 * has a letter.
 */
import { redis } from "./surveyEmail.js";

const REPLIES_KEY = "feedback:replies";
const MANUAL_KEY = "feedback:manual";
export const LETTERS = ["A", "B", "C", "D", "E", "F", "G"] as const;

export type FeedbackReply = {
  id: string;
  email: string;
  letter: string | null; // null = couldn't tell; Kristi can set it on the page
  snippet: string; // first ~300 chars of what they wrote
  receivedAt: string;
  unsubscribed: boolean; // they asked to stop and we auto-unsubscribed them
};

export async function saveReply(r: FeedbackReply): Promise<void> {
  await redis.hset(REPLIES_KEY, { [r.id]: JSON.stringify(r) });
}

export async function listReplies(): Promise<FeedbackReply[]> {
  const all = (await redis.hgetall<Record<string, unknown>>(REPLIES_KEY)) ?? {};
  const out: FeedbackReply[] = [];
  for (const v of Object.values(all)) {
    try {
      const r = typeof v === "string" ? JSON.parse(v) : v;
      if (r && typeof r === "object" && "id" in r) out.push(r as FeedbackReply);
    } catch {
      /* skip bad row */
    }
  }
  return out.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

export async function setReplyLetter(id: string, letter: string | null): Promise<boolean> {
  const raw = await redis.hget<unknown>(REPLIES_KEY, id);
  if (!raw) return false;
  const r = (typeof raw === "string" ? JSON.parse(raw) : raw) as FeedbackReply;
  r.letter = letter && (LETTERS as readonly string[]).includes(letter) ? letter : null;
  await saveReply(r);
  return true;
}

export async function getManualCounts(): Promise<Record<string, number>> {
  const raw = (await redis.hgetall<Record<string, unknown>>(MANUAL_KEY)) ?? {};
  const out: Record<string, number> = {};
  for (const L of LETTERS) out[L] = Number(raw[L] ?? 0) || 0;
  return out;
}

export async function adjustManual(letter: string, delta: number): Promise<void> {
  if (!(LETTERS as readonly string[]).includes(letter)) return;
  const cur = await getManualCounts();
  const next = Math.max(0, (cur[letter] ?? 0) + delta);
  await redis.hset(MANUAL_KEY, { [letter]: next });
}

export async function setManualCounts(counts: Record<string, number>): Promise<void> {
  const clean: Record<string, number> = {};
  for (const L of LETTERS) clean[L] = Math.max(0, Math.round(Number(counts[L] ?? 0)) || 0);
  await redis.hset(MANUAL_KEY, clean);
}

/** Pull the answer letter out of a reply. Only looks at the reply's own
 *  top lines (quoted original email below is cut off first). Returns null
 *  when unsure — better to ask Kristi than to guess wrong. */
export function parseLetter(body: string): string | null {
  const top = replyTop(body);
  const lines = top
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 6);
  for (const line of lines) {
    // "B", "b.", "(E)", "E!", "A - they didn't look like me"
    let m = /^\(?([A-Ga-g])\)?\s*(?:[.):,!\-–—]|$)/.exec(line);
    if (m && (line.length <= 3 || /^\(?[A-Ga-g]\)?\s*[.):,!\-–—]/.test(line))) {
      return m[1].toUpperCase();
    }
    // "Answer: C", "option e", "I'd pick A", "letter F"
    m = /\b(?:answer|option|letter|choice|pick|picked|choose|chose|say)\s*[:\-]?\s*\(?([A-Ga-g])\)?(?![a-z])/i.exec(line);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

export function wantsUnsubscribe(body: string): boolean {
  return /\b(unsubscribe|stop emailing|stop sending|remove me|take me off)\b/i.test(
    replyTop(body),
  );
}

/** The part of a reply ABOVE the quoted original email. */
export function replyTop(body: string): string {
  const cutMarkers = [
    /^On .+wrote:\s*$/im,
    /^-{2,}\s*Original Message\s*-{2,}/im,
    /^From:\s.+$/im,
    /^>/m,
    /^Sent from my /im,
  ];
  let end = body.length;
  for (const re of cutMarkers) {
    const m = re.exec(body);
    if (m && m.index < end) end = m.index;
  }
  return body.slice(0, end).trim();
}
