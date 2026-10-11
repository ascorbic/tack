# UX review: widgets and automation

Reviewer area: the widget picker (W) and all seven widget kinds, inbox frames, rules, provenance, Expand related. Driven with Playwright against `/play?scenario=widgets|tracking|roadmap|inbox|rules|related`, the `/play/widgets` and `/play/inbox` galleries, and a real board on the fake forge (`fake.tack/demo/app`) with two dev logins (alice as owner, bob as editor and then as a viewer). I tested at 1440x900 and 1280x800, in light and dark. Screenshots are in `shots/automation/`.

## Verdict

The individual pieces are unusually well made. The drag interactions are FigJam-grade: dragging a row out as a card, dragging an inbox item into a section with a tilt, drop-to-match with a staged-change preview, and Expand related laying out a whole web with one Undo. Every widget state (loading, empty, rate-limited, stale, signed-out, zoomed-out) has been designed, and dark mode holds up. The weak points are around those pieces rather than in them:

- **Floating panels position badly.** Config panels and the inbox editor open off-screen or under the toolbar, especially at 1280x800. A facilitator configuring a widget live will hit this within minutes.
- **Search queries are the only way in.** Every widget, inbox and rule starts from a raw GitHub search string. Presets help, but a plain-language query like "bugs in unpic" silently returns nothing (or, on github.com, a search of all of GitHub). There is no "did you mean" and no label or milestone picker.
- **Inbox trays, rules and lists overlap as concepts.** Trays also cover neighbouring sections.

Of the seven kinds, list, review queue, milestone and stale finder earn their space on a planning board. Timeline and release draft are mostly decoration for a planning session.

---

## Findings by feature

### 1. Widget picker (W)

**Major: Picker descriptions are truncated, so the picker can't explain itself.**
Each kind's one-line description is cut off with an ellipsis: "Any search, kept live. Drag rows out a…", "What blocks what, for a search or a s…". The full text only appears as a native `title` tooltip after a delay. For a first-time user this text is the only explanation of what a "Stale finder" or "Dependency map" is.
Evidence: `shots/automation/picker-open.png`, `shots/automation/real-picker.png`
Fix: let descriptions wrap to two lines (the tray has room: it is 780px wide with 3 columns), or switch to 2 columns. Add a tiny preview illustration on hover, as FigJam's widget browser does.

**Minor: Ready-made lists sit in an unlabelled row.**
The six preset pills ("Open bugs", "Needs triage", …) follow a divider with no heading, so they read as more widget kinds. On a board with no cards, only "Assigned to me" and "My review queue" appear, both personal.
Evidence: `shots/automation/picker-open.png`, `shots/automation/real-picker.png`
Fix: add a small "Quick lists for demo/app" label naming the repository the presets will use.

**Polish: Picker icon tiles are squashed.**
The kind icon tiles measure 18x30 instead of square, so they read as vertical capsules, more visibly in dark mode.
Evidence: `shots/automation/dark-1280-picker-zoom.png`
Fix: `flex: none; width/height: 30px` on `.widget-picker-kind .widget-kind`.

**Minor: New widgets drop on top of whatever is at the centre of the view.**
Clicking a kind places it at the viewport centre with no free-space search. In the widgets scenario the new list covered three widgets and a section. On the real board, "Assigned to me" landed squarely over the milestone widget.
Evidence: `shots/automation/list-added.png`, `shots/automation/real-assigned-to-me.png`
Fix: reuse the free-space placement rules already use (`placeCommandCard`-style nearest clear spot) when clicking. Keep exact placement for drag-from-picker.

**Polish: The widget tool's icon is the List icon.**
The toolbar button for "Widget W" uses the same bullet-list glyph as the List kind, so it reads as "add a list".
Evidence: `shots/automation/widget-tool-hover.png`
Fix: use a generic widget or grid glyph for the tool.

**Minor: The blank-board guide doesn't mention widgets.**
The first-run guide lists paste, sticky, text and cursor chat. Widgets, inboxes and rules, Tack's differentiators, aren't mentioned anywhere a newcomer would look.
Fix: add one row: "W: add a live list of issues".

