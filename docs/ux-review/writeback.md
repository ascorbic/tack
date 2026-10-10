# UX review: writing back to GitHub

Reviewer pass, 2026-10-10. Scope: the selection action bar and every action on it (sticky to issue with label, milestone and assignee pickers; parent issue from a section or cluster; connector to blocked-by; labels; milestone; assign; close and reopen; backlinks with the opt-in snapshot), staged marks on shapes, the Changes panel, the push sheet (review, previews, watcher estimates, push as you or the bot, progress, failures and retry, history), refusal states, and decisions (create, vote, decide, supersede, write back as an ADR PR or a Discussion).

## Verdict

The staging model is right, and most of it is built to a high standard: nothing reaches GitHub until a review step that shows real Markdown previews, who will be notified, who the write comes from, and what will happen on the board. The push itself is satisfying, and people watching see their stickies turn into cards as each one lands. The weak point is the time between staging and pushing. A staged change is a snapshot that doesn't follow the board: if you edit a sticky after staging it, the edit is silently dropped, and if you delete it, its issue still gets created. In a real 8-person session people keep editing while the facilitator stages, so I'd expect both to happen within the first hour. Next comes scale: after a push of 30 or more stickies the new cards overlap each other, the panel's order looks random, the marks bury the board, and nothing can be corrected in review without unstaging. Fix the first two before the EmDash session and it's a strong, trustworthy flow. Without them, the first push could create stale or unwanted public issues, and after that people won't trust it.

## How I tested

- `/play?scenario=writes`, `?scenario=push` and `?scenario=decisions`, and the galleries `/play/actions` and `/play/changes`, at 1440×900 and 1280×800, in light and dark mode.
- Real boards on the dev server against the fake forge (`fake.tack/demo/app`, `fake.tack/stress/cards`). In one session there were three people: Alice (owner), Bob (editor) and Carol (viewer), each in their own browser context. Alice laid out a section, loose stickies, a connector, cards and a decision. She staged everything with the bar and keyboard shortcuts and pushed it (one change was forced to fail with `[fail]`), while Bob and Carol watched.
- A 40-sticky brainstorm, staged and pushed in one go (1280×800).
- A fresh board with no cards and no recent repositories, to see the first-time repository picker.
- A public board opened signed out.
- Source read alongside: `src/client/actions/*`, `src/client/changes/*`, `src/client/decisions/*`, `src/shared/actions.ts`, `src/server/forges/fake.ts`.

Screenshots are in `shots/writeback/`. File names start with `p-`/`q-`/`d-`/`b-` for the playground, `rb-`/`m-`/`n-`/`so-` for real boards, `g-` for gallery crops and `e-` for the edit-after-staging tests. A `-dark` suffix marks dark mode and `-1280` marks 1280×800.

---

## Findings by feature

### 1. Staged changes vs. later edits to the board

**1.1 Editing a sticky after staging doesn't change the staged issue, and the edit is lost on push. Blocker.**
What I did: selected "A provider playground", ⌥I, ↵ (staged). Then I double-clicked the sticky and changed it to "A provider playground with live preview". The sticky shows the new text and still carries its "New issue in imagekit" mark. The Changes panel still says *Create issue "A provider playground"*. On push, the issue is created with the old title and the sticky is *replaced* by that issue's card, so the edit disappears from the board as well. Nothing warns about any of this. In a live session, people fix typos and sharpen wording on stickies all the time, often just after the facilitator has staged them.
Evidence: `shots/writeback/e-01-edited-after-stage.png`, `shots/writeback/e-02-panel-after-edit.png`.
Fix: for `issue.create` changes whose effect replaces a sticky, read the title and body from the sticky when the push is planned, not when the change is staged. Alternatively, rewrite the staged op on every text change in the same transaction. Either way, show the current text in the panel and sheet, and add a small "edited since staged" note on the row so the reviewer knows.

**1.2 Deleting a staged sticky leaves its issue staged, and pushing creates it anyway. Blocker.**
What I did: staged a sticky, then selected it and pressed Backspace. The toast said "Deleted a sticky · Undo". The Changes badge still showed 1, and the panel still listed *Create issue "A provider playground"*. "Show on the board" for that row has nothing to show. Pushing would publicly create (and notify watchers about) an issue the team deliberately threw away. The same probably applies to sub-issue links that hang off it.
Evidence: `shots/writeback/e-03-deleted-staged-sticky.png`.
Fix: when a shape a change depends on is deleted, unstage that change (and its dependants) in the same transaction, so a single Undo brings both back. Say so in the toast: "Deleted a sticky and unstaged its issue · Undo". If unstaging silently feels too aggressive, keep the row but mark it "Its sticky was deleted" and leave it out of the next push by default.

