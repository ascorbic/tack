# UX review: collaboration and facilitation

Reviewed 10 October 2026 against a dev server (fake forge, dev sign-in) on port 5224. I drove it with Playwright: real boards with 2, 3 and 8 signed-in people in separate browser contexts (1440×900 and 1280×800, light and dark), a signed-in viewer, plus `/play?scenario=retro|silent|vote|comments|since|history` and the `/play/facilitation`, `/play/comments` and `/play/history` galleries. Screenshots are in `shots/collaboration/`. The Playwright scripts are in the review worktree under `uxr/`.

## Verdict

The individual pieces are mostly good, and some are excellent. The silent-mode reveal wave, high-fives, the emote wheel, spotlight with break-out and rejoin, and History's "Bring back" all feel at least as good as FigJam. Where it falls short is running a room. Every facilitation control is open to every editor: anyone can close or delete the vote, stop the timer or end someone else's session, and participants see a Reveal button the server then refuses. Two features don't hold up past about four people: colours (only 7, hashed, so they collide) and the avatar strip (only 5 are clickable). The results of a vote are never shown to the room. Several features (silent mode, section votes) can only be started by selecting a section, which you'd only find if someone told you. For an 8-person EmDash session I'd fix the permission and visibility problems below first, rehearse the flow once, and not rely on "since you were here" rings for latecomers.

## Findings by feature

### Presence (avatars, colours, cursors)

**Major: people's colours collide, even in small groups.** `COLORS` in `src/client/presence.ts` has 7 entries and `personColor` in `src/client/auth/me.ts` picks one by hashing the user id. With 8 people, at least two must share a colour, and in practice it happens with 3. In my session Kai, Tom and Ben were all the same magenta, so their cursors, sticky author dots, silent-mode face-down backs and vote dots looked identical. Several palette entries are also close to each other (`#b4467a` and `#c2372b`; `#3b4cca`, `#7444c4` and `#2a7ab0`). The colour also sets the spotlight frame, so a red user's spotlight reads as an alarm.
Evidence: `shots/collaboration/spotlight-late-joiner.png`, `shots/collaboration/presence-7-people.png`.
Fix: assign colours per board from who's present: take the least-used colour among connected people, and keep a person's colour for the board so it's stable. Widen the palette to about 12 hues that are clearly distinct in both themes, and keep the frame and pill of facilitation chrome (spotlight) in an accent colour, using the person's colour only as an accent within it.

**Major: only 5 people are clickable; the rest collapse into a "+N" you can't use.** `MAX_SHOWN = 5` in `src/client/People.tsx`. In an 8-person session, "+2" is a plain `<span>` with a tooltip, so you can't follow or find those people.
Evidence: `shots/collaboration/presence-overflow-tooltip.png`, `shots/collaboration/presence-7-people-topbar.png`.
Fix: make "+N" a button that opens a list of everyone present (name, status, a "following you" marker, Follow and "Jump to"). Show up to about 8 avatars before collapsing, since the bar has room at 1440.

**Minor: avatars overlap so much that most faces are half hidden.** At 7 or more people each avatar shows about 60% of itself, and initials like "TO" and "JR" become hard to read (`shots/collaboration/presence-7-people-topbar.png`). Reduce the overlap, or expand the stack on hover as FigJam does.

**Minor: being followed is barely signalled.** The leader only gets a 10px eye badge on the follower's avatar (`shots/collaboration/follow-priya-being-followed.png`). FigJam shows a "N people following you" chip. Add a small pill when at least one person follows you. The text already exists in the avatar label (`selfLabel` in `People.tsx`).

**Polish: dev logins fetch `github.com/<login>.png`.** Fine in production, but some reviewers in dev will see real strangers' faces. Not a session risk.

### Cursor chat

**Minor: it can't be discovered.** The only ways in are `/` and a line in the shortcut sheet. There's no toolbar button or hint, so a first-time participant won't find it. Add "Chat at your cursor (/)" to the Facilitate menu's Stamps and emotes row and to the empty-state hint.
What works and should be kept: the live typing bubble, the author's name over others' bubbles, the 4-second linger after Enter and the fade (`shots/collaboration/cursorchat-seen-by-other.png`, `shots/collaboration/cursorchat-after-enter.png`, `shots/collaboration/cursorchat-after-6s.png`).

