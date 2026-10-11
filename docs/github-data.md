# GitHub data

How live cards get their data, stay fresh, and survive repositories being renamed.

## Keys, names and ids

Card keys in board documents name the repository: `github.com/owner/repo#123`. They're the stable identity of a card in documents and URLs, and they're never rewritten.

`Repo` Durable Objects are keyed by host and the forge's repository id instead: `github.com/@123456` (see `src/server/routing.ts`). A rename or transfer changes the name but not the id, so a repository's cache and subscriptions never split.

- **Boards** resolve each repository name to its id once (`GET /repos/{owner}/{repo}`, which GitHub redirects for renamed repositories), and store the mapping in their own storage. A board keeps reaching a renamed repository by its old name indefinitely, without asking GitHub again.
- **Webhooks** carry `repository.id`, so they route straight to the right `Repo`.
- **`Repo`** caches cards by item (`#123`) and remembers which key each board subscribed with. It sends each board the card under that board's key, with `repo` set to the repository's current name, so the card shows the new name while the document keeps the old key.

### Renames and transfers

`Repo` learns the current name from every webhook delivery (including `repository` `renamed` and `transferred` events) and every fetch. When the name changes, it rewrites the name on every cached card, fans them out so boards show the new name (it highlights on the card), and refetches watched cards to refresh their URLs. Old URLs keep working meanwhile, since GitHub redirects them.

Existing card keys keep working through the mapping above, so board documents are never migrated. A board can hold the same item under its old and new names (say, one pasted before the rename and one after): both keys reach the same `Repo` and the same cached card.

Edge case: if someone later creates a new repository with the old name, boards that resolved the old name before keep pointing at the renamed repository (the one their cards were about). Boards resolving the name for the first time get the new repository.

## Fetching

GitHub-specific code lives in `src/server/forges/github.ts` and `github-graphql.ts`. With a token (`repoToken`), reads use batched GraphQL: `nodes(ids:)` for items fetched before, aliased `issueOrPullRequest(number:)` fields for new ones, 50 items per request. Without a token, or if GraphQL fails, they fall back to REST, one item at a time.

Pull request cards carry `pull` details (`src/shared/cards.ts`): the CI rollup on the head commit (passed, failing, pending and skipped counts, plus failing check names), the review decision and each reviewer's latest state, mergeability, and the issues the PR closes. REST and webhook payloads only give `basic` details: head commit, mergeability and requested reviewers, but no CI, review decision or linked issues. The card says so rather than guessing. When a webhook's basic details arrive for a card that has full ones, `Repo` keeps the full ones until a refetch replaces them.

## Freshness

- **Item webhooks** (`issues`, `pull_request`) update cards immediately. Older payloads never overwrite newer ones, and neither does a fetch that raced a newer webhook.
- **CI and review webhooks** (`check_run`, `check_suite`, `workflow_run`, `status`, `pull_request_review`, plus `pull_request` for its derived state) queue a refetch of the PR, debounced per item with a `Repo` alarm: 2 s after the last event, at most 8 s after the first. A burst of CI events costs one fetch. `status` events (and checks on PRs from forks) name only a commit, matched to PRs by head commit. Only items some board is watching are refetched. If GitHub hasn't worked out mergeability yet, the refetch is retried a few times.
- **Parent issues**: issue cards say which issue they're a sub-issue of (`Card.parent`, from GraphQL's `parent`; REST's `parent_issue_url` where it's there, and webhook payloads that don't say keep what the last full fetch said). `sub_issues` webhooks queue a refetch of the sub-issue, as does a push that makes one (`Repo.refetchItems`), so the parent issue action knows the hierarchy without asking.
- **Reconcile on wake**: the first time a `Repo` serves cached cards after waking (and at most every five minutes after that), it checks every watched card with one cheap query (`updatedAt`, plus each PR's head commit, mergeability and check counts, since CI doesn't touch `updatedAt`), then fetches only the stale cards in one batch. Without a token, it lists the repository's recently updated issues over REST instead. Corrections fan out to boards like any other update.
- **Redelivery**: GitHub doesn't retry failed webhook deliveries, so a cron (every ten minutes, `src/server/github/redeliver.ts`) lists the app's recent deliveries and redelivers the ones that failed with a 5xx or never arrived, up to three attempts each. It needs a GitHub App (`appJwt`) and skips without one. Redeliveries reuse the delivery id, which `Repo` dedupes on for three days.