### 2. Writing search queries (list, stale, timeline, dependency map, inbox, rules)

**Major (Blocker if non-maintainers will set widgets up): Non-experts can't write the queries, and failure is silent.**
I typed "bugs in unpic" into a new list. Tack correctly shows chips (bugs / in / unpic) and warns that drop-to-match can't work. It then runs it as a full-text search "everywhere you can see". The widget says "Nothing matches, yet. New matches show up here as they happen." That is wrong: nothing will ever show up. On github.com it would instead return random results from all of public GitHub. The panel knows the board's busiest repository (`suggestedRepo`) and the repo's labels, but offers no correction.
Evidence: `shots/automation/list-query-naive-typing.png`, `shots/automation/list-query-naive-result.png`
Fix, in priority order:

1. When a query has no `repo:`/`org:` scope, show an inline suggestion such as "Search only demo/app?", one click to prepend `repo:`.
2. When bare words match a label name in that repo, offer "Did you mean `label:bug`?".
3. Change the empty state for unscoped or word queries to "Nothing matches this search. Check the search" with Edit, not "yet".
4. Longer term, add a structured builder (repo, state, labels, assignee, milestone pickers) that writes the query, with "Edit as text" for experts.

**Minor: The `sort:` qualifier and the Sort-by control disagree.**
I typed `… sort:created`. The chip shows `sort:created` but the segmented control still says "Updated". It's unclear which one wins.
Evidence: `shots/automation/list-query-or-labels.png`
Fix: when the query contains `sort:`, reflect it in the control (or strip it into the control on commit).

**Minor: Query entry is inconsistent across surfaces.**

- The list panel shows "How Tack reads it" chips, refresh and drop notes. The inbox editor shows a live match count but no chips. The rule composer shows neither.
- The host picker is inline in the inbox textarea, a separate "On" select in widget panels, and absent in the rule composer.
- Preset names differ: "Needs triage" (list) vs "Untriaged issues" (inbox); "Open bugs" vs "New bugs".

Evidence: `shots/automation/list-query-naive-typing.png`, `shots/automation/inbox-editor-full.png`, `shots/automation/rules-composer.png`
Fix: build one `QueryField` component (chips, live count, scope suggestion, host) and use it in all five places, with one shared preset list.

**Minor: "On fake.tack / github.com" ships to production.**
`HOSTS = ["github.com", "fake.tack"]` is hard-coded in `ConfigPanel.tsx`, `panels.tsx` and `KindPanels.tsx`. A production user will see the test forge in every widget panel. The label "On" is also unclear.
Fix: list only configured forges (hide the field when there's one), and label it "Forge".

**Polish: Raw GitHub error text.**
"The listed users and repositories cannot be searched either because the resources do not exist or you do not have permission to view them." This is GitHub's message verbatim.
Evidence: `shots/automation/gallery-list-states.png`
Fix: translate the common cases, e.g. "Can't see `acme/unpic`: it doesn't exist, or it's private to you."

### 3. Widget config panels

**Blocker: Config panels open off-screen.**
At 1280x800, opening "Edit list" on the Needs triage widget (right column) put the panel at x=1214, y=-55: a 66px sliver on the right edge, with the header above the top bar. At 1440x900 the timeline's panel also started above the viewport, hiding its title. Nothing clamps or flips it. A facilitator on a laptop will open a panel and see nothing.
Evidence: `shots/automation/list-config-1280.png`, `shots/automation/timeline-config-board.png`
Fix: clamp the `NodeToolbar` panel to the viewport. Flip to the left side when there's no room on the right, and pin to the top when it's too tall. Alternatively, pan the canvas so the panel fits (FigJam pans).

**Major: The timeline panel's query preview renders one or two characters per line.**
With a range set, the "Searches" box shows `re / po / :a / cm / e/ / im / ag …` as a tall column. I saw it in the gallery and on the board.
Evidence: `shots/automation/timeline-config-board.png`, `shots/automation/gallery-setup-panels.png`
Fix: in `.widget-config-notes li`, the `.widget-config-query` span needs `flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere` (or render the query as chips like the other panels).

**Minor: The milestone panel disagrees with its widget.**
On the real board, a new Milestone widget's body offered "v1" from `demo/app` (the board's repo, on fake.tack). Its panel showed an empty Repository field with `demo/app` as grey placeholder text that looks filled in, "Name a repository to see its milestones", and "On: github.com".
Evidence: `shots/automation/real-milestone-new.png`
Fix: prefill the field with the suggested repo and host, as the widget body already does. Don't use a real-looking repo as placeholder text.

