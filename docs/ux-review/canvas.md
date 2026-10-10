# Canvas UX review

Reviewed 2026-10-10 against the worktree `wf_30d50cab-408-1` (main at `3bd8599`), on a dev server at 1440×900 and 1280×800, in light and dark. I drove it with Playwright scripts: real boards with dev sign-in (three people at once: owner, editor, viewer), the `/play` scenarios (`empty`, `sections`, `connectors`, `brainstorm`, `arrange`, `stress`), `/play/cards` and `/play/crash`. I also read the source behind each finding. Screenshots are in `shots/canvas/`.

## Verdict

The craft in the individual pieces is high. Cards, CI and review states, connectors, section drop feedback, snapping guides and the crash page are all at or near FigJam quality, and two people typing in the same sticky merge cleanly, with undo that only takes back your own edits. The problems are in how the pieces fit together. A selected sticky takes over the keyboard, so Space-to-pan, Shift+1 zoom-to-fit and tool letters type characters into the note instead, which in an 8-person session will quietly add "!" and stray letters to other people's stickies. Adding issues is weak for a GitHub-native tool: there is no search, cards added from the tool all land in one invisible stack, and clicking a card's title opens GitHub in a new tab. People who join an existing board land on whatever is at the origin, not on the content. Fix the five items at the end and the session will feel smooth. The rest is polish.

---

## Findings by feature

### Keyboard and editing model (stickies and text)

**1. A selected sticky or text block swallows shortcut keys and writes them into the note: Blocker**

- What happens: `useEditing.ts` treats any one-character key with no ⌘/Ctrl/⌥ as "start typing" whenever exactly one sticky or text block is selected. It listens in the capture phase and stops the event, so it beats every single-key shortcut. With one sticky selected I measured:
  - Shift+1 (zoom to fit) → appends `!` and starts editing; the view doesn't move.
  - Shift+2 → `@`, Shift+0 → `)`, `=`/`+` (zoom in) → `=`, `-` (zoom out) → `-`.
  - Space (hold to pan) → appends a space. Space-drag does not pan.
  - Tool letters after Esc: Esc ends editing but leaves the sticky selected, so the very common rhythm "type a note, Esc, S for the next one" types an `s` into the note you just finished. Evidence: "please fix**s**", "5.0**X**", "line2**New ones**".
  - The keys only run their shortcut if you first click empty canvas.
- Why it matters: in a live session people click other people's stickies all the time, then reach for Space or Shift+1 to get around. Each time they silently edit someone else's note, as an undoable change that the author won't notice.
- Evidence: `shots/canvas/sticky-fit-text.png` (long note ends "please fixs"), `shots/canvas/sticky-pink-hand.png` ("before 5.0X"), `shots/canvas/card-multipaste.png` (Shift+1 typed into a pasted note), `shots/canvas/focus-ring-tab.png` ("line2New ones").
- Fix: only start editing on letters, digits and punctuation that aren't bound shortcuts, and never on Space. Let every combo in `SHORTCUTS` plus the tool keys win. Better: drop type-to-edit for anything except a sticky that was just selected by a click, and make Enter (already supported) the documented way in. Esc should also end editing _and_ deselect when the shape was created this session, so the next tool letter works.

**2. The action bar ("Make issue") floats under a sticky while you type: Polish**

- Evidence: `shots/canvas/sticky-editing.png`.
- Fix: hide the selection action bar while a shape is in text-edit mode, as the toolbar already hides during drags.

**3. Keys typed in the first moment after placing a shape are lost and can fire tool shortcuts: Polish**

- If you type within about 30 ms of clicking with the sticky or text tool, the first character goes to the window. "Hello" became "ello", "Heading" became "eading", and "B" switched to the comment tool. This is because focus arrives a few frames after mount (`focusWhenMounted`). Humans rarely type that fast, but fast typists sometimes do.
- Fix: while a just-placed shape is waiting for focus, buffer keystrokes and replay them into the field.

