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
- `src/server/log.ts` — structured logger: one JSON line per event (see Observability)
- `src/server/clientErrors.ts` — `POST /api/client-errors`: browser error reports, logged as `client.error` events
- `src/shared/` — forge-neutral item keys (`{host}/{repo}{#|!}{n}`, see `refs.ts`), card types and the Yjs shape schema, used by both server and client
- `src/client/` — React + React Flow canvas (own `tsconfig.json` with DOM types); `index.html` at the repo root is its entry
- `src/client/play/` — dev-only UI workbench, left out of production builds: `/play` runs a board entirely in the browser with simulated people (own Y.Doc + Awareness each) and simulated forge events, plus slow-motion and reduced-motion toggles; `/play/cards` is a gallery of every card state; `/play/crash` throws, to show the error fallback. Use these to iterate on interaction details
- `src/client/ErrorBoundary.tsx`, `src/client/errors.ts` — the error boundary and its fallback, and reporting of render errors, `window.onerror` and unhandled rejections to the Worker
- `src/client/styles.css` — design tokens, including motion: every duration is scaled by `--motion`, so slow motion and reduced motion apply everywhere. Use the spring easings (`--ease-spring`, `--ease-settle`) rather than ad hoc curves
- `scripts/send-webhook.ts` — send a signed webhook to a local dev server (reads `GITHUB_WEBHOOK_SECRET` from `.dev.vars`)
- `docs/spike.md` — spike findings: performance, Yjs growth, design decisions
- `test/` — Vitest tests in Node. Integration tests run the built Worker in Miniflare (`test/harness.ts`); `test/global-setup.ts` builds it first
- `e2e/` — Playwright smoke tests over the `/play` workbench, with their own config (`e2e/playwright.config.ts`) and screenshot baselines
- `cloudflare.config.ts` — Worker configuration, via `defineConfig` from `cf/config` (there is no wrangler.jsonc, and no Wrangler dependency at all)
- `compatibility.ts` — compatibility date/flags, shared between the Worker config and the test runtime
- `vite.config.ts` — unified Vite+ config: Vite plugins, Vitest, oxlint, and oxfmt
- `.cloudflare/types/` — generated `Env` and runtime types; not committed. `cf workers types` regenerates them (runs on `postinstall`, or `pnpm types`)

## Commands

- `pnpm dev` — start the dev server (`vp dev`). `cf dev` and `cf build` expect a `vite` binary, which Vite+ doesn't provide, so use `vp`
- `pnpm test` — unit and integration tests (`vp test`)
- `pnpm e2e` — Playwright smoke tests (`e2e/`). Starts its own dev server on port 5205, or reuses one already running there. Install the browser once with `pnpm exec playwright install chromium`
- `pnpm e2e:update` — the same, rewriting screenshot baselines for this platform
- `pnpm check` — format check, lint, and type check in one pass (`vp check`)
- `pnpm fix` — apply formatting and safe lint fixes
- `pnpm build` — production build
- `pnpm run deploy` — `vp build` then `cf deploy --prebuilt` (requires `cf auth login` or `CLOUDFLARE_API_TOKEN`). Note the `run`: `pnpm deploy` is pnpm's own workspace command, not this script. Production deploys happen via Workers Builds, which runs this on every push to `main`, not from CI or local machines
- `pnpm run deploy:preview` — builds Preview Build Output (`CLOUDFLARE_PREVIEW_BUILD=true vp build`) then `cf previews deploy --prebuilt`. Workers Builds runs this for every branch other than `main`, so each branch gets a Worker Preview with its own URL and its own isolated Durable Objects. `CLOUDFLARE_PREVIEW_BUILD` is what `cf build` sets for preview builds; we set it ourselves because `cf build` expects a `vite` binary

## Configuration Architecture

- **`cloudflare.config.ts` is the source of truth for the Worker**: name, entrypoint, compatibility, bindings, observability. It uses `defineConfig({ worker: { ... } })` from `cf/config`, which both the `cf` CLI and the Vite plugin read.
- The entrypoint uses the `with { type: "cf-worker" }` import attribute. This is what makes `Env` and `exports` inference work — keep that form when changing the entrypoint.
- **Previews**: `cloudflare.config.ts` uses the function form of `defineConfig`, which receives `isPreview`. Previews don't inherit production settings, so it returns the complete config for both. Previews get no secrets (webhooks only go to production, and card fetches work unauthenticated), so the code must treat `GITHUB_WEBHOOK_SECRET` and `GITHUB_TOKEN` as optional.
- **Bindings**: declare them in `cloudflare.config.ts` (e.g. `env: { MY_KV: bindings.kv() }` with `bindings` from the same import). The `Env` type is inferred from them — run `pnpm types` after config changes. Durable Object bindings to this same Worker are untyped; `src/server/namespaces.ts` restores the class types. Integration tests declare the same bindings for Miniflare in `test/harness.ts`, so keep the two in step.
- **`compatibility.ts`** exists so the test runtime (`test/harness.ts`) always matches the deployed runtime. Extra exports are not allowed in `cloudflare.config.ts` (its exports are schema-validated), which is why this is a separate file.
- **Version pins that must move together**: the `vite@*` and `vitest@*` overrides in `pnpm-workspace.yaml` pin Vite to `@voidzero-dev/vite-plus-core` at the installed `vite-plus` version, and Vitest to the version `vp toolchain vitest` reports. Update them whenever `vite-plus` changes. There are no direct `vite` or `vitest` dependencies: import test APIs from `vite-plus/test`.

