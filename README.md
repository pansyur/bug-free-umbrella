# Fae Feeds

A personal RSS reader that can also turn plain (non-RSS) web pages into a
subscribable feed.

## Setup

```bash
bun install
bun run dev
```

Env vars (see `.env`): `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, and the `VITE_`-prefixed client-side copies of
the first two.

Run the migration in `supabase/migrations/` against your Supabase project
before starting the app (via the Supabase CLI or SQL editor) — it adds the
soft-delete and item-selector columns used by this version.

### Google sign-in

The "Continue with Google" button now uses Supabase's own OAuth
(`supabase.auth.signInWithOAuth`) instead of Lovable's managed auth. Enable
the Google provider under Authentication → Providers in your Supabase
project and set its redirect URL, or the button will show an error.

## How the reader works

- **Newest first**: items are sorted by the article's own publish date
  (falling back to when it was fetched) across both the per-feed list and
  "All feeds".
- **Adding a feed**: pasting a URL checks whether it's a real RSS/Atom feed.
  If it is, it's added immediately. If not, the page is scraped for
  article-like links and you get a checklist to confirm which ones are
  actually articles before anything is saved — nav/footer/category noise
  can be unchecked. The common URL path of what you keep is remembered
  (`feeds.item_path_prefix`) and used to filter future refreshes of that
  feed automatically.
- **Deleting items**: "Delete" (per-item, multi-select, or the "Delete
  read" button) soft-deletes items — they're hidden immediately and the
  underlying row stays in the database so the feed's unique
  `(feed_id, link)` constraint stops it from being re-inserted as "new" on
  the next refresh/scrape.
- **Unread only**: the filter checkbox is remembered in `localStorage`, so
  it stays checked across reloads until you uncheck it.

## Deploying to Cloudflare Pages

```bash
bun run build
wrangler pages deploy
# or, for local preview of the built output:
bun run cf:preview
```

`wrangler.toml` has a starting config — after your first build, confirm
`pages_build_output_dir` matches wherever Nitro actually wrote the output
(check the `dist/` folder after `bun run build`) and adjust if needed.
Server-side secrets (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, etc.) are
set via `wrangler pages secret put <NAME>` or the Pages dashboard;
`VITE_`-prefixed vars are build-time and go in the Pages project's build
environment variables.

> This repo previously depended on `@lovable.dev/vite-tanstack-config` and
> `@lovable.dev/cloud-auth-js`, both now removed. `vite.config.ts` was
> rewritten by hand to reproduce the same plugin setup — since it couldn't
> be installed/built in the environment that authored this change, give the
> build a run locally and check it against TanStack Start's current
> Cloudflare deployment docs if anything's off.
