# Tack

A GitHub-native whiteboard for open source planning.

Tack cards, issues and ideas to a shared board, change tack together, and say _tack_ (Swedish for "thanks") to the people who got you there.

- **Live GitHub cards**: paste any issue, PR, discussion, release, milestone, code permalink or search, and it stays live via webhooks
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
pnpm test     # run tests inside the Workers runtime
pnpm check    # format, lint, and type check
pnpm fix      # same, but auto-fix
pnpm build    # production build
pnpm deploy   # build and deploy via cf
```

## Configuration

- [cloudflare.config.ts](cloudflare.config.ts) — the Worker itself: name, entrypoint, compatibility, bindings. `Env` types are inferred from the bindings you declare here and generated into `.cloudflare/types/` by `cf workers types` (run on install, or with `pnpm types`).
- [compatibility.ts](compatibility.ts) — compatibility date and flags, shared with the test runtime.
- [vite.config.ts](vite.config.ts) — everything else: Vite, Vitest, oxlint, and oxfmt in one file.
