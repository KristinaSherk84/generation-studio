# Roadmap

Deferred / approved-but-not-yet-built features for Generation Studio V2.

---

## AI reference-photo detection — soft warning + upsell

**Status:** approved by Kristi 2026-09-13, not built yet
**Estimated build:** ~1 hour
**Priority:** medium

### Why
Customers uploading AI-generated selfies as reference photos poison the identity anchor — Gemini learns from what it sees, and if the "you" it's studying is itself synthetic, the output won't look like the real person. This tanks likeness quality and drives support tickets / refund asks.

### The UX (soft friction, not a hard block)
When ANY of the 5 uploaded reference photos is flagged as AI-generated, show a modal before the customer hits "Generate":

> **We noticed some of your reference photos look AI-generated.**
> The AI works from what it sees — if the "you" it's studying is itself generated, the output won't look like the real you. Two options:
>
> - **Swap in real photos** (free — best result)
> - **Proceed anyway** with $3.99 unlock (we'll do our best)

Two CTAs: "Swap in real photos" (goes back to upload step) or "Pay $3.99 to proceed anyway" (routes through the existing unlock flow).

If the customer has already paid the $3.99 unlock, skip the modal — they've already committed.

### Why soft-warning, not a hard block
1. Doesn't insult the legitimate case (rare but exists — e.g., someone edited a real photo)
2. Converts skeptics into payers — the $3.99 becomes a "you're getting worse results, we're covering our costs" fee
3. Casual users just swap in real photos instead of bouncing entirely

### Detection stack (recommended combo)
Fire the modal if ANY of the 5 uploaded photos trips ANY of these signals:

1. **C2PA manifest read** — free, high-precision. Most major AI tools embed a signed "Content Credentials" manifest (ChatGPT/DALL·E, Adobe Firefly, Google Imagen/Gemini, Microsoft Designer). Library: `@contentauth/c2pa-node`. Near-zero false-positive rate.

2. **EXIF software-field check** — free, uses `exifr` (already in `package.json`). Real phone photos have `Make: Apple`, `Model: iPhone…`, GPS, focal length, ISO. AI images either have no EXIF or software fields like `Software: DALL·E 3` / `Software: Adobe Firefly`.

3. **Filename heuristics** — filenames containing `dalle`, `midjourney`, `chatgpt`, `firefly`, `imagen` are dead giveaways for lazy abusers.

Together these catch >80% of cases with zero recurring cost and near-zero false positives.

### Escalation options (only if abuse leaks through)
- **SightEngine** or similar paid AI-detection API (~$0.10/image, pixel-level analysis, catches even screenshotted/re-exported AI images)
- **SynthID** (Google-only proprietary detection API, only catches Google-generated content)

Skip these unless data shows the free stack isn't enough.

### Where to build it
Client-side detection at Step 3 upload (before generation fires). Each uploaded file runs through the three checks; results aggregated; modal shows before the customer hits "Generate my headshots."

### Non-goals
- NOT a hard block. Never refuse to serve a paying customer.
- NOT face-verification (that's the existing face-api.js check for "no face detected / multiple faces detected").

---

## Burned-in watermark previews (stop clean-image theft)

**Status:** approved as a roadmap item by Kristi 2026-09-30, not built yet
**Estimated build:** medium (touches generate, regen, versions, retouch, deliver)
**Priority:** high — anyone can currently get the full clean 2K file for free

### Why
The preview watermark ("INVISIBLE WATERMARKS APPLIED TO PROTECT ARTIST") is an HTML text overlay, not part of the image. The `<img src>` behind it is the full-resolution, clean 2K Blob JPEG. Right-click and long-press are blocked, but anyone can open DevTools, copy the image URL, open it in a new tab, and download the unwatermarked headshot — no screenshot or AI watermark removal needed. Suspected abusers (e.g. the jamezgustov48 / yasinfelix252 / unchained6566 device, 45 free generations, $0 purchases) may be doing exactly this.

### The fix
At generation time, save TWO copies:
1. **Clean original** — uploaded to Blob under an unguessable path; its URL is NEVER sent to the browser.
2. **Preview** — downscaled (~1024px long edge) with the watermark burned into the pixels (sharp + SVG text composite, diagonal repeat, same look as today's overlay). This is the only URL the client ever receives.

Store a server-side map `preview URL → original URL` (Redis, same TTL as the originals).

### Everywhere that must map preview → original (server side)
- `api/deliver.ts` — paid delivery must fetch/retouch the ORIGINAL.
- `api/retouch.ts` — retouch passes run on the original.
- `api/generate.ts` — Generate Versions `similarToUrl` should be mapped to the original before Gemini sees it (a watermarked source would leak watermark text into the versions).
- Batch store / recover-batch / save-session / update-session / RTV links keep storing PREVIEW URLs only.
- Admin tools (find-session, weekly-grads) should resolve originals for Kristi's own use.

### Must-not-break checks
- Every paid delivery ships the clean original at full 2K (test Basic + Deluxe tiers).
- Old sessions (pre-change) have no map entry → fall back to treating the stored URL as the original.
- Clarity recordings stay small (previews are smaller, so this helps).

### Caveat
A burned-in watermark can still be AI-erased, but that takes effort and yields a smaller, degraded image — versus today's 10-second clean 2K download. Pairs with the forensic-watermark idea in memory (project_watermark_defense).
