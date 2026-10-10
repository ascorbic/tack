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

Create `.dev.vars` (it's ignored by git):

```sh
TACK_SECRET=<any random string>
TACK_DEV_AUTH=1   # fake sign-in, local only
```

With `TACK_DEV_AUTH=1`, `/auth/dev?login=octocat` signs you in as a fake user, on localhost only. Add `&admin=1` for an admin, `&allow=1` to put them on the access list, `&orgs=a,b` to pretend they're in allowed organisations, and `&name=` for a display name. Fake users have no GitHub token, so they can't push to GitHub or read private repositories. `TACK_DEV_AUTH` is only read by the dev server: never set it in production.

## A GitHub App for local development

You can run `/setup` on localhost to create a GitHub App for development. Sign-in and installation tokens work, but GitHub can't reach your machine, so the app's webhook starts switched off ("Cards still load; live updates need a public URL").

To try webhooks, send one yourself, signed with `GITHUB_WEBHOOK_SECRET` from `.dev.vars`:

```sh
node scripts/send-webhook.ts issues payload.json
```

## Without GitHub at all

- **The playground**, `/play`, runs a board entirely in your browser, with simulated people and simulated GitHub events, and slow-motion and reduced-motion switches. `?scenario=` picks a board: `planning`, `triage`, `retro`, `silent`, `vote`, `push`, `writes`, `inbox`, `rules`, `widgets`, `roadmap`, `tracking`, `comments`, `since` and more. Galleries of every state are at `/play/cards`, `/play/changes`, `/play/widgets` and others. The playground isn't in production builds.
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

Screenshots come from the playground: with `pnpm dev` running, `pnpm --filter site screenshots http://localhost:5173` takes them again.
