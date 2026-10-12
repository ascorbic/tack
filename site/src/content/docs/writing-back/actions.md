---
title: Built-in actions
description: Every action that stages changes for GitHub, what it needs selected, and what it writes.
sidebar:
  order: 2
---

Select something and the bar under the selection offers what you can do with it. It's above the selection when there's no room below, and it never leaves the screen: select a section bigger than the view and the bar stays at the top of it as you move around.

The bar is in groups, with a rule between them. **Settings**, such as a card's labels, milestone and assignees, are icons that say what they are when you hover over them. **Actions** have a word beside their icon: **Make issue**, **Make parent issue**, **Stack**, **Related**, **Close**, **Backlink**, **Summarise**, **Decide** and so on, the main one in colour. The bar is as wide as the window lets it be; when it's narrower than that, the actions that matter least go, whole, into the **…** menu at its end (AI's first, then the rest), and the settings and main action always stay.

Every action only **stages** changes: nothing is written until someone [pushes](/writing-back/pushing/). Each panel says so: "Not written until pushed."

Actions only appear for what the repository's forge supports. Ones that can't do anything say why instead of opening: "Tack can't write to these yet: install the app" for repositories without the [GitHub App](/self-hosting/github-app/), "Nobody can be assigned in acme/app", "Merged pull requests can't be closed or reopened".

**From the keyboard**: <kbd>Tab</kbd> from a selected shape (or <kbd>F6</kbd>) moves to the bar, the arrow keys move along it, <kbd>Enter</kbd> opens an action, and <kbd>Esc</kbd> goes back to the shape. In every panel, <kbd>⌘</kbd> <kbd>Enter</kbd> stages.

| Action                                                        | Key                                    | Select                                            | Writes                                |
| ------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------- | ------------------------------------- |
| [Make issues](#make-issues)                                   | <kbd>⌥</kbd> <kbd>I</kbd>              | Stickies                                          | One issue per sticky                  |
| [Parent issue](#parent-issue)                                 | <kbd>⌥</kbd> <kbd>⇧</kbd> <kbd>I</kbd> | A section, a stack, or several stickies and cards | A parent issue, plus sub-issue links  |
| [Labels](#labels-assignees-and-milestone)                     | <kbd>⌥</kbd> <kbd>L</kbd>              | Cards                                             | Labels added and removed              |
| [Milestone](#labels-assignees-and-milestone)                  | <kbd>⌥</kbd> <kbd>M</kbd>              | Cards                                             | The milestone                         |
| [Assign](#labels-assignees-and-milestone)                     | <kbd>⌥</kbd> <kbd>P</kbd>              | Cards                                             | Assignees added and removed           |
| [Close or reopen](#close-or-reopen)                           | <kbd>⌥</kbd> <kbd>C</kbd>              | Cards                                             | State, with a reason                  |
| [Blocked by](#blocked-by)                                     | <kbd>⌥</kbd> <kbd>B</kbd>              | A connector, or the two issues it joins           | A blocked-by dependency               |
| [Comment with a link to this board](/writing-back/backlinks/) | <kbd>⌥</kbd> <kbd>K</kbd>              | Cards                                             | A comment, optionally with a snapshot |
| [Write back](/writing-back/decision-records/)                 |                                        | A decided decision                                | An ADR pull request, or a Discussion  |

On Windows and Linux, <kbd>⌥</kbd> is <kbd>Alt</kbd>. [Expand related](/boards/cards/#expand-related) (<kbd>⌥</kbd> <kbd>E</kbd>) is in the same bar, but stages nothing.

## Make issues

Select stickies, then **Make issue** (or **Make N issues**).

- **The first line is the title**, and the rest is the body. A leading heading mark, bullet or checkbox is dropped from the title. Titles over 256 characters are cut at a word, and the whole line kept at the top of the body.
- **Repository**: the chosen one shows with how many of its cards are on the board; **Change** (or typing) lists the board's repositories, then ones you've used lately. Type `owner/repo`, or paste a link to a repository or anything in it, for another.
- **The titles** are listed, and can be reworded in place: what you type goes back onto the sticky. **+ description** shows an issue's body, and **Show all** lists every one.
- **Start with**: optionally pick **Labels**, a **Milestone** and **Assignees** to create the issues with, so they need no second push.
- Stickies that are already staged, or empty, are left out: "1 already staged, 1 empty sticky left out."

**Stage N issues** stages them. When they're pushed, each sticky turns into its issue's card, in the same place.

## Parent issue

Select a section on its own (**Make parent issue**), or several stickies and cards, then <kbd>⌥</kbd> <kbd>⇧</kbd> <kbd>I</kbd>. A [stack](/boards/stacks/) on its own works too: its name is the title, its stickies and issues the sub-issues (pull requests are left out), and it spreads out as its stickies become cards.

- **Title**: the section's title, to start with.
- **Repository**: the one most of the cards are in.
- **Sub-issues**: everything in the section, however deeply nested, top to bottom and left to right. Stickies become new issues too. Pull requests are left out: "only issues can be sub-issues".

**Stage with N sub-issues** stages the parent, any new issues, and a sub-issue link for each. A dashed card hovers above the section to show where the parent will land. When it's pushed, the parent's card lands above the section (or above the cards, for a selection), connected to each sub-issue.

### When some already have a parent

An issue can only have one parent on GitHub. Before you stage, the panel checks which cards already have one ("Checking which already have a parent…": from the card, or by asking GitHub, as [Expand related](/boards/cards/#expand-related) does). It also knows a section this board already made a parent issue, from the card connected down into it.

If they do, it says so, "#5 and #6 are already sub-issues of #4 Resizing.", and offers:

- **Add to #4 Resizing** (the default, when the section or every card that has a parent shares one): no new parent issue. What's new (stickies, and cards with no parent) is staged under #4. What's already under it is left alone.
- **Make a new parent and move them**: a new parent issue, with each card taken off the parent it has. Each row says "moves from #4", and so do the changes: "Move #5 from #4 to “Resizing”".
- **Make a new parent without them**: a new parent issue for the rest. Cards with a parent stay where they are.

Each sub-issue in the list says what will happen to it.

## Labels, assignees and milestone

Select one or more cards.

- **Labels** (<kbd>⌥</kbd> <kbd>L</kbd>) and **Assign** (<kbd>⌥</kbd> <kbd>P</kbd>) show a checklist. A box is ticked if every selected item has it, dashed if some do. Only what you toggle changes: "+2 −1 on 3 items". With cards from several repositories, only the labels (or people) every one of them has are offered.
- **Milestone** (<kbd>⌥</kbd> <kbd>M</kbd>) picks one of the repository's open milestones, starting on the items' current one (ticked), or **No milestone**, last in the list.

Discussions take labels like issues do, though only labels the repository already has (GitHub can't make a new one on a discussion). They have no assignees or milestones: with only discussions selected those aren't offered, and with some, they say so.

## Close or reopen

<kbd>⌥</kbd> <kbd>C</kbd> offers what fits the selection:

- **Close as completed**: done, closed, fixed, resolved
- **Close as not planned**: won't fix, can't reproduce, stale
- **Close as duplicate**
- **Reopen**

Pull requests close without a reason, and merged pull requests can't be closed or reopened.

Discussions close as GitHub words it for them: **Close as resolved**, **Close as outdated** or **Close as duplicate**.

## Blocked by

Select a connector between two issues and choose **Blocked by** in its toolbar (<kbd>⌥</kbd> <kbd>B</kbd>), or select the two issues it joins and choose **Blocked by** in their bar. The arrow points from the blocker to what it blocks: "#377 will be marked as blocked by #412". **Swap** turns it round.

Both ends need to be issues (or stickies already staged as issues: "Make “…” an issue first, then link it"). Pull requests can't block or be blocked.

## From widgets

Two widgets stage changes too:

- **Drop to match**: drop cards on a [list](/widgets/list/#drop-to-match), and Tack stages the labels, assignees, milestone and state that would make them match its search.
- **Stale finder**: each row can be closed as not planned, labelled, or asked about with a comment. See [Stale finder](/widgets/stale-finder/).

## Undoing

Each action is one undo step, with an **Undo** toast. Once staged, a change can be unstaged from the [changes panel](/writing-back/overview/#the-changes-panel) until it's pushed.
