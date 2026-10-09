This file provides guidance to agentic coding tools when working with code in this repository.

## Repository Structure

Tack: a GitHub-native collaborative whiteboard for open source planning, built as a Cloudflare Worker with Vite+ and the Cloudflare Vite plugin.

- `src/index.ts` — the Worker entrypoint: webhook route, partyserver routing, DO exports
- `src/server/board.ts` — `Board` Durable Object (one per board): Yjs document via y-partyserver, live card relay via custom messages
- `src/server/repo.ts` — `Repo` Durable Object (one per repository): card cache, board subscriptions, webhook log and fan-out
- `src/server/webhooks.ts` — GitHub webhook signature verification and routing
- `src/shared/` — card types/normalisation and the Yjs shape schema, used by both server and client
- `src/client/` — React + React Flow canvas (own `tsconfig.json` with DOM types); `index.html` at the repo root is its entry
- `scripts/send-webhook.ts` — send a signed webhook to a local dev server (reads `WEBHOOK_SECRET` from `.dev.vars`)
- `docs/spike.md` — spike findings: performance, Yjs growth, design decisions
- `test/` — Vitest tests, run inside workerd via `@cloudflare/vitest-plugin`
- `cloudflare.config.ts` — Worker configuration (the experimental `cf`-CLI-native format; there is no wrangler.jsonc)
- `compatibility.ts` — compatibility date/flags, shared between the Worker config and the test runtime
- `vite.config.ts` — unified Vite+ config: Vite plugins, Vitest, oxlint, and oxfmt
- `worker-configuration.d.ts` — generated types; committed. Regenerated automatically while `pnpm dev` runs

## Commands

- `pnpm dev` — start the dev server (`vp dev`; `cf dev` also works and delegates to it)
- `pnpm test` — run tests in the Workers runtime
- `pnpm check` — format check, lint, and type check in one pass (`vp check`)
- `pnpm fix` — apply formatting and safe lint fixes
- `pnpm build` — production build
- `pnpm deploy` — build and deploy (`cf deploy`; requires `cf auth login` or `CLOUDFLARE_API_TOKEN`). Production deploys normally happen via Workers Builds on push to main, not from CI or local machines

## Configuration Architecture

- **`cloudflare.config.ts` is the source of truth for the Worker**: name, entrypoint, compatibility, bindings, observability. It uses the experimental new config format (`experimental.newConfig` in the Vite plugin), which both the `cf` CLI and plain `vp`/Vite commands read. `defineWorker` is imported from `@cloudflare/vite-plugin/experimental-config` — do not import it from `@cloudflare/config` directly, or the generated types stop resolving (the two packages carry different unique symbols).
- The entrypoint uses the `with { type: "cf-worker" }` import attribute. This is what makes `Env` and `exports` inference work — keep that form when changing the entrypoint.
- **Bindings**: declare them in `cloudflare.config.ts` (e.g. `env: { MY_KV: bindings.kv() }` with `bindings` from the same import). The `Env` type in `worker-configuration.d.ts` is inferred from them — run `pnpm dev` briefly after config changes to regenerate it, and commit the result.
- **`compatibility.ts`** exists so the Vitest runtime (`cloudflareTest` in vite.config.ts) always matches the deployed runtime. Extra exports are not allowed in `cloudflare.config.ts` (its exports are schema-validated), which is why this is a separate file.
- **Version pins that must move together**: the `vitest` devDependency and the `vitest` override in `pnpm-workspace.yaml` are pinned to the version bundled by vite-plus (check with `pnpm exec vp toolchain`). `vite` is aliased to `@voidzero-dev/vite-plus-core` (as a devDependency and an override) so every package resolves the same Vite — do not add a real `vite` dependency.

## Testing

- Tests run inside workerd. Import test APIs from `cloudflare:workers` (`env`, `exports`) — `exports.default.fetch()` replaces the deprecated `SELF`, and `env` from `cloudflare:test` is also deprecated.
- `test/env.d.ts` wires the `ProvidedEnv` type to the generated `Env`.
- For integration tests against the production build, use `createTestHarness()` from `wrangler` pointed at the built output (`dist/<worker_name>/wrangler.json` after `pnpm build`).

## Development Workflow

- Uses **pnpm**, wrapped by **Vite+** (`vp`). Format and lint are oxfmt/oxlint via `vp check` — there is no prettier or eslint. Type checking runs inside `vp check` (tsgolint with `typeAware`/`typeCheck` enabled).
- Formatting uses tabs (configured in `vite.config.ts` under `fmt`).
- CI (test.yml) runs `vp check`, `vp test`, and `vp build` via the `voidzero-dev/setup-vp` action.