**Minor: Release draft label inputs are too narrow.**
"breaking, break…", "enhancement, fe…" are clipped and you can't see which labels map where.
Evidence: `shots/automation/gallery-setup-panels.png`
Fix: stack each section as title above labels, or use a token input.

**Minor: The list panel duplicates the presets shown in the empty widget.**
The new-list empty state shows six presets, and the panel beside it shows the same six again.
Evidence: `shots/automation/list-added.png`
Fix: when the panel opens from the empty state, show presets in one place only (the widget body).

**Polish: The stale panel's segmented control wraps.**
The "Quiet for at least" segments wrap to two lines ("2 / weeks", "30 / days").
Evidence: `shots/automation/gallery-list-panels.png`
Fix: use short labels (2w, 30d, 2mo, 3mo, 6mo) or a select.

### 4. List widget

**Excellent (keep):** Dragging a row out shows a ghost card with a "Drop to add a card" pill, the source row dims, and on drop the row gets a pin and highlights. Hovering a row lights up its card on the board. Drop-to-match outlines the list, shows a confirmation ("Make #425 match: Add good first issue"), focuses "Stage 1 change" so Enter works, and toasts with Undo.
Evidence: `shots/automation/row-drag-midway.png`, `shots/automation/row-dropped.png`, `shots/automation/drop-to-match-confirm.png`, `shots/automation/drop-to-match-after-enter.png`

**Major: Rows have no click or keyboard path to the board.**
Clicking or double-clicking a list row does nothing. Rows aren't focusable, and there's no Enter to add. The inbox tray, by contrast, adds a card on click and supports Enter/Delete. Users who learn one will expect the other, and keyboard users can't use lists at all.
Evidence: `shots/automation/list-row-click.png` (card count unchanged at 4)
Fix: make rows focusable buttons. Click or Enter places the card beside the widget (free space), with Undo, matching the tray.

**Minor: The empty state is clipped in short widgets.**
"Mentions flaky" (default seeded height) cuts "Nothing matches, yet" in half under the footer.
Evidence: `shots/automation/widget-empty-clipped.png`
Fix: drop the illustration and use a compact one-line empty state when the body is under about 160px.

**Minor: Drop-to-match's preview is hidden under the dragged card.**
On the board, the "Drop to make it match" label and change chips are centred in the list, exactly where the dragged card sits. You only see the dashed outline and blurred rows.
Evidence: `shots/automation/drop-to-match-hover.png` (compare the gallery's `gallery-list-states.png`, where it's visible)
Fix: pin the overlay text to the top of the list body, or float it beside the cursor.

**Minor: Staged matches don't appear in the list.**
After staging "Add good first issue" on #425, the Good first issues list doesn't show #425 as pending. You have to trust the toast.
Fix: show staged-to-match cards as ghost rows ("after push") at the top, with the staged-change dot.

**Polish: Header query chips truncate with no way to read the whole query.**
"is:issue" and "label:bu…" are cut off at the header's edge. The full query is only in a `title` tooltip.
Evidence: `shots/automation/scn-widgets.png`, `shots/automation/viewer-board.png`
Fix: show the full query in a hover popover with Copy and "Open on GitHub", which is useful for viewers who can't open the panel.

### 5. Review queue, milestone, stale finder (tracking)

**Excellent (keep):** All three are strong planning tools: the review queue's summary chips ("Oldest 12d", "3 waiting 4d+", "1 failing CI"), the milestone's burn-up with pace forecast ("At 3 a week, done Oct 24: on track"), and the stale finder's age buckets with staged quick actions and "Close all 4". Their zoomed-out summaries (a big 6, a 63% ring, "8 gone quiet" with bucket bars) are exactly what a facilitator wants on a wall.
Evidence: `shots/automation/scn-tracking.png`, `shots/automation/tracking-zoomed-far.png`, `shots/automation/stale-row-hover.png`, `shots/automation/dark-1280-tracking.png`

