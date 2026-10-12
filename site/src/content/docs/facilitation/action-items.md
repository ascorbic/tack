---
title: Action items
description: Who'll do what by when, with a status that follows its GitHub issue, carried into the next session.
sidebar:
  order: 6
---

An action item is something someone will do: a row with a checkbox, an **owner** and a **due date**. Press <kbd>A</kbd> and click the board to add one, then type what needs doing. Select stickies and press <kbd>⌥</kbd> <kbd>⇧</kbd> <kbd>A</kbd> (**Action items** in the bar) to turn them into action items in place.

## Owner and due date

Click an item's chips to set them:

- **Owner**: anyone on the board (you first), or any GitHub login.
- **Due**: Today, Tomorrow, Friday, Next week, In 2 weeks, or a day on the calendar (the arrow keys move through it).

The left edge turns amber when an item is due within three days or today, and red once it's late, where the due chip says how many days late it is. Done items are struck through.

## Linking it to an issue

The **Issue** chip links the item to an issue: type `#123` (in the board's usual repository), `owner/repo#123`, or paste a link. Or stage a new issue in a repository, assigned to the item's owner, with the due date and a link back to the board; once you [push](/writing-back/pushing/), the item is linked to it.

Once it's linked, the item's status is the issue's: it's done when the issue is closed. Ticking it [stages](/writing-back/overview/) closing the issue (completed); ticking it again before you push takes that back. An item linked to an issue you can't read stays open as far as you can see.

## Carrying them over

Open action items belong in the next session. Select two or more and choose **Carry over** (<kbd>⌥</kbd> <kbd>O</kbd>), or use **Carry over…** in the Facilitate menu for all the open ones, and pick one of your boards. They go into its Actions section (or a new "Carried over from…" section), with their owners, due dates and issues, each saying where it came from. Carrying over twice doesn't double up.

When you make the next retro from a [template](/templates/), **Bring open action items from** does the same as it's made.
