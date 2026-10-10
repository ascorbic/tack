---
title: Comment commands
description: Put an issue or pull request on a board from a comment on GitHub.
sidebar:
  order: 3
---

Anyone working on GitHub can put an issue or pull request on a board without opening Tack, by mentioning the app in a comment on it:

```text
@tack-example-com add to Roadmap
@tack-example-com add to Roadmap in Next up
@tack-example-com help
```

The app answers to its slug: the name in its address on GitHub, `github.com/apps/<slug>` (**App settings** on `/setup` links there). The instance can add shorter names: see [Aliases](#aliases).

## Adding to a board

`add to <board>` puts the item on a board; `on` and `onto` work too. Name the board by its title, or paste its link, which always works. Titles match forgivingly (the start of one, some of its words, or with a typo or two), but if more than one of your boards matches, the app asks which.

`in <section>` (or `into`) puts it straight into a section of that board, or just below the section if it's full. Without a section, it goes below the last card a comment brought, or beside everything on the board. An item that's already on the board isn't added again.

The card remembers who asked: its foot says "Added from GitHub by @login", and links to the comment. It's treated as placed by that person: it's never marked as no longer matching, and [since you were here](/facilitation/since-you-were-here/) credits them.

## Who can

The person commenting must have signed in to Tack once (so it knows who they are), be on the instance's [access list](/self-hosting/access/), and be able to **edit** the board. Boards they can't open don't exist as far as the app's concerned; archived boards can't be added to.

Items from **private repositories** only go on **private boards** whose members can **all** read the repository, with no one invited who hasn't signed in yet. That's stricter than pasting a link, on purpose: nobody on the board chose the card, and even its number names the repository.

Commands need the [GitHub App installed](/self-hosting/repositories/) on the item's repository, since they arrive as webhooks.

## The app's answers

The app reacts to the comment with 👀 while it works, then replies, and swaps 👀 for 🚀 when it worked (or the item was already there) or 😕 when it didn't:

- "📌 Added this issue to **Roadmap** in “Next up”."
- "👍 This issue is already on **Roadmap**."
- "👋 I don't know you on Tack yet. Sign in once, then ask me again."
- "🤔 I couldn't find a board called “Roadmap” that you can edit. Its link always works: open the board and copy the address."
- "🔒 You can see “Roadmap” but can't edit it, so I can't add to it. Its owner can make you an editor."
- "🔒 This repository is private, and I've left this off “Roadmap”: …"

Replies are public wherever the item is, so they never name a board or section that isn't public unless the commenter already did, and anything quoted from a comment or a board is defused: no mentions, links or formatting.

Each comment runs once, even if GitHub delivers it twice or someone edits it. An edit counts only if the comment held no command before. Comments by bots, including the app's own replies, are never commands. Each repository gets at most 30 replies an hour; past that, the reactions still say how it went.

## Aliases

Mentioning a long app slug is a mouthful. An instance can answer to shorter names too, set as `TACK_COMMAND_ALIAS` in `cloudflare.config.ts` (comma-separated, empty by default). Choose carefully: a short name like `tack` is someone's real GitHub login, and every command would notify them.

Apps set up before comment commands existed need the **Issue comment** event turned on: see [When Tack needs new permissions](/self-hosting/upgrades/#when-tack-needs-new-permissions).