**4. Esc from editing keeps the sticky selected, but there is no fast "next sticky": Minor**

- FigJam habits: Tab or a hover "+" handle beside a sticky makes the next one in line. Here the side dots are connector handles, and clicking one does nothing (I checked). Tab while editing just blurs to the node.
- Fix: clicking (not dragging) a side handle creates a sticky of the same colour in that direction and starts editing it. Dragging still draws a connector.

### Empty board and first run

**5. The empty state is warm and clear, but it eats clicks in the middle of the board: Minor**

- The guide is lovely: three pinned notes, four hints, and two of them are buttons (`shots/canvas/firstrun-new-board-light.png`, `shots/canvas/firstrun-new-board-dark.png`). But `.empty-board-art` and `.empty-board-hints` have `pointer-events: auto`. A first-timer who picks the sticky tool and clicks the middle of the screen, the most natural spot, hits the art and nothing happens. Playwright couldn't click the pane there at all.
- Fix: set `pointer-events: none` on the art, and on the hints too while a placing tool (sticky, text, section, decision) is active.

**6. The empty state teaches paste, but nothing on it says how to find an issue: Minor**

- Its hints are ⌘V, S, T and /. Nothing points at the card tool (C), and the card tool can't search (see 9). A new user with no URL on their clipboard has no route to "put our issues on the board".
- Fix: add a hint for "C: add an issue or PR", and make that tool searchable.

**7. The minimap shows on an empty board as a blank white box: Polish**

- Evidence: bottom right of `shots/canvas/firstrun-new-board-light.png`.
- Fix: hide the minimap until the board has content, and add a way to toggle it (FigJam lets you hide it).

### Bottom toolbar and tools

**8. The toolbar is clean and every tool has a tooltip with its key. A few rough edges: Polish/Minor**

- What's good: tooltips are tight ("Sticky note S", `shots/canvas/firstrun-tooltip-dark.png`), each tool shows a one-line hint above the dock, and you can drag a sticky straight off the toolbar.
- Polish: the Stamp tool's full-colour 👍 emoji is the loudest thing in an otherwise monochrome dock (every screenshot), so it reads as a notification. Use a monochrome stamp glyph with the current emoji as a small badge.
- Minor: Decision (D), Widget (W) and Stamp (M) sit in the main dock with the same weight as Sticky and Text. For a first-time user that's 11 tools. Consider grouping the "facilitation and planning" tools behind a divider with labels on hover-expand, as FigJam does with its "more" drawer.

### Cards: adding, searching, details

**9. No way to search for an issue: the card tool only parses references: Major**

- What happens: C opens a field "owner/repo#123 or paste a URL". Typing what people actually think of ("emdash migration guide") just turns the field red. There is no message, no suggestion, and no search, although the forge adapters already have `search` and the widget runner uses it.
- Evidence: `shots/canvas/card-tool-invalid.png`.
- Fix: make the card tool a combobox. Bare text searches the board's repositories (`boardRepos(doc)`, busiest first) and shows live results with state icons. ↑/↓ moves and Enter adds. ⌘Enter adds every result to a grid. Keep reference parsing as the fast path. Explain any error in words: "Not an issue or PR link: try owner/repo#123, a GitHub URL, or search".

**10. Cards added with the card tool all land on one spot, stacked invisibly: Major**

