---
title: Images
description: Screenshots, photos and pictures on a board, and who can see them.
sidebar:
  order: 3.5
---

Put a screenshot beside the issue it's about, a photo of a whiteboard into a retro, or a mockup into a planning session.

## Adding images

- **Paste** a screenshot or a copied image (<kbd>⌘</kbd> <kbd>V</kbd>). It lands under the pointer.
- **Drop** image files from your desktop. Several at once are laid out together in a tidy grid where you drop them.
- **Pick** files with **Image** in the toolbar, or <kbd>⇧</kbd> <kbd>⌘</kbd> <kbd>K</kbd> (<kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>K</kbd> on Windows and Linux).
- **On a phone**, the **+** has **Photo**, which offers the camera or your photo library. On a tablet, **Image** in the toolbar does the same.

Boards take PNG, JPEG, GIF, WebP and AVIF images, and SVG, which is drawn into a picture as it's added (an SVG can hold scripts, so its file is never kept). Each is placed at its own size, no bigger than about half of what you can see, and dropped into the section under it, which grows to hold it.

Your browser gets each image ready before anything's sent:

- **Big images are made smaller**, to 2560 pixels on their longest side.
- **Photos lose their metadata.** A JPEG is drawn again, so where it was taken and the camera's details don't go on the board.
- **Animated GIFs keep moving**, as long as they're up to 10 MB and 4096 pixels a side. Bigger ones are added as a still picture.

Files can be up to 50 MB going in, and up to 10 MB once they're ready. Anything that can't be added says why.

While an image uploads, you see your own picture fill in, with its progress, and everyone else sees a blurred glimpse of it, shimmering, with your name. If the upload stops halfway (you close the tab), everyone sees that after a few minutes, and can remove it.

## Working with images

- **Resizing** keeps an image's proportions. Hold <kbd>Shift</kbd> to stretch it freely: it's cropped to fit rather than squashed, and **Original proportions** in its toolbar puts it back.
- **Alt text**: select an image and press <kbd>Enter</kbd>, double-click it, or choose **Alt text** in the toolbar above it, and describe what it shows. Screen readers read it, and so does [AI on boards](/boards/ai/): AI never sees the picture, only its alt text. A small dot on **Alt text** means it hasn't any yet.
- **Caption** shows the alt text beneath the image.
- **Open the full image** in a new tab from the toolbar.

Images are shapes like any other: select, move, arrange and copy them, put them in [sections](/boards/sections/) and lists, connect them, comment on them, stamp them and vote on them. They don't join [stacks](/boards/stacks/): stacks gather words into a theme and are named from what they say, and a picture says nothing a model may read.

Undo takes back adding an image, removing it, resizing it and its alt text, and [history](/boards/history/) shows images added, uploaded and removed.

## Copying between boards

Copy images from one board and paste them into another on the same Tack, and their files come too: they show as arriving for a moment while they're brought over. You need to be able to open the board they came from, and edit the one they're going to.

## Who can see them

An image's file is kept with its board, and served only to people who can open that board: it's private on a private board, and public on a public one. Its address on the board never changes what it shows, so your browser keeps it rather than asking again.

Each board keeps up to 1000 images and 256 MB of them. The same file twice is kept once.

When an image is removed, its file is kept for at least a week, and for as long as the board's history can still bring it back, so undo, copies on your clipboard and [Bring back](/boards/history/) all find it.

## Images elsewhere

- **[Export](/boards/export/)**: PNG and SVG exports draw images as they are on the board. A board's JSON carries its images' files, and importing it makes a board with them. [Backups](/boards/export/) leave the files out.
- **[Embeds and link previews](/boards/embeds/)** draw a small version of each image.
- **[Templates](/templates/)** leave images out: a template is kept apart from any board, and an image's file belongs to its board.
- **The [demo](/try/)** keeps images in your browser. Nothing is sent anywhere.
