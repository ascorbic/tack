# 📌 Tack

A self-hosted, open source, git-native whiteboard for collaborative planning.

Tack cards, issues and ideas to a shared board, change tack together, and say _tack_ to the people who got you there.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ascorbic/tack)

- **Live GitHub cards**: paste any issue or pull request link and it stays live via webhooks; lists and other widgets keep searches live
- **Freeform canvas**: move, group and sort stickies, issues and PRs around freely without affecting GitHub
- **Staged pushes**: create issues from stickies, label, link, and write decisions back, reviewed and pushed as one batch
- **Async welcome**: "since you were here", history replay, open voting windows
- **Decisions**: recorded on the board and written back as ADR PRs or Discussion posts
- **GitHub identity**: log in with GitHub; repo permissions decide what you can do

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

Tack runs as one Worker on your Cloudflare account, with a GitHub App you own. The docs site (`site/`, under Self-hosting) has the full guide; in short:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ascorbic/tack)

1. **Deploy** with the button above. It copies Tack into a new repository of yours and deploys it with Workers Builds. Keep the Worker's name, `tack`.
2. **Give it `TACK_SECRET`** when the button asks: a long random value (`openssl rand -base64 32`). It signs session cookies and encrypts the GitHub App's credentials, so keep a copy somewhere safe and never change it.
3. **Visit `/setup`** on your instance straight away. Its checklist walks you through the rest: choose **Create GitHub App**, and GitHub fills in the permissions, events, webhook and callback URLs from a manifest; you confirm, and you're sent back signed in as the instance's first admin.
4. **Install the app** on the repositories you plan with (`/setup` links to it). Public repos work without it; installing makes cards live and private repos visible. `/setup` checks webhooks arrive, and lists every repository the app's on and any on boards it isn't.
5. **Decide who can use it**: on `/setup`, admins add other admins, allowed GitHub users and allowed organisations. Everyone else who signs in sees an "invite-only" page.

Or deploy from your machine: fork and clone, `pnpm install`, `pnpm exec cf auth login`, then give the first deploy its secret (a new Worker needs it from the start):

```sh
echo "TACK_SECRET=$(openssl rand -base64 32)" > .env.secrets   # keep a copy of it somewhere safe
pnpm run deploy --secrets-file .env.secrets
rm .env.secrets
```

Later deploys are just `pnpm run deploy`, or connect the Worker to Workers Builds. Upgrading is pulling from `ascorbic/tack` and deploying: boards and storage migrate themselves when they next load.

Previews (and any instance without `TACK_SECRET`) have no sign-in: boards work anonymously.

### Local development

Copy `.dev.vars.example` to `.dev.vars` (gitignored) and fill it in:

```sh
TACK_SECRET=<any random string>
TACK_DEV_AUTH=1   # fake sign-in at /auth/dev?login=octocat&admin=1, local only
```

A GitHub App made from `/setup` on localhost works for sign-in and installation tokens, but GitHub can't deliver webhooks to it; use `scripts/send-webhook.ts`.

## Configuration

- [cloudflare.config.ts](cloudflare.config.ts) — the Worker itself: name, entrypoint, compatibility, bindings. `Env` types are inferred from the bindings you declare here and generated into `.cloudflare/types/` by `cf workers types` (run on install, or with `pnpm types`).
- [compatibility.ts](compatibility.ts) — compatibility date and flags, shared with the test runtime.
- [wrangler.jsonc](wrangler.jsonc) — generated from `cloudflare.config.ts` (`pnpm run wrangler-config`) for the Deploy to Cloudflare button, which only reads Wrangler configuration. Nothing else uses it; don't edit it by hand.
- [vite.config.ts](vite.config.ts) — everything else: Vite, Vitest, oxlint, and oxfmt in one file.
