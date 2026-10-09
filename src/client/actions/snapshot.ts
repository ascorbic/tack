import { domToBlob } from "modern-screenshot";
import { SNAPSHOT_MAX_BYTES, SNAPSHOT_MAX_SIDE } from "../../shared/backlinks.ts";
import type { Rect } from "../snapping.ts";

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
// Cards the comment's readers mustn't see are hidden before rasterising:
// their contents are dropped from the clone entirely (not blurred, which can
// be undone) and replaced by a plain "private" placeholder of the same size.

/** Board chrome that never belongs in a snapshot: selection UI, cursors, guides. */
const CHROME = [
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
	"[data-snapshot='hide']",
].join(",");

/** Space around the selection, in board units. */
export const SNAPSHOT_PADDING = 160;
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

/** The region to draw: the selection, padded, kept within what's on screen. */
export function snapshotRegion(selection: Rect, visible: Rect): Rect {
	const padded = {
		x: selection.x - SNAPSHOT_PADDING,
		y: selection.y - SNAPSHOT_PADDING,
		width: selection.width + SNAPSHOT_PADDING * 2,
		height: selection.height + SNAPSHOT_PADDING * 2,
	};
	// Shapes off screen aren't rendered at all (React Flow culls them), so
	// stay within the visible area, but never cut into the selection itself.
	const x0 = Math.min(selection.x, Math.max(padded.x, visible.x));
	const y0 = Math.min(selection.y, Math.max(padded.y, visible.y));
	const x1 = Math.max(
		selection.x + selection.width,
		Math.min(padded.x + padded.width, visible.x + visible.width),
	);
	const y1 = Math.max(
		selection.y + selection.height,
		Math.min(padded.y + padded.height, visible.y + visible.height),
	);
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function themeColor(name: string, fallback: string): string {
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
	};

	const maxScale = SNAPSHOT_MAX_SIDE / Math.max(width, height);
	const scales = [Math.min(2, window.devicePixelRatio || 1, maxScale), Math.min(1, maxScale)];
	let blob: Blob | null = null;
	for (const scale of new Set(scales)) {
		blob = await domToBlob(viewport, {
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
	throw new Error("The snapshot came out too big to upload. Try selecting fewer cards.");
}