- `onAddCard` places every card at `centre()`, the viewport centre, with no check for what's already there. Adding #5, #6 and #7 put three cards at exactly `translate(593px, 478px)`, on top of each other and over two existing cards. Only one is visible.
- Evidence: `shots/canvas/card-tool-stacking.png` (#7 hiding #5 and #6 and covering #11 and #12; the minimap shows the pile).
- Fix: place with `placement.ts`'s free-space search (already used for rules and Expand related), cascading from the last added card. Keep the tool open after adding so you can add several in a row.

**11. The same issue can be added any number of times, silently: Major**

- Pasting `fake.tack/stress/cards#3` twice gave two identical cards at the same coordinates. The card tool and multi-line paste behave the same way. On a planning board, duplicate cards split votes, connectors and section counts.
- Evidence: `shots/canvas/card-selected.png` (stacked duplicate #3 at the top; the shadow is doubled).
- Fix: when the item is already on the board, fly to it and pulse it, with a toast: "#3 is already here · Add another copy". Make copying a deliberate choice.

**12. Clicking a card's title opens GitHub in a new tab, even on the first click: Major**

- The title is an `<a target="_blank">` that fills most of the card's upper half. One click on an unselected card selected it _and_ opened a new tab.
- Why it matters: in a session people click cards to select, drag or vote on them, and get thrown out to GitHub.
- Fix: open the link only on ⌘/Ctrl-click, or on a click when the card is already selected (FigJam's link behaviour). Add a small ↗ button in the card head for the explicit action.

**13. No card details view: Minor**

- Double-clicking a card does nothing. To read an issue's body you leave the board. For a planning discussion ("what does #412 actually say?") a read-only peek would keep everyone on the board.
- Fix: double-click or Space opens a popover with the body rendered as Markdown (`changes/Markdown.tsx` already exists), plus linked PRs and the latest comments, with "Open on GitHub".

**14. Card visuals are excellent; keep them: Keep**

- What works: the loading skeleton (`shots/canvas/card-paste-loading.png`), state pills, the CI bar with failing job names, reviewer avatars, "Closes #…" rows, the compact zoomed-out variant, and every unavailable state with plain-language copy (`shots/canvas/cards-gallery-light.png`, `shots/canvas/cards-gallery-dark.png`).
- Small nit (Polish): reviewer status badges on 14px avatars are hard to read at 100%. Compact cards drop the `#number`, which is how people refer to items out loud ("move #412 to Next"), so keep the number in compact mode.

**15. Unrecognised links silently become stickies: Minor**

- `interpretText` turns anything that isn't a reference into a sticky. A GitHub Discussions link, `www.github.com/...`, or the test forge's own URL shape (`https://fake.tack/stress/cards/issues/3`, which `parseRef` doesn't accept) all become a yellow note with a URL in it, and nothing says why.
- Evidence: `shots/canvas/card-multipaste.png`.
- Fix: when pasted text is a single URL that isn't recognised, still make the sticky, but toast "Added as a sticky: Tack can't show that link as a card". Also accept `fake.tack` URLs, so the test forge behaves like GitHub in demos.

### Stickies

**16. Shrink-to-fit works well, but stickies can't be resized, so long notes are clipped: Minor**

- No resize handles. Very long notes shrink to about 9px text and then fade out.
- Evidence: `shots/canvas/sticky-fit-text.png`, and "More than fits" in the gallery.
- Fix: corner-drag resize for stickies (FigJam supports it), or a "wide" sticky option. Keep shrink-to-fit inside whatever size is chosen.

**17. Colour, typeface and author names: good. One gap: Polish**

- What works: the floating toolbar keeps focus while you're typing; recolouring also sets the colour of the next sticky; author names truncate gracefully.
- Missing: FigJam's "show or hide author" for a whole board. In a retro or brainstorm, facilitators often want notes anonymous. Add it as a board setting in Facilitate.

### Text blocks

**18. Text blocks are fine; sizes S/M/L/XL and two typefaces suffice: Polish**

- Evidence: `shots/canvas/text-selected-toolbar.png`. An empty text block removes itself on Esc (good). An empty sticky stays (FigJam does the same).
- Nit: the size toolbar has no bold, so section headings need XL. Bold, or a "Heading" style, would help the agenda text facilitators put at the top of a board.

### Sections

**19. Placing a section with a click re-parents shapes from other sections and overlaps them: Major**

- With F, clicking at the bottom of the Now/Next/Later board dropped a default-size "Untitled section" across two existing sections. It took the sticky that was in "Next" (Next went from 3 to 2, the new section from 0 to 1). It also partly overlaps "Now", and its title is hidden under a card.
- Evidence: `shots/canvas/sections-overview.png` ("Untitled se…" under the Now column; the sticky now belongs to it).
- Fix: when placing a section by click, look for free space with `placement.ts`, or shrink the default to fit the gap. Never capture shapes that already have a parent section unless the new section is drawn around them.

**20. Section toolbar covers the neighbouring section's title: Minor**

- When a section is selected, its colour swatches plus "Make inbox / Silent mode / Vote" run along the title row and hide "Next" completely.
- Evidence: `shots/canvas/section-selected-toolbar.png`.
- Fix: put the section toolbar above the title row (offset like the shape toolbar), or collapse the three actions behind a "…" when there isn't room.

**21. Drop feedback, drag-to-move and containment are excellent: Keep**

- What works: the target section lifts and glows, snapping guides appear, the count bumps with a "gulp" (`shots/canvas/section-drop-target.png`). Drawing a section around stickies captures them and focuses a "Name this section" title (`shots/canvas/section-new-around.png`). Dragging inside a section draws a marquee, as in FigJam.

**22. Shrinking a section drops its contents with no warning: Minor**

- Dragging the corner inwards past a card un-parents it, and the count drops from 2 to 1. The card is left half outside the tinted area.
- Evidence: `shots/canvas/section-resized-smaller.png`.
- Fix: while resizing, show content that will fall out as dimmed, or stop the resize at the content bounds unless ⌘ is held.

**23. No section display modes: Minor (feature gap)**

- There's no collapse or hide-contents (FigJam's "Hide contents"). On a large planning board, facilitators collapse finished areas to reduce noise and reveal sections one at a time. Silent mode covers the reveal case for stickies only.

### Connectors

**24. Connectors look great. Labels on short connectors are unreadable: Minor**

- What works: curved, elbow and straight routes, dashed lines, both-ends arrows, colours, labels, and loose ends (`shots/canvas/connectors-scenario.png`, `shots/canvas/connectors-scenario-dark.png`). "Blocked by" right on the connector toolbar is the right idea.
- The problem: between two stickies 12px apart, the label pill is squeezed into the gap and covered by the end handles ("b●●●s").
- Evidence: `shots/canvas/connector-label-typed.png`.
- Fix: when the path is shorter than the label, put the label beside the midpoint (offset perpendicular), and hide end handles while the label is being edited.

**25. Connector toolbar can render off-screen: Minor**

- For a connector near the left edge, the toolbar's first buttons (Curved, Elbow) are cut off at x < 0, and it covers the two stickies it connects.
- Evidence: `shots/canvas/connector-selected.png`.
- Fix: clamp node and connector toolbars to the canvas bounds, and prefer placing below when above would overlap the connected shapes.

**26. Connect handles appear on hover only, and not on sections: Polish**

- They're FigJam-like and discoverable. Sections can't be connection sources, though, and a connector into a section is a common way to say "these feed into Next".

### Selection, multi-select, arrange, snapping

**27. Marquee, Shift-click, align/distribute/tidy, the selection count and snapping guides all work: Keep, with fixes below**

- Evidence: `shots/canvas/arrange-multiselect-1440.png` (count badge "7" plus align tools), `shots/canvas/arrange-snap-guides.png` (magenta guides with end ticks, FigJam-grade).
- A five-arrow nudge burst is one undo step (verified).

**28. "Tidy up" moves shapes on top of unselected ones: Minor**

- Tidying a selection of 6 stickies and 1 card put the card squarely over the unselected #412 card.
- Evidence: `shots/canvas/arrange-tidied.png`.
- Fix: anchor the tidied grid at the selection's top-left and slide it clear of unselected shapes (the same `placeCard` slide that Expand related uses).

**29. Floating toolbars aren't kept inside the viewport and overlap content: Minor**

- At 1280×800 the align toolbar is pushed under the top bar (`shots/canvas/arrange-multiselect-1280.png`).
- With a mixed selection, the sticky colour toolbar sits in the middle of the selection, on top of the selected card (`shots/canvas/arrange-multiselect-1440.png`), because it's anchored to the stickies only.
- Fix: clamp all `NodeToolbar`s to the pane. When there's both a shape toolbar and a selection toolbar, anchor both to the full selection bounds (the `stacked` offset is already there).

### Zoom, pan, minimap

**30. People who open an existing board aren't shown its content: Major**

- No fit-to-content on load (no initial `fitView` in `Board.tsx`). Bob and Carol, joining Alice's board at 1280×800, saw it at 100% around the origin. The cards were half off the right edge, two stickies were under the toolbar, and the minimap covered the cards. The 500-card stress board opens at `translate(0,0) scale(1)` too.
- Evidence: `shots/canvas/multi-B-view.png`, `shots/canvas/multi-C-viewer-dark.png`.
- Fix: on first open, fit to content with toolbar-aware padding (capped at 100%). On return visits, restore your last viewport per board from local storage. For the session itself, Spotlight already brings people along. Also mention "Shift+1 to see everything" in the since-you-were-here digest.

**31. Zoom to fit ignores the toolbar and minimap: Minor**

- Fitted content ends up under the bottom dock (`shots/canvas/sections-overview.png`, `shots/canvas/arrange-multiselect-1280.png`).
- Fix: pass padding that accounts for the dock's height and the minimap's width to every `fitView`.

**32. No zoom percentage or zoom menu: Minor**

- The controls are +, −, fit and ?. FigJam shows the current zoom and a menu (zoom to 100%, fit, selection). People ask "what zoom are you at?" when following along.
- Fix: show the zoom % between − and +; clicking it opens a menu of the zoom shortcuts.

### Undo, redo, copy, paste, duplicate

**33. Per-person undo is solid: Keep**

- What works: Bob's ⌘Z after both he and Alice typed into one sticky removed only " BOB" and kept " ALICE". Undo after duplicate removed all 7 copies in one step. Redo works with ⇧⌘Z.
- Paste lands offset when the originals are in view, and under the pointer otherwise.

**34. Deleting one card or empty shapes gives no toast: Polish (keep as is?)**

- By design (`QUIET_DELETE_LIMIT`, words only). Noting it because cards matter more than words in Tack: a card carries connectors, votes and staged changes. Consider counting a card with staged changes or connectors as content.

### Multiplayer, viewers and resilience

**35. Concurrent editing and presence are good: Keep**

- Simultaneous typing in one sticky merged ("…drag ALICE BOB"). Remote cursors carry name labels. The view-only role gets a "View only" pill and a three-tool dock, and every write I tried as a viewer (sticky tool, drag, typing, paste) did nothing, with no errors.
- Evidence: `shots/canvas/multi-B-concurrent-edit.png`, `shots/canvas/multi-C-viewer-dark.png`.

**36. Someone deleting the sticky you're typing in drops your text silently: Minor**

- Bob's in-progress " (B typing)" vanished when Alice deleted the note, with no notice to Bob.
- Evidence: `shots/canvas/multi-B-sticky-deleted-under-them.png`.
- Fix: toast for the editor, "Alice deleted the sticky you were editing · Restore", using the delete's undo on Alice's side or a local re-create.

**37. Unsynced edits are invisible and unprotected: Major**

- The status pill is binary: "Synced" or "Connecting…". With the server down I kept editing (good, offline-first), but there's no count of unsent changes, no `beforeunload` warning, and no local persistence (no IndexedDB provider). When the dev server came back, Vite reloaded the page, and both stickies were gone. One was made before the drop (inside the server's 2 s save debounce), one during it. The reload is a dev artifact, but the same loss happens to anyone who closes or refreshes a tab while disconnected, for example on flaky conference Wi-Fi or mid-deploy.
- Evidence: `shots/canvas/disconnected-editing.png` (editing while "Connecting…"), then `shots/canvas/reconnected.png` (blank board, "Synced").
- Fix: add `y-indexeddb` persistence per board so unsent updates survive a reload. Show "Offline · 3 changes waiting" in amber, and warn on unload while any are pending.

### Shortcut sheet and theme

**38. The shortcut sheet is excellent: Keep, with one nit**

- `?` opens a two-column, searchable sheet that's generated from the same list as the key handling, so it can't drift (`shots/canvas/shortcuts-sheet-dark.png`).
- Nit (Polish): search results collapse into the left column and leave the right half empty (`shots/canvas/shortcuts-search-align.png`). Let results flow across both columns.
- Note: because of finding 1, several entries in the sheet (Shift+1, Space-drag, tool letters) silently don't work whenever one sticky is selected.

**39. Theme toggle: Keep**

- A two-state switch with an honest tooltip ("Light theme (following your system). Switch to dark"). Dark mode is well tuned across cards, stickies, sections and connectors (`shots/canvas/stickies-overview-dark.png`, `shots/canvas/connectors-scenario-dark.png`).
- Nit (Polish): once you toggle, there's no way back to "follow system" from the board. Add it on long-press or in the account menu.

### Performance (stress scenario, 500 cards)

**40. Fine at realistic sizes; heavy multi-selection drags stutter: Minor**

- Measured in headless Chromium (software rendering), so read these as relative rather than absolute numbers. Nodes off-screen are virtualised (24 DOM nodes at load).

  | Action                | Result                              |
  | --------------------- | ----------------------------------- |
  | Pan                   | p50 16.7 ms per frame, about 58 fps |
  | Wheel zoom-out to 0.1 | about 49 fps, one 250 ms hitch      |
  | Select all 500        | one 400 ms frame                    |
  | Drag all 500          | about 240 ms per pointer move       |
  | Undo of that drag     | a 380 ms frame                      |

- A real EmDash board (50–150 shapes) won't hit this.
- At 0.15 zoom, compact cards become unreadable specks (`shots/canvas/stress-fit.png`, `shots/canvas/stress-mid-zoom.png`). Below about 0.25, render cards as blocks in their state colour (open green, merged purple, closed grey) so the board still reads as a heat map.

### Error states and crash fallback

**41. The crash fallback is lovely, but it's the only error boundary: Major**

- "Something came unstuck" has calm copy, Reload, Home and collapsible details (`shots/canvas/crash-fallback-dark.png`).
- The problem: `ErrorBoundary` wraps the whole app (`main.tsx`) and nothing else. One shape that throws while rendering (a widget with unexpected data, a malformed card from a forge, a bad connector end) takes down the board for every viewer who has it on screen, and Reload brings them straight back to the crash.
- Fix: wrap each node type (and the connector layer and each panel) in a small boundary that renders "This shape couldn't be shown · Delete" and reports via `errors.ts`.

**42. Board not found and card unavailable states are good: Keep**

- "This board isn't here" has a way home. Missing, private and unreachable cards each say why in plain words (`shots/canvas/card-missing-states.png`, gallery).

---

## Top 5 to fix before the EmDash session

1. **Stop selected stickies from swallowing shortcuts (1).** Bound keys and Space must always win over type-to-edit, and Esc after writing a new sticky should leave the tool letters working. Otherwise every Shift+1 or Space-pan risks writing into someone else's note.
2. **Make adding issues work at session speed (9, 10, 11).** Search in the card tool, place each new card in free space instead of the viewport centre, and flag duplicates.
3. **Stop card titles opening GitHub on a plain click (12).** Use ⌘-click or a ↗ button, so selecting and dragging cards never sends people to a new tab.
4. **Fit to content when someone opens a board (30),** with toolbar-aware padding for every fit (31). Eight people joining should all see the board, not the origin.
5. **Protect against single-shape crashes and silent data loss (41, 37).** Per-node error boundaries, local persistence of unsent changes, and an honest "Offline · N waiting" status with an unload warning.

Close behind: click-placed sections capturing shapes from other sections (19), and Tidy up overlapping unselected shapes (28). Both are quick to hit while rearranging a board live.
