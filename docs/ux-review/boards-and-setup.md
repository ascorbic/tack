# UX review: boards and setup

Scope: everything around the canvas. That covers the home page (tabs, search, archived, new board), board tiles and thumbnails, renaming, sharing (invites, roles, visibility, leaving), what viewers and anonymous visitors see, the board top bar, sign-in and sign-out, `/setup` and the GitHub App install copy, the notifications bell, error pages, narrow widths, and accessibility basics.

Method: a fresh dev instance on port 5225 (`TACK_DEV_AUTH=1`), driven by Playwright with up to nine browser contexts at once (matt as owner and admin, alice, bob, carol, ben, ana…gus, plus anonymous). I tested at 1440×900, 1280×800, 1024×768, 768×1024 and 375×812, and at 390×844 with touch, in light and dark. I also went through `/play/boards`, `/play/auth` and `/play/cards`, ran axe-core on the home page, the board, the Share dialog, sign-in, setup and the missing-board page, and read the source under `src/client/boards`, `src/client/auth`, `src/server/boards` and `src/server/github/setup.ts`. The scripts are in the review worktree under `ux/`.

Limitation: the dev instance can't finish `/setup` without real GitHub, so everything ran before setup, where access control is off. The configured states (invite-only page, access editor, installed app) were reviewed from the galleries and the source, not live.

## Verdict

The surfaces around the canvas look good. The home page, tiles, Share dialog, error pages and setup card all share one calm visual language, in both light and dark. Several details are better than FigJam's: the board title is pre-selected on a new board, renames reach everyone live, tiles stagger in, and "You can edit this board now" toasts appear when your role changes. The weak spot is the path people take to arrive. An invite tells the invitee nothing and accepts any typo. The invitee then lands on an empty "My boards" tab. The default access ("Anyone on this Tack · Can edit") sits on the same row as "Anyone with the link", so it's easy to misread. The top bar has ten controls and wraps to two rows at 1024px and below. Nothing here will crash the EmDash session. Three things could still cost the first ten minutes: the arrival path, the crowded top bar on a projector or small laptop, and finding out on the day that the app isn't installed on the EmDash repos.

---

## Findings

Severity: **Blocker** (for the EmDash session) / **Major** / **Minor** / **Polish**.

### 1. GitHub App readiness (install prompts, not-live cards, private placeholders)

**1.1 Blocker (pre-flight): Tack can't show which repositories have the app installed, so "not live" and "can't push" only show up mid-session.**
The configured `/setup` page shows the app's name, an "Install on repositories" button and "App settings" (`SetupPage.tsx` `Configured`). It doesn't list the installations or repositories. On a board, every card from a repository without the app gets a grey "Not live" chip. Its tooltip says "Tack can't make changes there", which means staged write-back will fail for those cards. With 8 people at a session built on staged write-back, the facilitator would only learn this when the first push fails.
Evidence: `shots/boards-and-setup/67-card-not-live.png`, `shots/boards-and-setup/gallery-auth-light.png` ("Just created" and "Signed out" setup cards).
Fix: on `/setup`, list the installations and their repositories, each with live/writable status, using the data `Repo` already tracks. In the Share dialog, or on first open, add a one-line pre-flight for the board's repositories: "emdash-cms/emdash: live, writable ✓". Before next week, install the app on every EmDash repository you'll plan with, then open a board with one card from each to confirm no "Not live" chips remain.