**Minor: Text is unreadable at mid zoom.**
At about 0.4–0.5 zoom, widgets still render full rows with roughly 5px text. The summary view only takes over further out.
Evidence: `shots/automation/tracking-zoomed-out.png`
Fix: switch to the summary view earlier (around 0.55), or render summary plus top three rows at mid zoom.

**Minor: "Ask if it's still wanted" stages a comment you never see.**
The ping action stages a comment in your name (`pingComment`) without showing its text.
Fix: show the comment in the tooltip or a one-line preview in the staged mark, and let people edit it in Changes.

**Major (facilitation): "@me" widgets show different content to each person on a shared board.**
"Assigned to me" and "My review queue" resolve per viewer, by design. In a live session, when the facilitator says "look at the review queue", eight people see eight different lists. Nothing on the widget says so beyond an `@me` chip.
Fix: when adding an @me preset, ask "Just you, or @alice?" and default to the adder's login on shared boards. When @me remains, badge the header with "Your view".

### 6. Timeline

**Major (value): Timeline doesn't earn its space on a planning board.**
It's a strip of coloured circles and diamonds with no legend: what do green, purple, grey and diamond mean? Items are identified only on hover, and clicking a dot does nothing. I couldn't find a planning question it answers better than a sorted list.
Evidence: `shots/automation/roadmap-overview.png`, `shots/automation/timeline-hover.png`
Fix: add a legend (issue/PR × state) and support click-to-place (as the dependency map does). Consider making "Opened vs closed per week" bars the default, which answers "are we keeping up?". Otherwise drop it from the picker for the session.

**Minor: The hover tooltip is clipped by the widget header.**
The top line ("unpic #440 · Opened 13 d ago") is cut off.
Evidence: `shots/automation/timeline-hover.png`
Fix: render the tooltip in a portal, or flip it below the dot near the top edge.

### 7. Release draft

**Excellent (keep):** "v5.3.0 → v5.4.0 · New features" inference, sections by label, the Markdown preview toggle, and "Copy notes" with the toast "Copied the notes for v5.4.0: 10 pull requests".
Evidence: `shots/automation/release-copied.png`

**Minor: Sections spread to fill the height.**
In taller widgets, sections are spaced out with large empty gaps between FEATURES, FIXES and DOCS.
Evidence: `shots/automation/gallery-timeline-release.png`
Fix: pack sections to the top.

**Minor (value): Release draft is a release-manager tool, not a planning one.**
Useful the day before a release, low value in a planning session. Fine to keep, but don't feature it in the session.

### 8. Dependency map

**Excellent (keep):** Critical path highlighted, cycle detection drawn as red dashed loops, "No dependencies" chips, and an item popover with "Show on the board / Add to the board" and Open.
Evidence: `shots/automation/roadmap-overview.png`, `shots/automation/dep-item-click.png`

**Minor: Node titles truncate to about 20 characters.**
"Fewer options, better …", "Explain why each defa…": nodes stay narrow even in a wide widget, and the popover's Blocked by / Blocks lists show only numbers.
Fix: let node width grow with the widget (or two-line titles), and show titles in the popover lists.

### 9. Inbox frames

**Excellent (keep):** "Make inbox" on a selected section, a live "6 matches now" count while typing, ⌘↵ to start, and a tray where new items slide in. Dragging an item tilts it like a picked-up card, clicking drops it into the section with "From the 'Triage' inbox" provenance, and Dismiss has Undo plus an "N dismissed" list to bring items back. Keyboard support is there too (Enter adds, Delete dismisses).
Evidence: `shots/automation/inbox-overview.png`, `shots/automation/inbox-drag-midway.png`, `shots/automation/inbox-after-dismiss.png`, `shots/automation/inbox-editor-full.png`

