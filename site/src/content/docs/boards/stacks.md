---
title: Stacks
description: Drop a sticky onto another to stack them, named from what they say. Group a whole selection into themes at once.
sidebar:
  order: 3.5
---

Theming a planning session or a retro rarely starts with sections. People put stickies that go together on top of each other, then sort the stacks out after. A **stack** is that: a few stickies gathered into one neat stack with a count and a name, like app folders on a phone.

## Making a stack

Drag a sticky onto another and hold it there for a moment: the one underneath opens up to take it in. Let go and they're a stack, where the sticky underneath was. Moving on before it opens is just a move.

- **Add to a stack** the same way: drag a sticky (or several, or another stack) onto it and hold.
- **Stack a selection** with **Stack** in the selection's action bar (<kbd>⌥</kbd> <kbd>G</kbd>): the stickies go where the first of them is.
- One undo puts everything back as it was.

## Reading and changing a stack

A stack shows its top sticky, with the next ones peeking out underneath, a count, and its name.

- **Click it** (or select it and press <kbd>Enter</kbd>) to spread its stickies out into a grid where it is, to read and edit them. Only you see it open: everyone else still sees a stack. Click away or press <kbd>Esc</kbd> to gather it back up.
- **Drag a sticky out** of an open stack to take it out. Drag it to another place in the grid to reorder. A stack left with one sticky goes back to being that sticky.
- **Unstack** in its action bar (<kbd>⌥</kbd> <kbd>U</kbd>) lays its stickies out for good and the stack goes.
- Deleting a stack deletes its stickies with it.

A stack moves as one, sits in a section like anything else, can be [dot-voted](/facilitation/dot-voting/) and stamped, and connectors can join it. In a section shown as a list, it's one row. Exports, templates, history and copy and paste keep its stickies with it.

## Names

A stack is named for what its stickies have in common, a short theme like "Hard-to-find provider docs", marked ✨ as a suggestion. As stickies come and go and their text changes, the suggestion follows, a moment later.

Give it a name of your own by double-clicking its name (or clicking it once the stack's selected), or keep the suggestion with **Keep**. A name a person gave a stack is never changed by anything else; clear it to go back to suggestions.

Names come from the instance's [AI suggestions](#ai-suggestions). Without them, a stack is "Untitled stack" until someone names it.

## Group these

Select three or more stickies and choose **Group these** (<kbd>⌥</kbd> <kbd>⇧</kbd> <kbd>G</kbd>). Tack reads them and proposes stacks, each with a name. Before anything changes, you see the proposal: each stack's stickies are ringed and numbered on the board, and the panel lists them. Rename a stack, leave a sticky out, or drop a stack, then **Make** them, in one undo step. Stickies that fit no stack stay where they are. **Try again** asks for another proposal.

## Making issues from a stack

Select a stack and choose **Parent issue**: its name is the parent issue's title, and its stickies become its sub-issues. When the push lands, the stack spreads out and its stickies turn into their cards, with the parent's card above them. See [Built-in actions](/writing-back/actions/).

## Silent mode

A face-down sticky in a [silent](/facilitation/silent-mode/) section can be stacked like any other: it stays face down on the stack until the reveal. Its text isn't on the board until then, so it never lends a stack its words, and Group these leaves it out.

## AI suggestions

Names and Group these come from a language model running on the instance's own Cloudflare account ([Workers AI](/self-hosting/configuration/#ai-suggestions)), on by default. Only the stickies' visible text is sent: never face-down stickies, cards, comments or anything else. Each board limits how often it asks, and a stack whose text hasn't changed is never asked about twice. An instance can turn them off.
