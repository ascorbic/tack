---
title: Other forges
description: Cards from GitLab, Codeberg and other Forgejo instances, and Tangled; their webhooks, tokens and writes, and how to set them up.
sidebar:
  order: 4
---

GitHub is Tack's home, but a board can also hold issues and pull requests from GitLab, Forgejo (Codeberg, and Gitea, which shares its API) and Tangled. Paste a link to one, as you would a GitHub link, and it becomes a card.

Out of the box, every instance reads **gitlab.com**, **codeberg.org** and **tangled.org**, anonymously: public projects only, checked while someone has the board open. Giving the instance a token and a webhook secret for a host makes its cards live and, if you want, lets people push there. Self-hosted GitLab and Forgejo instances are added the same way.

## What each forge can do

|                         | GitLab                                                                 | Forgejo, Codeberg, Gitea                       | Tangled                                  |
| ----------------------- | ---------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------- |
| Keys                    | `gitlab.com/group/sub/project#12`, merge requests `!34`                | `codeberg.org/owner/repo#12` (shared numbers)  | `tangled.org/handle/repo#12`, pulls `!3` |
| Updates                 | Live from webhooks; otherwise checked every minute                     | Live from webhooks; otherwise every minute     | Checked every minute (no webhooks)       |
| CI                      | The head pipeline, with its failed jobs                                | Commit statuses                                | No                                       |
| Reviews                 | Reviewers and their states                                             | Reviews                                        | No                                       |
| Writes (when turned on) | Issues, labels, milestones, assignees, state, comments, merge requests | The same, plus blocked-by (issue dependencies) | None: read-only                          |
| Not offered             | Sub-issues and blocking links (paid GitLab features), Discussions      | Sub-issues, Discussions                        | Everything                               |

Actions that a forge can't do aren't offered for its cards.

## Who sees what

On GitHub, people sign in and Tack checks what each of them may read. On other forges nobody signs in, so Tack can't tell who may read a private project: **it only ever shows what's public.** An item in a private or internal project, or a confidential GitLab issue, is a placeholder for everyone, even when the instance's token could read it.

## Configuring forges

Forges are configured with one optional secret, `TACK_FORGES`, holding a JSON list. Each entry names a host and says what to change; entries for gitlab.com, codeberg.org and tangled.org change the defaults, and others add a self-hosted instance.

```json
[
	{
		"host": "git.example.com",
		"forge": "gitlab",
		"name": "Acme GitLab",
		"token": "glpat-…",
		"webhookSecret": "a long random string",
		"writes": true,
		"writers": ["octocat", "hubot"]
	},
	{ "host": "codeberg.org", "token": "…", "webhookSecret": "…" },
	{ "host": "tangled.org", "off": true }
]
```

Set it with `pnpm exec cf workers secrets update TACK_FORGES` (paste the JSON), or in the dashboard. Entries that don't make sense are left out, and the reason is logged as `forge.config.invalid`; the rest still apply.

| Field           | What it does                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `host`          | The forge's host name, like `git.example.com` (with a port if it needs one). GitHub can't be configured here        |
| `forge`         | `gitlab`, `forgejo` (also for Gitea) or `tangled`. Needed for hosts that aren't defaults                            |
| `name`          | What Tack calls it: "Acme GitLab". Defaults to the host                                                             |
| `token`         | The instance's own token for the host's API: a bot account's, never a person's. Without one, Tack reads anonymously |
| `webhookSecret` | Webhooks from the host are checked against it. Without one, they're refused                                         |
| `writes`        | `true` to let people push there with `token`. Off unless set; Tangled is always read-only                           |
| `writers`       | GitHub logins who may push there. Without it, any editor of a board may                                             |
| `off`           | `true` to stop serving a default host: its links become plain links                                                 |

### Tokens

Use a dedicated account: everything Tack writes there is as that account, whoever pushed it, and the push sheet says so ("Written on GitLab by this instance's own account, whoever pushes"). There's no "push as you" on other forges.

- **GitLab**: a personal, project or group access token with the `api` scope (`read_api` for reading only), for an account that's at least a Reporter on the projects people push to (Developer, to open merge requests).
- **Forgejo and Gitea**: an access token with `read:repository` and `read:issue`, plus `write:issue` and `write:repository` for writes, for an account with write access to the repositories.

### Webhooks

Webhooks make cards live. Add one on each project or repository (or once on a GitLab group or Forgejo organisation), pointing at your instance:

- **GitLab**: URL `https://<your instance>/webhooks/gitlab`, the host's `webhookSecret` as the **Secret token**, and the issue, merge request, comment and pipeline events.
- **Forgejo and Gitea**: URL `https://<your instance>/webhooks/forgejo`, content type `application/json`, the host's `webhookSecret` as the **Secret**, and the issue, pull request, comment and (where offered) commit status events.

A project counts as live for a week after its last delivery, and is checked while watched after that. The webhook secret lets whoever holds it tell Tack about any project on that host, so keep it to the people who set up webhooks, as you would the token.

Tangled has no webhooks: it's built on [atproto](https://atproto.com), and its issues and pulls are records in their authors' own repositories. Tack reads them through Tangled's index (`api.tangled.org`), learning which record an item's number is from its page once, and checks them every minute while a board has them open. Following the network's firehose (Jetstream, filtered to Tangled's collections) would make them live; that's the planned next step, not something an instance needs to set up.

## Rate limits

Each host has its own limits, kept apart from GitHub's: GitLab limiting the instance says nothing about GitHub. Anonymous reads hit them soonest, so give busy hosts a token.
