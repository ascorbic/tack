---
title: Where cards come from
description: How cards remember how they arrived, and what happens when they stop matching.
sidebar:
  order: 4
---

Every card remembers how it arrived:

| Arrived                                                                                | Foot of the card | Says                                                |
| -------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------- |
| Placed by a person: pasted, typed, [expanded](/boards/cards/#expand-related) or copied | Nothing          |                                                     |
| Dragged out of a [widget](/widgets/overview/)                                          | A list           | "From the “Open bugs” list"                         |
| Sorted out of an [inbox](/automation/inboxes/)                                         | A tray           | "From the “Triage” inbox"                           |
| Placed by a [rule](/automation/rules/)                                                 | A spark          | "Placed by rule: Pull requests beside their issues" |
| Asked for in a [comment on GitHub](/automation/comment-commands/)                      | An @             | "Added from GitHub by @kai", linking to the comment |

Point at the glyph, or select the card, to read it.

## When a card stops matching

What happens when the item no longer matches depends on how the card arrived:

- **Placed by a person, from a widget, or asked for in a comment**: nothing. A widget only ever copies, and a comment counts as its author placing the card.
- **From an inbox or a rule**: the card is **marked**, with a dashed edge and a band: "No longer matches the “Triage” inbox". It's never moved or removed.

The band offers:

- **Keep**: the card becomes an ordinary card, as if a person had placed it, and is never marked again.
- **Remove**: removes it from the board.

Marks come from GitHub's webhooks for the card's repository, and clear again if the item matches once more.
