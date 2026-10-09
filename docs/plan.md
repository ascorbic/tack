# Tack plan

Tack is a GitHub-native whiteboard for open source planning. Cards on the board are live views of GitHub objects, the canvas is freeform, and changes to GitHub are staged and pushed deliberately. It's built for async, distributed teams, it's open source and self-hostable, and it has to feel delightful.

This plan covers everything needed to get from the spike to a 1.0, in milestones that each end with something people can use.

## Principles

These decide arguments before they start.

1. **GitHub is the source of truth; the board is a lens.** Tack stores layout, freeform content and the things GitHub has no home for (votes, decisions in progress, sessions). It never keeps its own copy of issue state.
2. **Moving things never changes GitHub.** Only explicit actions do, and they're staged, previewed and pushed as a batch.
3. **Automation adds, people arrange.** Rules and live queries can put things on a board, but never move or delete what someone placed.
4. **Async first.** Everything that works in a live session must also work across time zones over days.
5. **Delight is a feature.** FigJam is the bar. Interaction details ship with the feature, not after it. See `AGENTS.md`.
6. **Forge-neutral core, GitHub-first product.** Nothing outside `src/server/forges/` knows about GitHub, but the UI uses GitHub's capabilities fully, not a lowest common denominator.
7. **Self-hostable on a free plan.** One deploy to a Cloudflare account, with a GitHub App created by the manifest flow. Self-hosting is the only distribution for now; there's no public hosted instance.
8. **Boards aren't owned by a repo.** A board can hold items from any repo. Public repos work read-only with no setup. Installing the app on a repo upgrades its items to live updates and write access.

## Where we are

**Spike, done** (branch `spike/live-cards`, see `docs/spike.md`):

- `Board` and `Repo` Durable Objects; Yjs via y-partyserver with chunked snapshots
- signed webhooks with dedupe and out-of-order protection, fanned out to boards
- the forge adapter layer, with GitHub and a fake forge
- a React Flow canvas with live issue/PR cards and stickies
- drags shared through awareness, committed on drop
- presence cursors
- `/play` and `/play/cards`, plus the first polish pass

**Proven**: React Flow handles hundreds of DOM cards. Drag-end commits keep Yjs growth small.

**Not yet**: auth, permissions, a GitHub App, writes to GitHub, and most of the canvas.

## Milestones

Estimates are rough, in focused weeks for one person working with Claude. Treat them as relative sizes, not promises.

### M1: A real board (private alpha) · ~5–7 weeks

The goal: plan an unpic milestone on Tack with two or three people, for real.

**Identity and access**

- GitHub App (manifest flow), with user-to-server OAuth for sign-in and a signed session cookie (Arctic)
- instance access control, since every instance is self-hosted: who may sign in (allowed users and orgs), and who administers the instance
- installation tokens per installation, cached and refreshed

**Boards, independent of repos**

- a board index in D1: create, rename, archive, list "my boards" and "shared with me"
- board membership: owner, editors, viewers, with invites by GitHub username
- board visibility: private, anyone signed in to the instance, or public (read-only, no sign-in)
- URLs: `/b/{id}/{slug}`
- a home page of boards with thumbnails

**Items from any repo: two tiers**

|             | App not installed                                                             | App installed          |
| ----------- | ----------------------------------------------------------------------------- | ---------------------- |
| Which repos | Public only                                                                   | Public and private     |
| Updates     | Lazy: fetched on view, ETag-polled while someone's looking, marked "not live" | Live, via webhooks     |
| Writes      | None: actions that would write are disabled, with an "install the app" prompt | Staged and pushed (M2) |

- GitHub App user tokens only reach repos where the app is installed, plus public data. That's why private repos need the app, and why it's the honest upgrade path.
- per-viewer filtering for private items: if a viewer can't read the repo, they get a "private reference" placeholder and the title never reaches them. Board membership never grants access to repo data.
- pushing uses the pusher's own token, so GitHub decides whether they can write. Board roles only decide who can stage changes.
- an "install the app" flow from a not-live card, which returns the user to the board

**GitHub data**

- `Repo` keyed by repository id, not name, handling renames and transfers
- batched GraphQL fetching: `nodes(ids:)`, `statusCheckRollup`, `reviewDecision`
- PR cards with CI and review state, mergeability, and linked issues
- reconcile when a board wakes, plus a cron that redelivers failed webhooks
- handling for installation and repository lifecycle events
- debounced subscription syncing in `Board`

**React Flow probe (first two weeks)**

React Flow is a node-and-edge editor, so test the whiteboard primitives most likely to fight it before building on top:

- connectors with loose ends: drawing from a card into empty space, and dragging an end from one card to another
- arrows that attach anywhere on a shape's outline and follow it
- frames: dropping cards in and out, keeping coordinates and stacking order consistent with our fractional-index z-order
- pen strokes and free arrows on our own SVG layer inside the React Flow viewport, with our own hit testing

If any of these is painful, decide then whether to move that piece to our own layer or start replacing the engine. The Yjs data model doesn't depend on React Flow, so either path keeps the data.

**Canvas core**

- selection: multi-select, marquee, shift-click
- undo/redo with `Y.UndoManager`, scoped to local changes
- copy, paste and duplicate; paste a URL to create a card (done)
- keyboard shortcuts and a shortcut sheet
- **sections/frames**: drop to contain, move together, resize, titles
- **connectors**: bound to shapes, routed, labelled, re-attachable
- stickies: colour picker, author, auto-sizing text, a handwriting font option
- text blocks
- snapping and alignment guides

**Presence**

- named, coloured cursors from GitHub identity, and avatars in the bar (partly done)
- cursor chat (type `/`)
- follow someone's viewport

**Delight**

- each feature above gets a `/play` scenario and gallery entries
- dark mode
- the empty board and first-run experience

**Ops**

- deploy to Cloudflare from Workers Builds
- error reporting and structured logs
- Playwright smoke tests for `/play` scenarios

**Exit**: a real planning session on unpic, then a list of what hurt.

### M2: Writing back to GitHub · ~4–5 weeks

The goal: a session's outcomes land in GitHub without anyone copying them over by hand.

**Operation model**

- forge-neutral operations, each targeting an item:
  - create issue
  - set labels, milestone, assignees
  - close or reopen
  - add sub-issue
  - link as blocked-by
  - comment
  - open a PR with files
  - create a Discussion
- the adapter applies them and declares which ones it supports

**Staging**

- actions queue into **pending changes**, and cards show their staged state
- anyone with edit access can stage; only people with write access can push

**Review and push**

- the push sheet from the mockup: grouped changes that can be toggled, a preview of each, and an estimate of how many watchers get notified
- push as yourself (user token, "via Tack") or as the bot
- batched writes, respecting rate limits

**Confirmation**

- each change is tagged and moves from sent to applied when its webhook arrives
- reconciliation, and failed changes return to the list
- an audit log of pushes on the board

**Built-in actions**

- sticky → issue, cluster → parent issue with sub-issues
- connector → blocked-by
- backlink comments with a board snapshot image

**Decisions**

- a decision object: proposed → decided → superseded
- linked items and votes
- written back as an ADR PR (`docs/decisions/NNNN-*.md`) or a Discussion post

**Exit**: one session produces issues, labels, a merged ADR and backlinks, with zero manual copying.

### M3: Widgets and automation · ~5–6 weeks

The goal: boards stay current without anyone tending them.

**Widget framework**

- typed configs (Valibot schemas) and a registry
- widgets render as nodes
- the server runs their queries with the viewer's permissions

**Live list**

- any search, kept live
- drag a row out to make a card (a copy; the list is unchanged)
- an on-board marker, with linked highlighting between row and card

**Drop to match**: dropping a card onto a list stages the changes that make it match (e.g. adding a label).

**Inbox frames**

- a query-bound frame: new matches land in a tray marked "new"
- people sort them; automation never rearranges

**Provenance**

- each card records how it arrived: manual, dragged from a list, inbox, or rule
- this decides what happens when it stops matching

**Expand related**: lay out linked PRs, sub-issues and blocked-by links around a card.

**Widgets**

- review queue
- milestone (progress, trend, at-risk)
- timeline (between two dates)
- release draft
- stale finder
- dependency map

**Rules**: e.g. "when a PR mentions a card on this board, place it beside the card".

**Exit**: a triage board that fills itself, and a release board that tracks a milestone.

### M4: Async and facilitation · ~5–6 weeks

The goal: planning that works across time zones and over days, plus live sessions that are fun to run.

**Since you were here**: board edits, GitHub activity and pushes since your last visit, with highlights on the canvas.

**History**

- a timeline scrubber and replay, built from Yjs snapshots and the event log
- per-section history

**Voting**

- dot votes with limits per person
- live voting, or a window that stays open for days
- reaction mirroring: 👍 on GitHub counts as a vote

**Silent mode**: hide others' stickies in a section until it's revealed.

**Facilitation**: timer, spotlight and follow, stamps and emotes, high-fives.

**Comments**: threads on sections and shapes, with mentions.

**Action items**

- owner and due date
- status comes from the linked issue
- carried into the next retro

