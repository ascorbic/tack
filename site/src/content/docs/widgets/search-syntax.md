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

### Discussions

As on GitHub, a search finds issues and pull requests unless it asks for discussions: `is:discussion` (or `type:discussion`) makes it a search of the repository's [discussions](/boards/cards/#discussions) instead, which understands `is:answered`, `is:unanswered`, `is:locked`, `category:"Q&A"`, labels, authors and the rest. Discussions are only searched for people who are signed in, as GitHub only searches them with an account.

Only categories that take answers (Q&A, and others set up like it) have answered or unanswered discussions: `category:Ideas is:unanswered` finds nothing, on GitHub and in Tack.

`sort:top` orders discussions by upvotes, the most first (`sort:top-asc` the fewest), as a list's **Top** does; GitHub's search understands it for discussions only, so for issues and pull requests **Top** means `sort:reactions`. GitHub's search index can lag behind the votes themselves, so Tack puts what comes back in order of the upvotes each discussion has now. A list's [Discussions mode](/widgets/list/#discussions) writes these for you.

## Rules

[Rules](/automation/rules/) run when GitHub sends a webhook, checking the item in the webhook against the search without asking GitHub. So they understand a subset:

| Understood                       | Examples                                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Words, matched against the title | `flaky`, `-wip`                                                                                                             |
| Where                            | `repo:owner/name` (at least one is required), `org:`, `user:`, `owner:`                                                     |
| Kind and state                   | `is:issue`, `is:pr`, `is:open`, `is:closed`, `is:merged`, `is:unmerged`, `is:draft`, `state:open`, `type:pr`, `draft:false` |
| Discussions                      | `is:discussion`, `is:answered`, `is:unanswered` (in categories that take answers), `is:locked`, `category:Ideas`            |
| Labels                           | `label:bug`, `-label:wontfix`, `label:"good first issue"`, `label:bug,regression`                                           |
| People                           | `author:octocat`, `assignee:octocat`, `no:assignee`                                                                         |
| Missing labels                   | `no:label`                                                                                                                  |
| Close reason                     | `reason:completed`, `reason:"not planned"`                                                                                  |
| Counts                           | `comments:>5`, `reactions:>=10`                                                                                             |
| Ignored                          | `sort:`, `in:`                                                                                                              |

Anything else (dates, milestones, review state, `is:public`, `linked:`, `involves:`) can't be checked by a rule yet: "Rules can't check “milestone:v1” yet." And `@me` doesn't work in a rule, since "Rules run for the whole board, so “@me” means nobody in particular."

Commas mean "any of": `label:bug,regression` matches either label.