### Follow

What works and should be kept: clicking an avatar to follow, the coloured frame with a "Following X · Stop" pill, close tracking while the leader pans, and Escape to stop (`shots/collaboration/follow-matt-following-priya.png`, `shots/collaboration/follow-after-leader-pans.png`). Following fits the leader's view to the follower's window, so different window sizes (1280 leader, 1440 follower) work.

**Polish:** the avatar tooltip ("Priya Shah / Stop following") stays on screen over the Following pill after clicking (`shots/collaboration/follow-matt-following-priya.png`). Hide the tooltip on click.

### Spotlight

What works and should be kept: everyone is pulled along at once, a latecomer arriving mid-spotlight is brought along automatically (`shots/collaboration/spotlight-late-joiner.png`), and "Break out" / "Rejoin" works (`shots/collaboration/spotlight-broke-out.png`). The leader's pill shows a live count ("6 with you", `shots/collaboration/spotlight-mine.png`), and followers stay where they were when it ends (`shots/collaboration/spotlight-ended-follower.png`).

**Major: anyone can spotlight, and there's no way to take it over or end someone else's.** Any editor can press "Spotlight me" while nobody else is spotlighting. While one is running, the button just says "X is spotlighting" and is disabled, so the facilitator can't end it if X has wandered off. With 8 people, someone will try it.
Fix: let the board owner and whoever is running the session take over ("Spotlight me instead") or end another person's spotlight. Optionally, let the facilitator restrict spotlighting to themselves.

**Minor: the spotlight pill covers the open Facilitate menu.** It sits above the menu, so the "Timer" heading is hidden (`shots/collaboration/facilitate-menu-while-spotlighting.png`). Put menus above the canvas pills in z-order.

**Minor: there's no "everyone, look here" without moving people.** Spotlight is the only way to get attention, and it takes over everyone's view. Add a lighter option, such as a wave ("Matt is calling everyone": a toast with a "Go there" button), or a "Bring everyone here" that moves people once without making them follow.

### Timer

What works and should be kept: it counts down against the server's clock, the ring shows progress, the last 10 seconds tick in amber, "Time's up" glows with a chime, there are pause / +1 / stop controls on hover, and it's readable at 1280 (`shots/collaboration/timer-running-participant.png`, `shots/collaboration/timer-final-seconds.png`, `shots/collaboration/timer-done-participant.png`, `shots/collaboration/timer-hover-controls.png`).

**Major: every editor can pause, extend or stop the facilitator's timer.** The controls appear on hover for everyone (`canControl={!readOnly}` in `Timer.tsx`; `shots/collaboration/timer-done-participant.png` shows +1 and ✕ to a participant). One participant clicking ✕ by accident ends the timebox for the whole room, and nobody is told who did it.
Fix: give the controls only to whoever started the timer and the board owner, and show the others a read-only pill. If it stays open to all, show a toast saying who paused or stopped it ("Kai stopped the timer"), and make stopping undoable for a few seconds.

**Minor: the timer has no label.** "0:59 · Matt Kane" doesn't say what it's timing. Add an optional label in the starter ("Silent brainstorm, 5 min"), shown in the pill and in History. History currently records it as "Timer set the timer", which is awkward copy (`src/shared/history.ts:992`; seen in the activity list of `shots/collaboration/history-real-1-open.png`). Make that "Matt Kane started a 5-minute timer".

**Minor: the timer can't be linked to the activity.** Starting silent mode or a vote can't start a timer, and a vote can't close when the timer ends. See Facilitation gaps below.

**Polish: "Time's up" stays for 2 minutes for everyone** (`TIMER_LINGER_MS`). That's fine for latecomers, but it piles up at the top with the vote bar. Collapse it to a small "Time's up" chip after 20 seconds.

### Stamps

What works and should be kept: M opens a stamp tray with a clear hint ("Click shapes to stamp them; again to take it off"). Stamps show counts, hovering lists who stamped, and your own are highlighted (`shots/collaboration/stamp-tool-on.png`, `shots/collaboration/stamp-hover-who.png`).

**Minor: stamps sit on the shape's bottom-left edge, so in a tight grid they overlap the next card's header** (`shots/collaboration/stamp-hover-who.png`, `shots/collaboration/vote-2-started-participant.png`). Inset them inside the bottom edge, or move them to the bottom-right, inside the shape.

