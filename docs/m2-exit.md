# M2 exit: one session against real GitHub

The M2 exit (#36) is one planning session that produces issues, labels, a merged ADR and backlinks, with nothing copied by hand. It's automated twice: `test/m2-exit.test.ts` runs the session through the real GitHub adapter against the fake GitHub, and `e2e/m2-exit.spec.ts` runs it through the UI on the dev server, on the fake forge. This is the same session by hand, on a real instance against a real test repository. It takes about fifteen minutes.

## Before you start

- **A test repository** you can push to, public (so its cards and snapshots can be shown to anyone), with:
  - one open issue to triage (the "seed" issue)
  - labels `bug` and `performance`, and an open milestone `v1`
  - ideally an existing record, `docs/decisions/0001-record-architecture-decisions.md`, on the default branch, to check numbering. Without one the ADR is 0001.
- **The app's permissions.** In the GitHub App's settings (Developer settings → GitHub Apps → "Tack (…)" → Permissions & events), Repository permissions must include **Contents: Read and write** (for the ADR's branch and commit), **Issues: Read and write**, **Pull requests: Read and write** and **Metadata: Read**, and the subscribed events must include **Issues** and **Pull request**. Apps created before M2 only asked for read access to contents, so raise it there.
- **The new permissions accepted on the installation.** Raising a permission sends every installation a request. On the account that installed the app: Settings → Applications → Installed GitHub Apps → "Tack (…)" → Configure, then **Review request** → **Accept new permissions**. Until then the ADR write-back fails with "Tack isn't allowed to write the files…".
- **The app installed on the test repository** (on the same Configure page: Repository access → add it). On a board, its cards show live, with no "Install the app" prompt.
- **Signed in to Tack with GitHub** (the account menu shows your login), as someone with push access to the repository. Dev sign-in can't push to GitHub.

## The session

1. On the home page, create a board, and call it "M2 exit" and the date.
2. Paste the seed issue's URL onto the board: it becomes a card.
3. Make a section (`F`, drag) titled "Resizing", and put two stickies (`S`) in it: "Wobble on resize", with a second line "Happens in Safari when the window narrows", and "Snap back after a drag".
4. Below it, two more stickies, "Faster cold starts" and "Cache the manifest", and a connector (`X`) from the first to the second.
5. Add a decision (`D`): "Store boards as Yjs documents", with a line of context. Connect it to the seed card, and vote Agree.

Stage everything (nothing reaches GitHub yet):

6. Select the two loose stickies, then **Make 2 issues** (⌥I). The test repository is chosen; **Stage 2 issues**.
7. Click the section's title, then **Parent issue** (⌥⇧I). The title is "Resizing"; **Stage with 2 sub-issues**.
8. Click the connector, then **Blocked by** (⌥B). It reads "Cache the manifest will be marked as blocked by Faster cold starts"; **Stage**.
9. Select the seed card: **Labels** (⌥L), add `bug`, **Stage**; **Milestone** (⌥M), `v1`; **Assign** (⌥P), yourself.
10. On the decision, **Decide**, then **Write back**. Keep "ADR pull request", check the path is `docs/decisions/0002-store-boards-as-yjs-documents.md` (one more than the highest record in the repository), type a line of Consequences, and **Stage write-back**.

Push:

11. **Changes** → **Review and push 12**. Check the previews (issue bodies, the ADR's file, and who'll be notified), keep **Push as: You**, and **Push 12 changes**. Wait for "All 12 changes are on GitHub". The four stickies become their issues' cards in place, the connector joins two of them, and the decision shows its pull request, "ADR 0002", as Open.
12. Select the four new cards: **Labels**, add `performance`, **Stage**.
13. Select all five cards (the seed and the four new ones), then **Comment with a link to this board** (⌥K). Wait for the snapshot preview, then **Stage 5 comments**.
14. **Changes** → **Review and push 9** → **Push 9 changes**, and wait for them all to land.
15. On GitHub, merge the ADR pull request. Within a few seconds the decision's record shows **Merged**, with no one touching the board.
16. **Changes** → **History**: both pushes, by you, every change applied, each linking to what it wrote.

## What to check on GitHub

- **Issues**: five new issues, each exactly once: "Faster cold starts", "Cache the manifest", "Resizing", "Wobble on resize" (with the second line as its body) and "Snap back after a drag".
- **Labels**: the seed issue has `bug`, milestone `v1`, and you as assignee. The four issues from stickies have `performance`.
- **Sub-issues**: "Resizing" lists "Wobble on resize" and "Snap back after a drag" as sub-issues, and each shows "Resizing" as its parent.
- **Blocked-by**: "Cache the manifest" shows it's blocked by "Faster cold starts" under Relationships, and "Faster cold starts" that it's blocking.
- **The ADR**: a pull request "ADR 0002: Store boards as Yjs documents" from `tack/adr-0002-store-boards-as-yjs-documents`, with one commit adding exactly `docs/decisions/0002-store-boards-as-yjs-documents.md`. The record starts `# 2. Store boards as Yjs documents`, its Status is "Accepted on" the day you decided it, with the votes, and its Links list the seed issue and the board. It's merged, and the file is on the default branch.
- **Backlinks**: each of the five issues has one comment: "This is on **M2 exit…** in Tack.", linking to the board, with the snapshot image **rendering** (not a broken image: GitHub fetches it through its image proxy from the instance's `/snapshots/….png`). Clicking the image opens the board.
- **Attribution**: the issues, comments and pull request are yours, with the app's name beside them ("via Tack (…)"), not by the app's bot.
- **Nothing twice**: no duplicate issues, comments or links anywhere. Reloading the board brings nothing back to the staged list.

## If something goes wrong

- "Tack isn't allowed to …": the new permissions aren't accepted on the installation, or the app doesn't have them.
- "Tack's GitHub App isn't installed on …": install it on the repository.
- "You can't write to …": your GitHub account lacks push access.
- A change says "Waiting for GitHub" for two minutes, then fails with "GitHub accepted this, but … didn't show it": webhooks aren't arriving. Check the app's Advanced → Recent deliveries.
- A broken image in a comment: the instance's `/snapshots/` URL isn't reachable from the internet.
- The server's side of it: filter Workers Logs on `event` starting with `push.` (see AGENTS.md, Observability).

## Known gap

The parent issue a section becomes isn't placed on the board as a card (only stickies are replaced by theirs), so from the UI it can't be backlinked without pasting its link onto the board by hand. The automated test backlinks it by key. Note in the results whether that hurt.

## Results

Write down the date, the instance and repository, links to the two pushes' issues and the ADR, and anything that hurt, in #36.
