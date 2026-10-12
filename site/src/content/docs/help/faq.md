---
title: FAQ
description: Common questions about Tack.
sidebar:
  order: 1
---

## Does moving cards change anything on GitHub?

No. Nothing you do to the layout touches GitHub. Only [pushing](/writing-back/pushing/) staged changes does, and someone has to review and push them.

## Is there a hosted Tack I can use?

No. Tack is self-hosted only for now: [deploy your own](/self-hosting/deploy/) on Cloudflare. To see it first, [try it in your browser](/try/): a board with pretend teammates and a pretend forge, where nothing leaves your browser except what you ask the AI to read.

## Can I use it with repositories I don't own?

Yes, for public repositories: paste any public issue or pull request, with no setup. Cards from repositories without the app aren't live (they update every one to five minutes while the board's open), and Tack can't write there. To write to a repository, the app needs to be installed on it, and you need write access.

## Can people outside my organisation see my board?

Only if you share it with them, or make it public. Even then, cards from private repositories only show their details to people who can read those repositories on GitHub: everyone else sees a "Private" placeholder. See [Boards and sharing](/boards/boards-and-sharing/).

## Who does a pushed issue say made it?

You, "via Tack", if you push as yourself; the app's bot if you push as the bot. Either way, Tack checks that you can write to the repository first.

## Will pushing spam our watchers?

The push sheet says roughly how many people each repository's changes will notify before you push. New issues, pull requests, discussions, comments and closing or reopening notify watchers; labels, milestones and links between issues don't. Backlink comments are opt-in, one per item.

## Does Tack store copies of our issues?

It caches what each card shows, so boards load quickly, and refreshes it from GitHub. It never keeps its own version of an issue's state: GitHub is always the source of truth. What it does store is the board itself: layout, stickies, comments, votes, decisions, its history and the push history.

## Which things can be cards?

Issues, pull requests and discussions on github.com, and issues and merge or pull requests from GitLab, Codeberg and other Forgejo instances, and Tangled. Releases, milestones and code links aren't cards (pasted, they're [link cards](/boards/link-cards/)), though [widgets](/widgets/overview/) can follow milestones and releases.

## Does it work with GitLab, Forgejo or Codeberg?

Yes, beside GitHub. Every instance reads public projects on gitlab.com, codeberg.org and tangled.org with no setup; give it a token and webhooks for a host to make its cards live and, if you want, to push there. Self-hosted GitLab and Forgejo work the same way. Sign-in is always with GitHub. See [Other forges](/self-hosting/forges/).

## Does Tack use AI?

Only where it helps and you can see it: naming [stacks](/boards/stacks/), sorting a selection or a section into named stacks (Auto-stack), and, when an editor asks, setting up a widget from a sentence, summarising a selection or drafting a decision. It runs on Workers AI in the instance's own Cloudflare account, reads only what the person asking can read, and shows everything before it goes on the board. An instance can turn it off. See [AI](/boards/ai/).

## Can I export a board?

Yes: as a PNG or SVG (the whole board, or what's selected), or as JSON to import into a new board, here or on another Tack. A board's owner can also have Tack back it up to a branch on GitHub. See [Export, import and backups](/boards/export/). You can also copy shapes between boards, and pasting them into another app gives plain text: stickies' text and cards' links.

## Is there an API?

There's no public API yet.

## Does it work on phones?

Yes. On a phone you can look around a board, vote, comment and add stickies; on a tablet you can do everything, with a finger or a pencil. See [Phones and tablets](/boards/phones-and-tablets/).