**Minor: clicking a card's title with the stamp tool focuses the title link** and leaves a blue focus ring (`shots/collaboration/stamp-different-emoji.png`). Stop the stamp tool from focusing links.

**Minor: number keys don't pick a stamp** while the stamp tool is on (I pressed 2 and nothing changed). The emote wheel uses 1–8, so do the same for stamps.

### Emotes and high-fives

These are excellent and should be kept as they are: E opens a radial wheel with number badges (`shots/collaboration/emote-wheel.png`), emotes float up for everyone (`shots/collaboration/emote-seen-by-other.png`), and high-fives detect two raised hands meeting and show a 🙌 burst with both names for both people (`shots/collaboration/highfive-celebration.png`, `shots/collaboration/highfive-celebration-other.png`). Viewers can emote too (`shots/collaboration/viewer-4-emote-wheel.png`), which is right.

**Polish:** the hand stays up for 6 seconds without showing time remaining. Fade the raised ✋ slightly in the last 2 seconds.

### Silent mode

What works and should be kept: the face-down sticky design (a hatched back with the author's avatar), the per-author counts in the section header, the server-enforced secrecy, the refusal toast, and the reveal wave, which is the best moment in the app (`shots/collaboration/silent-3-facilitator-facedown.png`, `shots/collaboration/silent-5-revealing-midwave.png`, `shots/collaboration/silent-6-revealed-participant.png`). The author's own view ("only you can see it" eye-slash icon) is clear (`shots/collaboration/silent-3b-author-deselected.png`).

**Major: participants see a Reveal button they can't use.** `SilentBadge` passes `canReveal={!readOnly}`, so every editor sees "Reveal 3". Clicking it gives "Only whoever started silent mode, or the board's owner, can reveal it while they're here" (`shots/collaboration/silent-4-participant-reveal-refused.png`). In a live session someone will click it. Mid-brainstorm they're told no, and they may think they broke something.
Fix: show Reveal only to the people who may reveal. That's who started it and the owner, plus any editor once the facilitator has left, which the server already knows; send it with the session mark. Everyone else gets "Matt will reveal".

**Major: silent mode can only be started by selecting a section on its own.** The Facilitate menu only describes how ("Select a section and choose Silent mode…"); it has no button (`shots/collaboration/facilitate-menu-open.png`). The header buttons appear only once the section is selected (`shots/collaboration/silent-1-section-selected.png`). On a board without sections, there's no silent mode at all.
Fix: put a "Start silent mode…" button in the Facilitate menu. It should pick the selected section, or ask you to click one (with section outlines highlighted), or offer to make a new section in the current view.

**Minor: you can't end silent mode except by revealing, and the reveal can't be undone.** If a facilitator starts it on the wrong section, they have to reveal whatever has been written. Add "Cancel silent mode" (reveal nothing: keep each sticky private to its author, or return them to their authors as ordinary stickies), and confirm a reveal while anyone's sticky is still being edited.

**Minor: the author's selection toolbar covers the section header.** After writing a sticky, its colour bar and "Make issue" sit over the "Silent · PS 2 · Reveal" header (`shots/collaboration/silent-3-author-view.png`), and the selection-actions toolbar blocked the Reveal button (Playwright couldn't click it until I deselected). Place the sticky toolbar below the sticky when it would overlap the section header.

