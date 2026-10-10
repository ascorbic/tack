---
title: Upgrading
description: Taking new versions of Tack, and what to do when it needs new GitHub permissions.
sidebar:
  order: 5
---

## Taking a new version

Tack is deployed from your fork, so upgrading is pulling in the new version and deploying it:

```sh
git pull https://github.com/ascorbic/tack.git main
pnpm install
pnpm run deploy
```

With Workers Builds, push the merge to your fork's `main` and it deploys by itself. Try a branch first if you like: Workers Builds gives each branch a [Preview](/self-hosting/deploy/#previews), though with no sign-in and empty boards.

Tack's Durable Objects create the storage tables they need as they start, so there's no database migration to run by hand.

:::caution[Early days]
Tack doesn't yet version its board format or migrate old boards: that's planned, along with backups. It reads boards carefully instead. A widget's settings are read field by field, with defaults for anything missing or malformed, and a widget a newer version added keeps its place and settings in an older one ("This widget needs a newer Tack"). Still, while Tack is a prototype, read the changes before you upgrade.
:::

**Never change `TACK_SECRET`.** It encrypts the app's credentials and everyone's tokens: a new one can't read them, and setup can't be run again.

## When Tack needs new permissions

The app's permissions and events are set from Tack's manifest **when the app is created**. A new version of Tack that needs more (as when decision records needed **Contents: Read and write**) can't change an existing app: you change it on GitHub.

1. On GitHub, open the app's settings: Settings → Developer settings → GitHub Apps → "Tack (…)" → **Permissions & events** (for an organisation's app, under the organisation's settings). **App settings** on `/setup` links there.
2. Raise the permission, or subscribe to the event, and save. GitHub asks every installation to accept.
3. On each account that installed the app: Settings → Applications → Installed GitHub Apps → "Tack (…)" → **Configure**, then **Review request** → **Accept new permissions**.

For a new event (as when [comment commands](/automation/comment-commands/) needed **Issue comment**), tick it under **Subscribe to events** in the same place. Events don't need accepting on installations.

Until the new permissions are accepted, writes that need them fail with "Tack isn't allowed to …". The full list Tack expects is in [What it asks for, and why](/self-hosting/github-app/#what-it-asks-for-and-why).
