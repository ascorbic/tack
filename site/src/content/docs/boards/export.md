---
title: Export, import and backups
description: Save a board or a selection as a PNG or SVG, export a board as JSON and import it into a new board, and back boards up to a branch on GitHub.
sidebar:
  order: 9
---

A board can leave Tack as an image, for docs, slides and chat, or as a file that holds the board itself, to import into a new board here or on another Tack. Its owner can also have Tack back it up to a branch on GitHub.

## Exporting

Open **Export** from the board's menu (the **⋯** beside its title), or press <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>E</kbd> (<kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>E</kbd> on Windows and Linux). Anyone who can open a board can export it, viewers included. Choose a format:

| Format   | What you get                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **PNG**  | An image, at 1×, 2×, 3× or 4× the board's size. **Copy** puts it on the clipboard, ready to paste.                                               |
| **SVG**  | An image that stays sharp at any size. It draws the board's own HTML inside SVG, so it opens in browsers; design tools may not read it.          |
| **JSON** | The board as data: every shape, with its rules and the facilitation steps prepared for it. Import it into a new board. **Copy** copies the JSON. |

For images, choose **Selection** (what's selected, with everything inside a selected section and the connectors between what's drawn) or **Whole board**, and whether to keep the board's **Background** or leave it transparent. The preview shows the image as it'll come out, and the size it'll be. Images are drawn in the theme you're using.

Images show the board as it is: nobody's cursor, selection or comment pins, no staged-change marks, stamps, dots or "what's new" rings. Every shape is drawn whole, even those out of view, so the board fades for a moment while it's drawn. Very large boards are drawn smaller, to stay within what browsers can draw, and the dialog says so.

Tack remembers your format, scale and background in this browser.

## What JSON leaves out

A board's file is its content, not anyone's own part of it:

- comments, history and visits, which aren't part of the board's content
- votes on decisions, dot votes and stamps: who voted for what is theirs
- stickies still face down in silent mode: their text is their author's until it's revealed
- staged changes, and where cards came from (inboxes, rules, lists)
- cards from repositories you can't read, and the issues action items link to there; the dialog says how many

Cards are their links, so an imported board shows them as they are now on GitHub, to whoever can read them.

## Importing

On the home page, choose **New board**, then **Import a board** under **From a file**. Drop a board's `.json` on it, choose the file, or paste its JSON. Tack checks it and shows what's in it; name the board, choose who can open it, and choose **Import board**.

The new board is yours, with everything in the file and new ids throughout. Rules count as made by you. Files from older versions of Tack are upgraded as they're read; a file from a newer version than this Tack is turned away, with a note to update first. Files can be up to 4 MB, and 10,000 shapes.

## Backing up to GitHub

A board's owner can have Tack commit its JSON to a branch of a repository now and then: choose **Back up to GitHub…** from the board's menu, then a repository (`owner/name`), a branch and how often: **Every hour**, **Every day** or **Every week**.

- **A branch of its own.** The first backup makes the branch with no history (an orphan branch), so none of the repository's own files come along; every backup after that is a commit on top. The branch's history is the board's. Each board writes `boards/<board id>.json`, so boards can share a branch. Tack never writes to the repository's default branch.
- **As the Tack app.** Backups are written by the app, only to a repository where it's installed and where you, the owner, can write. Tack checks both again before every backup, with the owner's own access, so if either changes, backups stop and the dialog says why. If someone else becomes the board's owner, it's their access that counts.
- **Only when something's changed.** A backup that would be the same as the last isn't written. **Back up now** writes one straight away.
- **Who can read them.** Anyone who can read the repository can read the backups, stickies, text and decisions included. Cards from repositories that aren't public are left out, unless they're from the backup's own repository. If the repository is public and the board isn't, the dialog says so.

**Turn off backups** stops them; the branch and its commits stay where they are. To restore a backup, download its file from GitHub and [import it](#importing) into a new board.

Editors can see whether a board is backed up, and where; only its owner can change it.
