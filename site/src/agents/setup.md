# Set up your own Tack

> Instructions for a coding agent (Claude Code, Codex, Cursor or another) working in the user's terminal. Served at {{site}}/setup.md, and built from the self-hosting docs with every command and link checked against them.

Tack is an open source, self-hosted whiteboard for planning on GitHub's own data: live issue and pull request cards on a shared board, with what's decided pushed back to GitHub as one reviewed batch. Every instance is someone's own: one Cloudflare Worker on their Cloudflare account, with a GitHub App they own.

**What you'll do:** check the prerequisites, fork and clone Tack, configure and deploy it to the user's Cloudflare account with a secret you generate, then hand the user the browser steps only they can do (creating the GitHub App and installing it), and check it works. It takes about fifteen minutes.

If the user would rather not use a terminal at all, the [Deploy to Cloudflare button](https://deploy.workers.cloudflare.com/?url=https://github.com/ascorbic/tack) does steps 2 to 5 in their browser (see [Deploy with the button]({{site}}/self-hosting/deploy.md#deploy-with-the-button)); step 6 onwards is the same.

## How to work

- Run the commands yourself, in the user's terminal, from the cloned repository. Say what you're about to do before anything that changes their accounts: forking, deploying, setting secrets.
- **Stop and ask the user** means stop: tell them exactly what to do and the URL to open, then wait for them to say it's done. Never sign in to GitHub or Cloudflare in a browser for them, or automate those pages: they're the user's own accounts and decisions.
- Never print, log or commit `TACK_SECRET`. Never change it once it's deployed.
- These steps follow the docs: [Deploy Tack]({{site}}/self-hosting/deploy.md) and [Set up the GitHub App]({{site}}/self-hosting/github-app.md). Links here go to the docs' Markdown (each page's HTML is the same address without `.md`), and {{site}}/llms.txt lists every page. If this file and the docs disagree, the docs win.

## 1. Check the prerequisites

```sh
node --version
pnpm --version
git --version
gh --version
```

- **Node.js {{node}} or later.** If it's missing or older, stop and ask the user to install it (with their version manager, or from https://nodejs.org).
- **pnpm {{pnpmMajor}}.** The repository pins `pnpm@{{pnpm}}` (`packageManager` in `package.json`). If it's missing, `npm install -g pnpm@{{pnpm}}`, or `corepack enable` on a Node.js that includes Corepack.
- **git.**
- **A Cloudflare account.** If the user hasn't one, stop and ask them to sign up at https://dash.cloudflare.com/sign-up. You'll log in to it with the `cf` CLI once the code is installed (step 3). Tack deploys with `cf`, never Wrangler.
- **A GitHub account**, and, if the repositories they'll plan with belong to an organisation, the right to create GitHub Apps for it. Ask the user which account or organisation owns those repositories: it should own the app.
- **`gh`, the GitHub CLI** (optional). If it's installed, check it's signed in with `gh auth status`. If it isn't signed in, ask the user whether they'd like to run `gh auth login` themselves; otherwise carry on without it.

## 2. Get the code

Fork Tack, so updates from `ascorbic/tack` are easy to pull in and Workers Builds can deploy from the fork. Ask the user before forking: the fork is public, under their account (or an organisation, with `--org <organisation>`). Nothing secret ever goes in the repository.

With `gh` signed in:

```sh
gh repo fork ascorbic/tack --clone
cd tack
```

This clones the fork with `origin` as the fork and `upstream` as `ascorbic/tack`. If the user already has a fork, clone that instead.

Without `gh`: ask the user to fork it at https://github.com/ascorbic/tack/fork (or skip the fork for now), then clone their fork, or `ascorbic/tack` itself:

```sh
git clone https://github.com/<you>/tack.git
cd tack
```

## 3. Install, and log in to Cloudflare

```sh
pnpm install
pnpm exec cf auth whoami
```

If `whoami` says it isn't authenticated, run `pnpm exec cf auth login` and tell the user to approve it in the browser window it opens (or they can give you a `CLOUDFLARE_API_TOKEN` to set instead). If `whoami` lists more than one account, ask which one Tack goes on, and run the `cf` commands below with `CLOUDFLARE_ACCOUNT_ID=<account id>` set.