### 2. Selection action bar

**2.1 Three floating toolbars can stack around one selection, and the staging bar loses. Major.**
Selecting stickies shows the stage bar ("Make 3 issues · Parent issue"), plus the align/distribute bar for multi-selection, plus the colour/font bar. That's three separate pills stacked under or around the selection (`rb-01-make-issues.png`, `p-01-marquee-stickies.png`). When there's no room below, the bar flips above and covers the selection's own staged marks (`p-17-card-marks-dark-1280.png`: the bar sits over the "→ 5.0" and "Will close" pills). FigJam uses one contextual toolbar with sections.
Fix: merge "stage" into the shape's existing contextual toolbar as its own group, so there's one bar per selection. Keep the text labels on the primary action ("Make 3 issues"), because those are the best part of the current bar.

**2.2 The action bar can't be reached with Tab. Major (accessibility), Minor for the session.**
After selecting a card, Tab goes to the card's title link and then to the next card. It never reaches "Labels", "Milestone" and the rest. The ⌥ shortcuts work and show in tooltips (`p-12-card-tooltip.png`), but that's the only keyboard route.
Fix: make the bar a roving-tabindex `toolbar` that receives focus on Tab from the selection (or on F6), with arrow keys between buttons.

**2.3 Icon-only triage buttons. Minor.**
For cards, the bar is "Related" followed by six unlabelled icons (labels, milestone, person, check-circle, link, tree) (`p-11-card-bar.png`). The tooltips are good and include shortcuts, but a first-time user has to hover each one. The link icon in particular doesn't suggest "comment on GitHub with a link to this board".
Fix: when the bar has room (one or two cards), label the two least-obvious icons: "Backlink" and "Close". For backlinks, consider a speech-bubble-with-link icon.

**2.4 Actions offered that can't do anything. Minor.**
On `demo/app`, which has no assignable people, ⌥P / Assign opens a panel that says only "Nobody can be assigned here", with a disabled Stage button (`rb-05-alt-p-no-assignees.png`).
Fix: disable the button with the reason in its tooltip, the way merged PRs already get "Merged pull requests can't be closed or reopened" (`rb-06-merged-pr-bar.png`, which is nicely done).

**2.5 Unwritable repositories are handled well. Keep.**
Selecting the `lovell/sharp` card (no app installed) shows the whole bar greyed out, with "Tack can't write to these yet: install the app" on every button and an "Install the app" link in the bar (`b-01-unwritable-card-bar.png`, `g-actions-bars-and-panels.png`). That's clear and honest.

### 3. Sticky → issue (Make issues panel)

**3.1 The repository field looks empty when a repository is picked. Major.**
The combobox shows the chosen repository as grey placeholder-style text ("acme/imagekit"), with no label. The actual choice is a small tick at the end of a list row underneath (`p-02-alt-i-panel.png`, `rb-01-make-issues.png`). First-time readers will think nothing is picked, or that the field is disabled. The full list of repositories is also always expanded, which pushes the extras and preview down.
Fix: show the selected repository as a solid "chip" value with a "Change" affordance, and collapse the list until the field is focused or typed in. Add a visible "Repository" label.

**3.2 Pasting a GitHub URL isn't accepted. Minor.**
On a fresh board (no cards, no recents) the field asks "Type a repository, like owner/repo". Typing `emdash-cms/emdash` works and shows "new" (`n-02-typed-owner-repo.png`). Pasting `https://fake.tack/demo/app/issues/3`, which is what people actually have on their clipboard, gives nothing (`n-03-typed-url.png`).
Fix: parse repository and issue URLs (and `host/owner/repo` keys) in the picker, as card paste already does.

**3.3 Titles can't be checked or fixed before staging. Minor.**
The preview lists titles, with "+ description" when there's a body, but nothing can be clicked or edited, and only the first four are shown ("and 36 more", `m-02-make-40-issues-1280.png`). Because of 1.1, editing the sticky afterwards doesn't help either.
Fix: make the preview rows editable inline (writing back to the sticky), and expand "+ description" on click.

