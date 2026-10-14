---
title: Cards
description: Live GitHub issues, pull requests and discussions on the board, and what each part of a card means.
sidebar:
  order: 2
---

A card is a live view of a GitHub issue, pull request or discussion. Tack never keeps its own copy of the item's state: the card shows what GitHub says, and changes when GitHub does.

## Adding cards

- **The card tool** (<kbd>C</kbd>): type a few words to search the board's repositories (the ones its cards, inboxes and widgets are from, busiest first), or start with `owner/repo` to search that one. Results show as you type: <kbd>↑</kbd> <kbd>↓</kbd> to choose, <kbd>Enter</kbd> to add, <kbd>⌘</kbd> <kbd>Enter</kbd> to add every result that isn't on the board yet. It finds issues, pull requests and discussions alike; **Issues**, **Pull requests** or **Discussions** under the results looks for only that kind (as `is:issue`, `is:pr` or `is:discussion` in the words would). It also takes a link, `owner/repo#123`, or just `#123` for the board's busiest repository. The tool stays open, so you can add several in a row; <kbd>Esc</kbd> closes it.
- **Paste** a link onto the board (<kbd>⌘</kbd> <kbd>V</kbd>, or <kbd>Ctrl</kbd> <kbd>V</kbd>). Several links, one per line, make several cards (up to 50), in rows of four from the pointer.
- From a **list widget**: drag a row onto the board. See [List](/widgets/list/).
- From an **inbox**: drag or click an item out of its tray. See [Inbox frames](/automation/inboxes/).
- **Expand related** (<kbd>⌥</kbd> <kbd>E</kbd>) lays out an issue's parent, sub-issues, dependencies and linked pull requests around it. See below.

New cards never land on anything: each goes in the nearest free space, beside the last one you added while it's in view, and the view follows if it has to. An item that's already on the board isn't added again: Tack shows you where it is ("emdash#412 is already on the board") and offers **Add another copy**, for when you do want two.

Tack understands:

- issue, pull request and discussion URLs on github.com: `https://github.com/owner/repo/issues/12`, `https://github.com/owner/repo/pull/34` and `https://github.com/owner/repo/discussions/56` (anything after the number, like `/files` or `#discussioncomment-7`, is fine, and so are `www.` and `http://`)
- the short form `owner/repo#12`, whichever of the three it is: on GitHub, discussions share their repository's numbers with its issues and pull requests
- issues and merge requests on GitLab (`https://gitlab.com/group/project/-/issues/12`, `/-/merge_requests/34`, in groups as deep as they go), issues and pull requests on Codeberg (`https://codeberg.org/owner/repo/issues/12`, `/pulls/34`), and issues and pulls on Tangled (`https://tangled.org/handle/repo/issues/12`), plus any self-hosted GitLab or Forgejo your instance [is set up for](/self-hosting/forges/)

Releases, milestones, commits and code links aren't cards (nor are discussions on GitLab, Codeberg or Tangled, which have none like GitHub's): like any other web address, they become [link cards](/boards/link-cards/), with the page's preview. Pasting text that isn't only links makes a sticky instead.

## What a card shows

