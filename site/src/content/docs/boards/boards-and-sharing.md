---
title: Boards and sharing
description: The home page, making and renaming boards, roles, visibility and archiving.
sidebar:
  order: 1
---

## The home page

The home page lists the boards you can open, in tabs:

| Tab                | What's in it                                                                    |
| ------------------ | ------------------------------------------------------------------------------- |
| **Recent**         | Boards you've opened lately, most recent first (up to 12)                       |
| **My boards**      | Boards you own                                                                  |
| **Shared with me** | Boards you've been invited to                                                   |
| **On this Tack**   | Boards anyone on the instance may open without an invitation, and public boards |
| **Archived**       | Archived boards you own or were invited to                                      |

Tabs only show once they have boards in them. Once you can see seven or more boards, a **Find a board** box filters them by title.

Each tile shows a sketch of the board, its visibility, when it was last edited (or opened, or archived) and up to three of its members. The **…** menu on a tile has **Rename**, **Copy link**, and for the board's owner **Archive** (or **Restore**).

## Making a board

Choose **New board**. Anyone allowed on the instance can make boards. A new board:

- is called "Untitled board", with the title ready to type over
- is owned by you
- is open to **Anyone on this Tack**, who **Can edit** (change this in **Share**)

Its address is `/b/{id}/{slug}`. The slug follows the title, and old links keep working after a rename, because the id is what counts.

To rename a board, click its title in the top bar (editors only), type, and press <kbd>Enter</kbd>. <kbd>Esc</kbd> puts it back. Titles are up to 120 characters.

## Roles

Everyone on a board has one of three roles:

| Role                    | Can                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| **Owner**               | Everything an editor can, plus sharing, visibility, archiving and deleting anyone's comments |
| **Editor** ("Can edit") | Change the board, stage changes for GitHub, run facilitation tools                           |
| **Viewer** ("Can view") | Look around, follow people, chat by their cursor, emote, and comment if signed in            |

People with view access get a smaller toolbar: Select, Hand and Comment. The board shows a **View only** badge: "You can look around and chat, but not change this board".

:::note
Board roles only decide what people can do to the board. They never grant access to a repository's data: a card from a private repository shows its details only to people who can read that repository on GitHub. Pushing to GitHub also needs your own write access there. See [Pushing](/writing-back/pushing/).
:::

## Sharing

Choose **Share** in the top bar. The dialog has three parts.

**Invite** (owners): type one or more GitHub usernames, separated by spaces or commas, choose **Can edit** or **Can view**, and **Invite**. People don't need to have signed in yet: until they do, they're listed as "invited, hasn't signed in yet".

**People with access**: everyone invited, with their role. The owner can change a role, **Remove** someone, or **Make owner** (for people who have signed in) to hand the board over. Members who aren't the owner can **Leave board**.

**Who can open this board**: the board's visibility.

| Visibility | Shown as               | Who can open it                                                                                                                 |
| ---------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Private    | "Only people invited"  | Only the people invited                                                                                                         |
| Instance   | "Anyone on this Tack"  | Everyone allowed on the instance, at the role you choose under "What people on this Tack can do" (**Can edit** or **Can view**) |
| Public     | "Anyone with the link" | Anyone at all, read-only and with no sign-in. People on the instance get the role you choose                                    |

Invited people keep their own role whatever the visibility, as long as they're still allowed on the instance. Public boards are the one thing that reaches past the instance's [access list](/self-hosting/access/).

**Copy link** copies the board's address.

### Public boards and signed-out visitors

Someone who isn't signed in can open a public board and look around, but can't edit, comment or vote. Cards from private repositories show as "Private" placeholders to them, as they would to anyone who can't read the repository, and widgets only show public results. They see a **Sign in** link in the top bar.

## Archiving

The owner can archive a board from its tile's **…** menu. An archived board is read-only for everyone: "This board is archived, so it's read-only." It moves to the **Archived** tab, and the owner can **Restore** it from there or from the board.

## When your access changes

If someone changes your role while you're on a board, it takes effect straight away: "You can edit this board now", or "You can view this board, but not edit it". If you're removed, the board closes and says "You don't have access to this board".
