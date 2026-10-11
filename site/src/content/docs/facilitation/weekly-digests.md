---
title: Weekly digests
description: Once a week, what happened on a board, posted as a GitHub Discussion and emailed to the people who ask for it.
sidebar:
  order: 7
---

A weekly digest is a board's week in one place: what was decided, which action items were done, started and are late, what happened on GitHub, what was pushed, and who did what. Its owner turns it on, and it goes out as a GitHub Discussion, by email to people who ask for it, or both.

Open it from the board's menu (**⋯** beside Share): **Weekly digest…**. Anyone signed in who can open the board sees the week so far, as their email would say it, and where and when it goes.

## What's in it

- **Decisions** marked decided that week, and by whom.
- **Action items** done, new, and late (with how late).
- **On GitHub**: what happened to the board's cards: merged, closed, reopened, new comments, CI failing or passing, approved, changes requested. Merged and closed first.
- **Pushed from the board**: who pushed, how many changes, and any that failed.
- **On the board**: who did what, most active first: "Priya added 4 stickies and a section, moved 2 cards".

It's built from what [Since you were here](/facilitation/since-you-were-here/) keeps, so it has the same details. A quiet week, when nothing happened, sends nothing.

## Turning it on

Only the board's owner can. In **Weekly digest…**:

- **Post a GitHub Discussion**: a repository and a category (Tack suggests one called something like "Announcements"). It's posted as the Tack app, so the app must be installed on the repository, Discussions must be on, and you must be able to write there. Tack checks when you turn it on and again before every post.
- **Email people who ask for it**: they each ask from the dialog. Only there if [this Tack can send email](/self-hosting/email/).
- **Day** and **Time**: when it goes out, in your time zone. Mondays at 9:00 by default.

**Turn on digests** saves it, and the dialog says when the next one goes. Below, **Recent digests** says how the last ones went: the Discussion it posted, how many people it emailed, a quiet week, or why something didn't go (the app was uninstalled, a category was renamed). **Turn off digests** stops it for everyone.

Each place gets one digest a week, at most: if something fails for a moment (GitHub or email having trouble), Tack tries again shortly, without sending twice.

## Who sees what

- A **Discussion** only names cards and pushes from repositories that are public, or from the Discussion's own repository. If a private board posts to a public repository, the dialog warns you that anyone can read it.
- An **email** only has what its reader can read on GitHub, and stops if they can no longer open the board.
- Nothing anyone wrote is turned into a mention or a link in a Discussion, so a digest never notifies anyone, and it doesn't add a reference to every issue it names.

## Getting it by email

In **Weekly digest…**, type your address under **Email it to me** and **Send a link**. Tack emails you a link to confirm, and sends nothing else until you follow it. The dialog then says where it goes, with **Use another address** and **Stop emailing me**.

Every digest email has a link to stop, and mail apps' own **Unsubscribe** button works too, without signing in.

## The preview

The right of the dialog is the next digest so far: as your email would say it, and, for editors when it's posted as a Discussion, as the Discussion would (**Your email** / **Discussion**). It's the real thing, with what you can read: the week goes from the last digest to now.
