---
title: Local development
description: Running Tack on your machine, with fake sign-in, the playground and test webhooks.
sidebar:
  order: 8
---

To work on Tack itself, or try it without deploying:

```sh
pnpm install
pnpm dev
```

`pnpm dev` runs the Vite+ dev server (`vp dev`), with the Cloudflare local explorer at `/cdn-cgi/local/explorer`. Use it rather than `cf dev`.

## Secrets locally

Copy `.dev.vars.example` to `.dev.vars` (it's ignored by git), and fill it in:

```sh
TACK_SECRET=<any random string>
TACK_DEV_AUTH=1   # fake sign-in, local only
GITHUB_WEBHOOK_SECRET=<any string>   # optional, for sending test webhooks
```

With `TACK_DEV_AUTH=1`, `/auth/dev?login=octocat` signs you in as a fake user, on localhost only. Add `&admin=1` for an admin, `&allow=1` to put them on the access list, `&orgs=a,b` to pretend they're in allowed organisations, and `&name=` for a display name. Fake users have no GitHub token, so they can't push to GitHub or read private repositories. `TACK_DEV_AUTH` is only read by the dev server: never set it in production.

## AI locally

Workers AI always runs on Cloudflare, so the dev server uses a stand-in (`TACK_AI=fake`) that names stacks and makes [widgets, summaries and decisions](/boards/ai/) from the board's own words, with nothing sent anywhere. To try the real thing, sign in to Cloudflare (`pnpm exec cf auth login`) and start the dev server with `TACK_DEV_AI=workers-ai pnpm dev`; requests are billed to your account. The playground (`/play?scenario=ai`) has a pretend AI that answers in your browser, for working on the interface without either.

## A GitHub App for local development

You can run `/setup` on localhost to create a GitHub App for development. Sign-in and installation tokens work, but GitHub can't reach your machine, so the app's webhook starts switched off ("Cards still load; live updates need a public URL"), and `/setup`'s webhook check says "Off while local".

To try webhooks, send one yourself, signed with `GITHUB_WEBHOOK_SECRET` from `.dev.vars`:

```sh
node scripts/send-webhook.ts issues payload.json
```

## Without GitHub at all

- **The playground**, `/play`, runs a board entirely in your browser, with simulated people and simulated GitHub events, and slow-motion and reduced-motion switches. `?scenario=` picks a board: `planning`, `triage`, `retro`, `silent`, `vote`, `push`, `writes`, `inbox`, `rules`, `widgets`, `roadmap`, `tracking`, `comments`, `since` and more. Galleries of every state are at `/play/cards`, `/play/changes`, `/play/widgets` and others. The playground isn't in production builds.
- **The demo**, as at [tack.social/try](/try/): the app's dev server serves it at `/play/try`, and `vp dev --mode try` serves it alone at `/try/`. Both use the AI stand-in; on tack.social it asks Workers AI through the docs site's Worker first (`?ai=offline` skips it).
- **The test forge**, `fake.tack`, is a pretend GitHub: cards like `fake.tack/acme/app#12` load without a network, and the whole push flow works against it.

## Tests

```sh
pnpm test     # unit and integration tests
pnpm e2e      # Playwright smoke tests over /play
pnpm check    # format, lint and type check
```

## These docs

The docs site is in `site/`, built with Astro Starlight:

```sh
pnpm --filter site dev       # preview the docs
pnpm --filter site build     # build them, checking every link
```

Screenshots come from the playground: with `pnpm dev` running, `pnpm --filter site screenshots http://localhost:5173` takes them again, and `pnpm --filter site og` draws the link preview image from them.
