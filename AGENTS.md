Guidance for coding agents and contributors working on Tack's code. `.claude/CLAUDE.md` is a symlink to this file.

Tack is a GitHub-native collaborative whiteboard for open source planning: one Cloudflare Worker (with Durable Objects) built with Vite+ and the Cloudflare Vite plugin, a React + React Flow client, and Yjs documents for boards. User-facing behaviour is documented on the site (`site/src/content/docs/`, published at tack.social); this file covers what you need to change the code safely.

## Design principle: delight

The UI must be delightful, with FigJam as the bar: considered typography, micro-interactions, and lots of small details (how a card lifts when picked up, how a live update lands, how a push confirms). Treat polish as a feature, not a follow-up. Respect `prefers-reduced-motion`, and keep interactions at 60fps.

- Every CSS duration is scaled by `--motion` (`src/client/styles.css`), so slow motion and reduced motion apply everywhere; `test/motion.test.ts` fails on one that isn't. Looping animations play once with motion reduced. Use the spring easings (`--ease-spring`, `--ease-settle`), not ad hoc curves.
- Text holds WCAG AA in both themes: quieten a state with a quieter ink, an outline or a strike, never by fading text with opacity (axe fails it, `e2e/a11y.spec.ts`).
- Design the interaction details (pickup, drop, live updates, presence, confirmation) with the feature, and add every new state to a `/play` gallery.

## Conventions

- **Commits**: small Conventional Commits, `type(scope): what changed, in plain words`, lowercase, no trailing period, no attribution lines (e.g. `fix(stacks): a stack's name is a 16px heading, in proportion with the cards around it`). Work goes straight to `main`, which Workers Builds deploys to production; push a branch only for a Worker Preview or a risky change (such as a board schema change). Run `pnpm check`, `pnpm test` and `pnpm build` (and the site build if `site/` or docs changed) before pushing.
- **Comments** are for a future reader of the code, not whoever reviews the change: plain sentences saying what something is and why, in British spelling. A block comment at the top of a module explains its part of the design, and the Yjs schemas are documented as tables at the top of their files (`src/shared/shapes.ts`, `src/shared/widgets.ts`). Anywhere else, a comment earns its place only when the code can't be made clearer, or to give a reason a reader would otherwise get wrong (an ordering constraint, a footgun, an invariant). A comment is never a summary of the change, a message to the reviewer, a justification for a decision ("intentionally", "for safety", "unlike X"), an account of what was tried and rejected, or a restatement of what the code plainly does. Never cite issues, pull requests or review threads, and never number comments: a decision's history goes in its commit message. Point at code, a site docs page or a section of this file, never at a document that may not exist. Tool directives (`oxlint-disable`, `@ts-expect-error`) keep the short reason that says why the rule doesn't apply there.
- **Code**: TypeScript throughout, formatted with tabs. Format, lint and type check are oxfmt, oxlint and tsgolint through `vp check` (no prettier or eslint). Import test APIs from `vite-plus/test`. Pure logic goes in `src/shared/`, so it's unit-tested in Node and shared by the server, the client, the playground and the demo.
- **Testing approach**: unit-test pure logic in Node; test server behaviour through the built Worker in Miniflare (`test/harness.ts`), with fakes for GitHub, other forges, AI and email; use Playwright (`e2e/`) only for what needs a browser. Every new `/play` scenario or gallery state goes in `e2e/play.spec.ts` or `e2e/gallery.spec.ts`, and new galleries in `e2e/a11y.spec.ts`'s list. See "Testing".
- **Parallel agents never run the full e2e suite.** Each run starts its own dev server and browsers, and several at once overload the machine until runs time out and flake. Run `pnpm check`, `pnpm test`, `pnpm --filter site build` and only the specs you touched (`pnpm e2e e2e/display.spec.ts --workers=2`, with your own `E2E_PORT` in a worktree), and stop any dev server you start. The full suite runs once on `main`, and in CI.
- **Example content** (fixtures, playground scenarios, tests, docs and screenshots) uses only the owner's projects (unpic, cirrus, emdash, tack) or made-up names, and fictional people; never real third-party products or services. It ends up on tack.social. Platform and dependency names (Cloudflare, GitHub, npm packages) are fine.
- **Docs move with the code**: when behaviour the docs describe changes (a UI string, a shortcut, a setting, a permission, a limit), update the page in `site/src/content/docs/` in the same change, and `site/src/agents/setup.md` with the self-hosting pages.

## Commands

- `pnpm install` — also runs `cf workers types` (`postinstall`), generating `.cloudflare/types/`
- `pnpm dev` — the dev server (`vp dev`), with `/play` and dev sign-in. `cf dev` and `cf build` expect a `vite` binary, which Vite+ doesn't provide, so always use `vp`
- `pnpm test` — unit and integration tests (`vp test`); `test/global-setup.ts` builds the Worker first
- `pnpm check` — format check, lint and type check in one pass (`vp check`); `pnpm fix` applies formatting and safe lint fixes
- `pnpm build` — production build; check anything the browser loads from elsewhere in the built app (`pnpm build && vp preview`) as well as the dev server, since the CSP differs
- `pnpm e2e` — Playwright (`e2e/`, config `e2e/playwright.config.ts`). Starts its own dev server on port 5205 (or `E2E_PORT`), or reuses one there. Install the browser once with `pnpm exec playwright install chromium`
- `pnpm e2e:webkit` — the same in WebKit (Safari), opt-in: `E2E_WEBKIT=1` adds a `webkit` project over the specs that cover what Safari does its own way (mobile, try, embed, embeds, images, links, canvas, stacks, cards); `E2E_WEBKIT=all` runs every spec in it. Not part of CI. Install once with `pnpm exec playwright install webkit`
- `pnpm e2e:visual` / `pnpm e2e:update` — also run (or rewrite the baselines for) the opt-in pixel comparison of the card gallery
- `pnpm run deploy` — `vp build` then `cf deploy --prebuilt` (needs `cf auth login` or `CLOUDFLARE_API_TOKEN`). Note the `run`: `pnpm deploy` is pnpm's own workspace command. Production deploys come from Workers Builds on every push to `main`, not from CI or local machines. A new Worker's first deploy needs `TACK_SECRET`: `pnpm run deploy --secrets-file <file>`
- `pnpm run deploy:preview` — `CLOUDFLARE_PREVIEW_BUILD=true vp build`, then `cf previews deploy --prebuilt`. Workers Builds runs it for every other branch, so each gets a Worker Preview with its own URL and isolated Durable Objects. We set `CLOUDFLARE_PREVIEW_BUILD` ourselves because `cf build` would need a `vite` binary
- `pnpm run wrangler-config` — regenerate `wrangler.jsonc` from `cloudflare.config.ts`; run it after any change there, or `test/wrangler-config.test.ts` fails
- `pnpm types` — regenerate `Env` types after changing bindings
- `pnpm --filter site dev` / `build` — preview or build the docs site (the build fails on broken links, undocumented widget settings and setup.md problems); `pnpm --filter site run deploy` builds and deploys it, then starts an AI Search sync; `pnpm --filter site run reindex` starts one on its own
- `pnpm --filter site screenshots <dev server URL>` — retake the docs' screenshots; `pnpm --filter site og` redraws `site/public/og.png`
- `pnpm --filter site run clips -- [name]` — record the looping social clips from the playground into `clips-out/` (not committed); see `site/scripts/clips/run.ts`
- `node scripts/send-webhook.ts` — send a signed webhook to a local dev server (reads `GITHUB_WEBHOOK_SECRET` from `.dev.vars`)
- `node scripts/load-test.ts` — see "Load"

`cf` uses the Cloudflare account you last used, so commands here need no account id; set `CLOUDFLARE_ACCOUNT_ID` only to target a different account.

## Configuration architecture

