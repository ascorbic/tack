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
- **Reconcile on wake**: the first time a `Repo` serves cached cards after waking (and at most every five minutes after that), it checks every watched card with one cheap query (`updatedAt`, plus each PR's head commit, mergeability and check counts, since CI doesn't touch `updatedAt`), then fetches only the stale cards in one batch. Without a token, it lists the repository's recently updated issues over REST instead. Corrections fan out to boards like any other update.
- **Redelivery**: GitHub doesn't retry failed webhook deliveries, so a cron (every ten minutes, `src/server/github/redeliver.ts`) lists the app's recent deliveries and redelivers the ones that failed with a 5xx or never arrived, up to three attempts each. It needs a GitHub App (`appJwt`) and skips without one. Redeliveries reuse the delivery id, which `Repo` dedupes on for three days.

Boards sync their subscriptions after card shapes are added, removed or re-pointed, debounced (150 ms, at most 1 s). Moving shapes and typing in stickies don't trigger a sync.
