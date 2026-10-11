---
title: Search syntax
description: What searches widgets, inboxes and rules understand.
sidebar:
  order: 10
---

Widgets, inboxes and rules all take searches written as on GitHub, like `repo:owner/name is:issue is:open label:bug`.

## Widgets and inboxes

Widgets and inboxes send the search to GitHub, so **anything GitHub's issue search understands works**. Tack reads a few qualifiers itself, to know when to refresh:

- `repo:owner/name`: refreshes when that repository changes
- `org:`, `user:` and `owner:`: refreshes when anything of theirs on the board changes
- no scope at all: "searches everywhere you can see", refreshing on any change the board hears about and every few minutes

People who aren't signed in only see public results: Tack adds `is:public` for them. `@me` means whoever's looking, and nothing for someone signed out.

## Rules

[Rules](/automation/rules/) run when GitHub sends a webhook, checking the item in the webhook against the search without asking GitHub. So they understand a subset:

| Understood                       | Examples                                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Words, matched against the title | `flaky`, `-wip`                                                                                                             |
| Where                            | `repo:owner/name` (at least one is required), `org:`, `user:`, `owner:`                                                     |
| Kind and state                   | `is:issue`, `is:pr`, `is:open`, `is:closed`, `is:merged`, `is:unmerged`, `is:draft`, `state:open`, `type:pr`, `draft:false` |
| Labels                           | `label:bug`, `-label:wontfix`, `label:"good first issue"`, `label:bug,regression`                                           |
| People                           | `author:octocat`, `assignee:octocat`, `no:assignee`                                                                         |
| Missing labels                   | `no:label`                                                                                                                  |
| Close reason                     | `reason:completed`, `reason:"not planned"`                                                                                  |
| Counts                           | `comments:>5`, `reactions:>=10`                                                                                             |
| Ignored                          | `sort:`, `in:`                                                                                                              |

Anything else (dates, milestones, review state, `is:public`, `linked:`, `involves:`) can't be checked by a rule yet: "Rules can't check “milestone:v1” yet." And `@me` doesn't work in a rule, since "Rules run for the whole board, so “@me” means nobody in particular."

Commas mean "any of": `label:bug,regression` matches either label.