**Templates**: retro, triage, release planning, roadmap (Now/Next/Later), incident review.

**Exit**: a retro run fully async over three days by people in three time zones.

### M5: Open beta and self-hosting · ~4–5 weeks

The goal: anyone can run Tack, and boards can be seen outside Tack.

**Self-hosting**

- a Deploy to Cloudflare button
- a GitHub App manifest setup wizard
- a configuration guide and upgrade path (doc schema versioning and migrations)

**Public boards**: polish the public visibility setting from M1. Public boards serve only public-repo data to anonymous viewers, with good link previews.

**Embeds**

- live board-region images (SVG/PNG) for READMEs, rendered with Satori + resvg
- OG images for shared links

**Comment commands**: `@tack add to <board>` from issues and PRs.

**Export**

- PNG/SVG of a selection or the whole board
- board JSON export and import
- snapshots to an orphan branch (optional)

**Hardening**

- Yjs compaction for very old boards
- load tests for connections per Durable Object
- rate-limit backoff
- security review (CSP, sanitising card content, webhook replay)

**Accessibility audit**: keyboard canvas navigation, screen-reader summaries of boards, contrast, reduced motion.

**Docs site**: Astro Starlight, covering getting started, self-hosting and the widget reference.

**Exit**: a stranger deploys their own instance from the README in under 15 minutes.

### M6: Beyond 1.0

**AI**

- "ask for a widget": description → typed config → previewed and applied
- cluster and summarise stickies
- draft decisions

Any writes the AI proposes go through pending changes.

**More forges**: Forgejo/Codeberg and GitLab adapters, and Tangled via the atproto firehose.

**Custom widgets**: sandboxed iframe code with a read-only data API.

**Mobile**: view, vote, comment and add stickies on phones; editing on tablets.

**Digests**: weekly board and repo summaries by email or Discussion post.

## Cross-cutting work

These run through every milestone, not as a phase.

**Delight**

- every feature ships with a `/play` scenario, gallery states, and a motion review in slow ×10
- a design-token layer that dark mode and theming build on

**Performance budget**

- 60fps pan and zoom with 500 cards
- under 2 s to an interactive board on a warm Durable Object
- `/play?scenario=stress` in CI as a benchmark

**Testing**

- unit tests and workerd integration tests (Vitest)
- Playwright end-to-end tests driven by `/play` scenarios
- visual regression on the gallery

**Data safety**

- doc schema versions and migrations
- snapshot backups to R2

**Observability**: logs, traces, and webhook and push failure dashboards.

**Dogfooding**: plan Tack on Tack from M1 onwards.

## Open decisions

| Decision                 | Options                                                      | Leaning                                                                                           |
| ------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Licence                  | **Decided: MIT**                                             | Matches the other projects and invites contribution                                               |
| Board ownership          | **Decided: boards are independent**                          | Membership and visibility per board; items from any repo; installing the app upgrades a repo      |
| Hosted instance          | **Decided: self-host only, for now**                         | Instances need sign-in allowlists; no quotas or abuse handling yet                                |
| Repos without the app    | **Decided: read-only and lazy for public repos**             | Private repos need the app installed (a GitHub App token limit)                                   |
| Anonymous viewers        | Public boards readable without sign-in?                      | Yes for public repos, read-only                                                                   |
| Canvas engine            | Stay on React Flow, or move to a custom DOM+SVG engine later | React Flow until it blocks freeform work. The data model is renderer-independent so we can switch |
| AI provider              | Workers AI default, admin-configured key, or off             | Off unless configured; Workers AI on Cloudflare                                                   |
| Pen and freeform drawing | M1 or later                                                  | After sections and connectors                                                                     |

## Risks

**GitHub ships its own version.** This is the main reason similar tools died. Mitigations:

- lean on what GitHub won't do: freeform canvases, staged batch writes, async facilitation, self-hosting, multiple forges
- don't compete with Projects on task management

**React Flow's limits for freeform work** (free arrows, rotation, pen). Mitigations:

- keep the data model renderer-independent
- build connectors early in M1 to find out

**Notification spam** from write-back makes maintainers hostile. Mitigations: batching, previews, watcher estimates, and backlink comments that can be turned off.

**API limits on busy repos.** Mitigations: webhooks first, batched GraphQL, ETag polling, and a cache per repo.

**Scope creep** into a task tracker. Mitigation: hold to principle 1.

## Next steps

1. Settle the remaining open decisions above.
2. Turn M1 into issues on `ascorbic/tack`. Dogfood: put them on a Tack board as soon as one exists.
3. Start M1 with the GitHub App and auth, since everything else depends on identity and permissions.
