---
title: Accessibility
description: Using a board from the keyboard and with a screen reader, contrast in both themes, and reduced motion.
sidebar:
  order: 10
---

A board is a canvas, but you don't need a mouse to use one, or to see it to follow along.

## Getting around from the keyboard

The first thing <kbd>Tab</kbd> reaches on a board's page is **Skip to board**, which jumps past the top bar to the board itself. From there:

- <kbd>Tab</kbd> and <kbd>Shift</kbd> <kbd>Tab</kbd> go through every shape in reading order: top to bottom in rows, each row left to right, and each section followed by what's in it (a list in its own order). Past the last shape, <kbd>Tab</kbd> leaves the board for the zoom controls and the toolbar, and coming back lands on the shape you were last on.
- The arrow keys go to the nearest shape that way, staying inside a section until there's nothing further that way in it.
- <kbd>Home</kbd> and <kbd>End</kbd> go to the first and last shape.
- Shapes out of view are brought into view as you reach them.

A ring shows which shape you're on. Being on a shape isn't selecting it:

- <kbd>Enter</kbd> or <kbd>Space</kbd> selects it. Then the arrow keys nudge it (<kbd>Shift</kbd> for 10px), <kbd>Enter</kbd> edits its words or renames it, <kbd>Tab</kbd> reaches its actions (labels, milestone, making issues and the rest), and <kbd>Esc</kbd> deselects it, leaving you where you were.
- <kbd>O</kbd> opens a card's issue or pull request in a new tab (a decision's pull request, an action item's issue).

Moving away from a selection clears it, so <kbd>Delete</kbd> never removes something you've moved on from. Every shortcut is listed under [Keyboard shortcuts](/boards/shortcuts/), and <kbd>?</kbd> shows them on the board.

## With a screen reader

- **The board** is a region named "Board", described by a summary of what's on it: how many sections, stickies and cards, then each section and what's in it. It stays current as the board changes.
- **Each shape** says what it is and what it says: "sticky note, Ship the docs, by Kai, in Went well"; "card, imagekit #412: Netlify ignores quality, open issue"; "section, To improve, 3 sticky notes". A face-down sticky in silent mode says only who wrote it (and, if it's yours, your words and that they're hidden).
- **Other people's changes** are announced politely, gathered up a few seconds at a time so a busy session isn't a stream of chatter: "Others added 2 stickies, moved 1 card".
- **Nudges** are announced once they settle ("Moved 1 sticky note 10 right"), and so is a push that's still going after you close the push sheet ("Pushing 3 changes", "Push finished"). Toasts are announced as they appear.

## Contrast and motion

Text meets WCAG AA contrast in both the light and dark themes, including label chips in any label colour and people's colours behind white names. Text that's quieter on purpose (paused rules, a waiting push step, an untitled section) stays readable rather than fading.

Tack follows your system's **reduce motion** setting: every animation and transition shortens to nothing, and anything that loops (spinners, shimmers, a blinking caret) plays once and rests instead.

Something not working for you? [Open an issue](https://github.com/ascorbic/tack/issues/new).
