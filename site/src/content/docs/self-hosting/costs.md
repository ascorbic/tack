---
title: Costs and limits
description: What Tack uses on Cloudflare and GitHub, and what drives usage.
sidebar:
  order: 7
---

Tack is designed to be self-hostable on a free plan, but what it costs you depends on how much it's used, and on Cloudflare's current prices and limits. This page says what Tack uses, so you can check it against them:

- [Workers pricing and limits](https://developers.cloudflare.com/workers/platform/pricing/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Workers Logs pricing](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing)

## What Tack uses on Cloudflare

| Product                         | How Tack uses it                                                              |
| ------------------------------- | ----------------------------------------------------------------------------- |
| Workers                         | One Worker, `tack`: the API, sign-in, webhooks and board connections          |
| Static assets                   | The app itself (HTML, scripts, fonts)                                         |
| Durable Objects, SQLite storage | One object per board, one per repository on a board, and two for the instance |
| Cron Triggers                   | One, every ten minutes, to redeliver failed webhooks                          |
| Workers Logs                    | Every log event                                                               |
| Workers AI                      | [AI suggestions](/self-hosting/configuration/#ai-suggestions): naming stacks  |

No KV, R2, D1 or Queues.

## What drives usage

- **People on boards.** Each person on a board holds a WebSocket to that board's object, which stays active while anyone's connected (Tack doesn't use WebSocket hibernation). Editing, moving and cursors are messages on it. While anyone's connected, the board also renews its interest in its repositories every minute.
- **Repositories without the app**, while a board is open: a check on GitHub every one to five minutes (see [Repositories](/self-hosting/repositories/#repositories-without-the-app)).
- **Webhooks**, for repositories with the app: each delivery wakes its repository's object, which tells the boards that have its items.
- **Widgets and inboxes**: searches while someone's looking, on a schedule from every minute (inboxes) to every 15 minutes, and after webhooks. Results are cached, and each board limits itself to 20 searches and 60 other reads a minute per person.
- **Pushes**: one write a second, run from the board object's alarm.
- **Storage**: each board's document (saved in chunks), its comments, push history, change log and [history](/boards/history/) (up to 8 MB), and backlink snapshots (each up to 1.5 MB, up to 1000 per board). Repository objects cache their cards.
- **AI suggestions**: a request to Workers AI each time a stack's text settles on something it hasn't been named for, and for each Group these. Each is a few hundred tokens; each board asks at most 20 times a minute. Workers AI's free daily allocation covers a lot of sessions; past it, it's billed. Turn them off with `TACK_AI=off`.
- **Logs**: one line per event; busy instances log a lot of `webhook.` and `repo.` events.
- **Images of public boards** ([embeds and link previews](/boards/embeds/)): drawing one takes a few hundred milliseconds of CPU time (more for a big board, and for PNG), and wakes the board's object. Each image is drawn once for each change to what it shows: after that, browsers and GitHub's image proxy are told it's unchanged, and drawn images are kept in Cloudflare's cache. Opening a public board's page asks the board for a description of it, for link previews.

:::caution[Images need more CPU time than the Free plan allows]
The Workers Free plan allows 10 ms of CPU time per request, which isn't enough to draw a board. On Free, embeds and link preview images may fail (everything else works). On the Paid plan they're well within the limits. The image renderer (Satori and resvg, as WebAssembly) also adds about 1.3 MB, compressed, to the Worker (about 1.6 MB in all, within the Free plan's 3 MB).
:::

## GitHub

GitHub Apps are free. What matters on GitHub is **rate limits**: card fetches are batched (50 items per GraphQL request), conditional polls cost nothing when nothing's changed, searches are budgeted per board, and pushes are spaced a second apart. Every call to GitHub shares one backoff: once GitHub says a token is rate limited (its hourly budget, or a secondary limit for too much at once), nothing calls GitHub with that token until GitHub says it's lifted, and pushes, widgets, comment commands and polling all wait for that same moment rather than retrying on their own. Widget and inbox searches run with each signed-in viewer's own token, so they count against that person's limits. Card fetches for repositories with the app use its installation token, shared by everyone on the instance, and checks on repositories without it borrow a watching viewer's token, or `GITHUB_TOKEN`.
