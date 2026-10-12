---
title: Embeds and link previews
description: Live images of a public board, or part of it, for READMEs and docs, and how its links unfurl.
sidebar:
  order: 1.5
---

A [public board](/boards/boards-and-sharing/#public-boards-and-signed-out-visitors) can be shown outside Tack: as a live image in a README or a docs page, and as a preview wherever its link is pasted. Tack draws both itself, on the server, from the board: what's in them is what anyone who isn't signed in would see.

## Copy embed

On a public board, choose **Share**, then **Get embed** beside **Embed in a README**. If a section is selected on its own, the embed starts with that section.

| Option    | Choices                                                                                                                                                                                                                                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Show**  | **Whole board**; **This view**, what's on your screen now; or **Pick on the board**: the dialog steps aside, the board dims, and you drag across the part you want, or click a section. An image of a section follows it as it moves and grows. The wheel still pans, and <kbd>⌘</kbd>/<kbd>Ctrl</kbd> with the wheel zooms; <kbd>Esc</kbd> goes back |
| **Theme** | **Follow the reader** (a light and a dark image, and the reader's browser shows the one that matches their theme), **Light** or **Dark**                                                                                                                                                                                                              |
| **As**    | **Markdown** or **HTML**, and **SVG** or **PNG**. Following the reader's theme needs HTML's `<picture>`, which GitHub READMEs allow                                                                                                                                                                                                                   |

The preview is the image itself. **Copy embed** copies the snippet, which shows the image and links back to the board. **Copy image link** copies just the image's address.

A Markdown embed looks like this:

```md
[![Roadmap on Tack](https://tack.example.com/embed/r5w9td42u2.svg)](https://tack.example.com/b/r5w9td42u2/roadmap)
```

and following the reader's theme, like this:

```html
<a href="https://tack.example.com/b/r5w9td42u2/roadmap">
	<picture>
		<source
			media="(prefers-color-scheme: dark)"
			srcset="https://tack.example.com/embed/r5w9td42u2.svg?theme=dark"
		/>
		<img alt="Roadmap on Tack" src="https://tack.example.com/embed/r5w9td42u2.svg" />
	</picture>
</a>
```

## Image addresses

Images live at `/embed/{board}.svg` and `/embed/{board}.png`, and take these options. Anything malformed is an error rather than some other image, so a typo shows as a broken image.

| Option             | Meaning                                                                          |
| ------------------ | -------------------------------------------------------------------------------- |
| _(none)_           | The whole board, with a little room around it                                    |
| `section={id}`     | One section and its title, wherever it is now                                    |
| `x`, `y`, `w`, `h` | A fixed area of the board, in board units (whole numbers; at most 40,000 a side) |
| `theme=dark`       | The dark theme (light is the default)                                            |
| `width={pixels}`   | The image's width, from 240 to 2400. Without it, the area's own size, up to 1200 |

Images are at most 2400 pixels tall: a taller area is drawn narrower. The board's title and Tack's mark sit in a small badge in the corner.

## What's in an image

Images draw what someone who isn't signed in sees:

- Cards from public repositories, with their number, title, state, labels and CI. Cards from private repositories (or any repository Tack doesn't know to be public) are drawn as **Private item**, without even the repository's name.
- Stickies, text, sections, connectors, decisions and action items. Stickies written in [silent mode](/facilitation/silent-mode/) that haven't been revealed are drawn face down, as "Hidden until the reveal".
- [Stacks](/boards/stacks/) as their theme cards: the name, the count and the first few stickies and cards a line each (private ones as **Private item**), or just the name and count when the image is small.
- Widgets as their frame and title, never their results.
- No comments, stamps, dot votes, cursors, staged changes or names of who wrote what.

Sections showing a list or a grid are drawn as their rows or mini cards. Text in scripts the image's fonts don't cover (most non-Latin scripts) and emoji are left out. Zoomed well out, text too small to read is drawn as soft bars, as the board does.

## Keeping up with the board

An image is drawn from the board as it was last saved, a few seconds after each change. Browsers and image proxies (GitHub's included) may reuse an image for a minute before asking again; Tack answers that question with "unchanged" (a `304`) unless what the image shows has changed, and keeps drawn images in Cloudflare's cache, so an unchanged board is cheap to show.

If the board stops being public, its images stop at once: they answer `404`, as they do for a board that doesn't exist. Images of a section that's been deleted say "This part of the board isn't there any more".

## Link previews

When a public board's link is pasted into Slack, Discord, a GitHub comment or a social site, it unfurls with:

- the board's title
- a description of what's on it, like "A board with 12 cards, 8 stickies and 3 sections from ascorbic/cirrus, on Tack." (naming only public repositories)
- a 1200 × 630 image of the board under its title (`/og/{board}.png`)

Boards that aren't public unfurl as plain "Tack", without their title: a private board's link says nothing about it.
