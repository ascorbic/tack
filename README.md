# Tack

A GitHub-native whiteboard for open source planning.

Tack cards, issues and ideas to a shared board, change tack together, and say _tack_ (Swedish for "thanks") to the people who got you there.

- **Live GitHub cards**: paste any issue or pull request link and it stays live via webhooks; lists and other widgets keep searches live
- **Freeform canvas**: layout never changes GitHub; explicit actions do
- **Staged pushes**: create issues from stickies, label, link, and write decisions back, reviewed and pushed as one batch
- **Async first**: "since you were here", history replay, open voting windows
- **Decisions**: recorded on the board and written back as ADR PRs or Discussion posts
- **GitHub identity**: log in with GitHub; repo permissions decide what you can do

> Status: early prototype.

## Stack

- [Vite+](https://viteplus.dev/) (`vp`) — dev server, build, test, lint, format, and type checking in one toolchain
- [`cf`](https://www.npmjs.com/package/cf) — the Cloudflare CLI (technical preview), for deploys and everything Cloudflare
- [`@cloudflare/vite-plugin`](https://developers.cloudflare.com/workers/vite-plugin/) 2.0, with `cloudflare.config.ts` from `cf/config`
- Vitest in Node, with integration tests running the built Worker in [Miniflare](https://www.npmjs.com/package/miniflare). No Wrangler
- TypeScript, pnpm
- The canvas is built on [React Flow](https://reactflow.dev) (MIT), and sync on [Yjs](https://yjs.dev) with [y-partyserver](https://github.com/cloudflare/partykit)

## Commands

```sh
pnpm dev      # dev server (with the Cloudflare local explorer at /cdn-cgi/local/explorer)
pnpm test     # unit and integration tests (the built Worker in Miniflare)
pnpm e2e      # Playwright smoke tests over /play (starts its own dev server)
pnpm check    # format, lint, and type check
pnpm fix      # same, but auto-fix
pnpm build    # production build
pnpm run deploy   # build and deploy via cf (`pnpm deploy` is a different, built-in pnpm command)
pnpm --filter site dev     # the docs site (site/, Astro Starlight)
pnpm --filter site build   # build the docs, failing on broken links
```

## Self-hosting

Tack runs as one Worker on your Cloudflare account, with a GitHub App you own. The docs site (`site/`) has the full guide; in short:

1. **Deploy** the Worker: `pnpm run deploy` (or connect the repo to Workers Builds).
2. **Set `TACK_SECRET`**, a long random value (e.g. `openssl rand -base64 32`). It signs session cookies and encrypts the GitHub App's credentials, so keep it safe and don't change it. Set it with `cf workers secrets update TACK_SECRET`, or in the dashboard under Workers → tack → Settings → Variables and secrets.
3. **Visit `/setup`** on your instance and click **Create GitHub App**. GitHub fills in the permissions, events, webhook and callback URLs from a manifest; you confirm, and you're sent back to sign in. Whoever completes setup becomes the instance's first admin.
4. **Install the app** on the repositories you plan with (`/setup` links to it). Public repos work without it; installing makes cards live and private repos visible.
5. **Decide who can use it**: on `/setup`, admins add other admins, allowed GitHub users and allowed organisations. Everyone else who signs in sees an "invite-only" page.

Previews (and any instance without `TACK_SECRET`) have no sign-in: boards work anonymously.

### Local development

Create `.dev.vars` (gitignored) with:

```sh
TACK_SECRET=<any random string>
TACK_DEV_AUTH=1   # fake sign-in at /auth/dev?login=octocat&admin=1, local only
```

A GitHub App made from `/setup` on localhost works for sign-in and installation tokens, but GitHub can't deliver webhooks to it; use `scripts/send-webhook.ts`.

## Configuration

- [cloudflare.config.ts](cloudflare.config.ts) — the Worker itself: name, entrypoint, compatibility, bindings. `Env` types are inferred from the bindings you declare here and generated into `.cloudflare/types/` by `cf workers types` (run on install, or with `pnpm types`).
- [compatibility.ts](compatibility.ts) — compatibility date and flags, shared with the test runtime.
- [vite.config.ts](vite.config.ts) — everything else: Vite, Vitest, oxlint, and oxfmt in one file.
