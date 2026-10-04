# GenerAItion Headshots — Claude Code guide

Live site: https://generationheadshots.com · Repo: KristinaSherk84/generation-studio · Vercel project `generation-studio` (prj_vr5MAY8KsRlFkmCH1FMZOJXwJAfx, team team_eSanI7y6IIrPLUWuM1vY9BZv).

AI headshot generator run by Kristi Sherk, a DC headshot photographer. Built Apr–Oct 2026 in Claude Cowork ("Master App Build" task); moved to Claude Code on 2026-10-04. The long-form history lives in Claude Code memory for this folder and in `../01 App Build Handoffs/`.

## Working with Kristi
- She does not code and has dyslexia. Plain English, short sentences, no jargon. When asking her to decide: one-sentence question, one-line bullet options, no filler.
- Explain what you are about to do before doing it. Ask before: deploying, anything involving money, payment code, API keys, deleting data, or changing pricing.
- Small, isolated changes and small commits. If something breaks, say what broke and what you want to try.
- She wants to learn a little each time, not read architecture essays.

## How code ships
- Deploy = `git push` to `main`. Vercel auto-builds. There is no staging; every push is production.
- Claude Code can commit and push directly from this Mac (osxkeychain creds work). Still ask Kristi before pushing.
- `git add` only the files you changed. Never sweep in `api/qwen-*.ts`, `api/lib/qwenTest.ts`, or `qwen-worker/` (untracked private Gemini-vs-Qwen experiment, deliberately unpushed).
- Run `npm run build` before committing. It type-checks `src/` only.
- After a push, verify on Vercel (deployments, runtime errors) and on the live URL.

## Engineering rules learned the hard way
- `api/` is NOT type-checked by the build. A syntax or type error in `api/*.ts` deploys silently and breaks that endpoint. Parse-check every API edit. For a full check use a temp tsconfig that extends `tsconfig.app.json` with `types:["node"]`, `include:["api"]` (pre-existing errors in `detectLandmarks.ts` and `test-email.ts` are known and harmless).
- Vercel functions use the classic `(req: VercelRequest, res: VercelResponse)` signature. Do not use Fetch-style `(request: Request) => Response` handlers (they hang to timeout) and do not use the Edge runtime (`@vercel/blob`, `sharp` need Node). Do not test uploads with `vercel dev`; test on a deployed URL.
- `api/generate.ts` has plain-string runtime whitelists for style / attire / lighting / background. Adding a value to a TypeScript union is not enough; add it to the whitelist too, and to `RECIPE_DIMS` in `api/admin/prompts.ts`. `api/deliver.ts` no longer re-validates these.
- Heavy functions (`generate`, `face-descriptor`, `check-outfit`, `crop-reference`) have memory/duration/includeFiles set in `vercel.json`. Keep that in sync if you add face-api usage elsewhere.
- Cron jobs live in `vercel.json` (`quota-report`, `followup-emails`, `survey-auto`). Admin endpoints are gated by `ADMIN_PASSWORD` (`?pw=`); cron by `CRON_SECRET`.

## Prompt editor rule (Kristi's standing directive)
Every Gemini-facing prompt string must be editable at `/api/admin/prompts` without a deploy:
1. Define it as a `*_DEFAULT` constant in `api/generate.ts`.
2. Resolve it via `seg("<key>", DEFAULT)` (or `gseg(...)` for gendered pairs), never inline.
3. Register it in `PROMPT_DEFAULTS` and `PROMPT_SEGMENTS` (`{ key, label, group, fires, note }`).
Live overrides are stored in Upstash Redis (`prompt:overrides`) and WIN over code defaults. A section marked "Edited" in the editor is Kristi's text; changing the code default does not change what Gemini sees. Say so when relevant.

## Product decisions not to undo
- Initial batch is always realistic skin; retouch (`api/retouch.ts`, tiers realistic / polished / glam) happens after the customer picks shots. Do not reintroduce a skin picker before generation. Vestigial `BLOCK_SKIN_*` / `skin` param in `generate.ts` stay as they are.
- Identity auto-check (`IDENTITY_CHECK_ENABLED`) skips slot 0 on purpose. The "face-fix redo pass on Pro" and the "image 1 is the primary reference" prompt paragraph were both tried and reverted on 2026-10-02 (pasted-face / copy-of-a-copy look). Do not re-add without a test batch Kristi approves.
- Prompts are positive "what it IS" language. Avoid NOT-lists; negations summon the negated thing.
- Pricing as of 2026-10-04: first 6 headshots free when `ENTRY_FEE_ENABLED` is not `"false"` (flag in `api/config.ts`; the paid-entry flow still exists), $3.99 unlock for more redos, $14.99 Basic (realistic) and $17.99 Deluxe (3 retouch versions) per photo (`api/create-photo-checkout-session.ts`). Change nothing here without asking.
- Previews are protected only by a text overlay; the clean 2K URL reaches the browser. Burned-in watermark previews are the top roadmap item (see `ROADMAP.md`).

## Where things are
- `src/App.tsx` (~25k lines): every screen as a `const XScreen = (...)` component; `export default function App()` at the bottom holds the state machine.
- `api/`: generation, Stripe checkout (`create-checkout-session` = entry/unlock, `create-photo-checkout-session` = per-photo), `deliver.ts` (Resend email + retouch), session stores in `api/lib/*Store.ts` (Upstash Redis), skin pipeline in `api/lib/skin/`, admin tools in `api/admin/`.
- `ROADMAP.md`: approved-but-unbuilt features with specs.
- `../_scripts/`: before/after pair graphics and weekly-grads scripts (Python).
- `scripts/delete_customer_files.mjs`: customer data deletion (Kristi runs it; Claude never deletes).

## Design
Inter font, warm greys (`#F5F5F3` page, `#2C2C2A` text, `#888780` mid, `#E8E8E6` border), 8px radius, plus the later forest-green primary CTA and gold cart badge. Match what is already in `App.tsx`; do not introduce new colors.

## Handy links
- Generation Headshots Google reviews: https://share.google/RuAya0t5gpBBcdAY9 (18 reviews as of 2026-10-04; the 400+ figure is the founder studio listing)
- Prompt editor: https://generationheadshots.com/api/admin/prompts?pw=… · Leads/feedback: /feedback