- **The head**: an icon for the kind and state, the repository's name and number (`unpic #412`), and the state: **Open**, **Closed**, **Merged**, **Draft** or **Not planned**.
- **The title**. Clicking a card selects it, as with any shape; clicking the title of a card that's already selected opens the item on GitHub, and so does <kbd>⌘</kbd>-clicking it (<kbd>Ctrl</kbd> on Windows and Linux). The **↗** beside the state opens it straight away.
- Up to four **labels**, in their colours.
- **The foot**: up to three assignees, the comment count, the reaction count (point at it, tab to it or tap it to see who reacted, by reaction: Tack asks GitHub then, and shows just the count if it can't), where the card came from (see [Where cards come from](/automation/provenance/)), and whether it's live.

Pull requests also show:

- **CI**: a bar split into failed, running, passed and skipped checks, with a summary ("1 failing · 10 passed", "4 of 12 running", "All 9 checks passed"), and the names of up to three failing checks, linked
- **Reviews**: reviewers with their verdicts, and "Approved", "Changes requested" or "Review required"
- **Conflicts**, when the branch has conflicts to resolve
- **Linked issues**: "Closes #412 …"

When the board is zoomed out a long way, cards shrink to their state, number, title and CI bar, so a board of hundreds of cards stays readable.

When a card changes on GitHub while you're looking, it pulses and the changed parts flash.

## Discussions

A GitHub Discussion is a card of its own, with a speech bubble where an issue has its ring:

- **The state**: **Open** (in blue), **Answered** with a tick (in green) once an answer's chosen, or **Resolved**, **Outdated** or **Duplicate** once it's closed. Hover **Answered** to see whose answer it is.
- **The category**, its emoji and name (`🙏 Q&A`), ahead of the labels.
- **The foot**: who started it, its **upvotes**, its comments, and a lock when it's locked.

Discussions take labels, closing (as resolved, outdated or duplicate), reopening and backlinks from the bar under them, staged and pushed like any change (see [Actions](/writing-back/actions/)). They have no assignees, milestones, sub-issues or dependencies, so those aren't offered, and **Expand related** isn't either. A list widget follows discussions when its search says `is:discussion` (the **Unanswered questions** list does); otherwise lists, inboxes and rules search issues and pull requests, as GitHub does.

Discussions need the GitHub App's **Discussions** permission. On an instance set up before Tack showed them, the app's owner adds it and each account accepts it; until then a discussion's card says the app needs it, with **Review permissions**. See [The GitHub App](/self-hosting/github-app/).

## Live and not live

How fresh a card is depends on whether the [GitHub App](/self-hosting/github-app/) is installed on its repository:

- **Installed**: the card is live. GitHub sends Tack a webhook when the item changes, and the card updates within seconds.
- **Not installed** (public repositories only): the card shows **Not live**. Tack checks the repository every minute or so while someone has the board open (every five minutes when nobody watching is signed in): Its tooltip leads with what that means, "Read-only: Tack can't push here", and links to **Install the app**, which takes an owner of the account (GitHub asks one if that isn't you).

Checks and reviews need the app too: without it, a pull request card says "Checks and reviews need the GitHub App".

See [Repositories, live and not](/self-hosting/repositories/) for the details.

Cards from GitLab, Codeberg and Tangled have no app to install. They're live while webhooks from their repository keep arriving, and otherwise show **Not live**, "Checked while you look"; whether Tack can push there is up to the instance. See [Other forges](/self-hosting/forges/).

## Private repositories

A card from a private repository only shows its details to people who can read that repository on GitHub, checked with their own GitHub account. Everyone else sees a placeholder with a lock and a **Private** chip: "This is in a private repository you can't see on GitHub, so its details stay hidden." If you've just been given access, choose **Got access? Check again**.

On other forges, Tack only ever shows what's public: an item in a private project, or a confidential GitLab issue, is a placeholder for everyone ("This isn't public on GitLab, and Tack only shows what's public there").

The same goes for a pull request's linked issues: one in a private repository you can't read shows as "in a private repository".

Other cards that can't load say why: "You don't have access to this repository.", "This item doesn't exist, or was deleted.", or "Tack can't read acme/vault. If it's private, an owner of acme can install the app on it."

## Expand related

Select one card and press <kbd>⌥</kbd> <kbd>E</kbd> (or **Related** in the bar under it). Tack asks GitHub, as you, what's related to the item, and offers each group with a switch:

| Group                                             | Placed                             |
| ------------------------------------------------- | ---------------------------------- |
| Parent                                            | Above                              |
| Closes (for a pull request: the issues it closes) | Above                              |
| Sub-issues                                        | Below, in rows of four             |
| Blocked by                                        | To the left                        |
| Blocking                                          | To the right                       |
| Linked pull requests                              | To the right, above what it blocks |

A little compass shows where each group will go. **Lay out** (<kbd>Enter</kbd>) adds the cards, each group sliding to the nearest clear space, and draws connectors: parent to child for the hierarchy, blocking in red from blocker to blocked, and pull requests dashed purple (labelled "closes" when they close the issue). Items already on the board are connected where they are, and nothing is connected twice.

Expanding doesn't stage anything for GitHub, so it works on any repository Tack can read, and the whole expansion is one undo step. Anything from a repository you can't read is left out entirely.
