---
title: Upgrading
description: Taking new versions of Tack, how boards and storage are migrated, rolling back, and what to do when Tack needs new GitHub permissions.
sidebar:
  order: 5
---

## Taking a new version

Tack is deployed from your own copy of it, so upgrading is pulling in the new version and deploying it:

```sh
git pull https://github.com/ascorbic/tack.git main
pnpm install
pnpm run deploy
```

That works whether your copy is a fork or the repository the [Deploy to Cloudflare button](/self-hosting/deploy/#deploy-with-the-button) made. With Workers Builds, push the merge to your repository's `main` and it deploys by itself. Try a branch first if you like: Workers Builds gives each branch a [Preview](/self-hosting/deploy/#previews), though with no sign-in and empty boards.

There's nothing to run by hand: boards and storage upgrade themselves, as below. Read the changes before you upgrade all the same.

**Never change `TACK_SECRET`.** It encrypts the app's credentials and everyone's tokens: a new one can't read them, and setup can't be run again.

## How boards are upgraded

Every board records the version of the format it's saved in. When a board next opens after an upgrade, before anyone's connected, Tack brings it up to the current format: it runs each change to the format made since, in order, and records the new version with each. So a board that nobody opened for a year upgrades through every version in between, the first time someone opens it.

- **Nothing's lost.** Upgrades only change what has to change, and a board's [history](/boards/history/) shows each one as Tack's ("Tack upgraded the board"), so you can see the board as it was before.
- **They're safe to repeat.** Running an upgrade on a board that's already had it changes nothing, so one that stopped partway is simply run again.
- **Old tabs keep working.** Readers are forgiving of what they don't recognise, so someone with a tab open from before the upgrade carries on until they reload.
- **A board that can't be upgraded still opens.** If an upgrade fails, the board carries on as it was, the failure is logged as `board.migrate.failed`, and it's tried again the next time the board opens.

Tack's storage (each board's push queue, comments and history, the instance's users and installations) is upgraded the same way, when each part starts: new tables are created as they're needed, and changes to existing ones run once each, in order (`storage.migrated` in the logs).

## Rolling back

Upgrades only ever add: new keys, new columns, new tables. So deploying an older version after a newer one has run is safe. An older Tack leaves boards and storage from a newer one as they are (logged as `board.migrate.newer` and `storage.migrate.newer`) and reads what it understands, and the newer version carries on where it left off when you deploy it again. A widget a newer version added keeps its place and settings in an older one ("This widget needs a newer Tack").

With Workers, rolling back is deploying the older version: from the dashboard (Workers & Pages → `tack` → Deployments), or by deploying an older commit.

## When Tack needs new permissions

The app's permissions and events are set from Tack's manifest **when the app is created**. A new version of Tack that needs more (as when decision records needed **Contents: Read and write**) can't change an existing app: you change it on GitHub.

1. On GitHub, open the app's settings: Settings → Developer settings → GitHub Apps → "Tack (…)" → **Permissions & events** (for an organisation's app, under the organisation's settings). **App settings** on `/setup` opens the app's page on GitHub, a click away.
2. Raise the permission, or subscribe to the event, and save. GitHub asks every installation to accept.
3. On each account that installed the app: Settings → Applications → Installed GitHub Apps → "Tack (…)" → **Configure**, then **Review request** → **Accept new permissions**.

For a new event (as when [comment commands](/automation/comment-commands/) needed **Issue comment**), tick it under **Subscribe to events** in the same place. Events don't need accepting on installations.

Until the new permissions are accepted, writes that need them fail with "Tack isn't allowed to …", and `/setup` shows the installation as "Live, read-only". The full list Tack expects is in [What it asks for, and why](/self-hosting/github-app/#what-it-asks-for-and-why).