**1.2 Minor: the "Not live" copy reads as broken, and its tooltip heading doesn't match the chip.**
The chip says "Not live". The tooltip heading says "Updates while the board is open", which describes a mode, not a problem. The body then says "changes show up within a minute or so, and Tack can't make changes there". The serious part (no write-back) is buried in a subordinate clause.
Evidence: `shots/boards-and-setup/67-card-not-live.png`.
Fix: label the chip by what people get ("Updates every minute") and give the tooltip a heading that names the consequence ("Read-only: the Tack app isn't on lovell/sharp"). Add the install action, and say who can install it ("Ask an org owner to install…" when the viewer isn't one).

**1.3 Polish: the private placeholder works well.**
"This is in a private repository you can't see on GitHub, so its details stay hidden" with "Got access? Check again" is clear, honest and actionable (`shots/boards-and-setup/68-card-private.png`). Keep it. The "can't read acme/vault. If it's private, install the app on it" variant (`shots/boards-and-setup/69-card-missing-installable.png`) is fine, but "Install the app" offers every viewer an action only an org owner can complete.

### 2. Sharing and invites

**2.1 Major: invites notify no one and accept any string, so typos fail silently.**
Inviting `alice, bob` added two rows reading "@alice · invited, hasn't signed in yet" (`shots/boards-and-setup/10-share-invited.png`). Nothing is sent to anyone, and there's no notification for invites (`src/server/notifications.ts` only handles mentions and replies). Nothing checks that the login exists on GitHub, so `emdash-mantainer` would sit in the list for ever as "invited". Only an obviously malformed login gets an error (`shots/boards-and-setup/11-share-invalid-login.png`). After inviting, the dialog doesn't tell the owner they now have to send the link themselves.
Fix: resolve logins against GitHub as they're typed (`GET /users/:login`, through the viewer's token), showing the avatar and name, with autocomplete from people already on the instance. Mark unknown logins red before submit. After inviting, show "They won't get an email. Copy the link and send it to them" next to Copy link. Optionally post an invite to the bell for people who already have accounts.

**2.2 Major: the "Can edit" on the General access row reads as applying to "Anyone with the link".**
With visibility set to public, the row reads "Anyone with the link ▾ … Can edit ▾" (`shots/boards-and-setup/12-share-public.png`). The right-hand control is the *instance* role, but it sits on the same line as the link setting, so an owner will read it as "anyone with the link can edit". A viewer sees the same row with a static "Can edit" (`shots/boards-and-setup/21-bob-share-panel.png`). The description line underneath ("Anyone with the link can view… People on this Tack can edit") contradicts the control beside it.
Fix: when visibility is public, split it into two rows: "Anyone with the link · Can view" (fixed), and "People on this Tack · Can edit ▾". Or rename the control "People on this Tack: Can edit".

**2.3 Major: new boards are editable by everyone on the instance by default, and nothing says so at creation.**
`src/server/directory.ts:484` defaults to `visibility: "instance"`, and the Share dialog shows "Anyone on this Tack · Can edit" on a board nobody has shared yet (`shots/boards-and-setup/09-share-owner-empty.png`). For an OSS instance that allowlists an org, every new scratch board can be edited by the whole org and appears in everyone's "On this Tack" tab. FigJam defaults to private-to-team with an obvious indicator. This may be the right default for Tack, but it should be a visible choice.
Fix: show the access level next to the title, or on the Share button ("Share · Team can edit"). Or ask once, on the first board, which default the person wants. Remember the choice per user.

**2.4 Minor: the dialog opens with focus on Close, not the invite field.**
Measured focus order on open: Close → invite field → "Invite as" → each member's role → visibility → instance role → Copy link. A keyboard user has to Tab once before typing, and most people open Share to type a name.
Fix: put initial focus on the invite input when the person can manage, and on Copy link when they can't.

**2.5 Minor: "Leave board" acts at once, with no confirmation, no undo and no toast.**
Alice clicked Leave board and was sent straight to `/` (836 ms) with no message (`shots/boards-and-setup/32-alice-share-panel-member.png` → `shots/boards-and-setup/33-alice-after-leave.png`). On a private board that's irreversible without the owner. On an instance-visible board it's confusing: the board is still in her "On this Tack" tab, so it looks as if nothing happened.
Fix: ask "Leave ‘EmDash planning'? You'll need an invite to get back in" (or "You can still open it as someone on this Tack"), then show a toast on the home page.

