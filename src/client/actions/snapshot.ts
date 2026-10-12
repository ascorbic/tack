import { domToBlob } from "modern-screenshot";
import { SNAPSHOT_MAX_BYTES, SNAPSHOT_MAX_SIDE } from "../../shared/backlinks.ts";
import type { Rect } from "../snapping.ts";

export { SNAPSHOT_FRAME, SNAPSHOT_PADDING, snapshotRegion } from "./snapshotFrame.ts";

// Board snapshots for backlinks (#33), rendered in the browser.
//
// We draw the canvas's own DOM, with modern-screenshot (MIT): it clones the
// React Flow viewport into an SVG foreignObject, inlining computed styles and
// embedding our web fonts, and rasterises it to a PNG. Drawing the real DOM
// means a snapshot always looks exactly like the board, cards, stickies,
// sections and connectors included, with no second renderer to keep in step.
// (It's a maintained fork of html-to-image, whose newer releases React Flow
// warns against; rendering our own SVG would mean re-implementing every shape.)
//
// It draws the board as it is, not as this person sees it this moment: a copy
// at rest, with no selection, hover, staged-change marks, toolbars, cursors
// or minimap (see `stage`).
//
// Cards the comment's readers mustn't see are hidden before rasterising:
// their contents are dropped from the clone entirely (not blurred, which can
// be undone) and replaced by a plain "private" placeholder of the same size.

/**
 * What never belongs in a snapshot: selection UI, cursors and guides, and
 * staged changes' marks (which may not be true by the time it's read).
 */
export const CHROME = [
	".staged-marks",
	".selection-frame",
	".guides",
	".cursors-layer",
	".sticky-ghost",
	".section-draft",
	".section-resize",
	".connector-toolbar",
	".connector-end",
	".connector-handle",
	".connector-target",
	".connector-snap",
	".connector-draft",
	".react-flow__node-toolbar",
	".react-flow__resize-control",
	".react-flow__nodesselection",
	".react-flow__selection",
	".react-flow__minimap",
	".react-flow__panel",
	"[data-snapshot='hide']",
].join(",");

/** Attributes saying something's selected or highlighted for this person, right now. */
const TRANSIENT_ATTRIBUTES = ["data-selected", "data-linked", "data-highlighted"];
/** React Flow's classes for the same. */
const TRANSIENT_CLASSES = ["selected", "dragging"];

/**
 * Put a copy of the board at rest: no chrome, nothing selected or
 * highlighted. Works on a detached copy, so the board on screen never
 * changes while a snapshot is drawn.
 */
export function atRest(root: Element): void {
	for (const element of root.querySelectorAll(CHROME)) element.remove();
	for (const element of [root, ...root.querySelectorAll("*")]) {
		for (const name of TRANSIENT_ATTRIBUTES) element.removeAttribute(name);
		element.classList.remove(...TRANSIENT_CLASSES);
	}
}

/**
 * Stage a copy of the viewport at rest, off screen, for drawing.
 *
 * modern-screenshot inlines each element's computed style, so whatever the
 * element on screen looks like right now (selected, hovered, mid-animation)
 * is what gets drawn. So we draw a copy instead: inside shallow copies of its
 * ancestors up to the `.react-flow` element (so the board's styles match it
 * as they match the original), out of view, inert, with nothing selected,
 * under no pointer, and with animations and transitions off (`.snapshot-stage`
 * in actions.css), so every shape is drawn as it settles.
 */
export function stage(
	viewport: HTMLElement,
	flow: HTMLElement,
	size: { width: number; height: number },
): { copy: HTMLElement; dispose: () => void } {
	const chain: HTMLElement[] = [];
	for (let element = viewport.parentElement; element; element = element.parentElement) {
		chain.unshift(element);
		if (element === flow) break;
	}
	let host: HTMLElement | null = null;
	let inner: HTMLElement | null = null;
	for (const element of chain) {
		const shell = element.cloneNode(false) as HTMLElement;
		shell.removeAttribute("id");
		if (inner) inner.append(shell);
		else host = shell;
		inner = shell;
	}
	const copy = viewport.cloneNode(true) as HTMLElement;
	// Typed values aren't attributes, so cloning leaves them behind.
	const fields = "input, textarea, select";
	const from = viewport.querySelectorAll<HTMLInputElement>(fields);
	copy.querySelectorAll<HTMLInputElement>(fields).forEach((field, i) => {
		const value = from[i]?.value;
		if (value !== undefined) field.value = value;
	});
	atRest(copy);
	const root = host ?? copy;
	if (inner) inner.append(copy);
	root.classList.add("snapshot-stage");
	root.setAttribute("aria-hidden", "true");
	root.inert = true;
	Object.assign(root.style, {
		position: "fixed",
		left: "-200vw",
		top: "0",
		// At least as big as the image: drawn larger than the board is on
		// screen, a tall region would otherwise be cut off at the bottom.
		width: `${Math.max(flow.clientWidth, size.width)}px`,
		height: `${Math.max(flow.clientHeight, size.height)}px`,
		overflow: "hidden",
		pointerEvents: "none",
	});
	(flow.parentElement ?? document.body).append(root);
	return { copy, dispose: () => root.remove() };
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Wait for the board's images (image shapes' files) to load or fail, for at
 * most `ms`. One still loading is see-through, fading in once it's loaded
 * (`.image-file[data-loaded]`), so a copy taken too soon would draw a hole:
 * shapes that were off screen until a moment ago (drawing turns culling
 * off) have only just started. One that fails draws as unavailable, and
 * one that takes longer is drawn as it is: neither stops the drawing.
 * modern-screenshot then inlines each file it draws, fetched again from
 * the browser's cache (same-origin, or a `blob:` URL in the playground).
 */
