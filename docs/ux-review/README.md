# Usability review, 10 October 2026

Five reviewers each took a critical look at one area of Tack, driving it like a person would (Playwright, light and dark, 1280 and 1440 wide, several people at once), against the bar of FigJam and an eight-person planning session with the EmDash team. Screenshots are kept locally in `shots/` (not committed: about 90 MB).

| Area | Report |
| --- | --- |
| The canvas: tools, cards, stickies, sections, connectors, selection, zoom | [canvas.md](canvas.md) |
| Writing back to GitHub: actions, staging, the push sheet, decisions | [writeback.md](writeback.md) |
| Widgets, inbox frames, rules, provenance, expand related | [automation.md](automation.md) |
| Collaboration and facilitation: presence, timer, silent mode, votes, comments, since, history | [collaboration.md](collaboration.md) |
| Boards, sharing, the top bar, setup, sign-in, small screens, accessibility | [boards-and-setup.md](boards-and-setup.md) |

## Blockers for the EmDash session

- **Selected stickies swallow shortcuts** (canvas 1): Shift+1, Space and tool letters type into the selected sticky.
- **Edited stickies push their old text** (writeback 1.1): a staged issue doesn't follow later edits to its sticky.
- **Deleted stickies still become issues** (writeback 1.2).
- **Anyone can close or delete a vote, or stop the timer** (collaboration: dot voting, timer).

## Majors, by theme

- **Getting issues onto the board fast:** search in the card tool, free-space placement, duplicate detection; card titles shouldn't open GitHub on a plain click; fit to content when a board opens.
- **Trust:** per-shape error boundaries, offline persistence with an honest status and unload warning; plain-language forge errors; provenance footer on created issues.
- **Scale:** cards overlap after a batch of stickies becomes cards; the Changes panel and push sheet at 30+ items.
- **Facilitation:** who may reveal; start silent mode from Facilitate; distinct presence colours; a clickable list of everyone; everyone sees vote results.
- **Widgets and automation:** panels off-screen at 1280 wide; non-experts can't write searches; inbox trays cover neighbours; @me means different things to different people; rules firing mid-discussion.
- **Around the board:** checking the app is installed on every repo before the session; the invitee arrival path; a crowded top bar; ambiguous access settings; search that only covers one tab.