**2.6 Minor: when you lose access live, the board is replaced by a generic error with no explanation.**
Carol had the public board open. The owner made it private, and her canvas was immediately replaced with "You don't have access to this board" (`shots/boards-and-setup/26-carol-after-made-private-live.png`). That's the same copy as someone who never had access (`27-carol-private-forbidden.png`). There's no "Request access" button.
Fix: when access is lost mid-session, say so ("Matt made this board private"). Add "Ask for access", which notifies the owner through the bell and shows them the request in the Share dialog (FigJam's pattern).

**2.7 Polish: the whole sub-line of a pending invite is in monospace.**
"@alice · invited, hasn't signed in yet" is set entirely in the mono face (`shots/boards-and-setup/10-share-invited.png`), so the prose reads like code. Use mono for `@alice` only.

**2.8 Polish: the dialog jumps vertically as rows are added.**
It's centred with `showModal()`, so each invite or error moves the header and input up (compare `09`, `10` and `11`). Pin the dialog's top edge, for example `margin-top: 18vh`, so the field under your cursor stays put.

**Keep:** the spring-up animation, the newly-invited row highlight, the skeleton rows while loading (gallery "Loading"), Copy link turning into "Link copied" with a check (`13-share-copied.png`), the clipboard fallback to `prompt()`, and the dark theme (`70-share-dark.png`).

### 3. Arriving on the home page: tabs, search, tiles

**3.1 Major: an invited person lands on an empty "My boards" tab, not on the board shared with them.**
Alice had one board shared with her and had never opened it. Her home page opened on "My boards 0 / No boards here yet." and the board sat behind the second tab (`shots/boards-and-setup/16-alice-home-shared.png`). The default is "Recent if any, else My boards" (`HomePage.tsx`). For the EmDash session, this is what every invitee who types the instance URL instead of clicking the link will see.
Fix: choose the default tab by content: Recent, then Shared with me (when it has unvisited boards), then My boards. Better still, add an "unseen" dot or a "New" pill to shared boards you haven't opened, and pin "Shared with you recently" at the top of Recent.

**3.2 Major: search covers only the current tab.**
On "My boards", searching "retro" found 1 board, because the other retro board was in Archived (`shots/boards-and-setup/36-home-search-retro.png`). On the default "Recent" tab (1 board) search finds almost nothing, but the box sits above the tabs and looks global. The "no results" copy, "No boards called "emdsh"." (`shots/boards-and-setup/37-home-search-none.png`), doesn't mention the tab either.
Fix: make search global across Mine, Shared and On this Tack (deduplicated, and archived boards behind a "Show 2 archived matches" link). Or scope it visibly: "No boards called "emdsh" in Recent · Search all boards". Add fuzzy matching ("emdsh" should find "EmDash").

**3.3 Minor: the tabs overlap and "On this Tack" is jargon.**
With 11 of my own boards the tabs read "Recent 1 · My boards 11 · Shared with me 2 · On this Tack 10 · Archived 2" (`shots/boards-and-setup/34-home-many-1440.png`). "On this Tack" contains my own instance-visible boards, so the counts don't add up and the same board appears in three tabs. A newcomer won't know what "a Tack" is.
Fix: rename it "Everyone's boards" or "Team", and exclude boards already in Mine or Shared. Or drop the counts on overlapping tabs.

**3.4 Minor: the tabs aren't real ARIA tabs for the keyboard.**
They have `role=tab` but no `tabpanel`, no roving tabindex, and ArrowRight does nothing (tested: focus stayed on "Recent"). Every tab is a separate Tab stop.
Fix: add arrow-key navigation, `tabindex=-1` on unselected tabs, and `role=tabpanel` with `aria-labelledby` on the grid. Or drop the tab roles and use a segmented nav with `aria-current`.

**3.5 Minor: new and empty boards all have the same thumbnail.**
Nine fresh boards show the identical pinned blank note (`shots/boards-and-setup/41-archive-immediately-after.png`). Two are both "Untitled board", so they're impossible to tell apart.
Fix: give empty boards a varied empty sketch (different note colour and tilt, seeded by board id), or show the creation date. Don't let a second board be created as "Untitled board" when one already exists ("Untitled board 2"), or prompt for a name on the home page.

**3.6 Minor: archiving from a tile has no undo.**
Archive → the tile vanishes, the grid reflows and the page scrolls. No toast or status was found (`shots/boards-and-setup/41-archive-immediately-after.png`, then `42-archived-tab.png`).
Fix: show a toast, "Archived ‘Docs restructure' · Undo", and animate the tile out (it animates in, but not out).

**3.7 Minor: a rename moves the tile.**
After a rename from the tile menu, the tile jumps to the front of "My boards", because it's sorted by updated time (`shots/boards-and-setup/40-tile-renaming.png` → `41`). The tile you just edited is suddenly somewhere else.
Fix: don't let a rename count as an "edit" for sorting, or delay the re-sort until the next visit.

**3.8 Polish: the tile menu has no Duplicate and no templates.**
The "…" menu has Rename, Copy link and Archive (`shots/boards-and-setup/39-tile-menu.png`). There's no "Duplicate board", and "New board" always makes a blank one. For a recurring planning session ("Retro – sprint 41/42"), duplicating last time's board is the obvious flow.
Fix: add Duplicate (structure and sections, no comments or history). Later, add a "Start from…" row (Retro, Release planning, Triage) under New board.

**3.9 Polish: there's no keyboard shortcut for search.**
Neither `/` nor ⌘K focuses "Find a board" (tested). Bind `/`.

**3.10 Polish: the guest home before setup looks unfinished.**
Before setup, a guest sees "Boards / New board / No boards yet. Make the first one." on a bare page (`shots/boards-and-setup/01-anon-home-before-setup.png`), without the corkboard illustration the signed-in empty state has (`shots/boards-and-setup/04-home-empty-signed-in.png`). There's also no hint that the instance needs setting up. The only route to `/setup` is inside the guest avatar menu.
Fix: show a "This Tack isn't set up yet · Set up Tack" banner to everyone until setup is done, and use the illustrated empty state for guests too.

**Keep:** the illustrated first-run empty state and "Create your first board" (`04`), the tile lift on hover (`38-tile-hover.png`), the staggered entrance, visibility icons on tiles, avatar stacks with +N, inline rename on the tile with Enter/Escape (`40`), the thumbnails following the theme (`46-home-1280-dark.png`), and the 1280 layout (`45-home-1280.png`).

### 4. New board and renaming

**4.1 Keep: the new-board flow is excellent.**
New board → board in 656 ms, with the title "Untitled board" selected and holding focus while the board mounts (`shots/boards-and-setup/05-new-board-just-created.png`, `06-new-board-settled.png`). Type and press Enter, and the URL slug and tab title update (`/b/fj4kgqkw5w/emdash-planning`, "EmDash planning · Tack"). Escape restores the old title, an empty title falls back to "Untitled board", and renames reach other people's top bar and tab title live (tested with ben). After Enter, focus returns to the canvas, so `S` picks the sticky tool straight away. This is better than FigJam.

**4.2 Minor: a long title pushes the top bar to two rows at 1280px.**
A 110-character title truncates with an ellipsis, but the bar still wrapped to 97 px (`shots/boards-and-setup/60-title-long-1280.png`). While editing, the field scrolls the text so its start is hidden (`shots/boards-and-setup/59-title-editing-long-1280.png`).
Fix: cap the title at roughly 32ch with ellipsis, give it `flex-shrink: 1` and `min-width: 0` before any buttons wrap, and show the full title as a tooltip.

**4.3 Polish: there's no rename affordance until you hover.**
The title is a plain button with `title="Rename"` (`shots/boards-and-setup/07-board-renamed.png`). First-time owners won't know they can click it unless they've just created the board. A faint pencil or underline on hover is FigJam's pattern, and a menu item (see 5.1) would help too.

### 5. The board top bar

**5.1 Major: the bar has 10 controls and 2 indicators, and it wraps at 1024px and below.**
Owner at 1440: brand · title · [presence and your account] · History · Rules · Facilitate · Comments · theme · "Synced" · Changes · Share · bell (`shots/boards-and-setup/08-topbar-owner-1440.png`). Viewers also get a "View only" badge (`shots/boards-and-setup/19-bob-viewer.png`). With 8 people the presence stack shows six avatars and "+2", and the bar is full (`shots/boards-and-setup/49-topbar-8people-1440.png`). Measured bar height: 55 px at 1440 and 1280, **97 px (two rows) at 1024 and 768** (`shots/boards-and-setup/48-board-8people-1024.png`, `48-board-8people-768.png`), and 179 px at 375 (`48-board-8people-375.png`). At 1024 the bottom toolbar also overlaps the minimap. A facilitator sharing a 1024×768 window, or anyone on a 13" laptop with a sidebar or an iPad, gets a two-row bar. FigJam keeps about five things up there: menu, title, avatars, Share and a present button.
Fix (in order):
1. Move the theme toggle into the account menu. It's a set-once preference and doesn't belong next to Share.
2. Replace the "Synced" text with a dot by the title, and show words only when something is wrong ("Reconnecting…", "Offline, changes saved locally").
3. Put History and Rules in a board menu, a "▾" after the title that also holds Rename, Duplicate, Archive and Copy link (FigJam's file menu).
4. Make Comments and Facilitate icon buttons with tooltips below 1280px.
5. Keep Changes (with count) and Share as the only labelled buttons.
6. Below 1024, collapse the remaining buttons into a "⋯" overflow, and never wrap.

**5.2 Minor: tooltips and shortcuts are inconsistent.**
History has a `title` with "⌥⇧⌘H", Rules has "Rules: automation that places cards", Comments has "(B to add one)", and the theme toggle has a long sentence ("Light theme (following your system). Switch to dark"). Facilitate, Changes and Share have no tooltip at all (from a hover pass over every button). The tooltips are native `title`s, so they're slow and unstyled, while the people stack uses a styled tooltip (`shots/boards-and-setup/50-people-overflow-open.png`).
Fix: use one styled tooltip component for every top-bar button, with a short name and a shortcut chip. Give Share a memorable shortcut.

**5.3 Minor: the bell and your account move between the home page and the board.**
On the home page the order is bell · theme · avatar at the far right (`34`). On a board your avatar is in the presence stack in the middle, and the bell is after Share at the far right (`08`). The notification bell after the primary button is unusual. The Share button should be the right-most anchor.
Fix: put the bell next to your avatar on both pages, and keep Share right-most on the board.

**5.4 Minor: viewers see buttons they can't use, or that read oddly.**
As a viewer, Rules opens a panel that says "No rules yet. Start with one of these:" followed by nothing, because the templates are hidden for viewers (`shots/boards-and-setup/66-viewer-rules.png`). Changes says "You can look, but not change it" (good, `66-viewer-changes.png`). On an archived board Rules, Facilitate and Changes are all still shown. Pressing `S` as a viewer silently does nothing (`shots/boards-and-setup/20-bob-tries-sticky.png`).
Fix: for viewers, say "No rules on this board" without the lead-in, or hide Rules when there are none. Answer edit shortcuts with a toast, "You're viewing. Ask Matt to let you edit" plus an "Ask" button.

**5.5 Minor: two panel toggles can look active at once.**
With Changes open, opening History left the Changes button pressed while the History panel was showing (`shots/boards-and-setup/66-viewer-history.png`). Escape didn't close the Changes panel either.
Fix: make the right-hand panels one exclusive group with one `aria-pressed`. Escape should close whichever is open.

**5.6 Polish: the "+2" overflow only gives a tooltip.**
Clicking "+2" shows a tooltip ("Fay Laurent, Gus Patel", `shots/boards-and-setup/50-people-overflow-open.png`). You can't follow or spotlight those two people the way you can the visible avatars.
Fix: open a small list of everyone on the board, with follow buttons, as FigJam does.

**Keep:** the Share button changes its icon to a globe when public, which is a quiet but useful hint (`15-board-seeded.png`). The role-change toasts are also good (`22-bob-promoted-toast.png`), and so is the account menu (`51-account-menu-board.png`) and the notifications empty state (`52-notifications-empty.png`).

### 6. Viewers and anonymous visitors

**6.1 Minor: archiving a board while people are on it tells them their role changed.**
Ben (an editor) had the board open when the owner archived it. His toast said "You can view this board, but not edit it" (`shots/boards-and-setup/62-ben-board-archived-live.png`), as if he'd been demoted, and the archived notice only appeared after a reload (`shots/boards-and-setup/64-ben-archived-board-reload.png`).
Fix: when a board becomes read-only through archiving, show "Matt archived this board. It's read-only now" and the archived notice straight away.

**6.2 Minor: before setup, the public-board copy contradicts what happens.**
An anonymous visitor to a public board got the full editing toolbar (sticky, text, sections…) and no "View only" badge (`shots/boards-and-setup/24-anon-public-board.png`). Meanwhile the Share dialog promises "Anyone with the link can view". That's because access control is off before setup, but it's exactly the instance someone tries first.
Fix: before setup, say so in the Share dialog ("Until this Tack is set up, anyone can edit every board"), or make public boards read-only for guests even before setup.

**6.3 Minor: archived boards remove the whole toolbar.**
Owner and editor on an archived board get no select, hand or comment tools (`shots/boards-and-setup/63-owner-archived-board.png`). Panning works, but the toolbar's absence feels broken, and viewers on non-archived boards do keep select, hand and comment (`19`).
Fix: show the viewer toolbar (select, hand) on archived boards, with comment greyed out and a tooltip.

**Keep:** the viewer toolbar is trimmed to select, hand and comment, and the "View only" pill has a helpful tooltip.

### 7. Sign-in, sign-out, setup, errors

**7.1 Minor: after sign-out there's no confirmation.**
Sign out → the page reloads (blank for about a second) and comes back as a guest, "Merry Badger", on the same board (`shots/boards-and-setup/56-after-signout-on-board.png`). Nothing says you signed out. On a configured instance a private board would show the sign-in page, which is fine.
Fix: show a toast, "Signed out. You're browsing as a guest", or go to `/signin` with a "Signed out" note.

**7.2 Minor: unknown paths show the home page with the wrong URL.**
`/some/random/path` renders the home page and keeps the bad URL (`shots/boards-and-setup/31-random-path.png`). Unknown routes fall through to `App` in `main.tsx`.
Fix: render the existing "This board isn't here" card ("This page isn't here") with a link home (`29-anon-missing-board.png`), and return 404 from the Worker.

**7.3 Minor: an unconfigured deployed instance can be claimed by anyone.**
`/setup` says "Whoever creates it becomes this instance's first admin" (`shots/boards-and-setup/02-setup-fresh.png`). Before setup, any visitor can do that, and the home page doesn't warn about it (see 3.10).
Fix: require a one-time setup token printed in the Worker logs, or the `TACK_SECRET`, to start setup. At minimum, show a banner on every page until setup is done.

**7.4 Polish: the error pages have only one action.**
"You don't have access to this board" has only "All boards" (`shots/boards-and-setup/27-carol-private-forbidden.png`). Add "Ask for access" (see 2.6) and "Switch account" (sign out and sign back in). The sign-in page shown to a signed-out visitor of a private board (`28-anon-private-signin.png`) is good: it returns to the board afterwards.

**7.5 Polish: there's a blank white page before the app paints, even in dark mode.**
`index.html` has no inline background or `color-scheme`, and the board and home loading states are an empty `<div aria-busy>`. Under throttling the page stays white for several seconds (`shots/boards-and-setup/73-board-loading-slow.png`; the dev bundle exaggerates this). Dark-mode users get a white flash.
Fix: inline `<meta name="color-scheme" content="light dark">` and a two-line `<style>` with the canvas colour and dots in `index.html`, then show a skeleton top bar while `/api/me` and the board load.

**7.6 Polish: shared links have no preview.**
`index.html` is static, with no `og:` or `twitter:` tags, so a board link pasted into Discord or Slack shows only "Tack". The facilitator will be pasting this link into the EmDash chat.
Fix: for `/b/:id/:slug`, have the Worker inject `og:title` (the board title, when the board is public or instance-visible), `og:description` and an `og:image`. The thumbnail sketch can be rendered to SVG or PNG on the server.

**Keep:** the setup page copy is excellent. It covers who owns the app, why each permission is needed, and the "running locally" webhook note. The sign-in copy ("nothing changes on GitHub until you push it") and the invite-only "Check again" explanation are both good (`gallery-auth-light.png`, `gallery-auth-dark.png`, `03-signin-page-before-setup.png`).

### 8. Narrow widths, touch, accessibility

**8.1 Minor: phones are unusable for the board, though the home page holds up.**
At 375 px the top bar takes 179 px (four rows), the bottom toolbar is clipped on both sides with a horizontal page scroll, and the minimap covers the toolbar (`shots/boards-and-setup/48-board-8people-375.png`, `58-touch-board-390.png`). The home page works at 375 (`53-home-375.png`) apart from tabs wrapping to three rows, and the tile "…" is visible without hover on touch (opacity 1, `57-touch-home-390.png`). The Share dialog fits at 375 (`55-share-375.png`). At 768 the home page is fine (`53-home-768.png`).
Fix: for the EmDash session, phones only need to view and comment. Below 600 px, show title, avatars, Share and "⋯" in the bar, hide the minimap, and let the toolbar scroll horizontally inside itself. Make the home tabs one horizontally scrolling row.

**8.2 Minor: axe found problems on the home page.**
The board, Share dialog, sign-in, setup and error pages had **0 violations** in light and dark. The home page had 2 serious and 1 moderate:
- `aria-prohibited-attr`: `span[aria-label="2 people"]` in the tile's avatar stack (`BoardTile.tsx`). Give it `role="img"`, or use visually hidden text.
- `heading-order`: the page `h1` "Boards" goes straight to tile `h3`s. Use `h2`, or add a visually hidden `h2` for the grid.

**8.3 Polish: focus rings vary.**
The home tab focus ring is a square box offset from the tab (`shots/boards-and-setup/43-focus-ring-home.png`), while buttons get rounded rings (`71-topbar-focus-ring-dark.png`). Home tab order is logical: brand → bell → theme → account → search → New board → each tab → each tile link → tile "…" (see 3.4 for the tabs).
Fix: use one `:focus-visible` ring token, rounded to each control's radius.

---

## Top 5 to fix before the EmDash session

1. **Prove the app is installed and writable on every EmDash repository** (1.1). List installations and repositories on `/setup`, or at least do a manual pre-flight: open a board with one card per repository and check for "Not live". Staged write-back is the point of the session, and right now you'd find a gap only when a push fails.
2. **Fix the arrival path for invitees** (2.1, 3.1). Validate invited logins against GitHub with an avatar preview, tell the owner to send the link, and default the home page to "Shared with me" when it holds boards the person hasn't opened.
3. **Slim the top bar so it never wraps at 1024px** (5.1). Move theme into the account menu, make "Synced" a dot, and put History and Rules in a title menu. Keep Changes and Share labelled, and make the rest icons.
4. **Make access obvious and unambiguous** (2.2, 2.3). Split "Anyone with the link · Can view" from "People on this Tack · Can edit", and show the board's access level near the title or the Share button so nobody is surprised who can edit.
5. **Make search global and forgiving** (3.2). The search box sits above the tabs and should search all of them. Tell people when a match is in Archived.