Boards sync their subscriptions after card shapes are added, removed or re-pointed, debounced (150 ms, at most 1 s). Moving shapes and typing in stickies don't trigger a sync.

## Two tiers of repository access (#9)

Boards can hold items from any repository. What Tack can do with them depends on whether the GitHub App is installed on it:

|         | App not installed                                                    | App installed      |
| ------- | -------------------------------------------------------------------- | ------------------ |
| Repos   | Public only (private ones 404, so their cards say "install the app") | Public and private |
| Updates | Fetched on view, then ETag-polled while someone's looking            | Live, via webhooks |
| Writes  | None (`writable: false`)                                             | M2                 |

`Repo` decorates every card it sends with its repository's status: `live` (the app is installed), `writable` and `visibility` (`public` or `private`; unknown counts as private). It learns whether the app is installed from `isInstalled` (rechecked every ten minutes) and visibility from the repository's REST record and every webhook's `repository.private`, including `privatized` and `publicized` events, which resend every card so boards filter them afresh.

- **Watching**: while a board has anyone connected, it tells each of its repositories every minute (`Repo.watch`), as a three-minute lease. It names a connected viewer, whose own token reads public data where there's no installation: the app's user tokens only reach public data there, but with that person's rate limit rather than the anonymous 60 an hour.
- **Polling**: a `Repo` that isn't live polls with its alarm while any lease is current, and never otherwise: every minute with a token (a 304 costs no rate limit), every five without. One conditional request lists the repository's 50 most recently updated items (`If-None-Match` with the last ETag); on a change, the cards that changed are refetched, and if more changed than a page shows since the last poll, everything is reconciled instead. The five-minute reconcile also runs while watched, which (with a token) catches CI changes that don't touch `updatedAt`. Opening a board polls at once if the last poll is more than 15 s old (60 s without a token).
- **Installing the app**: a not-live card's tooltip, and a private repository's "install the app" card, link to `/setup/install?state=<board path>`, which redirects to `https://github.com/apps/<slug>/installations/new` with that state; GitHub sends people back through `/setup/installed`, which returns to the board. Installation webhooks (and `/setup/installed` itself) reach `Instance`, which notifies whoever asked to hear about those repositories (`install_watchers`): `Repo` objects register when they wake, and boards register repositories they couldn't read at all. A `Repo` that goes live refetches its watched cards with the installation's token and resends them all, so cards upgrade in place without a reload; one that's uninstalled downgrades the same way.

## Who sees what (#10)

`Repo` caches are shared by every board and viewer, so each `Board` filters what each connection receives (`src/server/visibility.ts`):

- Each connection's viewer comes from the Worker (`authorizeBoardConnection`, in the `x-tack-access` header), and every card message goes through `send`, per connection and in order, including the first `cards` snapshot and every update.
- Public cards go to everyone. For any other card, the board checks whether the viewer can read the repository with their own token (`GET /repositories/{id}`), caching the answer per viewer and repository. Anonymous viewers (on public boards), and anyone without a token (dev sign-in users), can't. Errors count as no. Board roles never grant access to repository data: an owner of a board sees placeholders for repositories they can't read, like anyone else.
- Viewers who can't read it get `{ key, missing: true, reason: "private" }`: the key is already in the board's document; the title, labels, people and everything else never leave the server.
- Pull request cards can carry the titles of issues they close in other repositories. Unless GitHub said that repository is public, those titles are blanked.
- Nothing else sends card data to clients. `Board.liveCards()` (unfiltered) is RPC-only, for tests. Logs name repositories and logins, never titles. Anything derived from a board must use shapes and card keys only: the home page thumbnail (`boards/thumbnail.ts`) is rectangles and colours, with no text from cards, and only public cards lend it their state's colour.

**Latency of access changes**: answers are cached for five minutes when yes, two when no, 15 s after an error. While anyone's connected, the board rechecks stale answers every minute and resends what changed, so losing access shows within about six minutes and gaining it within about three. Gaining it shows at once on reconnecting (a new connection rechecks answers older than 5 s) or when the viewer presses "Check again" on the placeholder (a `recheck` message, at most every 5 s per connection).