## Testing

- Unit tests run in Node. Integration tests use `startWorker()` from `test/harness.ts`: `mf.dispatchFetch()` for HTTP, and `repoStub()` (or `mf.getDurableObjectNamespace()`) for Durable Object RPC.
- End-to-end smoke tests are Playwright, in `e2e/`, kept out of `vp test` so it stays fast. They drive `/play` scenarios (render counts, simulated forge events, people joining, the sticky tool, dragging) and fail on any uncaught page error. When you add a `/play` scenario or gallery state, add it to `e2e/play.spec.ts` or `e2e/gallery.spec.ts`.
- `e2e/gallery.spec.ts` screenshots `/play/cards` with reduced motion and animations off, against per-platform baselines in `e2e/gallery.spec.ts-snapshots/` (`*-darwin.png` locally, `*-linux.png` in CI). After an intended visual change, run `pnpm e2e:update` and commit the new PNGs. For the Linux baselines CI compares against, run the **Test** workflow manually with "update snapshots" ticked, download its `e2e-linux-baselines` artifact into `e2e/gallery.spec.ts-snapshots/`, and commit. Until a Linux baseline exists, CI runs the gallery's other checks and skips only the pixel comparison.
- In CI, the `e2e` job runs separately from `test`, and uploads traces and failure screenshots as the `e2e-results` artifact. Open a trace with `pnpm exec playwright show-trace <trace.zip>`.

## Observability

- **Server logs** use `log` from `src/server/log.ts`: `log.info("webhook.verified", { repo, delivery })` writes one JSON line with `level`, `event` and the context. Use dotted event names and put identifiers in context fields rather than in the event name, so they can be filtered on. Errors passed in context are serialised with their stack.
- **Events**: `webhook.received`, `webhook.verified`, `webhook.ignored`, `webhook.rejected` (bad signature) and `webhook.failed`; `repo.ingest` (duplicate or processed, with update counts), `repo.fanout` (boards notified, failures) and `repo.fanout.failed`, `repo.fetch` (warns when the forge errored); `board.load` and `board.save` (snapshot bytes and chunks), `board.save.failed`, `board.subscriptions.failed`, `board.connection.error` and `board.exception`; and `client.error`.
- **Client errors**: the app is wrapped in an error boundary with an on-brand fallback. Render errors, `window.onerror` and unhandled rejections are posted to `POST /api/client-errors` (at most 10 distinct errors per page load), which accepts reports up to 16 KB from the app's own origin, rate limits per client IP (in memory, per isolate; the IP is never logged), and logs a `client.error` event with the message, stack, component stack, path (no query string) and user agent. No third-party service is involved.
- **Finding logs in production**: Workers Logs is enabled (`observability` in `cloudflare.config.ts`). In the Cloudflare dashboard, open Workers & Pages → `tack` → Observability, and filter on fields such as `event = client.error` or `level = error`. JSON fields are indexed automatically. From a terminal, `cf o11y telemetry query` runs the same queries against the Workers Observability API (see `cf schema o11y telemetry query` for the request body), and `cf o11y telemetry live-tail` prepares a live tail.
- **Finding logs locally**: the dev server prints log lines to the terminal, and also keeps them queryable through the Cloudflare local explorer: `curl -X POST http://localhost:5173/cdn-cgi/local/explorer/api/local/observability/query -H 'content-type: application/json' -d '{"sql":"SELECT ts_ms, level, message FROM logs ORDER BY ts_ms DESC LIMIT 20"}'` (use your dev server's port). The e2e tests use this to check that a crash on `/play/crash` lands as a `client.error` event.

## Development Workflow

- Uses **pnpm**, wrapped by **Vite+** (`vp`). Format and lint are oxfmt/oxlint via `vp check` — there is no prettier or eslint. Type checking runs inside `vp check` (tsgolint with `typeAware`/`typeCheck` enabled).
- Formatting uses tabs (configured in `vite.config.ts` under `fmt`).
- CI (test.yml) runs `vp check`, `vp test`, and `vp build` via the `voidzero-dev/setup-vp` action in the `test` job, and the Playwright smoke tests in a separate `e2e` job, with the browser cached by Playwright version.
