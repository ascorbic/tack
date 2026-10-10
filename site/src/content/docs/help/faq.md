---
title: FAQ
description: Common questions about Tack.
sidebar:
  order: 1
---

## Does moving cards change anything on GitHub?

No. Nothing you do to the layout touches GitHub. Only [pushing](/writing-back/pushing/) staged changes does, and someone has to review and push them.

## Is there a hosted Tack I can use?

No. Tack is self-hosted only for now: [deploy your own](/self-hosting/deploy/) on Cloudflare.

## Can I use it with repositories I don't own?

Yes, for public repositories: paste any public issue or pull request, with no setup. Cards from repositories without the app aren't live (they update about once a minute while the board's open), and Tack can't write there. To write to a repository, the app needs to be installed on it, and you need write access.

## Can people outside my organisation see my board?

Only if you share it with them, or make it public. Even then, cards from private repositories only show their details to people who can read those repositories on GitHub: everyone else sees a "Private" placeholder. See [Boards and sharing](/boards/boards-and-sharing/).

## Who does a pushed issue say made it?

You, "via Tack", if you push as yourself; the app's bot if you push as the bot. Either way, Tack checks that you can write to the repository first.

## Will pushing spam our watchers?

The push sheet says roughly how many people each repository's changes will notify before you push. New issues, pull requests, discussions, comments and closing or reopening notify watchers; labels, milestones and links between issues don't. Backlink comments are opt-in, one per item.

## Does Tack store copies of our issues?

It caches what each card shows, so boards load quickly, and refreshes it from GitHub. It never keeps its own version of an issue's state: GitHub is always the source of truth. What it does store is the board itself: layout, stickies, comments, votes, decisions and the push history.

## Which GitHub things can be cards?

Issues and pull requests on github.com. Discussions, releases, milestones and code links aren't cards, though [widgets](/widgets/overview/) can follow milestones and releases.

## Does it work with GitLab, Forgejo or Codeberg?

Not yet. Tack's core is forge-neutral, and other forges are planned, but GitHub is the only one today.

## Can I export a board?

Not yet: export (images, and board files to import elsewhere) is planned. You can copy shapes between boards, and pasting them into another app gives plain text: stickies' text and cards' links.

## Is there an API?

There's no public API yet.

## Does it work on phones?

Tack is built for a mouse or trackpad and a keyboard. Viewing, voting, commenting and adding stickies on phones is planned.