- **`cloudflare.config.ts` is the source of truth for the Worker**: name (`NAME`), entrypoint, compatibility, bindings, observability, via `defineConfig` from `cf/config` (no Wrangler dependency), which both `cf` and the Vite plugin read. The entrypoint uses the `with { type: "cf-worker" }` import attribute, which makes `Env` and `exports` inference work: keep that form.
- **Bindings** are declared there (`env: { MY_KV: bindings.kv() }`), and `Env` is inferred from them (`pnpm types`). Durable Object bindings to this same Worker are untyped; `src/server/namespaces.ts` restores the class types. Integration tests declare the same bindings for Miniflare in `test/harness.ts`: keep the two in step.
- **`compatibility.ts`** holds the compatibility date and flags, shared with the test runtime so tests match production. It's a separate file because `cloudflare.config.ts`'s exports are schema-validated.
- **Previews**: the function form of `defineConfig` receives `isPreview` and returns a complete config for both (previews inherit nothing). Previews get no secrets and no cron triggers (Preview uploads refuse them), so code must treat `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN` and `TACK_SECRET` as optional.
- **Secrets**: one declared with `bindings.secret()` is _required_ on deploy, and deploys keep secrets that aren't declared. So production declares only `TACK_SECRET`; the optional `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN`, `TACK_FORGES` and `TACK_DEV_AUTH` are declared only in `mode === "development"` (so `.dev.vars` can set them) and kept in production when set on the Worker. **Never declare a new optional secret for production**: it breaks every new instance's first deploy.
- **The Deploy to Cloudflare button** reads only `wrangler.jsonc` (generated by `scripts/wrangler-config.ts` with the converter `cf` uses; never edit it by hand), prompts for the secrets in `.dev.vars.example` (`TACK_SECRET` only, described in `package.json`'s `cloudflare.bindings`), and runs `package.json`'s `deploy` script. It deploys the name in `cloudflare.config.ts`. The self-hosting pages (`deploy.mdx`, `configuration.md`, `upgrades.md`) describe it.
- **Version pins that move together**: the `vite@*` and `vitest@*` overrides in `pnpm-workspace.yaml` pin Vite to `@voidzero-dev/vite-plus-core` at the installed `vite-plus` version, and Vitest to what `vp toolchain vitest` reports. Update them whenever `vite-plus` changes. There are no direct `vite` or `vitest` dependencies. The site keeps its own Vite for Astro (`astro>vite`).
- **Satori is pinned to 0.32.0**: from 0.33 it loads HarfBuzz from a file at import time, which Workers can't do.

## Repository map

Root:

- `src/index.ts` — the Worker entrypoint: routing, the cross-site check, security headers, Durable Object exports
- `cloudflare.config.ts`, `compatibility.ts`, `wrangler.jsonc` (generated), `.dev.vars.example` — see "Configuration architecture"
- `vite.config.ts` — the one Vite+ config: plugins, Vitest, oxlint, oxfmt, the `try` and `try-ai` build modes, and the `_headers` file for static assets
- `index.html` — the client's entry; `src/client/tsconfig.json` adds DOM types
- `.cloudflare/types/` — generated `Env` and runtime types, not committed

Server (`src/server/`):

- `board.ts` — `Board` Durable Object, one per board: the Yjs document (y-partyserver), live card relay filtered per connection (`visibility.ts`), and the alarm shared by pushes, backups and digests (`alarmAt`). Most per-board features hang off it as helpers over its SQLite
- `repo.ts` — `Repo` Durable Object, one per repository (by stable id, `routing.ts`): card cache, webhook log and fan-out to boards, refetches, polling, reconcile on wake, repository status. See `docs/github-data.md`
- `instance.ts` — `Instance` Durable Object (singleton): GitHub App credentials, installations and tokens, users, sessions, the access allowlist; every credential is encrypted at rest with `TACK_SECRET`
- `directory.ts` — `Directory` Durable Object (singleton): the board index, members, visits, thumbnails, notifications, settings such as `custom_widgets`
- `identity.ts` — `getViewer`, `viewerToken`, `canUseInstance`: the identity contract the rest of the code uses
- `auth/` — sign-in, sessions, OAuth with PKCE, instance access checks, crypto helpers
- `boards/` — `access.ts` (`roleFor`), the `/api/boards` routes and the per-board connection check (`routes.ts`), templates and carrying action items (`templates.ts`), people lookups (`people.ts`)
- `github/` — the GitHub App: manifest and app JWTs, `/setup` routes, webhook health, webhook verification, `tokens.ts` (`repoToken`, `isInstalled`: everything reading GitHub goes through it), the redelivery cron
- `forges/` — forge adapters: GitHub (`github*.ts`), GitLab, Forgejo, Tangled, and the synthetic `fake.tack` (`fake.ts`), with `config.ts` (which hosts an instance serves, `TACK_FORGES`), `rest.ts` and `rateLimit.ts` (`forgeFetch`). Everything outside this folder is forge-neutral
- `push/` — pushing staged changes: routes, planning (`plan.ts`) and the engine each `Board` runs (`engine.ts`)
- `widgets/runner.ts` — runs widget and inbox queries as the person looking; `widgets/sandbox.ts` — custom widgets' sandbox page
- `links/` — link cards' unfurling and image proxy, behind `guard.ts`'s `guardedFetch`
- `embeds/` — board images, link preview images and `/b/*` meta tags, drawn with Satori and resvg
- `ai.ts` — the one place the server asks Workers AI (`askModel`, `aiStatus`); `ai/` — AI on boards; `stacks.ts` — stack naming and Auto-stack
- `rules.ts`, `commands.ts`, `comments.ts`, `reactors.ts`, `since.ts`, `digests.ts` (+ `digestRoutes.ts`, `digestEmail.ts`, `email.ts`), `facilitation.ts`, `history.ts`, `images.ts`, `snapshots.ts`, `exports.ts`, `backups.ts`, `related.ts`, `itemSearch.ts`, `notifications.ts`, `compaction.ts` — one feature's server half each
- `migrations.ts` — Durable Object SQLite migrations; `securityHeaders.ts` — CSP and headers; `awareness.ts` — presence checks; `webhooks.ts` — `POST /webhooks/:forge`; `log.ts` — the structured logger; `clientErrors.ts` — browser error reports; `testClock.ts` — the test clock

Shared (`src/shared/`), forge-neutral and pure where possible:

- `shapes.ts` — the board document's shape schema (documented at its top) and `addCardShape`; `refs.ts` — item keys (`{host}/{repo}{#|!}{n}`), `parseRef`, `parseKey`, `isRepoPath`; `cards.ts` — card types
- `schema.ts` — board document versions and migrations
- Canvas logic: `geometry.ts`, `sections.ts` (containment), `connectors.ts`, `structure.ts`, `growth.ts`, `placement.ts`, `display.ts` (lists and mini cards), `repair.ts` (dangling references), `addCards.ts`, `place.ts`, `swap.ts`
- Features: `changes.ts` and `actions.ts` (staging), `decisions.ts` and `adr.ts`, `widgetRegistry.ts` and the widget kinds (`timeline.ts`, `releaseDraft.ts`, `dependencyMap.ts`, `review.ts`, `milestone.ts`, `stale.ts`, `customWidgets.ts`), `search.ts` (the one reading of GitHub-style searches), `inbox.ts`, `rules.ts`, `provenance.ts`, `related.ts`, `comments.ts`, `since.ts`, `digests.ts`, `history.ts`, `facilitation.ts`, `facilitator.ts`, `silent.ts`, `silentHub.ts`, `dotvotes.ts`, `volunteers.ts` (hands up, and staging them as assignees), `reactions.ts` (who reacted, for stamps and cards' reaction counts), `actionItems.ts`, `templates.ts`, `builtInTemplates.ts`, `prepared.ts`, `stacks.ts` and `stack*.ts`, `ai.ts`, `aiContext.ts`, `aiPlace.ts`, `images.ts`, `links.ts`, `linkPreview.ts`, `boardExport.ts`, `backups.ts`, `embed.ts`, `a11y.ts`, `compaction.ts`
- `fakeStackAi.ts`, `fakeBoardAi.ts` — the stand-in models for local dev, the playground and the demo

Client (`src/client/`):

- `main.tsx` — routes, including the `/play` galleries; `App.tsx`, `Board.tsx` — the app and the board canvas; `nodes.tsx` — React Flow node types
- `undo.ts` — `transactLocal` and undo; `connection.ts`, `pending.ts` — the live connection and edits kept until the server has them
- `sections.tsx`, `connectors.tsx`, `canvasStructure.ts` — sections and connectors on the canvas
- `commands.ts`, `shortcuts.ts` (the one list of shortcuts, also the docs' shortcuts page), `keys.ts`, `clipboard.ts` (`interpretText`), `snapping.ts`, `arrange.ts`, `navigation.ts`, `announce.tsx`
- Feature folders: `actions/` (the selection's action bar and popovers), `changes/` (pending changes and the push sheet), `widgets/` (and `widgets/custom/`), `inbox/`, `rules/`, `comments/`, `since/`, `facilitation/`, `history/`, `stacks/`, `display/`, `decisions/`, `actionItems/`, `volunteers/`, `links/`, `reactions/` (who reacted: the tooltip, and fetching a card's reactors on hover), `images/`, `export/`, `embeds/`, `digests/`, `ai/`, `boards/` (home page, share dialog, new board), `auth/` (sign-in and `/setup`), `touch/` (phones and tablets)
- `styles.css` — design tokens, motion and themes
- `play/` — the dev-only workbench (see "Playground, demo and site")
- `try/` — the public demo at tack.social/try, and `try/embed/`, the landing page's live embeds

Elsewhere:

- `src/demoAi/` — the docs site Worker's code (`tack-docs`): the demo's AI (see "The demo's AI")
- `site/` — the docs site (Astro Starlight): pages in `site/src/content/docs/`, agent docs in `site/src/agents/`, build scripts in `site/scripts/`
- `test/` — Vitest, in Node and Miniflare; `e2e/` — Playwright
- `scripts/` — `wrangler-config.ts`, `load-test.ts`, `send-webhook.ts`
- `docs/` — `github-data.md` (how cards are keyed, fetched and kept fresh), `security-review.md` (the security review and threat models), `accessibility.md` (the accessibility audit)

## The board document

Each board is a Yjs document held by its `Board` object. Its keys are documented at the top of `src/shared/shapes.ts` (and `widgets.ts`, `changes.ts` and the other modules that own a root map). One `Y.Map` per shape in `shapes`, one property per key, fractional-index `z`.

- **Every local write goes through `transactLocal(doc, fn)`** (`src/client/undo.ts`, origin `LOCAL_ORIGIN`), or it can't be undone. One transaction is one undo step. Changes from other people, the server and seeding are never undone. Server and automatic writes use their own origins (`PUSH_ORIGIN`, `RULE_ORIGIN`, `SILENT_ORIGIN`, `MIGRATE_ORIGIN`, `STACK_ORIGIN`, `UNFURL_ORIGIN`, `IMAGE_ORIGIN`, `TEMPLATE_ORIGIN`, `IMPORT_ORIGIN`, `GROW_ORIGIN`, `REPAIR_ORIGIN` and others), which history attributes and undo ignores. To fold a follow-up write into the step that caused it, use `History.amend` while that step is still the latest.
- **A committed move writes `x`, `y` and `parent` together**, even when the parent is unchanged or null, so concurrent moves resolve to one person's position and section, never a mix. (Deleting a key wouldn't work: a delete never beats a concurrent set.) Containment is decided geometrically when something is committed (`containerFor`), then stored, so the server reads it without knowing rendered sizes.
- **References can dangle** after concurrent edits (a section deleted while someone drops into it). Readers must tolerate them; `repair.ts` fixes them on the server.
- **Every card is made through `addCardShape`** (or the client's `addCard`) with its provenance; people add cards through `Board`'s `addCards` (`addCardsInRun`), which never adds a second card for an item already on the board unless asked.
- **Anything that places shapes in a section calls `growSections` in the same transaction**, so one undo takes both back. Growth is idempotent and only outwards; sections never shrink by themselves.
- **Card data never goes in the document.** Cards are keys; their data is relayed per connection and filtered for what each viewer can read (`Board.visibleTo`). Likewise silent mode's hidden text, comments, read state, visits, history and the push audit log live in the board object's SQLite, not the document.
- **Copies drop what belongs to the original**: paste and duplicate leave out the properties in `UNCOPIED` (`src/client/clipboard.ts`: provenance, silent marks, uploads, a decision's write-back, an action item's staged issue). A new property that shouldn't travel with a copy goes there.
- **Exports copy properties by name** (`KEEP` in `src/shared/boardExport.ts`): a new shape property stays out of exports until it's added there.
- Only the server writes `meta`. New _optional_ keys need no migration (readers default what's absent); anything else does (see "Format versions and migrations").

## Canvas and React Flow

React Flow renders the box-shaped nodes (cards, stickies, text, sections, widgets, decisions, stacks, images, link cards). Everything that isn't a box is on our own layers inside its viewport (`ViewportPortal`): connectors (`connectors.tsx`: ends that float or pin anywhere on an outline, routing and hit testing are ours), comment pins, inbox trays and marks. Containment, geometry and hit testing are ours too, in `src/shared/`, so the server and image renderer reuse them.

- **Containment is not React Flow's `parentId`**: each shape has a `parent` key and absolute coordinates. Sections sort first in the node array, outer before inner, with a negative `zIndex` (`SECTION_Z`), so a selected section (which React Flow lifts by 1000) stays beneath its contents. While a section is dragged its contents follow as derived overrides (`useCanvasStructure`); `commitMoves` writes everything on drop in one transaction.
- **One stacking context**: our layers sit at one z-index rather than interleaving with nodes, so a connector can't pass under one card and over another.
- **Pointer events**: our tools listen in the capture phase on React Flow's DOM node to get ahead of its drag and selection handlers, and our interactive elements use the `nodrag`/`nopan` classes. Every new tool has to follow that convention. React Flow's marquee only selects nodes.
- **Keys**: shortcuts ignore text fields; keys on a selected shape are shortcuts, never typed into it (Enter or a double-click edits). Keyboard focus is apart from the selection: **in any new handler for Enter, arrows or the like on the selection, check `isOnUnselectedShape`** (`keys.ts`). Arrow keys inside any `[role=toolbar]` aren't nudges. `shortcuts.ts` is the single list behind the key handling, the `?` sheet and the docs.
- **Chrome over the canvas**: mark any new panel that floats over the canvas with `data-chrome`, so popovers, the action bar and the minimap keep clear of it (`CHROME` in `src/client/actions/Popover.tsx`, `popoverPlacement.ts`); use `useInsideCanvas` for any new toolbar anchored to shapes.
- **Lists and mini cards** (a section's `display`): the document says only which mode, never where. Rows are the shapes' own React Flow nodes, repositioned by a pure layout from the document (`layoutDisplays`), so selection, connectors and keyboard focus keep working. React Flow's size for a row is never written into `measured` (`boxSize` only ever sees a shape's size as a card), and arrow keys never nudge rows.
- **Phones** (`src/client/touch/`, `useDevice`): a phone's board has no toolbar, selection or dragging, and taps open bottom sheets; tablets edit as a computer does, with touch-sized controls. Writing the document from a sheet is for editors, as everywhere.
- **Accessibility**: every node is named (`ShapeLabel.tsx`, `describeShape`), and anything a screen reader should hear that isn't on screen goes through `announce(text)`. Unavailable actions are `aria-disabled` with their reason, not `disabled`. See `docs/accessibility.md`.

## Auth and access

- **`TACK_SECRET`** signs session cookies and encrypts stored credentials (HKDF-derived keys). Without it (Previews) sign-in and setup are off, `getViewer` returns null, and boards work anonymously; code must keep working that way.
- **GitHub App**: created from a manifest at `/setup`; whoever completes setup becomes the first admin. Webhooks verify against the stored webhook secret, then `GITHUB_WEBHOOK_SECRET`. Installation tokens are minted with an app JWT, cached, and refreshed five minutes before expiry.
- **Sign-in**: the app's OAuth flow with state and PKCE (`/auth/signin` → `/auth/callback`). Sessions are a random id in a signed, HTTP-only, SameSite=Lax cookie (Secure over HTTPS); only its hash is stored. User tokens are stored encrypted and refreshed with rotation by `viewerToken`. Return paths are only ever paths on this site (`safeReturnTo`, `src/shared/returnTo.ts`).
- **Cross-site requests**: `src/index.ts` turns away every request that could change something (any method but GET, HEAD and OPTIONS) and every live connection whose `Origin` or `Sec-Fetch-Site` says another site (`isCrossSite`), before any route. Webhooks are the one exception: they're signed. Routes keep their own checks too.
- **Instance access**: once set up, only admins, allowed users and members of allowed orgs may use the instance (`canUseInstance`). Before setup everything is open.
- **Boards**: an owner, members (owner, editor, viewer; invited by GitHub login) and a visibility: private (members only), instance (anyone allowed on the instance, at `instanceRole`) or public (also anyone at all, read-only, signed out). Archived boards are read-only. **`roleFor` in `src/server/boards/access.ts` is the one function deciding a role.** Live connections are checked in the Worker (`authorizeBoardConnection`), which passes the role to the `Board` in a header it always overwrites; viewers get read-only connections, and role changes reach open connections at once (or close them with 4403).
- **Board membership never grants access to repo data.** Per-viewer card filtering is `Board.visibleTo` (with `src/server/visibility.ts`); the push audit log and digests go through `Board.redactAudit` (a change to a repository not known to be public reads "A change to a private repository" for viewers who can't read it).
- **Dev sign-in**: with `TACK_DEV_AUTH=1` in `.dev.vars` (declared for `vp dev` only; never in production), `/auth/dev?login=octocat` signs in a fake user on loopback hosts. Options: `name`, `admin=1`, `allow=1`, `orgs=a,b`, `return_to`. Dev users have negative ids.

## Access table

Who may use every route and every message on a board's connection (#60). "Can open" is `roleFor` (owner, editor or viewer; strangers only on public boards); "instance users" are people allowed on the instance (everyone before setup); "strangers" are signed out. `test/access-table.test.ts` checks every row with seven people (a stranger, someone signed in but not allowed, an instance user, a private board's viewer, editor and owner, and an admin): **add a row there, and here, with every new route or message type.** Everything that changes state is also same-site only (above).

| Route                                                                              | Who                                                                                     |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /api/me`, `POST /api/client-errors`                                           | Anyone (client errors: rate limited per IP)                                             |
| `GET /auth/signin`, `GET /auth/callback`, `POST /auth/signout`                     | Anyone (OAuth state and PKCE; sign-out ends your own session)                           |
| `GET /auth/dev`                                                                    | Only with `TACK_DEV_AUTH` (declared in dev only), on a loopback host                    |
| `GET /api/setup`                                                                   | Anyone; the access settings only for admins                                             |
| `PUT /api/setup/access`, `GET /api/setup/installations`, `GET /api/setup/webhooks` | Admins                                                                                  |
| `GET /setup/callback`                                                              | GitHub's code for the new app; whoever holds the setup claim becomes the first admin    |
| `GET /setup/install`, `GET /setup/installed`                                       | Anyone (redirects to GitHub and back, to paths on this site)                            |
| `POST /webhooks/:forge`                                                            | The forge's signature (GitLab: the host's token); each signed body counts once          |
| `GET /api/boards`                                                                  | Anyone: the boards they can open                                                        |
| `POST /api/boards`, `POST /api/boards/legacy`, `POST /api/boards/import`           | Instance users                                                                          |
| `GET /api/boards/:id`                                                              | Can open                                                                                |
| `PATCH /api/boards/:id`                                                            | Renaming: editors. Visibility, `instanceRole`, archiving, `customWidgets`: the owner    |
| `GET /api/boards/:id/members`                                                      | Can open, signed in (not strangers on a public board)                                   |
| `POST /api/boards/:id/members`, `PATCH /api/boards/:id/members/:login`             | The owner                                                                               |
| `DELETE /api/boards/:id/members/:login`                                            | The owner, or the member themselves (leaving)                                           |
| `GET /api/boards/:id/people`                                                       | Can open (strangers: the members only, not recent visitors)                             |
| `GET /api/boards/:id/history`, `…/history/segment`                                 | Can open                                                                                |
| `GET /api/boards/:id/pushes`                                                       | Can open (changes to repositories they can't read say only that they happened)          |
| `POST /api/boards/:id/push`                                                        | Editors, signed in                                                                      |
| `GET /api/boards/:id/search`, `GET /api/boards/:id/related`                        | Can open; asked with their own token, so only what they may read                        |
| `GET /api/boards/:id/reactors`                                                     | Can open; asked with their own token, about items they may read                         |
| `POST /api/boards/:id/snapshots`                                                   | Editors                                                                                 |
| `POST /api/boards/:id/unfurl`                                                      | Editors, signed in; rate limited per person and board                                   |
| `GET /api/boards/:id/links/image`                                                  | Can open; only images a link card on that board shows                                   |
| `POST /api/boards/:id/images`                                                      | Editors                                                                                 |
| `POST /api/boards/:id/images/copy`                                                 | Editors, who can open the board copied from (else the same 404)                         |
| `GET /api/boards/:id/images/:hash`                                                 | Can open (anyone else: the same 404 as a missing file)                                  |
| `POST /api/boards/:id/ai`                                                          | Editors, while AI is on (`TACK_AI`), within the board’s AI budget                       |
| `POST /api/boards/:id/carry`                                                       | Editors of the board carried to, who can open the board carried from                    |
| `GET /api/boards/:id/backup`                                                       | Editors                                                                                 |
| `PUT`/`DELETE /api/boards/:id/backup`, `POST /api/boards/:id/backup/run`           | The owner, who must be able to write the repository                                     |
| `GET /api/boards/:id/digest`                                                       | Can open, signed in; the preview holds only what they may read                          |
| `PUT`/`DELETE /api/boards/:id/digest`                                              | The owner, who must be able to write the Discussion's repository                        |
| `PUT /api/boards/:id/digest/subscription`                                          | Instance users who can open, signed in; nothing's sent until they confirm               |
| `DELETE /api/boards/:id/digest/subscription`                                       | Signed in: their own                                                                    |
| `POST /api/digests/confirm`, `POST /api/digests/unsubscribe`                       | Whoever holds the signed link from the email (one click, RFC 8058)                      |
| `GET /api/templates`                                                               | Instance users                                                                          |
| `POST /api/templates`                                                              | Editors of the board saved                                                              |
| `DELETE /api/templates/:id`                                                        | Whoever saved it, or an admin                                                           |
| `GET /api/repos/meta`, `GET /api/repos/files`, `GET /api/repos/categories`         | Instance users, for repositories they can read                                          |
| `GET /api/people`, `GET /api/people/:login`                                        | Instance users                                                                          |
| `GET /api/notifications`, `POST /api/notifications/read`                           | Signed in: their own                                                                    |
| `GET /snapshots/:id.png`                                                           | Anyone with the link (128 random bits)                                                  |
| `GET /embed/:id.svg`, `/embed/:id.png`, `/og/:id.png`                              | Anyone, public boards only: every other board is the same 404 as one that doesn't exist |
| `GET /b/:id/:slug`                                                                 | Anyone gets the app's page; link preview tags only for public boards                    |
| `GET /sandbox/widget`                                                              | Anyone: custom widgets' sandbox page, with no data in it                                |
| `WS /parties/board/:id`                                                            | Can open; viewers' connections are read-only; same-site only                            |

| Board message                                                                         | Who                                                                                                                                           |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Sync step 1 (reading the document)                                                    | Anyone connected                                                                                                                              |
| Sync step 2 and updates (writing it)                                                  | Editors and owners (y-partyserver drops viewers'; archived boards are read-only). From a document rebuilt since, the connection closes (4410) |
| Awareness (presence)                                                                  | Anyone connected; who they are comes from their sign-in, and only for their own client ids (at most four, 32 KB each)                         |
| `clock`, `silent-hello`                                                               | Anyone connected                                                                                                                              |
| `timer`, `spotlight`                                                                  | Editors; changing or ending someone else's: its starter, the owner, or any editor once the starter has left                                   |
| `silent-start`, `silent-text`, `silent-reveal`                                        | Editors (text: only their own stickies; reveal: the starter, the owner, or any editor once the starter has left)                              |
| `comment-*`                                                                           | Signed in and can open (strangers read only). Edit and delete their own; owners delete any; resolve and move their own, editors any           |
| `since-request`, `since-seen`                                                         | Anyone connected                                                                                                                              |
| `widget-watch`, `widget-unwatch`, `widget-refresh`, `inbox-preview`, `widget-preview` | Anyone connected; queries run with their own access (`public` for strangers)                                                                  |
| `widget-query`                                                                        | Anyone connected, for custom widgets only, while the owner has custom widgets on; run with their own access, at most 8 searches a widget      |
| `recheck`                                                                             | Anyone connected (throttled)                                                                                                                  |
| `stack-group` (Auto-stack)                                                            | Editors (refused with `not_editor` otherwise); one at a time per connection, within the board's AI budget. `stacks-ai` goes to everyone       |

## Security

The security review (#60) is in `docs/security-review.md`: what was checked, what was fixed, what's left, and the threat models for link cards and custom widgets. What code has to keep doing:

- **Headers on everything**: the Worker's responses get them from `withSecurityHeaders` (`src/server/securityHeaders.ts`): nosniff, `X-Frame-Options: DENY`, a referrer policy, COOP, a permissions policy, HSTS over HTTPS, and a CSP (`default-src 'none'` for data; `same-origin` resources for `/api/` and `/auth/`). Pages the Worker serves (`/b/*`) get the app's policy with the hashes of the inline scripts they actually have; a 304 carries no policy. Static assets get theirs from the `_headers` file the build writes (`securityHeaders()` in `vite.config.ts`), with the hash of `index.html`'s inline theme script.
- **The app's CSP** (`appCsp`): scripts only from the app and by hash (**never add inline scripts or eval**), styles inline (React Flow positions nodes with `style`), images from any HTTPS host, `data:` and `blob:`, fetches to the app, `wss:` (older Safari doesn't count the board's own WebSocket as `'self'`), `avatars.githubusercontent.com` and `github.com` (snapshots and exports inline avatars), `base-uri 'self'` (modern-screenshot resolves fonts with a `<base>`), forms to the app and GitHub (the app manifest), `frame-src 'self'`, no framing of the app. Anything new the browser loads from elsewhere needs a directive, checked in the built app as well as the dev server.
- **Links from the document or the forge** go through `safeUrl` (`src/client/changes/inline.ts`): only http(s). Never `dangerouslySetInnerHTML` with anything that isn't ours; Markdown previews render as React elements.
- **Repository names** in keys must be plain path segments (`isRepoPath` in `src/shared/refs.ts`; `parseKey` and `parseRepoKey` refuse others), and paths built from anything else are encoded (`segments`), so nothing written into a board can point a request carrying someone's token at another API path.
- **Webhooks**: only the body is signed, so deliveries are told apart by its SHA-256 (`digestOf`) as well as their id (`Repo` keeps both for three days, installation events' for 30), and comment commands written more than a week ago are ignored.
- **Server-side fetches** only ever go to forge APIs at fixed hosts through `forgeFetch`: GitHub's, and the hosts in the instance's forge configuration (`config.ts`), never one a board names that isn't configured. The one exception is link cards, and only through `guardedFetch`. **Never `fetch` a URL from a document, a request or a page any other way.**
- **Link cards** (`src/server/links/`): `guardedFetch` allows http(s) on standard ports with no credentials, refuses local names and every non-public IPv4 and IPv6 range (IPv4 inside IPv6 too), resolves names over DNS over HTTPS and refuses any private answer, follows at most three redirects by hand checking each hop, and times out (5 s a hop, 8 s in all); callers read at most 512 KB of a page and 5 MB of an image (`readCapped`). Unfurling is for signed-in editors, rate limited per person and board (`UNFURL_LIMITS`) and cached a day. The image proxy only fetches what a link card on that board shows, types images by their bytes (`sniffImage`) and serves them with `nosniff` and a sandboxing CSP. The playground and the demo use `playLinks`, never the routes. Logs never hold a link's whole address.
- **Pasted and dropped text** goes through `interpretText` (`src/client/clipboard.ts`): only references (`parseRef`, first) and bare http(s) addresses (`linkUrl`) make cards; anything else is a sticky.
- **Custom widgets' code** only ever runs in the sandbox: an iframe with `sandbox="allow-scripts"` and nothing else, loading `SANDBOX_PATH`, whose CSP loads nothing. **Never add `allow-same-origin` or any other flag, never relax the sandbox page's policy, never run a widget's code anywhere else** (not in the app, not in a worker of the app's origin), and keep the app's `frame-src 'self'`. Everything a frame sends is untrusted: check it with `parseFrameMessage`, answer only its own window, and only with what the person looking may read. Nothing in its API writes.
- **Images** are sniffed by their bytes (PNG, JPEG, GIF, WebP, AVIF; never SVG, which the browser draws to PNG before upload), served from the instance's origin with `nosniff` and `default-src 'none'; sandbox`, only to people who can open the board.
- **Presence**: `sanitizeAwareness` (`src/server/awareness.ts`) checks every awareness update: who people are comes from their sign-in, a connection only speaks for its own few client ids, states are bounded.
- **Rate limits**: every forge call goes through `forgeFetch` (`src/server/forges/rateLimit.ts`), which keeps primary, secondary and GraphQL limits in a per-isolate gate by token (hashed) and resource and answers 429 itself while one holds. Callers read `rateLimitOf` and wait for the same `retryAt`.
- **What never goes in logs**: tokens, comment text, hidden sticky text, AI prompts, board content or answers, IP addresses, links' whole addresses.

## Privacy rules by feature

Each feature below has rules the server enforces. Docs paths are relative to `site/src/content/docs/`, where the behaviour is described.

### Public boards and embeds

Public boards are readable by anyone, signed out, read-only. Whatever a signed-out visitor gets on any channel is only what anyone may see: cards from repositories not known to be public are bare placeholders (`visibleCard`), widget and inbox queries run at the `public` access level, related and search answer with public items only, the digest's card activity skips what they can't read, the push log is redacted, and `GET /api/boards/:id/people` gives the members but not recent visitors. Board content itself (stickies, comments, staged changes' text) is public on a public board. `test/public-boards.test.ts` checks every channel.

Embeds and link preview images are drawn on the Worker, never in a browser:

- **Only public boards**, checked on every request with `Directory.publicBoard(id)`, which answers null for private boards, instance boards and boards that don't exist alike: the same `404` image, the same plain app shell page.
- **`buildScene` (`src/shared/embed.ts`) is the only place deciding what's drawn**, from `Board.embedData()` (exactly what an anonymous connection gets). It draws nothing of a card that isn't `visibility: "public"`, face-down stickies face down, widgets as frames, link cards from their saved preview's words (nothing is fetched); no comments, stamps, votes, staged changes or authors.
- **Rendering**: `draw.ts` (pure, unit-tested in Node) builds Satori's element tree; Satori and resvg are WebAssembly modules imported compiled (`.wasm`), and the fonts as data (`.bin`), since Workers can't compile WebAssembly from bytes. The renderer is a dynamically imported chunk.
- **Caching**: the ETag hashes the scene, options, title and `RENDERER_VERSION`; **bump `RENDERER_VERSION` when drawing changes**. Drawing takes a few hundred ms of CPU, more than the Workers Free plan allows (`site/src/content/docs/self-hosting/costs.md` says so).

### Silent mode

A shared Yjs document can't keep a secret (every update goes to every connection), so **hidden sticky text never goes into the document**. A sticky made in a silent section has no `text`; its author's client sends what they type as `silent-text`, the server keeps it per author in SQLite (`SilentHub`) and sends it back only to that author's connections, and `silent-reveal` writes every kept text into the document at once (`SILENT_ORIGIN`). Only the server starts and ends silent mode: marks clients write themselves are put right (`SilentHub.reconcile`). `test/facilitation-board.test.ts` checks nothing another connection receives contains hidden text, and `test/history-board.test.ts` that history never does. Docs: `facilitation/silent-mode.mdx`.

### Comments and since you were here

Comments live in the board object's SQLite (`src/server/comments.ts`), not the document: viewers can comment but can't write the document, the server stamps who wrote each message, and read state is private (sent only to its owner's connections). Mentions are checked against the board's people. Since-you-were-here's card activity covers only repositories the viewer can read.

### Comment commands

`@<app slug> add to <board> [in <section>]` on GitHub puts the item on a board (`src/server/commands.ts`, `src/shared/commands.ts`, GitHub's half in `forges/github-commands.ts`). The commenter must be a Tack user allowed on the instance who can edit the board. **An item from a repository not known to be public only goes on a private board with no outstanding invites whose members can all read it**, each checked with their own token. Replies are public wherever the item is, so they never name a board or section that isn't public unless the commenter did, and quote people's words defused (`quote`). Each comment runs once (remembered by comment id for 30 days); comments by bots never count. Aliases (`TACK_COMMAND_ALIAS`) are empty by default because a short alias like `tack` is a real GitHub login. Docs: `automation/comment-commands.md`.

### Widgets, inboxes and rules

Widget and inbox queries run with the permissions of the person on the connection (`src/server/widgets/runner.ts`): `user:{id}` with their own token, everyone else `public` (`is:public` added, and any result not known to be public dropped). Results are cached per query and access level. Rules run with the app's access on webhook deliveries and only place items from repositories already on the board (or chosen when it was made, `scopeRepos`); `rule_placed` in SQLite means a rule never places an item twice. An inbox's results only ever clear "no longer matches" marks, since one viewer's results leaving a card out may just mean they can't read it.

### Stacks and AI

- `src/server/ai.ts` is the only code that talks to Workers AI (`askModel`); keep each feature's prompts and answer readers beside it (`stackNaming.ts`, `src/server/ai/draft.ts`). `TACK_AI` (a text binding) is on by default, `off` turns AI off, and without the `AI` binding it's unavailable. Local dev runs `TACK_AI=fake` (the stand-ins in `fakeStackAi.ts` and `fakeBoardAi.ts`); `TACK_DEV_AI=workers-ai` asks the real, billed service.
- **What a model reads is built on the server** from the document and what may be shared, never from text the client sends: stack names read stickies' visible text and only card titles everyone who can see the board can read (`Board.sharedTitles`; any doubt means no); AI on boards reads cards the asker may read (`BoardAi.prepare`, `collectItems`), never face-down stickies or private repositories' keys. Board content is fenced as untrusted data in prompts.
- **AI proposes, people place**: `POST /api/boards/:id/ai` writes nothing; placing a proposal is the asker's own undoable edit. Proposed widgets are checked strictly (`checkWidget`), and **a new widget kind or field needs a line in `WIDGET_GUIDES`** (`test/ai.test.ts` fails otherwise).
- A stack's `title` is a person's; the server only writes `suggested` (and `unnameable`). Budgets: `NAMING_LIMITS` and `AI_LIMITS`. Docs: `boards/stacks.mdx`, `boards/ai.mdx`.

### Images

Files live in the `Board` object's SQLite (`ImageStore`, chunked, by SHA-256), not R2, so there's nothing to set up and serving one never loads the document. Limits are `IMAGE_LIMITS`. The browser prepares files first (`src/client/images/prepare.ts`: SVG drawn to PNG, JPEGs re-encoded to drop metadata, thumbnails and a blurred stand-in). Files nothing has shown for a week (`IMAGE_KEEP_MS`) that history doesn't mention are swept as the board saves. **Boards are never deleted**: deleting one's object would delete its files. AI reads alt text only. Docs: `boards/images.md`.

### Pushing, backups and digests

- **Pushing** (`src/server/push/`): the engine snapshots what was pushed in the board's SQLite and applies it one write at a time from the alarm, writing statuses into the document with `PUSH_ORIGIN`. **SQLite is the truth**: a change being pushed or applied is never pushed again, whatever the document says. `apply` never throws for forge errors; creates look for what an unanswered earlier attempt made (`retryOf`) before making it again. Which changes are included is each pusher's own choice (`PushSession.leftOut`), never in the document. The UI offers only writes the forge supports (`RepoMeta.writes`). Docs: `writing-back/`.
- **Backups** commit the board's JSON to a branch (never the default branch) as the app; only the owner turns them on, and `checkTarget` checks the repository again with the current owner's token before every backup. Cards from non-public repositories are left out unless they're from the backup's own repository.
- **Weekly digests**: a Discussion gets cards and pushes only from public repositories (or its own), with everything people wrote defused (`quote`) and items named, not linked, so it never notifies anyone; an email only what its reader can read, while they can still open the board. Email needs confirming, and every email has a one-click unsubscribe. Each place gets at most one digest per ISO week (`digest_runs`). Docs: `facilitation/weekly-digests.md`.

### Other forges

GitLab, Forgejo (Codeberg, Gitea) and Tangled read and write with the instance's own token for the host (`TACK_FORGES`), never a viewer's GitHub token, so `canRead` is true only for public repositories and `canWrite` takes the pusher's login (`writers`). Every entry point calls `configureForges(env)` (the Worker's handlers and each Durable Object's constructor) so `parseKey` knows the hosts. Docs: `self-hosting/forges.md`.

## Custom widgets

JavaScript editors write, run in a sandbox (see "Security"), drawing the board's data through a small read-only API. Off on every board until its owner turns them on (`board_settings.custom_widgets` in the Directory, `PATCH /api/boards/:id`); the server enforces it per connection. Model and protocol: `src/shared/customWidgets.ts`; the board's side: `src/client/widgets/custom/` (`SandboxHost`).

- **Protocol**: `postMessage`, every message carrying `tack: PROTOCOL`. Changing it means bumping `PROTOCOL` and keeping the bootstrap (`src/server/widgets/sandbox.ts`) and `SandboxHost` in step.
- **Searches** go through the board's channel as `widget-query` and are cached, budgeted (`CUSTOM_LIMITS`) and refreshed like any widget's.
- **Freezing**: sandboxes can share a thread with the board, so loops are guarded before the code runs (`guardLoops`, with acorn), and `SandboxHost` stops frames that stop answering pings.
- **Tests**: `test/custom-widgets.test.ts`, `test/custom-guard.test.ts`, and `e2e/custom-widgets.spec.ts`, whose sandbox check widget (`src/client/play/sandboxCheck.ts`) tries every way out.

## Format versions and migrations

Upgrades must never strand a board or an object's storage (#55). Both are versioned and migrate themselves when they next load; there's never anything for an owner to run.

- **Board documents** carry their version in the root `meta` map (`schema`; absent is 0). `Board.onStart` runs `migrateBoard` (`src/shared/schema.ts`): every migration in `BOARD_MIGRATIONS` newer than the stamp, in order, each in its own transaction with `MIGRATE_ORIGIN` that also moves the stamp on. A migration that throws is logged (`board.migrate.failed`) and leaves the stamp where it was; a board from a newer Tack (a rolled-back deploy) is left alone (`board.migrate.newer`).
- **Writing a board migration**: append it with the next version (never edit or reorder a released one); make it idempotent and write only what needs changing; never throw for malformed data; keep readers tolerant of the old format for at least a release (a tab running old code writes the old way until it reloads). New _optional_ keys don't need one. Test each against an old-format document (`test/schema.test.ts`) and the load path end to end (`test/board-schema.test.ts`). Template, export and import code that writes a document from JSON should stamp it (or run `migrateBoard`) too.
- **Exports** are `tack.board` with a `version` (`BOARD_EXPORT_VERSION`); change the format by bumping it and adding a migration from the one before (`MIGRATIONS` in `src/shared/boardExport.ts`). Newer versions are refused.
- **Durable Object SQLite**: tables are created with `CREATE TABLE IF NOT EXISTS` each time a part starts, which is all a new table needs. Changing a table objects already have (a column, an index on one, rewriting rows) is a migration: `migrateSql(sql, scope, migrations)` in `src/server/migrations.ts`, one ordered list per part (`PUSH_MIGRATIONS` in `src/server/push/migrations.ts`, `REPO_MIGRATIONS` in `src/server/repo.ts`), recorded in `schema_versions`. Add new columns to the `CREATE TABLE` too, use `addColumn` (idempotent), and only ever add, so a rolled-back deploy still reads what a newer one wrote. Unit-test them over Node's SQLite (`memorySql` in `test/sqlite.ts`, `test/migrations.test.ts`).
- **Compaction** (`src/server/compaction.ts`, `src/shared/compaction.ts`) rebuilds very old documents to drop tombstones, only as a board loads and only when nobody's connected. The rebuilt document can't merge with old copies, so connections naming a retired client id are closed with 4410 and clients discard what they kept. **History** has its own budget and thinning (`src/shared/history.ts`), and starts a new stretch at a rebuild (`epoch`).

## Playground, demo and site

- **`/play`** (`src/client/play/`, dev only, left out of production builds) runs a board entirely in the browser with simulated people, a pretend forge and pretend servers, plus slow-motion and reduced-motion toggles. Scenarios are `SCENARIOS` in `src/client/play/scenarios.ts` (`/play?scenario=<name>`); galleries of every state are the `/play/*` routes in `src/client/main.tsx` (cards, auth, boards, actions, ai, changes, inbox, widgets, facilitation, comments, history, lists, mobile, templates, digests, crash). Use them to iterate on interaction details, and for screenshots.
- **The demo** (`src/client/try/`, tack.social/try) is the playground's simulations as a page of its own: three boards kept in localStorage, a guided first run, and nothing sent anywhere but what visitors ask the demo's AI to read (`network.ts` refuses everything else). Built with `vp build --mode try` into `dist/try/` with its own `_headers` (`tryCsp`); `vp dev --mode try` serves it alone, and the app's dev server serves it at `/play/try` (what `e2e/try.spec.ts` drives). The guide points at the app's own class names: **when you rename one it uses, update `targetsFor` in `Guide.tsx`**.
- **Live embeds** (`src/client/try/embed/`, `/try/embed/?feature=…`, `/play/embed` in dev, `e2e/embed.spec.ts`) play scripted loops of one feature on the landing page, save nothing, never ask the real AI, and never take focus from the page around them.
- **The site** (`site/`) is Astro Starlight with its own Astro and Vite. The shortcuts page and widget settings tables are generated from `src/client/shortcuts.ts`, `TOOL_KEYS` and the widget schemas: a widget field the docs don't label fails the build. Screenshots are WebP in `site/src/assets/screenshots/`, taken from `/play` by `pnpm --filter site screenshots` (it checks nothing: look at each for names that aren't the owner's projects or made up). The landing page's board is the `hero` scenario (`src/client/play/hero.ts`), with stickies from `site/src/hero.ts`.
- **For coding agents**, the build writes each page as Markdown (`/self-hosting/deploy.md`), `/llms.txt`, `/llms-full.txt` and `/setup.md` (`site/scripts/agents.ts`, `site/src/agents/`). setup.md's commands must be the docs' own (or in `AGENT_COMMANDS`, `site/src/agents/setup.ts`) and every link must lead to a built page, or the build fails.
- **Build and deploy**: `pnpm --filter site build` runs `astro build`, the agent docs, copies in the demo (`site/scripts/try.ts`) and writes Cloudflare Build Output for the `tack-docs` Worker (`site/cloudflare.config.ts`, `site/scripts/build-output.ts`): the site as static assets, and as code only the demo's AI (`src/demoAi/`, bundled by `vp build --mode try-ai`). `pnpm --filter site run deploy` deploys it and then starts an AI Search sync (see "The docs' Ask"). Root lint skips `site/` (Astro's virtual modules need its generated types); formatting covers it.

## The demo's AI

The demo runs in the browser, but its AI is real (#75): stack names, Auto-stack, summaries, decisions and widgets ask Workers AI through the `tack-docs` Worker, `POST /try/api/ai` (`src/demoAi/handler.ts`), with the playground's stand-in as the fallback.

- **What's sent** is only what the task reads (`DemoAiRequestSchema`, `src/shared/demoAi.ts`): strict objects, no prompts, models or settings, capped by a real board's limits and a 64 KB body. The Worker builds every prompt with the real server's code (`stackAi`, `draft`), so prompts and checks match. Models are per task (`DEMO_MODELS`): stack names ask `AI_MODEL`, the rest `AI_FALLBACK_MODEL`, since the main model often fails the larger schemas.
- **Guards**: same-origin only, JSON only; per visitor, the `DEMO_AI_LIMIT` rate limiting binding (by IP); per day (UTC), the `DemoBudget` Durable Object counts requests in all (`DEMO_AI_DAILY`) and per visitor (`DEMO_AI_VISITOR_DAILY`, by a hash of the IP and day; the address is never stored or logged). `DEMO_AI=off` switches it off. Change the limits in `site/cloudflare.config.ts`, then deploy the site.
- **The page** (`src/client/try/ai.ts`, `DemoAi`) asks it only in the published build or with `?ai=live`; `/play/try` uses the stand-in, so e2e stays offline and deterministic. On any failure the stand-in answers, and `AiHint.tsx` says so quietly.
- **Watching it**: each request logs one `demo.ai` line on `tack-docs` (outcome, status, task, item count, ms, model, attempts, usage or the limit hit; never content or addresses). Dashboard: Workers & Pages → `tack-docs` → Observability, filtering on `event = demo.ai`.
- **Tests**: `test/demo-ai.test.ts` (the Worker as deployed, in Miniflare), `test/try.test.ts`, `e2e/try.spec.ts`.

## The docs' Ask

"Ask AI" beside the docs' search answers from the docs with links to the pages it read. It's Cloudflare AI Search's own: the `tack-docs` instance in the account's `default` namespace crawls `https://tack.social` from its sitemap (leaving out `/try/**`) and answers on its public endpoint. There's no Worker code for it, and nothing about it is in the repository but the endpoint's address.

- **Settings** live on the instance: `pnpm exec cf ai-search get tack-docs --namespace default` shows them, `cf ai-search update` changes them. Only `/chat/completions` is on, browsers may call it only from `tack.social`, and it allows 30 requests a minute for the whole instance.
- **The endpoint** is `ASK_ENDPOINT` in `site/src/ask/stream.ts` (its id never changes). Locally it won't answer the browser, so `astro dev` and `astro preview` pass `/__ask/*` through to it.
- **Fresh answers**: each page's sitemap `<lastmod>` is its build time (`site/astro.config.ts`), and the crawler only re-reads pages whose `<lastmod>` is newer. The site's `deploy` script ends by starting a sync (`site/scripts/reindex.ts`: `cf ai-search jobs create tack-docs --namespace default`); a sync in cooldown is skipped, transient errors are retried, and after a deploy a failure only warns. The instance also syncs every 6 hours. Answers are cached for 48 hours: after a change that makes old answers wrong, `cf ai-search purge-cache tack-docs --namespace default`.
- **The dialog** (`site/src/components/Ask.astro`, `Search.astro`) streams the answer through `site/src/ask/markdown.ts` (everything escaped; links only to the web or the docs) and shows its sources. Tests: `test/docs-ask.test.ts`.

## Testing

Unit tests run in Node; integration tests run the built Worker in Miniflare. Name tests after the module or feature (`test/<feature>.test.ts`, `test/<feature>-board.test.ts` for end to end through the Worker, `e2e/<feature>.spec.ts`).

- **The harness** (`test/harness.ts`): `startWorker()` returns a Miniflare; use `mf.dispatchFetch()` for HTTP and `repoStub()`, `instanceStub()`, `boardStub(mf, id)` for Durable Object RPC. Options: `devAuth: true` (then `signIn(mf, "octocat", { admin?, allowed?, orgs? })` for a cookie), `outboundService: github.fetch`, `clock: true`, `persist` (restart to test waking), `assets`, `ai`, `bindings`. `signInWithGitHub` signs in through the fake OAuth flow for a real user token. To turn access control on, complete setup: `await (await instanceStub(mf)).completeSetup(github.manifestCode)`. The harness loads every module of the build output (`bundleModules`), as Miniflare doesn't follow them from the entry.
- **Live connections**: `connectBoard` (`test/board-client.ts`) is a minimal Yjs sync client over real WebSockets; `roundTrip()` waits until the server has applied everything sent; `BoardClient.raw` is everything it received (to search for what must never arrive). Boards must be in the index to connect: create them through `/api/boards`.
- **Fakes**: `FakeGitHub` (`test/fake-github.ts`: the app, OAuth, installations, repositories, issues, pull requests and discussions over REST and GraphQL, writes, searches, webhook payloads such as `github.event(...)`, `comment(...)` and `mergePull(...)`, `failWrites`, and `requests` to count fetches); `FakeGitLab`, `FakeForgejo`, `FakeTangled` (`test/fake-forges.ts`); `FakeAi` (`test/fake-ai.ts`: queue answers, fail calls, read what was sent); a fake Email Service (`test/fake-email.ts`, bound as `TACK_TEST_EMAIL`). The synthetic `fake.tack` forge's writes succeed without a network (anything containing `[fail]` is refused), so the whole push flow runs locally.
- **Time**: `startWorker({ clock: true })` sets `TACK_TEST_CLOCK=1` (harness only, never declared in `cloudflare.config.ts`) and `setClock(mf, at)` moves the isolate's `Date`; `World` (`test/world.ts`) keeps `FakeGitHub`'s clock in step. `boardStub(mf, id)` has `*Timing(...)` methods to shorten the push engine's, runner's, inbox's and comment commands' waits, and methods that run what an alarm would (`runWidgets()`, `runBackups()`, `historyCompact(now)`).
- **Exit tests** run whole sessions end to end and must keep passing: `test/m2-exit.test.ts` (staging, pushing and write-backs through the real GitHub adapter), `test/m3-exit.test.ts` and `test/m4-exit.test.ts` (days of automation and async facilitation on the test clock), and `e2e/m2-exit.spec.ts`, `e2e/m3-exit.spec.ts`, `e2e/m4-exit.spec.ts` through the UI.
- **Security tests**: `test/access-table.test.ts` (the access table, row by row), `test/security.test.ts` (headers, cross-site requests, webhook replays, repository paths, forged presence), `test/public-boards.test.ts`, `test/rate-limit.test.ts`, `test/links.test.ts` and `test/links-worker.test.ts` (the SSRF guard), `test/custom-widgets.test.ts`.
- **In Miniflare tests**, send multipart bodies as bytes (`new Response(form)`): its fetch doesn't know Node's `FormData`. The harness sets `TACK_FORGES` to `""` (the defaults); after changing it in Node, call `configureForges(env)`.
- **e2e** (Playwright, kept out of `vp test`): specs drive `/play` scenarios and galleries, or real boards on the dev server signed in with `/auth/dev` (read a real board's document through the dev-only `window.tackBoard`). Every spec fails on any uncaught page error. Drag well inside the viewport (React Flow pans when a drag nears its edge), wait for glides and sheets to settle before reading positions, and before setup every instance board is visible to everyone, so tests that count boards make theirs private. Use `reducedMotion: "reduce"` where motion doesn't matter.
- **WebKit**: keep the specs it runs engine-aware: `allowClipboard(page, browserName)` (Chromium's clipboard permissions; WebKit gets a clipboard of the page's own); the `pageErrors` fixture lets through WebKit's "ResizeObserver loop completed with undelivered notifications."; Safari writes `translate(x, 0)` as `translate(x)`, so read transforms with `nodePosition` or a `DOMMatrixReadOnly`; there's no CDP in WebKit, and touches are dispatched in the page (`fingers(page, browserName)` picks).
- **Accessibility**: `e2e/a11y.spec.ts` runs axe (WCAG 2.1 AA and best practices) over the main pages, a real board and every `/play` gallery in both themes, failing on serious or critical violations; `e2e/keyboard.spec.ts` covers keyboard navigation; `test/theme.test.ts` checks token contrast.
- **Visual regression is opt-in for now**: the design changes too fast for pixel baselines, so `e2e/gallery.spec.ts`'s screenshot test only runs with `VISUAL=1` and no baselines are committed. The gallery's structural checks always run.
- **CI** (`.github/workflows/test.yml`): the `test` job runs `vp check`, `vp test`, `vp build` and the site build; e2e runs in four shards (Chromium), uploading traces and screenshots as `e2e-results-<shard>` (open with `pnpm exec playwright show-trace <trace.zip>`). A manual run with "update snapshots" uploads Linux baselines as `e2e-linux-baselines-<shard>`.

## Load

`scripts/load-test.ts` puts many simulated people on one board (one `Board` object): each speaks the Yjs sync and awareness protocols as the app does, all moving cursors at 5 Hz, ten moving shapes twice a second, on a board of 200 shapes. Run it against the built Worker in Miniflare (`pnpm build && node scripts/load-test.ts --worker --clients 200`) or a dev server (`node scripts/load-test.ts http://localhost:5173`). Run it again after changing what the board sends per message or per connection.

Presence is most of a busy board's traffic and fans out to everyone, so the board relays it in batches every 40 ms (`AWARENESS_BATCH_MS` in `board.ts`): at most 25 presence messages a second per connection. Results (2026-10-11, `--worker`, 20 s, an 8-core Apple Silicon laptop also running the clients):

| People | Connect p50 / p95 | All synced | Edit seen by everyone p50 / p95 / max | Messages per client per second | Memory (workerd, peak) |
| ------ | ----------------- | ---------- | ------------------------------------- | ------------------------------ | ---------------------- |
| 50     | 37 / 52 ms        | 0.24 s     | 10 / 19 / 24 ms                       | 28                             | 186 MB                 |
| 100    | 114 / 142 ms      | 0.44 s     | 23 / 43 / 63 ms                       | 38                             | 246 MB                 |
| 200    | 317 / 415 ms      | 1.1 s      | 36 / 68 / 87 ms                       | 35                             | 359 MB                 |
| 400    | 508 / 824 ms      | 3.5 s      | 113 / 232 / 268 ms                    | 24                             | 502 MB                 |

No connection dropped at any size. Up to about 200 people a board stays real-time; at 400 edits land within a quarter of a second but joining takes seconds. Memory is everything workerd holds (85 MB idle), not one object's 128 MB limit. A Durable Object runs on one thread, so a board is the unit of scale, and its CPU runs out long before connections do.

## Observability

- **Server logs** use `log` from `src/server/log.ts`: `log.info("webhook.verified", { repo, delivery })` writes one JSON line with `level`, `event` and the context. Use dotted event names and put identifiers in context fields, not the event name, so they can be filtered on. Errors in context are serialised with their stack. Never log what "Security" lists as never logged.
- **Client errors**: the app has an error boundary, and on the board each shape, layer and panel draws inside its own (`ShapeBoundary.tsx`), so one failure shows in place and the rest carries on. Render errors, `window.onerror` and unhandled rejections are posted to `POST /api/client-errors` (at most 10 per page load, 16 KB each, same origin, rate limited per IP in memory; the IP is never logged) and logged as `client.error`. No third-party service is involved.
- **In production**: Workers Logs is on (`observability` in `cloudflare.config.ts`). Dashboard: Workers & Pages → `tack` → Observability, filtering on fields such as `event = client.error` or `level = error`. From a terminal: `cf o11y telemetry query` (see `cf schema o11y telemetry query`) or `cf o11y telemetry live-tail`.
- **Locally**: the dev server prints log lines, and keeps them queryable through the local explorer: `curl -X POST http://localhost:5173/cdn-cgi/local/explorer/api/local/observability/query -H 'content-type: application/json' -d '{"sql":"SELECT ts_ms, level, message FROM logs ORDER BY ts_ms DESC LIMIT 20"}'` (use your dev server's port). The e2e tests use it to check that `/play/crash` lands as `client.error`.

**Events** (add new ones here):

- Webhooks and repositories: `webhook.received`, `webhook.verified`, `webhook.ignored` (with a reason; for comments that aren't commands: `no_command`, `bot`, `already_a_command`, `action`, `stale`), `webhook.rejected` (bad signature), `webhook.failed`; `repo.ingest`, `repo.fanout`, `repo.fanout.failed`, `repo.fetch`, `repo.refetch`, `repo.reconcile`, `repo.reconcile.failed`, `repo.renamed`, `repo.visibility`, `repo.poll`, `repo.poll.failed`, `repo.installation`, `repo.installation.watch.failed`, `repo.activity`, `repo.activity.failed`; `forge.rate_limited` (host, resource, `primary` or `secondary`, when it lifts, and the token as `anonymous`, `app` or a hash), `forge.config.invalid`
- Boards: `board.load`, `board.save` (snapshot bytes and chunks), `board.save.failed`, `board.document` (every load: bytes, live items, tombstones, clients, whether compaction is due), `board.compacted`, `board.compact.skipped`, `board.compact.failed` (`mismatch` or `error`), `board.document.stale` (closed with 4410), `board.migrated`, `board.migrate.failed`, `board.migrate.newer`, `storage.migrated`, `storage.migrate.failed`, `storage.migrate.newer` (SQLite migrations), `board.repaired`, `board.awareness.refused`, `board.subscriptions.failed`, `board.connection.error`, `board.exception`, `board.route.resolved`, `board.route.unresolved`, `board.readable`, `board.readable.failed`, `board.send.failed`, `board.watch.failed`, `board.refetch.failed`, `board.installation`, `board.installation.watch.failed`, `board.matches`
- The board index and people: `board.created`, `board.updated`, `board.legacy.claimed`, `board.member.invited`, `board.member.updated`, `board.member.removed`, `board.member.resolved`, `board.member.refused`, `people.lookup.failed`, `board.custom_widgets` (turned on or off), `board.index.failed`, `board.access.failed`, `board.rename.failed`
- Setup, sign-in and access: `setup.completed`, `setup.failed`, `setup.webhooks`, `github.webhooks.failed` (the webhook check); `auth.signin`, `auth.signin.dev`, `auth.signin.failed`, `auth.signout`, `auth.refresh.failed`, `auth.orgcheck.failed`, `auth.rejected` (cross-site); `access.denied` (including refused board connections), `access.updated`; `github.installation`, `github.installation.failed`, `github.installation.notified`, `github.token.failed`, `github.graphql.unavailable` (falling back to REST), `github.redelivery`, `github.redelivery.failed`
- Pushing: `push.started`, `push.rejected`, `push.change.sent`, `push.change.applied` (with `via`), `push.change.retry`, `push.change.failed`, `push.effect`, `push.completed`, `push.healed`, `push.access.failed`, `push.run.failed`, `repos.meta.failed`, `repos.files.failed`, `repos.categories.failed`
- Rules and comment commands: `rule.placed`, `rule.skipped` (`no_section` or `no_room`), `rule.held`, `rule.released`, `rule.failed`; `command.received`, `command.duplicate`, `command.placed`, `command.done` (the outcome, e.g. `added`, `ambiguous`, `private_repo`), `command.retry`, `command.failed`, `command.limited`, `command.reply.failed`, `command.react.failed`
- Widgets and related: `widget.query` (kind, access, status, results, ms), `widget.query.failed`, `widget.send.failed`, `widget.refresh`, `widget.watch.failed`; `related.fetched`, `related.failed`; `search.items`, `search.items.failed` (the card tool's search); `reactors.fetched`, `reactors.failed` (who reacted to a card's item)
- Images, snapshots and links: `image.stored`, `image.rejected` (`access`, `not_editor`, `form`, `size`, `type`, `dimensions`, `unreadable`, `quota`, `copy_access`), `image.copied`, `image.swept`, `image.sweep.failed`; `snapshot.stored`, `snapshot.rejected` (`cross_site`, `access`, `not_editor`, `type`, `not_png`, `size`, `dimensions`, `quota`), `snapshot.missing`; `link.unfurled`, `link.refused` (`signed_out`, `not_editor`, `rate_limited`), `link.image.fetched`, `link.image.refused` (`not_on_board`, `rate_limited`), `link.image.failed`
- Facilitation: `timer.changed`, `spotlight.started`, `spotlight.stopped` (`stopped` or `left`), `facilitation.refused`, `facilitation.failed`; `silent.started`, `silent.revealed`, `silent.refused`, `silent.reconciled`
- Comments and since: `comment.started`, `comment.replied`, `comment.edited`, `comment.deleted`, `comment.resolved`, `comment.reopened`, `comment.failed`, `comment.people.failed`, `comment.notified`, `comment.notify.failed`; `since.digest`, `since.failed`, `since.history.failed`
- Templates, imports, backups and action items: `board.seeded`, `board.seed.failed`; `board.imported`, `board.import.rejected` (`not_json`, `not_tack`, `newer`, `too_large`, `invalid`), `board.import.failed`; `backup.configured`, `backup.refused`, `backup.written`, `backup.unchanged`, `backup.failed`, `backup.disabled`; `template.saved`, `template.rejected` (`too_large`), `template.deleted`; `actions.carried`, `actions.carry.failed`
- History: `history.compacted`, `history.trimmed`, `history.caught_up`, `history.failed`
- AI: `ai.answered`, `ai.refused` (`off`, `unavailable`, `forbidden`, `invalid`, `rate_limited`, `empty`…), `ai.failed` (`unusable` or `failed`), `ai.model.failed`; `stack.named`, `stack.name.failed`, `stack.name.limited`, `stack.unnameable`, `stack.grouped`, `stack.group.refused`, `stack.group.failed`
- Embeds: `embed.rendered`, `embed.served` (a `304` or from the cache), `embed.refused` (`not_public`), `embed.failed` (`data` or `draw`), `embed.cache.failed`, `embed.preview.failed`
- Digests: `digest.configured`, `digest.disabled`, `digest.refused`, `digest.posted`, `digest.emailed`, `digest.quiet`, `digest.discussion.failed`, `digest.email.failed`, `digest.failed`, `digest.subscribe.asked`, `digest.subscribed`, `digest.unsubscribed` (`via` the board, a link, lost access or a suppressed address), `digest.confirm.failed`, `email.error`
- Client: `client.error`
- The docs site's Worker (`tack-docs`): `demo.ai` (see "The demo's AI")
