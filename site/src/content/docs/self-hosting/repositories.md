---
title: Repositories, live and not
description: What changes when the GitHub App is installed on a repository, and how cards stay fresh.
sidebar:
  order: 4
---

A board can hold items from any repository. What Tack can do with a repository depends on whether the instance's GitHub App is installed on it:

|                                 | App not installed                                                                  | App installed       |
| ------------------------------- | ---------------------------------------------------------------------------------- | ------------------- |
| Which repositories              | Public only                                                                        | Public and private  |
| Updates                         | Checked every one to five minutes while a board has them open, marked **Not live** | Live, from webhooks |
| CI and reviews on pull requests | Not shown                                                                          | Shown               |
| Writes                          | None: actions are disabled, with an "install the app" prompt                       | Staged and pushed   |
| Rules and webhook refreshes     | No                                                                                 | Yes                 |

This is because of how GitHub Apps work: people's sign-ins through the app only reach repositories where it's installed, plus public data.

GitLab, Codeberg and Tangled work differently: there's no app, and the instance's own token and webhooks decide what's live and writable. See [Other forges](/self-hosting/forges/).

## Live repositories

With the app installed, GitHub sends Tack a webhook whenever an issue, pull request, review, check or workflow run changes, and the cards update within seconds. CI and review changes are gathered for a couple of seconds and fetched together.

If webhooks go missing, the cron trigger asks GitHub every ten minutes to redeliver deliveries that failed in the last six hours (up to three attempts each). When a repository's object wakes after being idle, it also catches up with GitHub, at most every five minutes.

## Repositories without the app

While someone has a board open, Tack checks each repository without the app for changes: every minute when it can use a token (a signed-in viewer's own, or [`GITHUB_TOKEN`](/self-hosting/deploy/#secrets)), every five minutes without one. It's one conditional request each time, which costs nothing against GitHub's rate limit when nothing has changed. Nobody looking, no checks.

## Private repositories

Private repositories need the app installed. Even then, **each person only sees what they can read on GitHub**: Tack checks each viewer's access with their own token (and rechecks it regularly), and everyone else gets a "Private" placeholder. Being a member of a board never grants access to a repository's data. See [Cards](/boards/cards/#private-repositories).

## Renames and transfers

Tack keys repositories by GitHub's id, not their name, so renaming or transferring a repository keeps its cards working, and they show the new name.