**Minor: "Make issue" is offered on a face-down sticky, then says "Make 0 issues … 1 empty sticky left out"** (`shots/collaboration/silent-leak-2-make-issue-popover.png`). The text isn't in the document, so it doesn't leak (good; I checked another person's document for the secret text), but the copy is wrong and confusing. Hide issue actions on silent stickies, or disable them with "Reveal first to make an issue".

**Minor: the start toast doesn't tell people what to do.** "Matt Kane put 'Brainstorm: what hurts?' in silent mode: your stickies there are yours alone until the reveal" (`shots/collaboration/silent-2-started-participant.png`). Add the action: "…Add stickies there; only you can read yours until Matt reveals them." Also add a "Go there" button, because people who are elsewhere on the board don't know where the section is.

**Polish:** the toast is also shown to everyone who opens the board while a session is running (`shots/collaboration/viewer-2-facilitate-menu.png`). That helps latecomers, so keep it, but give it the "Go there" button too.

### Dot voting

What works and should be kept: the start dialog (dots stepper, closing presets, hidden results, counting 👍 on GitHub) is clear (`shots/collaboration/vote-1-start-dialog.png`). The vote bar shows your dots left, "Place dots" outlines the shapes you can vote on (`shots/collaboration/vote-4-dots-placed.png`), "No dots left: click one of yours to move it" is a nice touch, and Results ranks rows with voters' avatars (`shots/collaboration/vote-7-results-open.png`). It works well in dark mode (`shots/collaboration/vote-6-dark-dots.png`).

**Blocker: any participant can close, or delete, the facilitator's vote.** "Close vote" is in every editor's vote bar (`shots/collaboration/vote-2-started-participant.png`), and the Results panel offers "Close vote" and a red "Delete vote" to everyone (`shots/collaboration/vote-7-results-open.png`). `closeVote` and `deleteVote` in `src/shared/dotvotes.ts` are plain document writes with no check. With 8 people, an accidental "Close vote" in the middle of voting is likely, and a delete loses the ballots for the whole room.
Fix: show Close and Delete only to whoever started the vote and the board owner, and have the server put right writes from anyone else, as `SilentHub.reconcile` does for silent marks. Ask for confirmation on Delete.

**Major: closing a vote doesn't show anyone the result.** When the facilitator closes it, the dots vanish from every shape and participants see "Vote closed: 'Now' · 2 people voted · Results" (`shots/collaboration/vote-8-closed-participant.png`). The outcome is one click away for each person, and the canvas shows nothing.
Fix: when a vote closes, open the Results panel for everyone (they can dismiss it). Leave a small rank and total badge on each voted shape until the vote is put away. Add "Sort the section by votes" and "Spotlight results" for the facilitator.

**Major: votes on a section can only be started from a selected section** (the same hidden header row as silent mode; `shots/collaboration/silent-1-section-selected.png`). The Facilitate menu offers only "Vote on the board…". Let the menu's vote button pick a section, as proposed for silent mode.

**Minor: counting 👍 on GitHub is on by default.** For an in-room prioritisation, it lets old, popular issues outrank what the room voted for. The Results header says "👍 on GitHub count", but the rows don't show the split clearly. Default it to off for votes on a section during a live session, or show "12 dots + 7 👍" per row.

**Minor: "Hide results until it closes" is only hidden in the interface.** The ballots are in the shared document (`dotVotesMap`), so anyone with devtools can read them, and History records who voted when ("… voted" four times in `shots/collaboration/history-real-1-open.png`). That's inconsistent with silent mode, which the server enforces, and the copy ("so nobody follows the crowd") implies the same guarantee. Either word it as "Others' dots aren't shown", or keep hidden ballots on the server the way silent text is kept.

**Minor: the dots hint and the "no dots left" toast stack on each other** above the toolbar (`shots/collaboration/vote-5-out-of-dots.png`). Swap the hint's text for the message rather than stacking a second pill.

**Polish: two vote bars stack at the top** (open and recently closed; `shots/collaboration/play-vote-1280.png`), along with the spotlight and timer pills. With all of them, the top of the board is crowded and covers section headers (`shots/collaboration/viewer-5-comment.png`). Merge closed votes into a single "Results" chip.

### Comments

What works and should be kept: press B and click anything to comment, with a hint pill. @-mention autocomplete shows name and login. Pins are the commenter's avatar. Replies arrive live in an open thread. Resolve comes with an Undo toast. The panel has Open, Resolved and Mentions tabs. Clicking a notification pans to the thread and opens it, even from far away (`shots/collaboration/comments-3-mention-suggest.png`, `shots/collaboration/comments-9-facilitator-sees-reply.png`, `shots/collaboration/comments-13-after-notification-click.png`, `shots/collaboration/comments-14-resolved-toast.png`). Viewers can comment (`shots/collaboration/viewer-5-comment.png`).

**Minor: mentions show the login, not the name** ("@priya-tackux", `shots/collaboration/comments-8-thread-open.png`). On a GitHub-native tool logins are fine to type, but for reading, show the name with the login on hover.

**Minor: a mention during a live session only adds a badge to the bell.** Nothing on the board itself tells Priya that Matt just mentioned her (`shots/collaboration/comments-11-bell-while-away.png`). Show a short toast ("Matt mentioned you · View") when you're on the board.

**Minor: the bell count and Comments count are easy to confuse.** With two mentions, the bell said 1 and "Comments" said 1 (one had already been opened from its pin; `shots/collaboration/comments-12-notifications-two.png`). Explain both counts in their tooltips (unread mentions vs open threads).

**Polish: the Comments panel and the Facilitate menu are translucent,** so card text and cursor labels show through behind their text (`shots/collaboration/comments-10-panel.png`, `shots/collaboration/facilitate-menu-open.png`). Raise the panel background's opacity to at least 96%, or blur more strongly.

**Polish:** the thread popover header just says "Comment". Say what it's on ("Comment on #1 Synthetic card 1…"), as the panel does.

### Notifications bell

It works (`shots/collaboration/comments-7-notifications-open.png`), and "Mark all read" is there. The badge sits on the bell's corner and is easy to miss at 1280 next to Share. See the live-toast suggestion above.

### Since you were here

What works and should be kept: the digest opens on arrival with grouped "On the board / On GitHub / Pushed / Comments" sections, "1 mention of you" is highlighted, and the "N on the board" stepper pans to each change (`shots/collaboration/since-1-arrival.png`, `shots/collaboration/since-4-stepper-next-1280.png`). The rings with labels ("Changed · Merry Puffin", "Moved · Quiet Wren") are clear (`shots/collaboration/since-3-rings-early-1280.png`).

**Major: the rings fade before you've looked at them.** A highlight counts as seen after 1.8 seconds in the viewport (`SEEN_AFTER_MS` in `src/client/since/Highlights.tsx`), including while the digest panel covers it. On arrival at 1280 the panel takes the left 380px, and within about 3.5 seconds the count dropped from "New 9" to "New 4" and every ring on screen had faded, including ones under the panel (`shots/collaboration/since-3-rings-early-1280.png`, then `shots/collaboration/since-3b-rings-later-1280.png`). A latecomer reading the digest misses the rings.
Fix: don't count anything as seen while the digest is open, or only count shapes in the visible area outside the panel. Require the person to have moved the pointer or panned at least once. Raise the time to 4–5 seconds.

**Minor: the stepper centres changes in the whole window, not the visible part,** so cards land half behind the panel (`shots/collaboration/since-4-stepper-next-1280.png`, with #412 behind the panel). Offset by the panel's width.

**Minor: the button shows "New 9" while the stepper says "8 on the board"** (`shots/collaboration/since-1-arrival.png`). Explain the difference or count the same things.

**Polish: "#412 closed" uses a grey dot as its icon,** while merged and CI failing have proper glyphs (`shots/collaboration/since-1-arrival.png`). Use the closed-issue icon.

**For EmDash:** this is for async catch-up, not live sessions. A latecomer joining 10 minutes in gets nothing, because the visit gap is longer than that. See "Late joiners" below.

### History

What works and should be kept: the History button, the activity list grouped by day with avatars, the dock with play / step / speed and a coloured tick timeline, the "Whole board / A section" toggle, and the one-click "Bring back" from the list. Bringing back returns to the live board, pans to the restored sticky, selects it and offers Undo (`shots/collaboration/history-real-1-open.png`, `shots/collaboration/history-real-3-step-back2.png`, `shots/collaboration/history-real-5-brought-back.png`). The arrow keys step through history.

**Minor: facilitation floods the activity list.** After a 10-minute session: "Matt Kane voted" twice, "Kai Andersen voted", "Priya Shah voted", "Priya Shah stamped", "Matt Kane stamped" and "Timer set the timer" (`shots/collaboration/history-real-1-open.png`). A 60-minute session will bury the structural edits. Group them ("4 people voted on 'Now'"), and add a filter for edits only vs everything.

**Minor: the panel covers the right third of the canvas, so you can't click shapes behind it to bring them back** (`shots/collaboration/history-real-3-step-back2.png`: the deleted sticky was behind the panel, and the click was blocked). Make the panel collapsible, or pan the board to stay clear of it while scrubbing.

**Polish:** "History starts here · The board as it was" at the bottom of the list is good. The dock covers the bottom 130px, where the zoom controls also are; fine at 1440, tight at 1280.

### Facilitate menu

**Major: half of the menu is instructions, not actions.** Timer and Spotlight have buttons. "Dot vote" has a button for the whole board only. "Silent mode" and "Stamps and emotes" are paragraphs of instructions (`shots/collaboration/facilitate-menu-open.png`). For viewers it shows "M stamps shapes", which they can't do (`shots/collaboration/viewer-2-facilitate-menu.png`).
Fix: make each row an action. Silent mode: "Start on a section…". Vote: "On a section…" or "On the board…". Stamps: open the stamp tray. Emotes: open the wheel. Add a "Running now" section at the top listing the active timer, vote, silent sessions and spotlight, each with its controls, so the facilitator has one place to manage the session. Hide the stamp row for viewers.

**Minor: z-order.** The vote bar draws over the open menu (`shots/collaboration/viewer-2-facilitate-menu.png`), and so does the spotlight pill (`shots/collaboration/facilitate-menu-while-spotlighting.png`).

**Minor: keyboard.** The menu has no shortcut. Escape closes it but drops focus to `<body>` instead of returning it to the Facilitate button (checked with `document.activeElement`). The shortcut sheet lists cursor chat, follow and emotes, but not the timer, spotlight, silent mode or voting (`shots/collaboration/keys-shortcut-sheet.png`). Return focus on close, add shortcuts (for example ⇧T for the timer and ⇧S to spotlight), and list them in the sheet.

### Viewers

Viewers get a cut-down toolbar (select, hand, comment), a "View only" pill, can emote and comment, and are brought along by spotlight (`shots/collaboration/viewer-1-arrival.png`, `shots/collaboration/viewer-3-spotlight.png`, `shots/collaboration/viewer-5-comment.png`). That's the right set. Remove the stamp copy from their Facilitate menu (above).

## Facilitation gaps for a 60-minute, 8-person session

These are missing features rather than defects, but you'll feel them in the EmDash session.

- **No agenda or flow.** Nothing ties the timer, silent mode and vote together. A facilitator will juggle three separate controls in three places (the Facilitate menu, a selected section's header, and the pills on the canvas). Lightweight fix: a "Running now" area in the Facilitate menu (above). Larger fix: agenda items on the board (title, minutes, section), where "Start" begins the timer, spotlights the section and optionally starts silent mode or a vote.
- **No attention-getter except spotlight.** See the spotlight finding: a "Call everyone" wave, or "Bring everyone here once".
- **No facilitator role.** Everything is open to every editor (timer, votes, spotlight), and silent mode is the only feature with a notion of who's running it. One "facilitator" per board session (whoever starts something, with the owner able to take over) would fix four of the findings above.
- **Late joiners.** They do get the spotlight, the timer and the silent-mode toast, which is good. They don't get "what's happening now": an open vote is a bar they might not notice, and "since you were here" doesn't fire for a 10-minute absence. Show a one-time "Session in progress: timer 3:12 left, voting on 'Now', 'Brainstorm' is silent" card on join.
- **Small laptops (1280×800).** Everything fits, but the top of the canvas collects the spotlight pill, timer pill and vote bars, covering section headers (`shots/collaboration/viewer-5-comment.png`, `shots/collaboration/timer-running-participant.png`). Stack them into one compact "session bar".

## Top 5 to fix before the EmDash session

1. **Restrict closing and deleting votes, and the timer's controls, to whoever started them and the owner,** with the server enforcing it, a confirmation for Delete vote, and a toast saying who paused or stopped the timer. (Dot voting Blocker, Timer Major.)
2. **Show Reveal only to the people who may reveal,** and put a "Start silent mode…" action in the Facilitate menu. (Silent mode, two Majors.)
3. **Assign presence colours per board so people who are present never share one,** from a wider palette. (Presence Major.)
4. **Make "+N" in the avatar strip a clickable list of everyone** (follow or jump to them), and show about 8 avatars before collapsing. (Presence Major.)
5. **When a vote closes, show everyone the results** and leave rank badges on the shapes. (Dot voting Major.)

Close runners-up: since-you-were-here rings fading under the digest panel, and turning the Facilitate menu's instruction rows into actions.