**Major: The tray covers the neighbouring section, and stays full size when zoomed out.**
The tray always attaches to the section's right edge, above every shape. With side-by-side sections (Bugs / Docs / Later, the most common planning layout), the Docs tray sits over Later. Because the tray deliberately grows against zoom, at 1280x800 zoomed out it hides Docs and Later entirely.
Evidence: `shots/automation/inbox-new-collecting.png`, `shots/automation/inbox-zoomed-out-1280.png`
Fix: put the tray on whichever side has room. Collapse automatically to the "N new" badge below a zoom threshold or when it overlaps another section. Make the folded state the default for other viewers.

**Major: The inbox editor opens under the toolbar and off-screen.**
On "Make inbox" for a lower section, the editor's count, suggestions and buttons were behind the bottom toolbar and below the fold. I had to scroll the canvas to find "Start collecting".
Evidence: `shots/automation/inbox-editor-open.png`, `shots/automation/inbox-editor-naive.png`
Fix: the same clamping and auto-pan as config panels.

**Major: Two inboxes with overlapping queries both offer the same items.**
I made Docs an inbox with the same suggested query as Triage. Its tray offered #505 (dismissed from Triage) and #502/#501 (pending in Triage). Nothing warns that another inbox covers this, and dismissals don't carry across.
Evidence: `shots/automation/inbox-new-collecting.png`
Fix: warn in the editor ("Triage already collects 5 of these"), and don't offer items already on the board or pending in another inbox on the same board.

**Minor: Editor suggestions ignore the section's name.**
In a section titled "Docs", the suggestions are still Untriaged / New bugs / Good first issues / Open PRs.
Fix: when the section title matches a repo label, lead with `label:<title>` ("Docs" → `label:docs`). Small, delightful.

**Minor: The tray's counts don't add up.**
The header says "2 new · 6 matches" while the section holds 3 and 1 is dismissed.
Evidence: `shots/automation/inbox-after-dismiss.png`
Fix: "2 new · 3 placed · 1 dismissed" on hover, or drop "6 matches" from the header.

**Polish: Clutter when a section is selected.**
Selecting a section shows colour dots, Make inbox, Silent mode, Vote and a floating "Parent issue" bar. The row overflows onto the next section's label (Later is hidden).
Evidence: `shots/automation/section-selected-make-inbox.png`
Fix: move Make inbox, Silent and Vote into a "⋯" menu, or wrap them.

### 10. Rules

**Excellent (keep):** Rules read as sentences ("When a pull request mentions a card on this board, place it beside that card."), with a switch per rule, "Placed 1 card, last just now", clickable activity, and a toast with Show when a rule places a card while you watch.
Evidence: `shots/automation/rules-panel.png`, `shots/automation/rule-fired-activity.png`, `shots/automation/rule-toast-closed-panel.png`

**Major: Rules and inboxes overlap as concepts.**
"New matches into a section" (a rule) and "Make inbox" (a section) both say "put search matches in this section". One auto-places and one queues for triage, but nothing in either UI explains the difference or links to the other. Either can be set on the same section with the same query.
Fix: in the rule composer, add "Prefer to review them first? Make the section an inbox instead". In the inbox editor, add "Place automatically" as a toggle that creates the rule. Better still, merge them: an inbox with an "auto-place" switch.

**Minor: The composer starts with a duplicate rule and gives no feedback.**
"New rule" pre-fills `repo:acme/unpic is:issue is:open label:bug` → "New bugs", identical to an existing rule. There's no duplicate warning and no live match count (unlike the inbox editor). "Matching items / Linked pull requests" is jargon for the two kinds, and "appears" is vague (opened? labelled later?).
Evidence: `shots/automation/rules-composer.png`
Fix: start empty or use an unused preset, warn on duplicates, and add the live count. Rename the tabs "Search matches" / "Pull requests for cards", and spell out "appears" as "is opened or starts matching".

**Minor: Viewers see a lead-in sentence with nothing after it.**
As a viewer, the Rules panel says "No rules yet. Start with one of these:" and then nothing (the templates are hidden for viewers).
Evidence: `shots/automation/viewer-rules.png`
Fix: for viewers say "No rules on this board." Also consider hiding the Rules button for viewers when there are none.

