---
title: Who can use it
description: The instance's access list of admins, people and organisations, and the invite-only page.
sidebar:
  order: 3
---

Once the GitHub App is set up, an instance is **invite-only**: only the people on its access list can sign in and use it. (Before setup, everything is open, which is why you should [run setup straight away](/self-hosting/deploy/).)

## The access list

Admins manage it on `/setup`, under **Who can use this instance**:

| List              | Who                          | Notes                                               |
| ----------------- | ---------------------------- | --------------------------------------------------- |
| **Admins**        | Can change these settings    | They need to have signed in once. Keep at least one |
| **People**        | GitHub users who may sign in | By GitHub username                                  |
| **Organisations** | Members may sign in          | Checked each time someone signs in                  |

**Save changes** applies them; **Discard** throws them away.

Organisation membership is checked **when someone signs in**, including private membership (using the app's [Organisation members permission](/self-hosting/github-app/#what-it-asks-for-and-why) where it's installed on the organisation). So removing an organisation takes effect at once, but adding one, or someone joining it, takes effect the next time they sign in.

## Everyone else

Someone who signs in and isn't on the list sees "This Tack is invite-only": "You're signed in as @login, but this instance is only open to people its admins have added." **Check again** signs them in afresh, which rechecks their organisations.

The one exception is [public boards](/boards/boards-and-sharing/#public-boards-and-signed-out-visitors): anyone can open them, read-only, without signing in. The home page shows signed-out visitors only the instance's public boards.

## Sessions

Sessions last 30 days, in an HTTP-only cookie. Only a hash of each session is stored. People's GitHub tokens are stored encrypted, and refreshed as GitHub requires.
