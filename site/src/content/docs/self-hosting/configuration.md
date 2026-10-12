---
title: Configuration
description: Everything you can configure on an instance, where it lives, and what changing it does.
sidebar:
  order: 4
---

An instance is configured in four places: **secrets** on the Worker, **`cloudflare.config.ts`** in your copy of Tack, **`/setup`** on the instance, and the **GitHub App's settings** on GitHub. Most instances only ever need `TACK_SECRET` and `/setup`.

## Secrets

Set on the Worker, never in the repository: `pnpm exec cf workers secrets update <NAME>`, or the dashboard (Workers & Pages → `tack` → Settings → Variables and secrets). Deploys keep them.

| Secret                  | Default | What it does                                                                                                                                                                                                                                                                                                          |
| ----------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TACK_SECRET`           | none    | **Required for sign-in.** Signs session cookies and encrypts every stored credential, with keys derived from it. Make it long and random (`openssl rand -base64 32`). **Never change it**: the app's credentials and everyone's tokens are encrypted with it, a new one can't read them, and setup can't be run again |
| `GITHUB_WEBHOOK_SECRET` | none    | A second secret webhooks are checked against, after the one the app was created with: for an app set up by hand, or after changing the secret in the app's settings                                                                                                                                                   |
| `GITHUB_TOKEN`          | none    | A GitHub token Tack reads public repositories with when the app isn't installed on them, so they get a signed-in rate limit rather than GitHub's anonymous one. A fine-grained token with read-only access to public repositories is enough. Never used for writes                                                    |
| `TACK_FORGES`           | none    | The forges besides GitHub: self-hosted GitLab and Forgejo instances, tokens and webhook secrets for them and for gitlab.com and Codeberg, writes, or turning one off. JSON; see [Other forges](/self-hosting/forges/)                                                                                                 |

Without `TACK_SECRET` (as on [Previews](/self-hosting/deploy/#previews)), sign-in and setup are off, `/setup` says "Tack needs a secret first", and boards work anonymously.

## `cloudflare.config.ts`

The Worker itself, read by the `cf` CLI and the build. Change it in your copy of Tack and deploy.

| Setting                                   | Default               | What it does                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NAME`                                    | `tack`                | The Worker's name, a constant near the top of the file: the Durable Object bindings follow it. Regenerate `wrangler.jsonc` (`pnpm run wrangler-config`). Renaming a deployed Worker makes a new one, with new, empty Durable Objects                                           |
| `TACK_COMMAND_ALIAS`                      | empty                 | Short names the app answers to in [comment commands](/automation/comment-commands/#aliases), besides its GitHub App slug: comma-separated, e.g. `tack`. Empty by default, because a short name like `tack` is someone's real GitHub login, and every command would notify them |
| `TACK_AI`, `AI`                           | `on`, and the binding | [AI suggestions](#ai-suggestions): naming stacks, Auto-stack, and [AI on boards](/boards/ai/) (widgets in words, summaries and drafted decisions). `off` turns them all off. `AI` is the Workers AI binding they use                                                           |
| `EMAIL_FROM`                              | empty                 | Who [digest emails](/self-hosting/email/) come from, e.g. `Tack <tack@mail.example.com>`, on a domain onboarded to Cloudflare Email Service. Setting it adds the `send_email` binding; empty leaves email off                                                                  |
| `triggers`                                | every ten minutes     | The cron that asks GitHub to redeliver webhooks that failed to arrive                                                                                                                                                                                                          |
| `observability`                           | on                    | [Workers Logs](/self-hosting/observability/). Turning it off loses Tack's logs                                                                                                                                                                                                 |
| `compatibilityDate`, `compatibilityFlags` | in `compatibility.ts` | The Workers runtime Tack is built for. Shared with the tests: change them only with a new version of Tack                                                                                                                                                                      |

Bindings you don't see here (the four Durable Objects, `assets`, `AI`) are part of how Tack works: leave them as they are.

`wrangler.jsonc` is generated from `cloudflare.config.ts` for the [Deploy to Cloudflare button](/self-hosting/deploy/#the-buttons-limits), and nothing else reads it. After changing `cloudflare.config.ts`, run `pnpm run wrangler-config`; the tests fail until you do.

### AI suggestions

[Stacks](/boards/stacks/) are named from what their stickies say, and **Auto-stack** sorts a selection into named stacks, by a language model on [Workers AI](https://developers.cloudflare.com/workers-ai/), on your own Cloudflare account. Editors can also ask it for a widget in words, a summary of what's selected, or a draft decision ([AI on boards](/boards/ai/)). They're on by default, through the `AI` binding in `cloudflare.config.ts`, with Gemma 4 26B A4B; `/setup` says whether they're on, and which model they use.

- **What's sent**: for stacks, only stickies' visible text, and the titles of issues and pull requests that everyone who can see the board can read (from a public repository, or, on a board only its members can open, one every member can read), a stack's or a selection's at a time: never face-down stickies in silent mode (their text isn't on the board until the reveal), other cards' titles, comments, names or anything else. For AI on boards, what's selected as the person asking may read it: stickies' and notes' text and cards' titles, never face-down stickies or cards (or even the names of repositories) they can't read; for a widget, their description, the board's repositories and its sections' names.
- **How often**: a stack is named a moment after its text changes, and never twice for the same text (names are kept per board). Each board asks at most 20 times a minute and 240 an hour; Auto-stack counts as four. AI on boards asks only when an editor does: 12 requests a minute and 120 an hour per board, 6 a minute per person.
- **What it costs**: Workers AI has a free daily allocation, then it's billed per use (see [Costs](/self-hosting/costs/#ai)). Naming a stack is a few hundred tokens; a summary at most a few thousand.
- **Turning them off**: set `TACK_AI` to `off` in `cloudflare.config.ts` and deploy (removing the `AI` binding does the same, and `/setup` says they're unavailable). Stacks are then "Untitled stack" until someone names them, and neither Auto-stack nor AI on boards is offered.
- **Local development** uses a stand-in that names stacks from their words, and makes widgets, summaries and decisions from keywords, with nothing sent anywhere. Start `pnpm dev` with `TACK_DEV_AI=workers-ai` to ask the real model (it needs a Cloudflare login, and is billed).

### Link previews

[Link cards](/boards/link-cards/) are the one place Tack fetches an address someone typed rather than a forge's API, so the instance reads pages and their images itself, carefully. There's nothing to configure; this is what it does, so you know what to expect from your Worker:

- **Who can make it fetch**: reading a page (`POST /api/boards/:id/unfurl`) is only for signed-in editors of the board, at most 20 fresh pages a minute (200 an hour) per person and 60 a minute (600 an hour) per board. Images (`GET /api/boards/:id/links/image`) are for anyone who can open the board, but only images a link card on that board shows, at most 240 fresh ones a minute per board: it's never an open proxy. The limits are counted per isolate, in memory (`UNFURL_LIMITS` in `src/server/links/budget.ts`).
- **Where it won't go**: only `http` and `https`, on their standard ports, with no user name or password in the address. Host names are resolved first (DNS over HTTPS, Cloudflare's `1.1.1.1`), and an address is refused if any answer is private, loopback, link-local (where cloud metadata lives), shared, reserved, multicast or for documentation, in IPv4 or IPv6, including IPv4 written inside IPv6; so are names that only mean something locally (`localhost`, `.local`, `.internal`, single words). Redirects are followed by hand, at most three, each checked again from the start. On Cloudflare a Worker can't reach private networks anyway; these checks are what keep `vp dev` and other runtimes as safe.
- **How much**: 5 seconds a request (8 for a page and its redirects together), only the first 512 KB of a page (its head is nearly always in the first few kilobytes), and images up to 5 MB (SVG up to 256 KB), checked by their first bytes to be PNG, JPEG, GIF, WebP, AVIF, ICO or SVG whatever the server says. Images aren't resized. They're passed on with `nosniff` and a policy that sandboxes them, so even an SVG opened on its own can't run anything.
- **Caching**: previews for a day (pages that couldn't be read for an hour) and images for a week, in the Worker's Cache API (`tack-links`), so a page on many boards is read once. Boards keep each card's preview themselves, and read it again once it's a day old.
- **Privacy**: the sites see your Worker's requests (as `TackLinkPreview/1.0`), never your users' browsers or addresses. The app's Content Security Policy is unchanged: images come from the app itself.
- **Logs**: `link.unfurled` (the host, how it went, whether it was cached), `link.refused`, `link.image.fetched`, `link.image.refused` and `link.image.failed`. Never the full address, which may hold something private in its query.

### Custom domains

Add one to the Worker under Workers & Pages → `tack` → Settings → Domains & Routes. The GitHub App is made for the address `/setup` was run on, so add the domain **before** setup if you can. If you add it afterwards, update the app on GitHub: its **Callback URL** to `https://your-domain/auth/callback`, its **Webhook URL** to `https://your-domain/webhooks/github`, and its **Setup URL** to `https://your-domain/setup/installed`. `/setup`'s webhook check says "Going elsewhere" until the webhook URL matches.

### Security headers

Tack sends a Content Security Policy and the usual security headers with everything it serves: the app only runs its own scripts, nothing may put it in a frame, and browsers are told to use HTTPS for a year. If you change Tack to load something from elsewhere (an analytics script, a font service) or to be framed by another site, change the policy in `src/server/securityHeaders.ts` too, or browsers will block it. Images of public boards for READMEs and link previews are unaffected: they're images, not pages.

## `/setup`

On the instance, for admins (also **Instance settings** in the account menu):

- **The GitHub App**: created here once, then a link to its settings on GitHub. See [Set up the GitHub App](/self-hosting/github-app/).
- **Webhooks** and **Where it's installed**: checks, not settings. See [After setup](/self-hosting/github-app/#after-setup).
- **AI suggestions**: whether they're on, and with which model. See [AI suggestions](#ai-suggestions).
- **Who can use this instance**: admins, people and organisations. See [Who can use it](/self-hosting/access/).

## The GitHub App's settings

On GitHub (**App settings** on `/setup`): the app's name and logo, its URLs (above), its webhook secret and whether its webhook is active, and its permissions and events. Tack fills them all in when it creates the app; change them only as [Upgrading](/self-hosting/upgrades/#when-tack-needs-new-permissions) or this page says.

## Local development only

| Variable                 | What it does                                                                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TACK_DEV_AUTH=1`        | Fake sign-in at `/auth/dev`, on localhost only. Only read by the dev server, and never set it in production. See [Local development](/self-hosting/local-development/)                                                  |
| `TACK_DEV_AI=workers-ai` | An environment variable for `pnpm dev`, not `.dev.vars`: gives the dev server the real Workers AI, through your Cloudflare account (`cf auth login`), billed. Without it, a stand-in answers from the board's own words |

Put local secrets in `.dev.vars` (git ignores it): copy `.dev.vars.example` and fill it in.
