---
title: Boards and sharing
description: The home page, making and renaming boards, roles, visibility and archiving.
sidebar:
  order: 1
---

## The home page

The home page lists the boards you can open, in tabs:

| Tab                | What's in it                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **Recent**         | Boards shared with you that you haven't opened yet, then boards you've opened lately, most recent first (up to 12) |
| **My boards**      | Boards you own                                                                                                     |
| **Shared with me** | Boards you've been invited to                                                                                      |
| **Team boards**    | Other boards anyone on the instance may open without an invitation, and public boards                              |
| **Archived**       | Archived boards you own or were invited to                                                                         |

**My boards** is always there; the other tabs show once they have boards in them. The page opens on **Recent** when it has anything in it, so a board someone has just shared with you is the first thing you see, marked **New** until you open it. **Team boards** leaves out boards already under **My boards** or **Shared with me**. The arrow keys move between tabs.

Once you can see seven or more boards, a **Find a board** box searches all of them, whichever tab they're under (press <kbd>/</kbd> to get there). It forgives a missing letter or two ("emdsh" finds "EmDash planning"), and archived boards that match are offered behind **Show archived matches**. <kbd>Esc</kbd> clears it.

Each tile shows a sketch of the board, its visibility, when it was last edited (or opened, or archived) and up to three of its members. A board with nothing on it yet shows a blank note of its own colour. For people who can edit the board, the **…** menu on its tile has **Rename** and **Copy link**, and for the owner **Archive** (or **Restore**). Archiving says so, with **Undo**. Renaming a board leaves its tile where it is.

## Making a board

Choose **New board**, then a [template](/templates/) or a **Blank board**. Anyone allowed on the instance can make boards. A new board:

- is called after its template and today (or "Untitled board", numbered if you have one already: "Untitled board 2"), with the title ready to type over
- is owned by you
- is open to whoever you chose under **Who can open it**: **Everyone on this Tack** (who can edit it) or **Only people I invite**. Tack remembers your choice for next time, and you can change it later in **Share**

Its address is `/b/{id}/{slug}`. The slug follows the title, and old links keep working after a rename, because the id is what counts.

To rename a board, click its title in the top bar (editors only: a pencil shows on hover), type, and press <kbd>Enter</kbd>. <kbd>Esc</kbd> puts it back. Titles are up to 120 characters; a long one is cut short in the top bar, with the whole of it on hover.

Beside the title, a chip says who can open the board: **Invite only**, **Anyone here can edit** (or **can view**), or **Public**. Clicking it opens **Share**.

## Roles

Everyone on a board has one of three roles:

| Role                    | Can                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| **Owner**               | Everything an editor can, plus sharing, visibility, archiving and deleting anyone's comments |
| **Editor** ("Can edit") | Change the board, stage changes for GitHub, run facilitation tools                           |
| **Viewer** ("Can view") | Look around, follow people, chat by their cursor, emote, and comment if signed in            |

People with view access get a smaller toolbar: Select, Hand and Comment. The board shows a **View only** badge: "You can look around and comment, but not change it". Pressing a tool's key that would change the board (<kbd>S</kbd> for a sticky, say) says so: "You can view this board, but not edit it. Ask its owner if you need to."

:::note
Board roles only decide what people can do to the board. They never grant access to a repository's data: a card from a private repository shows its details only to people who can read that repository on GitHub. Pushing to GitHub also needs your own write access there. See [Pushing](/writing-back/pushing/).
:::

## Sharing

Choose **Share** in the top bar, or the access chip beside the title. The dialog has three parts.

**Invite** (owners): type one or more GitHub usernames, separated by spaces or commas, choose **Can edit** or **Can view**, and **Invite**. As you type, people who've used this Tack are suggested (arrow keys and <kbd>Enter</kbd> pick one), and each username you finish is checked on GitHub and shown with their picture and name: "On this Tack", "Hasn't used Tack yet", or, in red, "No GitHub user by that name". Tack won't invite a username GitHub doesn't know, or an organisation. People don't need to have signed in yet: until they do, they're listed as "invited, hasn't signed in yet".

Tack doesn't email anyone. After an invite, the dialog says so, and **Copy link** is there to send them.

**People with access**: everyone invited, with their role. The owner can change a role, **Remove** someone, or **Make owner** (for people who have signed in) to hand the board over. Members who aren't the owner can **Leave board**, which asks first.

**General access**: who else can open the board.

| Visibility | Shown as               | Who can open it                                                                                                                 |
| ---------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Private    | "Only people invited"  | Only the people invited                                                                                                         |
| Instance   | "Anyone on this Tack"  | Everyone allowed on the instance, at the role you choose under "What people on this Tack can do" (**Can edit** or **Can view**) |
| Public     | "Anyone with the link" | Anyone at all, read-only and with no sign-in. A second row, **People on this Tack**, sets what people on the instance can do    |

Invited people keep their own role whatever the visibility, as long as they're still allowed on the instance. Public boards are the one thing that reaches past the instance's [access list](/self-hosting/access/).

**Copy link** copies the board's address.

For people who can edit, the dialog also lists the board's repositories under **On GitHub**, and whether Tack can push to each: "Live · Tack can push", or "Updates while open · read-only" with **Install the app**. Check it before a session, so a missing installation doesn't show up when the first push fails.

On a public board, Share also offers **Embed in a README**: a live image of the board, or part of it, to put in a README or docs page. See [Embeds and link previews](/boards/embeds/).

### Public boards and signed-out visitors

Someone who isn't signed in can open a public board and look around, but can't edit, comment or vote. A note at the bottom says "You're viewing a public board", and that signing in with GitHub lets them comment, and see cards from private repositories they can read; **Sign in** is there and in the top bar, and **×** puts the note away for good on that board. The **View only** badge says "You can look around. Sign in to comment".

They only ever get what anyone may see:

- Cards from private repositories (or any repository Tack doesn't know to be public) are "Private" placeholders, with nothing but where they are on the board, as they are for anyone who can't read the repository. Their titles, labels and states never reach a signed-out visitor's browser.
- Widgets and inboxes only show results from public repositories, and searching from the card tool, and **Expand related**, only find public items.
- **What's new** only lists GitHub activity on public repositories' cards, and the push history says no more about a change to a private repository than "A change to a private repository" (this goes for signed-in people who can't read the repository too).
- History replays the board's own content (stickies, sections, connectors and where cards are), never card data.
- Mentions in comments show the board's members by name, but signed-out visitors aren't told who else has been looking at the board.

Everything else on a public board is public: stickies, text, sections, decisions, comments, and the board's history. Silent mode's hidden text is the exception: it never leaves its author's browser before the reveal, so nobody else can see it, signed in or not.

A public board's link unfurls in Slack, Discord, GitHub and social sites with its title, a description of what's on it (naming only public repositories) and an image of it. See [Embeds and link previews](/boards/embeds/).

## Archiving

The owner can archive a board from its tile's **…** menu. An archived board is read-only for everyone: "This board is archived, so it's read-only." People on it when it's archived are told who archived it. It keeps the Select and Hand tools, and moves to the **Archived** tab, where the owner can **Restore** it (or from the board).

## When your access changes

If someone changes your role while you're on a board, it takes effect straight away: "You can edit this board now", or "You can view this board, but not edit it". If you're removed while you're on it, the board closes and says "You no longer have access to this board".
