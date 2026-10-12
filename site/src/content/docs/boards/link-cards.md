---
title: Link cards
description: Any web page on the board as a card with its preview, read once and kept on the board for everyone.
sidebar:
  order: 2.5
---

Paste a web address that isn't an issue or pull request onto the board, and it becomes a **link card**: the page's preview image, its site's name and icon, its title, a few lines of its description, and where it is. Docs you're planning around, a design, a competitor's changelog, a forum thread: they sit beside your [cards](/boards/cards/) and stickies, and look at home there.

## Adding one

- **Paste** an address onto the board (<kbd>⌘</kbd> <kbd>V</kbd>, or <kbd>Ctrl</kbd> <kbd>V</kbd>). Several addresses at once, one per line or separated by spaces, make several cards (up to 20 link cards in one go), in rows of four from the pointer. Issues and pull requests among them become their own cards, as ever: Tack always checks whether an address is something a forge can show as a card first.
- **Drop** a link onto the board: from your browser's address bar, a page, or a chat. It lands where you let go.

Only an address on its own makes a link card. "Read https://tack.social before Friday" stays a sticky, words and all. An address that's already on the board isn't added again: Tack shows you where it is and offers **Add another copy**.

While Tack reads the page, the card shows the address and a shimmer where the preview will be. It takes a moment, and the preview then appears for everyone on the board at once. Placing the card is one undo step; the preview arriving isn't another.

## What it shows

- **The preview image** the page chose for links (its Open Graph or Twitter card image), cropped to fit. A page without one gets a band in a colour of its site's own, with its icon (or its initial) on it.
- **The site**: its icon and name (or its address, if it doesn't give a name). The **↗** beside it opens the page straight away.
- **The title**. As with cards, clicking selects; clicking the title of a link card that's already selected opens the page in a new tab, and so does <kbd>⌘</kbd>-clicking it (<kbd>Ctrl</kbd> on Windows and Linux). <kbd>O</kbd> opens the selected one.
- Up to three lines of **description**, and the **host** underneath.

Zoomed out, a link card shrinks to its picture and a big title. In a [list or a grid of mini cards](/boards/sections/), it's a row with its site's icon. Link cards stack with stickies and cards (and a stack's name can come from what they say), take dot votes, stamps and comments, and appear in [exports and backups](/boards/export/), templates, history and [embeds](/boards/embeds/) like everything else.

## When there's no preview

- **A page that couldn't be read** (it didn't answer, or said it wasn't there): a plain card with the address and the site's initial, and "No preview: the page couldn't be read." Tack tries again an hour later.
- **An address Tack won't read**: a private or local address (a machine on your network, `localhost`), one on an unusual port, or one with a password in it. The card says "Tack doesn't read previews from this address." It still opens when you click it.
- **A page with nothing to say about itself**: its title, or its address, and no description.

A preview image that won't load falls back to the coloured band: there's never a broken image on the board.

## Fresh, but not live

A link card's preview is kept on the board, so it shows instantly, for everyone, even offline. It's read again quietly once it's a day old, the next time an editor has the board open. Unlike issue cards, link cards aren't live: a page doesn't tell Tack when it changes.

## Privacy

Tack reads pages and fetches their images on its own server, never from your browser, so the sites you link to never see who's looking at your board. Only editors who are signed in can make Tack read a page; viewers see what's already been read. What a preview says is part of the board's content, like a sticky's words: everyone who can open the board sees it, and on a [public board](/boards/boards-and-sharing/), so does everyone else.

Self-hosting? See [Link previews](/self-hosting/configuration/#link-previews) for what the instance fetches, and its limits.
