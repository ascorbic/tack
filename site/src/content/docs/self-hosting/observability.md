---
title: Observability
description: Finding Tack's logs, the events it logs, and browser error reports.
sidebar:
  order: 6
---

Tack logs one JSON line per event, with a `level`, an `event` name and its context: `{"level":"info","event":"push.completed",…}`. Workers Logs is on (`observability` in `cloudflare.config.ts`), so they're kept and searchable.

## Finding logs

**In the dashboard**: Workers & Pages → tack → Observability. JSON fields are indexed, so filter on them: `event = client.error`, `level = error`, or `event` starting with `push.`.

**From a terminal**, with the `cf` CLI:

```sh
pnpm exec cf o11y telemetry query       # run a query (see `cf schema o11y telemetry query` for the body)
pnpm exec cf o11y telemetry live-tail   # prepare a live tail
```

**Locally**, the dev server prints log lines to the terminal, and the Cloudflare local explorer keeps them queryable:

```sh
curl -X POST http://localhost:5173/cdn-cgi/local/explorer/api/local/observability/query \
  -H 'content-type: application/json' \
  -d '{"sql":"SELECT ts_ms, level, message FROM logs ORDER BY ts_ms DESC LIMIT 20"}'
```

Comment text and silent mode's hidden sticky text never go in logs.

## Events

Event names are dotted, with identifiers in the context rather than the name, so they filter well. The main families:

| Prefix                                             | What it covers                                                                         | Look for                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `webhook.`                                         | Webhook deliveries arriving and being verified                                         | `webhook.rejected` (bad signature), `webhook.failed`                       |
| `repo.`                                            | Each repository's cache: ingesting deliveries, fetching, polling, reconciling, renames | `repo.fetch` warnings (GitHub errors), `repo.poll.failed`                  |
| `board.`                                           | Boards loading and saving, membership, connections                                     | `board.save.failed`, `board.exception`                                     |
| `setup.`, `auth.`, `access.`                       | Setup, sign-in and the access list                                                     | `auth.signin.failed` (with a reason), `access.denied`                      |
| `github.`                                          | Installations, tokens, GraphQL fallbacks, the redelivery cron                          | `github.token.failed`, `github.redelivery` (counts)                        |
| `push.`                                            | Pushes and each change in them                                                         | `push.rejected`, `push.change.failed`, `push.completed` (counts by status) |
| `rule.`, `widget.`                                 | Rules placing cards, widget and inbox searches                                         | `rule.skipped` (`no_section`, `no_room`), `widget.query.failed`            |
| `snapshot.`, `related.`                            | Backlink snapshots, Expand related                                                     | `snapshot.rejected` (with a reason)                                        |
| `embed.`                                           | Images of public boards and link previews: drawn, served from cache, refused           | `embed.rendered` (ms, bytes), `embed.failed` (with a stage)                |
| `timer.`, `spotlight.`, `silent.`, `facilitation.` | Facilitation                                                                           | `silent.refused`, `facilitation.failed`                                    |
| `history.`                                         | Board history: thinning and trimming                                                   | `history.trimmed`, `history.failed`                                        |
| `command.`                                         | Comment commands from GitHub                                                           | `command.done` (the outcome), `command.failed`, `command.limited`          |
| `comment.`, `since.`                               | Comments, notifications and Since you were here                                        | `comment.failed`, `since.failed`                                           |
| `digest.`, `email.`                                | Weekly digests: turned on, posted, emailed, subscriptions                              | `digest.discussion.failed`, `digest.email.failed` (with a code)            |
| `client.error`                                     | Errors in people's browsers                                                            | See below                                                                  |

The full list is in [AGENTS.md](https://github.com/ascorbic/tack/blob/main/AGENTS.md#observability), under Observability.

## Errors in the browser

The app catches render errors, uncaught errors and unhandled promise rejections, and posts them to the instance (`POST /api/client-errors`), where they're logged as `client.error` with the message, stack, component stack, path (without its query string) and browser. Each page sends at most ten distinct errors, reports are limited per client, and the client's IP address is never logged. No third-party service is involved.
