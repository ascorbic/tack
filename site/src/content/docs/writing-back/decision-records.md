---
title: Decision records
description: Writing a decision back as an ADR pull request or a Discussion post.
sidebar:
  order: 4
---

A [decision](/boards/decisions/) that's been decided can be written back to GitHub. Choose **Write back** on it.

## The dialog

- **Write it as**: **ADR pull request** ("Adds record 0002 for review"), or **Discussion post** ("Announces it for comment"; off if the repository has Discussions turned off).
- **Repository**: the repositories of the decision's linked cards come first.
- **Context**, **Decision** and **Consequences**: start from the decision's body and title. A preview of the record sits beside them.
- For a Discussion, the **Category**: one called something like "Decisions", "ADR" or "RFC" if there is one, then "Announcements", then "General".

**Stage write-back** stages it with the board's other changes. The decision shows "ADR 0002 · Staged", then "Pushing…" and "Confirming…" while it's pushed.

## ADR pull requests

The record is a Markdown file in the repository's `docs/decisions/` directory, in the layout adr-tools uses:

- **Path**: `docs/decisions/NNNN-title-in-words.md`, numbered one more than the highest record already in `docs/decisions` on the default branch. Records staged on the same board count too, so two decisions pushed together don't collide.
- **Branch**: `tack/adr-NNNN-title-in-words`, from the default branch, with one commit adding that one file.
- **Pull request**: "ADR NNNN: Title", saying which board it was decided on, and listing the linked items.

The record itself:

```markdown
# 2. Store boards as Yjs documents

Date: 2026-10-08

## Status

Accepted on 2026-10-08 (4 agree, 1 disagree)

## Context

…

## Decision

…

## Consequences

…

## Links

- [acme/app#412: Drop Node 18 support](https://github.com/acme/app/issues/412)
- Decided on [the Tack board](https://tack.example.com/b/…)
```

Once it's pushed, the decision shows the pull request live, like a card: **Open**, then **Merged** when someone merges it on GitHub, with CI along the bottom.

Writing an ADR needs the app's **Contents: Read and write** permission. Apps set up before Tack could write files only have read access: see [Upgrading](/self-hosting/upgrades/#when-tack-needs-new-permissions).

## Discussion posts

The post is titled "Decision: Title", with the same record as its body. Once pushed, the decision links to it: "Posted to Discussions".

## If it fails

The decision shows **Write-back failed**, with **Retry**, which opens the dialog again. Reopening a decision as proposed unstages a write-back that hasn't been pushed.
