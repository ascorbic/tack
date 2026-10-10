---
title: Built-in actions
description: Every action that stages changes for GitHub, what it needs selected, and what it writes.
sidebar:
  order: 2
---

Select something and the bar under the selection offers what you can do with it. Every action only **stages** changes: nothing is written until someone [pushes](/writing-back/pushing/). Each panel says so: "Not written until pushed."

Actions only appear for what the repository's forge supports, and are disabled with "Tack can't write to these yet: install the app" for repositories without the [GitHub App](/self-hosting/github-app/).

| Action                                                        | Key                                    | Select                                   | Writes                                |
| ------------------------------------------------------------- | -------------------------------------- | ---------------------------------------- | ------------------------------------- |
| [Make issues](#make-issues)                                   | <kbd>⌥</kbd> <kbd>I</kbd>              | Stickies                                 | One issue per sticky                  |
| [Parent issue](#parent-issue)                                 | <kbd>⌥</kbd> <kbd>⇧</kbd> <kbd>I</kbd> | A section, or several stickies and cards | A parent issue, plus sub-issue links  |
| [Labels](#labels-assignees-and-milestone)                     | <kbd>⌥</kbd> <kbd>L</kbd>              | Cards                                    | Labels added and removed              |
| [Milestone](#labels-assignees-and-milestone)                  | <kbd>⌥</kbd> <kbd>M</kbd>              | Cards                                    | The milestone                         |
| [Assign](#labels-assignees-and-milestone)                     | <kbd>⌥</kbd> <kbd>P</kbd>              | Cards                                    | Assignees added and removed           |
| [Close or reopen](#close-or-reopen)                           | <kbd>⌥</kbd> <kbd>C</kbd>              | Cards                                    | State, with a reason                  |
| [Blocked by](#blocked-by)                                     | <kbd>⌥</kbd> <kbd>B</kbd>              | A connector between two issues           | A blocked-by dependency               |
| [Comment with a link to this board](/writing-back/backlinks/) | <kbd>⌥</kbd> <kbd>K</kbd>              | Cards                                    | A comment, optionally with a snapshot |
| [Write back](/writing-back/decision-records/)                 |                                        | A decided decision                       | An ADR pull request, or a Discussion  |

On Windows and Linux, <kbd>⌥</kbd> is <kbd>Alt</kbd>. [Expand related](/boards/cards/#expand-related) (<kbd>⌥</kbd> <kbd>E</kbd>) is in the same bar, but stages nothing.

## Make issues

Select stickies, then **Make issue** (or **Make N issues**).

- **The first line is the title**, and the rest is the body. A leading heading mark, bullet or checkbox is dropped from the title. Titles over 256 characters are cut at a word, and the whole line kept at the top of the body.
- **Repository**: the board's repositories come first, with how many cards each has, then ones you've used lately. Type `owner/repo` for another.
- **Start with**: optionally pick **Labels**, a **Milestone** and **Assignees** to create the issues with, so they need no second push.
- Stickies that are already staged, or empty, are left out: "1 already staged, 1 empty sticky left out."

**Stage N issues** stages them. When they're pushed, each sticky turns into its issue's card, in the same place.

## Parent issue

Select a section on its own (**Parent issue**), or several stickies and cards, then <kbd>⌥</kbd> <kbd>⇧</kbd> <kbd>I</kbd>.

- **Title**: the section's title, to start with.
- **Repository**: the one most of the cards are in.
- **Sub-issues**: everything in the section, however deeply nested, top to bottom and left to right. Stickies become new issues too. Pull requests are left out: "only issues can be sub-issues".

**Stage with N sub-issues** stages the parent, any new issues, and a sub-issue link for each. A dashed card hovers above the section to show where the parent will land. When it's pushed, the parent's card lands above the section (or above the cards, for a selection), connected to each sub-issue.

## Labels, assignees and milestone

Select one or more cards.

- **Labels** (<kbd>⌥</kbd> <kbd>L</kbd>) and **Assign** (<kbd>⌥</kbd> <kbd>P</kbd>) show a checklist. A box is ticked if every selected item has it, dashed if some do. Only what you toggle changes: "+2 −1 on 3 items". With cards from several repositories, only the labels (or people) every one of them has are offered.
- **Milestone** (<kbd>⌥</kbd> <kbd>M</kbd>) picks one of the repository's open milestones, or **No milestone**.

## Close or reopen

<kbd>⌥</kbd> <kbd>C</kbd> offers what fits the selection:

- **Close as completed**: done, closed, fixed, resolved
- **Close as not planned**: won't fix, can't reproduce, stale
- **Close as duplicate**
- **Reopen**

Pull requests close without a reason, and merged pull requests can't be closed or reopened.

## Blocked by

Select a connector between two issues and choose **Blocked by** in its toolbar (<kbd>⌥</kbd> <kbd>B</kbd>). The arrow points from the blocker to what it blocks: "#377 will be marked as blocked by #412". **Swap** turns it round.

Both ends need to be issues (or stickies already staged as issues: "Make “…” an issue first, then link it"). Pull requests can't block or be blocked.

## From widgets

Two widgets stage changes too:

- **Drop to match**: drop cards on a [list](/widgets/list/#drop-to-match), and Tack stages the labels, assignees, milestone and state that would make them match its search.
- **Stale finder**: each row can be closed as not planned, labelled, or asked about with a comment. See [Stale finder](/widgets/stale-finder/).

## Undoing

Each action is one undo step, with an **Undo** toast. Once staged, a change can be unstaged from the [changes panel](/writing-back/overview/#the-changes-panel) until it's pushed.
