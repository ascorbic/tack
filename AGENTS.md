This file provides guidance to agentic coding tools when working with code in this repository.

## Design principle: delight

The UI must be delightful, with FigJam as the bar: considered typography, micro-interactions, and lots of small details (how a card lifts when picked up, how a live update lands, how a push confirms). Treat polish as a feature, not a follow-up. Respect `prefers-reduced-motion`, and keep interactions at 60fps.

## Repository Structure

Tack: a GitHub-native collaborative whiteboard for open source planning, built as a Cloudflare Worker with Vite+ and the Cloudflare Vite plugin.

- `src/index.ts` — the Worker entrypoint: webhook route, partyserver routing, DO exports
- `src/server/board.ts` — `Board` Durable Object (one per board): Yjs document via y-partyserver, live card relay via custom messages
- `src/server/repo.ts` — `Repo` Durable Object (one per repository): card cache, board subscriptions, webhook log and fan-out
- `src/server/forges/` — forge adapters (GitHub, plus a synthetic `fake.tack` forge for tests and stress boards): fetching items, verifying and normalising webhooks, capabilities. Everything outside this folder is forge-neutral
- `src/server/webhooks.ts` — `POST /webhooks/:forge` routing
- `src/shared/` — forge-neutral item keys (`{host}/{repo}{#|!}{n}`, see `refs.ts`), card types and the Yjs shape schema, used by both server and client
- `src/client/` — React + React Flow canvas (own `tsconfig.json` with DOM types); `index.html` at the repo root is its entry
- `src/client/play/` — dev-only UI workbench, left out of production builds: `/play` runs a board entirely in the browser with simulated people (own Y.Doc + Awareness each) and simulated forge events, plus slow-motion and reduced-motion toggles; `/play/cards` is a gallery of every card state. Use these to iterate on interaction details
- `src/client/styles.css` — design tokens, including motion: every duration is scaled by `--motion`, so slow motion and reduced motion apply everywhere. Use the spring easings (`--ease-spring`, `--ease-settle`) rather than ad hoc curves
- `scripts/send-webhook.ts` — send a signed webhook to a local dev server (reads `GITHUB_WEBHOOK_SECRET` from `.dev.vars`)
- `docs/spike.md` — spike findings: performance, Yjs growth, design decisions
- `test/` — Vitest tests in Node. Integration tests run the built Worker in Miniflare (`test/harness.ts`); `test/global-setup.ts` builds it first
- `cloudflare.config.ts` — Worker configuration, via `defineConfig` from `cf/config` (there is no wrangler.jsonc, and no Wrangler dependency at all)
- `compatibility.ts` — compatibility date/flags, shared between the Worker config and the test runtime
- `vite.config.ts` — unified Vite+ config: Vite plugins, Vitest, oxlint, and oxfmt
- `.cloudflare/types/` — generated `Env` and runtime types; not committed. `cf workers types` regenerates them (runs on `postinstall`, or `pnpm types`)

## Commands

- `pnpm dev` — start the dev server (`vp dev`). `cf dev` and `cf build` expect a `vite` binary, which Vite+ doesn't provide, so use `vp`
- `pnpm test` — run tests in the Workers runtime
- `pnpm check` — format check, lint, and type check in one pass (`vp check`)
- `pnpm fix` — apply formatting and safe lint fixes
- `pnpm build` — production build
- `pnpm deploy` — `vp build` then `cf deploy --prebuilt` (requires `cf auth login` or `CLOUDFLARE_API_TOKEN`). Production deploys normally happen via Workers Builds on push to main, not from CI or local machines

## Configuration Architecture

- **`cloudflare.config.ts` is the source of truth for the Worker**: name, entrypoint, compatibility, bindings, observability. It uses `defineConfig({ worker: { ... } })` from `cf/config`, which both the `cf` CLI and the Vite plugin read.
- The entrypoint uses the `with { type: "cf-worker" }` import attribute. This is what makes `Env` and `exports` inference work — keep that form when changing the entrypoint.
- **Bindings**: declare them in `cloudflare.config.ts` (e.g. `env: { MY_KV: bindings.kv() }` with `bindings` from the same import). The `Env` type is inferred from them — run `pnpm types` after config changes. Durable Object bindings to this same Worker are untyped; `src/server/namespaces.ts` restores the class types. Integration tests declare the same bindings for Miniflare in `test/harness.ts`, so keep the two in step.
- **`compatibility.ts`** exists so the test runtime (`test/harness.ts`) always matches the deployed runtime. Extra exports are not allowed in `cloudflare.config.ts` (its exports are schema-validated), which is why this is a separate file.
- **Version pins that must move together**: the `vite@*` and `vitest@*` overrides in `pnpm-workspace.yaml` pin Vite to `@voidzero-dev/vite-plus-core` at the installed `vite-plus` version, and Vitest to the version `vp toolchain vitest` reports. Update them whenever `vite-plus` changes. There are no direct `vite` or `vitest` dependencies: import test APIs from `vite-plus/test`.

## Testing

- Unit tests run in Node. Integration tests use `startWorker()` from `test/harness.ts`: `mf.dispatchFetch()` for HTTP, and `repoStub()` (or `mf.getDurableObjectNamespace()`) for Durable Object RPC.

## Development Workflow

- Uses **pnpm**, wrapped by **Vite+** (`vp`). Format and lint are oxfmt/oxlint via `vp check` — there is no prettier or eslint. Type checking runs inside `vp check` (tsgolint with `typeAware`/`typeCheck` enabled).
- Formatting uses tabs (configured in `vite.config.ts` under `fmt`).
- CI (test.yml) runs `vp check`, `vp test`, and `vp build` via the `voidzero-dev/setup-vp` action.
