---
title: Troubleshooting
description: What Tack's errors mean, and what to do about them.
sidebar:
  order: 2
---

## Pushing

**"Tack isn't allowed to …"**
: The GitHub App doesn't have the permission it needs, or the installation hasn't accepted it. Decision records need **Contents: Read and write**; apps created before Tack wrote files only had read access. See [When Tack needs new permissions](/self-hosting/upgrades/#when-tack-needs-new-permissions).

**"Tack's GitHub App isn't installed on …"**
: Install the app on that repository: **Install the app** in the push sheet, or **Install on repositories** on `/setup`. Or leave those changes out.

**"You can't write to …"** / "You can stage but not push here"
: Your GitHub account doesn't have write access to the repository. Someone who does can push what you staged.

**"Sign in to push"**
: Pushing writes as a person. Sign in with GitHub; fake sign-in (`/auth/dev`) can't push to GitHub.

**A change says "Sent, waiting for GitHub to confirm" for two minutes, then fails: "GitHub accepted this, but … didn't show it"**
: Webhooks aren't reaching the instance. In the app's settings on GitHub, check **Advanced → Recent deliveries**: are deliveries failing, or going to an old address? The cron trigger redelivers failed ones every ten minutes, but if the webhook URL is wrong, fix it in the app's settings (it should be `https://your-instance/webhooks/github`). Then **Retry** the change: Tack never writes anything twice.

**"GitHub's rate limit: Tack will try again at …"**
: Nothing to do: Tack waits and retries, in order. It gives up if the limit won't lift within 70 minutes.

**A change failed, and I'm not sure if it went through**
: **Retry** it. A retried create first looks for what an earlier attempt made, and a change that's already on GitHub is never pushed again.

## Backlinks

**The snapshot image is broken in the GitHub comment**
: GitHub fetches the image through its proxy from your instance's `/snapshots/….png`. That address needs to be reachable from the internet: an instance behind Cloudflare Access, a VPN or a private network won't work.

## Cards

**A card says "Not live"**
: The app isn't installed on its repository. It still updates, about once a minute while the board's open. Install the app for live updates, CI and reviews. See [Repositories](/self-hosting/repositories/).

**A card shows "Private", with nothing else**
: It's in a private repository you can't read on GitHub. If you've just been given access, choose **Got access? Check again**.

**"Tack can't read owner/repo. If it's private, install the app on it."**
: Private repositories need the app installed, even for people who can read them.

**Cards stopped updating**
: For live repositories, check the app's recent deliveries on GitHub (above). In the logs, look for `webhook.rejected` (a signature that doesn't match: was the app's webhook secret changed?) and `webhook.failed`.

## Signing in and setup

**"Tack needs a secret first"**, or "Sign-in isn't available here"
: The Worker has no `TACK_SECRET`. Set one: see [Deploy Tack](/self-hosting/deploy/#secrets). Previews never have one.

**"This Tack is invite-only"**
: You're not on the instance's access list. Ask an admin to add you, or an organisation you're in. Added to an organisation recently? **Check again** signs you in afresh, which rechecks it.

**Sign-in fails at GitHub after moving to a custom domain**
: The app's callback URL is the address it was set up on. Add the new address's `/auth/callback` to the app's callback URLs on GitHub, and update its webhook URL too.

**"Setup took too long, or started in another tab"**
: Run `/setup` again, in one tab. If GitHub made a half-finished app ("GitHub didn't hand over the new app's credentials"), delete it from your GitHub settings first.

## Widgets and inboxes

**"GitHub needs a breather"**
: GitHub's search rate limit. The widget says when it'll try again.

**"Lots of searches on this board just now"**
: The board's own search allowance for the minute is used up. It tries again shortly.

**"GitHub only searches up to 256 characters."**
: Shorten the search. Tack adds a sort, and `is:public` for people who aren't signed in.

**"Sign in to see what “@me” means for you."**
: `@me` needs someone signed in.

**A widget or inbox over a repository without the app only updates every few minutes**
: Repositories without the app send no webhooks, so widgets over them refresh on their schedule. Install the app for webhook refreshes.

## Finding out more

Every event Tack logs is searchable in Workers Logs: for pushes, filter on `event` starting with `push.`. See [Observability](/self-hosting/observability/).