**Minor: Rules can interrupt a live session.**
A rule can drop cards onto the board mid-discussion, and there's no single "pause all rules" or session-quiet switch. A facilitator would have to toggle each rule.
Fix: add "Pause rules during this session" to the Facilitate menu (and when a timer or silent mode is running), queueing placements to apply after.

**Polish: Rule placements have no Undo or Remove in the toast.**
The toast says "A rule: Added #522 to 'New bugs'" with Show only, and doesn't name the rule. A beside-placed PR gets no connector to its issue.
Fix: add a Remove action, name the rule, and draw a dashed "closes" connector for beside-linked placements.

### 11. Provenance and "no longer matches"

**Excellent (keep):** Restrained glyphs (tray, list, spark) that expand to "From the 'Triage' inbox" on hover. The dashed edge and the Keep / Remove band are clear, and the band is hidden for viewers.
Evidence: `shots/automation/provenance-hover-stale.png`

**Minor: The band doesn't say why a card stopped matching.**
"No longer matches" on a card that is now Closed: you have to compare it against the query yourself.
Fix: "No longer matches: closed" (or "label bug removed"). The client has both the query and the card.

**Polish: Glyphs are too faint to notice.**
The 12px grey glyphs in the card foot are easy to miss, and people won't know cards have provenance at all.
Fix: tint them with the source's colour (inbox blue, rule amber).

### 12. Expand related

**Excellent (keep):** ⌥E or the "Related" action opens a sheet with toggles per relation and counts, "On the board" tags, and "Adds 9 cards, connects 1 already here". Lay out (↵) builds a tidy web with typed connectors (blocks / closes / hierarchy) in one undoable step and toasts with Undo. This feature is the strongest demo for the EmDash session.
Evidence: `shots/automation/related-expanded.png`, `shots/automation/related-laid-out-fit.png`

**Minor: The sheet covers the card being expanded.**
The popover sits directly over #412, the card it's about.
Evidence: `shots/automation/related-expanded.png`
Fix: anchor it beside the card, not over it.

**Polish: Connectors and toasts collide with cards.**
After layout, the "closes" connector from PR #418 runs through #447's title, the action bar sits on top of the sub-issue elbows, and the toast covers the sub-issue row.
Evidence: `shots/automation/related-laid-out.png`
Fix: route connectors around cards, move the action bar below the hierarchy, and raise the toast while the layout is on screen.

### 13. Viewers vs editors

Viewers get refresh but no config, the Keep/Remove band is hidden, and the toolbar is reduced to select, hand and comment. All correct.
Evidence: `shots/automation/viewer-board.png`
Problem: the viewer Rules panel (see Rules above).

---

## Top 5 to fix before the EmDash session

1. **Clamp or flip every floating panel into the viewport** (widget config panels, inbox editor), or pan to fit. At 1280x800 the list panel opens entirely off-screen. (`list-config-1280.png`, `timeline-config-board.png`, `inbox-editor-open.png`)
2. **Rescue non-expert queries.** Suggest `repo:<board repo>` for unscoped searches, turn label-like words into `label:` suggestions, and replace "Nothing matches, yet" with "Nothing matches this search. Edit it" when a query can never match. (`list-query-naive-result.png`)
3. **Stop inbox trays covering neighbouring sections.** Put the tray on the side with room, and fold it to its badge when zoomed out or overlapping. (`inbox-new-collecting.png`, `inbox-zoomed-out-1280.png`)
4. **Fix the timeline panel's one-character query column and the squashed picker icons, and let picker descriptions wrap.** These are three cheap CSS fixes that are the first things people see. (`timeline-config-board.png`, `dark-1280-picker-zoom.png`, `picker-open.png`)
5. **Make shared-board widgets mean the same thing to everyone.** Default @me presets to the adder's login (or badge them "Your view"). Add a "pause rules for this session" switch to Facilitate so cards don't appear mid-discussion. Place new widgets in free space instead of on top of other widgets. (`real-assigned-to-me.png`, `rule-toast-closed-panel.png`, `list-added.png`)
