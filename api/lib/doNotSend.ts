/**
 * DO NOT SEND — email suppression list.
 *
 * Any automated or bulk email (especially the planned Google-review-request
 * campaign) MUST filter these addresses out. Add anyone who is unhappy, asked
 * not to be contacted, or requested that their data be deleted.
 *
 * This list is ALSO the retained record of those customers — so we can prove we
 * are honoring "do not contact me" even after their images have been deleted.
 *
 * Usage in a future email job:
 *   import { isSuppressed } from "./lib/doNotSend.js";
 *   if (isSuppressed(customerEmail)) continue; // skip this person
 */

export type SuppressedContact = {
  email: string;
  name?: string;
  reason: string;
  addedAt: string; // YYYY-MM-DD
};

export const DO_NOT_SEND: SuppressedContact[] = [
  {
    email: "livenow4u@proton.me",
    name: "Sean Bull",
    reason:
      "Unhappy customer; asked that his data be deleted and not to be contacted. His images were removed from Blob on 2026-07-13. Stripe record intentionally retained.",
    addedAt: "2026-07-13",
  },
];

const SUPPRESSED = new Set(DO_NOT_SEND.map((c) => c.email.trim().toLowerCase()));

/** Returns true if this email must NOT receive any automated/bulk email. */
export function isSuppressed(email: string): boolean {
  return SUPPRESSED.has((email || "").trim().toLowerCase());
}