## 4. Configure

Everything about the Worker is in `cloudflare.config.ts`. Ask the user these questions, change only what they ask for, and leave everything else as it is. See [Configuration]({{site}}/self-hosting/configuration.md).

- **The Worker's name**, `NAME` in `cloudflare.config.ts`: `{{name}}` unless they want another. Check it's free with `pnpm exec cf workers list`: deploying replaces a Worker with the same name, so if one called `{{name}}` is there and isn't a Tack they mean to replace, choose another name. The Durable Objects follow `NAME`. The instance will be at `https://<name>.<their workers.dev subdomain>`.
- **AI suggestions**: naming stacks of stickies, Auto-stack, and AI on boards, through Workers AI on their account. On by default; Workers AI has a free daily allocation, then it's billed per use. To turn them off, change the `"on"` in `TACK_AI`'s line of `cloudflare.config.ts` to `"off"`. See [AI suggestions]({{site}}/self-hosting/configuration.md#ai-suggestions) and [Costs]({{site}}/self-hosting/costs.md).
- **A custom domain** (optional): ask now. The GitHub App is created for the address `/setup` runs on, so a custom domain is added after the first deploy and before step 6.
- **Email** (optional, can wait): weekly digests by email need a domain onboarded to Cloudflare Email Service. Leave `EMAIL_FROM` empty for now; see step 8.

If you changed `cloudflare.config.ts`, regenerate `wrangler.jsonc` (Tack's tests fail if it's out of date), and commit and push it, so the fork deploys the same thing:

```sh
pnpm run wrangler-config
```

## 5. Deploy, with the secret

A new Worker needs `TACK_SECRET` from its first deploy. Generate it into a file git ignores, and deploy with it:

```sh
echo "TACK_SECRET=$(openssl rand -base64 32)" > .env.secrets
pnpm run deploy --secrets-file .env.secrets
```

`pnpm run deploy` builds Tack and deploys it with `cf deploy` (note the `run`: `pnpm deploy` is a different, built-in pnpm command). The deploy prints the Worker's address: that's the instance.

**Stop and ask the user** to copy `TACK_SECRET` from `.env.secrets` into their password manager. It encrypts the GitHub App's credentials and everyone's tokens, and signs sessions: if it's lost or changed, setup can't be run again. Once they've saved it, delete the file:

```sh
rm .env.secrets
```

Check the instance answers, and has its secret:

```sh
curl -s https://<instance>/api/setup
```

`"status":"unconfigured"` means it's deployed with its secret and waiting for setup. `"status":"unavailable"` means it has no `TACK_SECRET`: see [Troubleshooting](#troubleshooting).

Until setup is done, `/setup` is open to anyone who can reach the instance, and whoever completes it becomes the admin. So go straight on to step 6.

## 6. The GitHub App: stop and ask the user

These steps happen in the user's browser, signed in to GitHub. Give them the instance's `/setup` URL and these steps, then wait. Don't open a browser or sign in for them.

**Custom domain first, if they want one:** Cloudflare dashboard (https://dash.cloudflare.com) → Workers & Pages → the Worker → Settings → Domains & Routes. Then use that domain, not `workers.dev`, for everything below.

1. **Open `https://<instance>/setup`.**
2. **Who owns the app?** **My account**, or **An organisation** with its login: the account that owns the repositories they'll plan with (GitHub only lets a private app be installed on the account that owns it).
3. **App name**, like `Tack (tack.example.com)`: unique across GitHub, at most 34 characters.
4. **Create GitHub App**, then confirm it on GitHub. They come back signed in as the instance's admin: "Your GitHub App is ready."
5. **Install on repositories**, and pick the repositories on GitHub. GitHub shows the permissions Tack asks for, including **Discussions: Read and write**; installing accepts them. Back on `/setup`: "Installed. Cards from those repositories now update live." In an organisation they don't own, an owner has to approve the installation.
6. **Who can use this instance**: add the people and organisations who may sign in, then **Save changes**. Until then, only admins can.

Full detail, and what each permission is for: [Set up the GitHub App]({{site}}/self-hosting/github-app.md) and [Who can use it]({{site}}/self-hosting/access.md).

## 7. Check it works

```sh
curl -s https://<instance>/api/setup
```

It should now say `"status":"configured"`. Then ask the user to open `https://<instance>/setup`: it should say **Tack is ready**, with the checklist at the top **All set**. If **Webhooks** says "Waiting for the first", opening an issue in an installed repository sends one. Every repository they'll plan with should be under **Where it's installed**.

Logs, if anything's wrong (or the dashboard: Workers & Pages → the Worker → Observability):

```sh
pnpm exec cf o11y telemetry query
pnpm exec cf o11y telemetry live-tail
```

Look for `level = error`, or an event named in [Observability]({{site}}/self-hosting/observability.md).

Finally, suggest they open `https://<instance>/`, make a board, and paste in a link to one of their issues.

## 8. Optional, now or later

- **Deploy on every push** (the user, in the dashboard): connect the Worker to the fork under Workers & Pages → the Worker → Settings → Builds, with the deploy command `pnpm run deploy` and the non-production branch deploy command `pnpm run deploy:preview`. Each branch then gets a [Preview]({{site}}/self-hosting/deploy.md#previews).
- **Email for weekly digests**: the user onboards a sending domain in the dashboard's Email Service; then set `EMAIL_FROM` in `cloudflare.config.ts`, run `pnpm run wrangler-config`, commit, and deploy. See [Email]({{site}}/self-hosting/email.md).
- **More secrets** (a `GITHUB_TOKEN` for reading public repositories without the app, other forges' tokens in `TACK_FORGES`): the user creates the tokens; set each with `pnpm exec cf workers secrets update <NAME>`, which asks for the value. See [Secrets]({{site}}/self-hosting/deploy.md#secrets) and [Other forges]({{site}}/self-hosting/forges.md).

## Upgrading later

Tack is deployed from the user's own copy, so upgrading is pulling in the new version and deploying it. Boards and storage upgrade themselves. See [Upgrading]({{site}}/self-hosting/upgrades.md).

With a fork and `gh`, bring the fork up to date with `ascorbic/tack`, then pull and deploy:

```sh
gh repo sync <you>/tack
git pull
pnpm install
pnpm run deploy
```

If the Worker deploys from the fork with Workers Builds, the sync deploys it by itself: there's no need to deploy from the terminal. If the fork has commits of its own (a changed `NAME`, say), `gh repo sync` can't fast-forward it: merge instead, and push.

```sh
git pull upstream main
git push
```

Without a fork, or without `gh`:

```sh
git pull https://github.com/ascorbic/tack.git main
pnpm install
pnpm run deploy
```

If a new version needs new GitHub permissions, the user changes them on GitHub: [When Tack needs new permissions]({{site}}/self-hosting/upgrades.md#when-tack-needs-new-permissions).

## Troubleshooting

- **The deploy fails: "The following required secrets have not been set: TACK_SECRET".** Deploy with `--secrets-file`, as in step 5. See [Troubleshooting: signing in and setup]({{site}}/help/troubleshooting.md#signing-in-and-setup).
- **`/setup` says "Tack needs a secret first"** (or `/api/setup` says `unavailable`). The Worker has no `TACK_SECRET`: set it with `pnpm exec cf workers secrets update TACK_SECRET`, from the user's saved copy if there is one. See [Secrets]({{site}}/self-hosting/deploy.md#secrets).
- **Webhooks say "Not arriving", "Refused" or "Going elsewhere".** See [Webhooks]({{site}}/self-hosting/github-app.md#webhooks).
- **"Live, read-only" or "Live · no Discussions" under Where it's installed.** The installation hasn't accepted Tack's permissions. See [Apps set up before discussions were cards]({{site}}/self-hosting/github-app.md#apps-set-up-before-discussions-were-cards).
- **Sign-in fails after adding a custom domain.** The app's URLs still point at the old address. See [Custom domains]({{site}}/self-hosting/configuration.md#custom-domains).
- **"This Tack is invite-only".** The person isn't on the access list: an admin adds them. See [Who can use it]({{site}}/self-hosting/access.md).
- **Anything else**: [Troubleshooting]({{site}}/help/troubleshooting.md), the [FAQ]({{site}}/help/faq.md), and the logs ([Observability]({{site}}/self-hosting/observability.md)).
