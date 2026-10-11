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

Without `TACK_SECRET` (as on [Previews](/self-hosting/deploy/#previews)), sign-in and setup are off, `/setup` says "Tack needs a secret first", and boards work anonymously.

## `cloudflare.config.ts`

The Worker itself, read by the `cf` CLI and the build. Change it in your copy of Tack and deploy.

| Setting                                   | Default               | What it does                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`                                    | `tack`                | The Worker's name. Change each Durable Object binding's `worker` with it, and regenerate `wrangler.jsonc` (`pnpm run wrangler-config`). Renaming a deployed Worker makes a new one, with new, empty Durable Objects                                                            |
| `TACK_COMMAND_ALIAS`                      | empty                 | Short names the app answers to in [comment commands](/automation/comment-commands/#aliases), besides its GitHub App slug: comma-separated, e.g. `tack`. Empty by default, because a short name like `tack` is someone's real GitHub login, and every command would notify them |
| `triggers`                                | every ten minutes     | The cron that asks GitHub to redeliver webhooks that failed to arrive                                                                                                                                                                                                          |
| `observability`                           | on                    | [Workers Logs](/self-hosting/observability/). Turning it off loses Tack's logs                                                                                                                                                                                                 |
| `compatibilityDate`, `compatibilityFlags` | in `compatibility.ts` | The Workers runtime Tack is built for. Shared with the tests: change them only with a new version of Tack                                                                                                                                                                      |

Bindings you don't see here (the four Durable Objects, `assets`) are part of how Tack works: leave them as they are.

`wrangler.jsonc` is generated from `cloudflare.config.ts` for the [Deploy to Cloudflare button](/self-hosting/deploy/#the-buttons-limits), and nothing else reads it. After changing `cloudflare.config.ts`, run `pnpm run wrangler-config`; the tests fail until you do.

### Custom domains

Add one to the Worker under Workers & Pages → `tack` → Settings → Domains & Routes. The GitHub App is made for the address `/setup` was run on, so add the domain **before** setup if you can. If you add it afterwards, update the app on GitHub: its **Callback URL** to `https://your-domain/auth/callback`, its **Webhook URL** to `https://your-domain/webhooks/github`, and its **Setup URL** to `https://your-domain/setup/installed`. `/setup`'s webhook check says "Going elsewhere" until the webhook URL matches.

## `/setup`

On the instance, for admins (also **Instance settings** in the account menu):

- **The GitHub App**: created here once, then a link to its settings on GitHub. See [Set up the GitHub App](/self-hosting/github-app/).
- **Webhooks** and **Where it's installed**: checks, not settings. See [After setup](/self-hosting/github-app/#after-setup).
- **Who can use this instance**: admins, people and organisations. See [Who can use it](/self-hosting/access/).

## The GitHub App's settings

On GitHub (**App settings** on `/setup`): the app's name and logo, its URLs (above), its webhook secret and whether its webhook is active, and its permissions and events. Tack fills them all in when it creates the app; change them only as [Upgrading](/self-hosting/upgrades/#when-tack-needs-new-permissions) or this page says.

## Local development only

| Variable          | What it does                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TACK_DEV_AUTH=1` | Fake sign-in at `/auth/dev`, on localhost only. Only read by the dev server, and never set it in production. See [Local development](/self-hosting/local-development/) |

Put local secrets in `.dev.vars` (git ignores it): copy `.dev.vars.example` and fill it in.
