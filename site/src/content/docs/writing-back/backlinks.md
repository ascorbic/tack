---
title: Backlinks
description: Comment on issues with a link back to the board, and optionally a snapshot of it.
sidebar:
  order: 5
---

A backlink is a comment on an issue or pull request that links back to the board, so people on GitHub can find where it was discussed.

Select one or more cards and choose **Comment with a link to this board** (<kbd>⌥</kbd> <kbd>K</kbd>). Add an optional **Note**, and **Stage N comments**. Like every action, nothing is written until someone [pushes](/writing-back/pushing/).

## What the comment says

Your note, if you wrote one, then:

> This is on **Imagekit 5.0 planning** in Tack, in the **Now** section.

The board's name links to the board. The section is only mentioned if the card is in a titled section.

## Snapshots

**Include a snapshot of the board** adds an image of the board around the item, linking to the board. It's **off by default**, and Tack remembers your choice for each board, in your browser. Nothing is drawn or uploaded unless it's on.

- The image is drawn in your browser, from the board at rest: no selection, cursors, toolbars or staged marks. It frames the item and the shapes near it, whole, with even space around them.
- When the comments go to more than one audience, the panel shows the **versions** of the image, one for each ("For public repos", "For acme/vault"): each comment gets the one its readers can see.
- **Private cards stay private.** A comment in a public repository can be read by anyone, so cards from private repositories are replaced in its image by a "Private card" placeholder. A comment in a private repository gets an image of its own, keeping that repository's cards. The panel says when it's hiding something: "A card from a private repository is hidden in this image, since the comment is public."
- Snapshots are stored on your instance and served at `/snapshots/….png`, with an unguessable name that says nothing about the board, so GitHub's image proxy can fetch them. Each is at most 1.5 MB and 4096 pixels a side, and a board can hold 1000.

If the image shows as broken on GitHub, your instance's `/snapshots/` address isn't reachable from the internet.