export async function imagesLoaded(root: ParentNode, ms = 5000): Promise<void> {
	const pending = [...root.querySelectorAll<HTMLImageElement>("img.image-file:not([data-loaded])")];
	if (pending.length === 0) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		Promise.all(
			pending
				.filter((image) => !image.complete)
				.map(
					(image) =>
						new Promise<void>((resolve) => {
							image.addEventListener("load", () => resolve(), { once: true });
							image.addEventListener("error", () => resolve(), { once: true });
						}),
				),
		),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, ms);
		}),
	]);
	clearTimeout(timer);
	// Each says it's loaded (or broken) when React next renders.
	await frame();
	await frame();
}

/** The image's longest side, in CSS pixels, before device scaling. */
const TARGET_SIDE = 1400;

export interface SnapshotRequest {
	/** The `.react-flow` element. */
	flow: HTMLElement;
	/** The area to draw, in board coordinates. */
	region: Rect;
	/** Node ids (shape ids) whose contents must be hidden. */
	hidden: ReadonlySet<string>;
	/** Linked items (on pull request cards) to leave out, by item key. */
	hideLinked?: (key: string) => boolean;
	/** Sizes of hidden nodes, so placeholders keep their shape. */
	sizeOf?: (id: string) => { width: number; height: number } | undefined;
}

export function themeColor(name: string, fallback: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** A plain stand-in for a hidden card, styled inline since the clone has no stylesheet. */
function placeholder(doc: Document, size: { width: number; height: number } | undefined) {
	const surface = themeColor("--surface-muted", "#f7f6f2");
	const line = themeColor("--line-strong", "rgba(23,25,28,.16)");
	const muted = themeColor("--muted", "#5a5f66");
	const box = doc.createElement("div");
	box.setAttribute(
		"style",
		[
			`width:${Math.round(size?.width ?? 240)}px`,
			`height:${Math.round(size?.height ?? 120)}px`,
			"box-sizing:border-box",
			"display:flex",
			"flex-direction:column",
			"align-items:center",
			"justify-content:center",
			"gap:6px",
			"border-radius:12px",
			`border:1.5px dashed ${line}`,
			`background:repeating-linear-gradient(135deg, ${surface} 0 10px, transparent 10px 20px), ${surface}`,
			`color:${muted}`,
			"font:600 13px/1.2 'Geist Variable', system-ui, sans-serif",
		].join(";"),
	);
	box.innerHTML = `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg><span>Private card</span>`;
	return box;
}

/**
 * Draw part of the board as a PNG. Tries a sharper image first, then a
 * smaller one if that's too big to upload.
 */
export async function renderSnapshot(request: SnapshotRequest): Promise<Blob> {
	const viewport = request.flow.querySelector<HTMLElement>(".react-flow__viewport");
	if (!viewport) throw new Error("The board isn’t showing");
	const { region, hidden } = request;
	const zoom = Math.min(1.25, TARGET_SIDE / Math.max(region.width, region.height));
	const width = Math.max(1, Math.round(region.width * zoom));
	const height = Math.max(1, Math.round(region.height * zoom));
	const background = themeColor("--ground", "#f4f3ef");

	const filter = (node: Node): boolean => {
		if (!(node instanceof Element)) return true;
		if (node.matches(CHROME)) return false;
		const owner = node.parentElement?.closest<HTMLElement>(".react-flow__node");
		if (owner && hidden.has(owner.dataset.id ?? "")) return false;
		const linked = node.closest<HTMLElement>(".linked li[data-key]");
		if (linked && request.hideLinked?.(linked.dataset.key ?? "")) return false;
		return true;
	};

	const onCloneNode = (clone: Node) => {
		if (!(clone instanceof Element)) return;
		for (const node of clone.querySelectorAll<HTMLElement>(".react-flow__node[data-id]")) {
			const id = node.dataset.id ?? "";
			if (!hidden.has(id)) continue;
			node.replaceChildren(placeholder(clone.ownerDocument, request.sizeOf?.(id)));
		}
		// What was drawn, for the e2e tests to look at.
		if (import.meta.env.DEV) Object.assign(window, { tackSnapshotDom: clone.outerHTML });
	};

	await imagesLoaded(viewport);
	const { copy, dispose } = stage(viewport, request.flow, { width, height });
	try {
		const maxScale = SNAPSHOT_MAX_SIDE / Math.max(width, height);
		const scales = [Math.min(2, window.devicePixelRatio || 1, maxScale), Math.min(1, maxScale)];
		for (const scale of new Set(scales)) {
			const blob = await domToBlob(copy, {
				type: "image/png",
				width,
				height,
				scale,
				backgroundColor: background,
				filter,
				onCloneNode,
				style: {
					width: `${width}px`,
					height: `${height}px`,
					transform: `translate(${-region.x * zoom}px, ${-region.y * zoom}px) scale(${zoom})`,
					transformOrigin: "0 0",
				},
			});
			if (blob.size <= SNAPSHOT_MAX_BYTES) return blob;
		}
	} finally {
		dispose();
	}
	throw new Error("The snapshot came out too big to upload. Try selecting fewer cards.");
}