**3.4 The extras pickers (labels, milestone, assignees) are excellent. Keep.**
The pills open their picker in place, keyboard filtering works ("enh" ↵ picked *enhancement*), and the chosen values replace the pill label (`p-04-labels-after-enter.png`, `p-05-milestone-pill.png`). The toast confirms "Staged 3 issues for acme/imagekit, with a label" with Undo. Fields the repository doesn't support are simply not offered (no Assignees on `demo/app`).

**3.5 The popover background lets the canvas show through. Polish.**
At 94% opacity with backdrop blur, sticky text behind the panel is faintly visible through form fields (`n-02-typed-owner-repo.png`: the sticky's letters show through under the repo field and preview).
Fix: use an opaque `--surface` for popovers that contain inputs, and keep the glass look for the bar only.

### 4. Parent issue from a section or a cluster

**4.1 Well designed overall. Keep.**
Selecting a section and choosing "Parent issue" prefills the title from the section name, picks the repository most of its cards are in, and lists children in reading order, marking which are new (`p-09-parent-panel.png`, `rb-02-parent.png`). It says "N pull requests are left out: only issues can be sub-issues". After staging, a dashed placeholder card appears above the section, connected to it (`rb-03-after-parent.png`). Mixed sticky + card selections only offer "Parent issue", which is the right restraint.

**4.2 The placeholder card reads "#?". Polish.**
"#?" looks like a broken reference.
Fix: show a "New" chip in its place (the sheet already uses NEW for unborn issues, `rb-13-sheet.png`).

**4.3 The section's staged marks pile up. Minor.** See 7.1.

### 5. Triage: labels, milestone, assign, close/reopen

**5.1 The milestone picker highlights "No milestone" first. Minor.**
⌥M then ↵ immediately stages *removing* the milestone (`p-15-milestone-panel.png`). There's also no marker for the card's current milestone.
Fix: highlight the current milestone (or the first real one), tick the current one, and put "No milestone" at the bottom.

**5.2 Enter and ⌘↵ are inconsistent. Minor.**
Make issues, Parent and Blocked-by stage with ↵. Labels, Assignees and Backlink need ⌘↵, because ↵ toggles an option or adds a newline. The reasoning holds, but people will press ↵ in the labels panel, see a label toggle, and wonder why nothing was staged.
Fix: accept ⌘↵ everywhere as "stage", and show the ⌘↵ hint consistently on every Stage button.

**5.3 Toast copy is vague. Minor.**
"Staged labels for an item", "Staged closing an item" and "Staged milestone 5.0 for an item" don't say which item or which labels.
Fix: "Staged +docs on #412", "Staged closing #412 as completed".

**5.4 The close menu is good. Keep.**
The completed / not planned / duplicate menu has plain-language subtitles ("Won't fix, can't repro, stale") (`p-16-close-menu.png`).

### 6. Connector → blocked-by

**6.1 Clear and well built. Keep.**
Selecting an arrow gives "Blocked by" in the connector toolbar. The panel explains "The arrow points from the blocker to what it blocks", offers Swap, and spells out "#377 will be marked as blocked by #412" (`p-19-blocked-by-panel.png`). Between two stickies that are themselves staged as issues it still works ("Cache the manifest will be marked as blocked by Faster cold starts", `rb-08-all-staged.png`), and the push orders it after the creates.

**6.2 It's only discoverable by selecting an arrow. Minor.**
Nobody will guess that an arrow between two cards can become a GitHub dependency.
Fix: when two cards (or a card and a staged sticky) are selected and connected, also offer "Blocked by" in the main action bar.

### 7. Staged marks on shapes

**7.1 Too many marks, and they collide. Major.**
Each staged change adds its own pill above the shape ("New issue in imagekit", "Sub-issue of 'Docs for 5.0'", "Blocks #377"), a label pill below ("+ enhancement"), and a tilted ghost card behind stickies. Pills from neighbouring shapes overlap each other and the shapes above (`p-20-after-blocked.png`: the *Write the migration guide* sticky has two pills stacked on its top edge, and "+ enhancement" under *Benchmarks in CI* is hidden behind *Codemods for 5.0*). The ghost card reads as a rendering glitch rather than "this will become a card". With 40 staged stickies the board turns into a field of identical green pills (`m-03-40-staged-1280.png`).
Fix: one combined mark per shape ("New issue · sub-issue of Docs · +enhancement"), truncated, with the details on hover. Collapse marks to a small coloured dot below about 60% zoom. Drop the ghost card, or animate it in only on hover.

**7.2 Failure is clearly marked. Keep.**
A failed create turns its pill red ("New issue in app" in red, dashed red outline, `rb-18-bob-after.png`), so everyone can see which sticky didn't make it.

### 8. Changes panel

**8.1 The order looks random, and nothing is grouped. Major (at scale).**
With 40 stickies staged in one action, the panel lists *Idea 1, 2, 3, 5, 4, 6, 14, 7, 13, 15…* (`m-04-panel-40-1280.png`). The order is neither staging order nor board order, so a facilitator can't scan it against the board. Forty rows of "Create issue … · You · just now" is a lot of scrolling.
Fix: sort by staging time and then by board position (top-left to bottom-right). Collapse a batch staged by one action into one expandable row ("40 new issues from stickies").

**8.2 The include toggles are shared, and nobody can see who unticked one. Major (for an 8-person session).**
The checkbox on each row is board-wide state. If Bob unticks Alice's change "to look at it", Alice's next push silently leaves it out. Nothing on the row says who left it out or when. "Everyone on the board sees this list" doesn't tell you that everyone also *controls* it.
Fix: show "Left out by Bob" on unticked rows (like "Staged by"). Better still, make inclusion a choice in the push sheet that applies to that push only, and keep the panel as a shared list without checkboxes.

**8.3 The failure badge covers the count. Minor.**
The red failure dot sits on top of the count pill, so "11" reads as "1" plus a dot (`q-01b-badge-zoom.png`, also `rb-18-bob-after.png`).
Fix: move the dot to the button's top-right corner, outside the count, or tint the count pill red when something failed.

**8.4 "Show on the board" and hover-to-highlight work well. Keep.**
Clicking a row's summary pans to the shape and selects it (`f-01-show-on-board.png`, `q-03-row-click-focus.png`). Hovering a row highlights its shapes.

**8.5 Viewer mode reads clearly. Keep.**
Carol (viewer) gets "What's staged on this board. You can look, but not change it.", greyed-out checkboxes, no push button, and no action bar on selection (`rb-12-viewer-changes.png`).

### 9. Push sheet: review

**9.1 The review is the best part of the feature. Keep.**
It shows real Markdown previews (code, bold, task lists, @mentions), label, milestone and assignee chips, "On the board, its sticky turns into the new card", NEW chips for unborn issues in sub-issue and blocked-by rows, and before/after for labels. Each repository gets its own watcher chip ("Notifies ~214 people" or "No watchers"), and the footer names who gets pinged ("@jo, @priya hear about being assigned"). "Push as You / Tack's bot" is a clear two-card choice, ⌘↵ pushes, and repositories without the app get a warning band with their rows unticked (`q-04-push-sheet.png`, `q-05-push-sheet-scrolled.png`, `rb-13-sheet.png`).

**9.2 Nothing can be edited in review. Major.**
To fix a typo in a title, change a label or move a change to another repository, you have to unstage, find the shape again, and restage. Review is exactly where a facilitator notices these things.
Fix: allow inline edits in the sheet for issue titles and bodies, labels, milestone and assignees (for stickies, write the title edit back to the sticky). At minimum add an "Edit" link that reopens the original panel with the change's values.

**9.3 Long, repetitive reviews for title-only issues. Minor.**
Forty stickies give forty cards that each say "No description." in italics with the same footer (`m-05-sheet-40-1280.png`).
Fix: a compact one-line row for issues without a body, and per-section "Collapse all".

**9.4 Backlink previews don't show the snapshot. Minor.**
The comment preview shows a chip, "The board around this item", where the image will go (`b-05-backlink-preview.png`).
Fix: show the actual thumbnail. It's already drawn and uploaded by then.

### 10. Push sheet: progress, failures, retry, history

**10.1 Progress feels great. Keep.**
The ring fills, with a red arc for failures (`rb-17b-ring-zoom.png`). Rows go Waiting → Sending → Sent, waiting to confirm → On the test forge #520, with a green flash. "You can close this: it carries on" is reassuring, and the result line "10 landed, 1 didn't" has an in-place Retry and "Retry it" (`q-06-progress-1500.png`, `rb-17-push-done.png`). Bob, watching, saw stickies become cards one by one and his panel showed "Pushing 9" (`rb-15-bob-during-push.png`). That's exactly the shared moment a live session needs.

**10.2 Raw forge errors are shown as-is. Major.**
`friendlyError` only adds a full stop, so GitHub's own wording reaches people. The changes gallery shows "Resource not accessible by integration." under a failed assignment (`g-changes-panels.png`, third panel). The fake forge's "refused this, as asked ('[fail]')" is fine for tests, but real GitHub 403, 404, 410 and 422 messages are jargon.
Fix: map the common cases to plain language plus an action. For example: "Tack's app doesn't have permission to assign people in acme/imagekit. Ask an org owner to accept the new permissions." Also "Issues are turned off in this repository", "Label 'x' doesn't exist (create it?)", "Rate limited, retrying in 40s". Keep the raw text behind a "Details" toggle.

**10.3 Pace at scale. Minor.**
Forty creates took 44 s (one write a second, `m-06-pushing-40-1280.png`). The progress view and "you can close this" cover it, but with 8 people watching, a line like "about 40 s left" would stop people wondering whether it's stuck.

**10.4 Progress order differs from review order. Polish.**
Rows are reordered for dependencies (sub-issue links move after creates). That's correct, but the jump between the review list and the progress list is disorienting.
Fix: keep the review order, and show "waiting for #… to be created" on dependants.

**10.5 History is clear. Keep.**
It shows who pushed, as whom (bot icon for "as Tack's bot"), when, per-change links, and a "1 failed" chip with the reason (`q-08-history.png`).

**10.6 Missing-dependency refusal is vague. Minor.**
"A change needs an issue that isn't in this push. Include it" doesn't name the change or the issue (`g-refused-missing-dependency-top.png`).
Fix: "'Make *Write the migration guide* a sub-issue of #412' needs *Write the migration guide* to be created first. Include it".

**10.7 Refusals are well written. Keep.**
"You can stage but not push here … Leave its changes out" (no write access, `g-refused-no-write-access-top.png`), not installed, signed out ("Sign in to push"), someone else pushing, offline, and view only ("View only: you can't push from this board", `g-review-view-only-top.png`). Each has one clear way forward.

### 11. After the push: what lands on the board

**11.1 New cards overlap where stickies used to be. Major.**
Stickies are 176 px wide and people place them roughly 200–220 px apart. The cards that replace them are 252 px wide, centred in the same place, so every card overlaps its neighbour. Connectors between them get buried (`rb-18-bob-after.png`: #498938 and #213434 overlap and their arrow is drawn across the top; `m-08-board-after-40-1280.png`: every one of 40 cards overlaps the next). The facilitator then has to tidy up in front of everyone.
Fix: after a batch of replacements, run the same "nearest clear spot" nudge that Expand related uses, or a local grid reflow inside each section. Alternatively, keep the new card at the sticky's width for its first render.

**11.2 Created issues carry no provenance. Major.**
Issues created from stickies contain only the sticky's text. There's no link to the board or section, and no credit to whoever wrote the sticky. Every issue is authored by the person who pushed. For an OSS project, "where did this come from and whose idea was it" matters, and the backlink feature already shows how it could work.
Fix: an optional, on-by-default footer on created issues, for example "From *EmDash planning* › Plugin API, an idea by @priya", using the same body builder as backlinks. Add a switch for it in the push sheet.

### 12. Backlinks and the snapshot

**12.1 The opt-in snapshot and private-card redaction are thoughtful. Keep.**
The snapshot is off by default. Turning it on draws a preview, and a card from another private repository is replaced with a "Private card" placeholder, with "hidden in this image, since the comment is public" (`b-03-backlink-snapshot.png`).

**12.2 The audience chips are unclear. Minor.**
"Public repositories | 🔒 acme/vault" are tabs between two snapshots, one per audience, but they look like filters or labels. The footer says "2 snapshots" without explaining why.
Fix: "2 versions: one for public repositories, one for acme/vault (private)", and label the chips "For public repos" / "For acme/vault".

**12.3 Snapshot framing. Polish.**
The preview is mostly empty canvas, and shapes are clipped at the edges ("Open" chips cut in half on the left, `b-03-backlink-snapshot.png`).
Fix: frame the selection plus any shapes it touches, with consistent padding, and never cut through a shape.

### 13. Decisions

**13.1 The lifecycle reads well. Keep.**
Proposed decisions show Agree/Disagree with avatars and a for/against bar, and a "Decide" button. The DECIDED and SUPERSEDED stamps, "Superseded by" link, and dashed "supersedes" connector make history legible (`d-00-board.png`, `d-02-decided.png`). After staging a write-back, the decision shows "ADR 0004 · Staged" and a "New pull request" mark (`d-05-staged.png`), and once pushed it tracks the PR's CI like a card (Adopt Conventional Commits, `d-00-board.png`).

**13.2 Write-back dialog: what you type there lives only in the dialog. Major.**
Context, Decision and Consequences are prefilled from the decision and can be edited, but the edits (and Consequences, which exists only here) go into the staged op, not onto the board's decision. Cancel and you lose them. If the push fails and you retry, you start from scratch. The board never shows the consequences everyone agreed on.
Fix: store Consequences on the decision shape (and edits to Context), and write them back as people type. The dialog then becomes a view onto the decision, not a separate draft.

**13.3 Fixed ADR folder and native select. Minor.**
The path is always `docs/decisions/NNNN-slug.md` (`DECISIONS_DIR`) and can't be edited (`d-03-writeback-dialog.png`). Projects with `adr/` or `docs/adr/` will get a second numbering scheme. The Repository field is a native `<select>`, unlike the searchable repository picker used everywhere else.
Fix: make the folder editable and remember it per repository (or detect `adr`/`docs/adr`), and reuse the repository picker.

**13.4 "Decide" is one unconfirmed click for any editor. Minor (facilitation).**
In a live session someone can decide a decision while the vote is still going. Undo and "Reopen as proposed" exist (`d-06-menu.png`), which helps.
Fix: let the owner restrict Decide to facilitators, or ask for a short confirmation when votes are split ("3 agree, 1 disagree: decide anyway?").

**13.5 The decision menu mixes actions with a list. Polish.**
The "…" menu shows "Reopen as proposed / Supersede with a new decision" and then a "SUPERSEDED BY" list of unrelated decisions to pick from (`d-06-menu.png`). It reads as though this decision is already superseded by them.
Fix: a "Mark as superseded by…" submenu.

### 14. Refusal states and roles: one environment note

On a real dev board opened signed out (public visibility), the signed-out window could untick a change in the shared panel and add stickies. That's because the dev instance has no GitHub app configured, so `allowed` is true for everyone (`src/server/boards/routes.ts:173`). It's not a writeback bug, but make sure the EmDash instance is configured (GitHub app plus allowlist) before the session, or anyone with the link can edit what's staged. The gallery's intended signed-out state ("Review 4" → "Sign in to push", `g-changes-panels.png` and `g-refused-signed-out-top.png`) looks right.

---

## Genuinely excellent: keep these

- The push sheet review: Markdown previews, NEW chips, before/after labels, per-repository watcher estimates, named mentions, and push as you vs. the bot.
- Live, shared progress: the ring with a red arc, rows that flash as they land, and stickies turning into cards for everyone watching.
- Dependency awareness: blocked-by and sub-issues between not-yet-created issues, ordered correctly, with a refusal that offers to include what's missing.
- Every stage action gives an Undo toast. Every action states "Not written until pushed."
- Unwritable repositories, merged PRs and view-only users get disabled controls with the reason, never silent failures.
- The snapshot is opt-in, with private-card redaction.
- Decision stamps, supersede connectors, and an ADR that follows its PR's live state.

## Top 5 to fix before the EmDash session

1. **Keep staged issues in step with their stickies (1.1).** Read the title and body from the sticky when the push is planned, or rewrite the op when the sticky's text changes. Today a reworded sticky is silently replaced by an issue with the old wording.
2. **Unstage (or flag and exclude) changes whose shape was deleted (1.2).** Otherwise deleted ideas become public, notifying issues.
3. **Reflow cards after a batch sticky→card swap (11.1).** A pushed brainstorm currently becomes a pile of overlapping cards in front of the whole team.
4. **Make the Changes panel and push sheet work at 30+ items (8.1, 8.2, 9.2).** Use a stable order (staged, then board position), collapsible batches, "Left out by …" on unticked rows, and inline title/label edits in review.
5. **Translate forge errors and add provenance to created issues (10.2, 11.2).** The facilitator needs to understand a failure without reading GitHub's API wording, and the EmDash community should be able to see which board, and whose sticky, each new issue came from.
