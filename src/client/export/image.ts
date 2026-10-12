import { domToBlob, domToForeignObjectSvg } from "modern-screenshot";
import { CHROME, imagesLoaded, stage, themeColor } from "../actions/snapshot.ts";
import type { Rect } from "../snapping.ts";

// Drawing the board as an image to export (#59), with the snapshot renderer
// backlinks use (actions/snapshot.ts): a copy of the canvas's own DOM at
// rest, so it looks exactly like the board. Unlike a backlink's snapshot it
// draws at the board's own size (zoom 1) and a scale of the person's
// choosing, optionally on a transparent ground, and as SVG as well as PNG.
//
// An export is the board's content, so what's only someone's, or only now,
// stays out besides the usual chrome: comment pins, what's new rings,
// inbox trays, stamps and dots, history's marks, uploads' progress.
//
// Image shapes draw their files: same-origin `<img>`s (`blob:` URLs in the
// playground), waited for, then inlined by modern-screenshot, so an SVG
// carries them too. A file that won't load draws as unavailable (or, if
// fetching it again fails, transparent): it never stops an export.

export const EXPORT_CHROME = [
	CHROME,
	".comment-layer",
	".since-layer",
	".inbox-anchor",
	".marks-layer",
	".replay-marks",
	".history-restore-bar",
	".display-preview",
	// An empty list's words are for people at the board, not a picture of it.
	".list-empty-note",
	// An image still uploading draws as its blurred stand-in, without whose upload it is.
	".image-progress",
	".image-badge",
].join(",");

export type ImageFormat = "png" | "svg";

export interface ImageRequest {
	/** The `.react-flow` element. */
	flow: HTMLElement;
	/** What to draw, in board coordinates. */
	region: Rect;
	/** Shape ids (nodes and connectors) to draw; null for everything. */
	only: ReadonlySet<string> | null;
	format: ImageFormat;
	/** Pixels per board unit (PNG only). */
	scale: number;
	/** The board's ground behind it, or nothing (transparent). */
	background: boolean;
}

/** The board's ground colour, as the image's background. */
export function groundColor(): string {
	return themeColor("--ground", "#f4f3ef");
}

export async function renderImage(request: ImageRequest): Promise<Blob> {
	const viewport = request.flow.querySelector<HTMLElement>(".react-flow__viewport");
	if (!viewport) throw new Error("The board isn’t showing");
	const { region, only } = request;
	const width = Math.max(1, Math.round(region.width));
	const height = Math.max(1, Math.round(region.height));

	const filter = (node: Node): boolean => {
		if (!(node instanceof Element)) return true;
		if (node.matches(EXPORT_CHROME)) return false;
		if (!only) return true;
		if (node.matches(".react-flow__node[data-id]")) {
			return only.has((node as HTMLElement).dataset.id ?? "");
		}
		const connector = node.getAttribute("data-connector");
		return connector === null || only.has(connector);
	};

	// Image shapes drawn as they are, not mid-load (see `imagesLoaded`).
	await imagesLoaded(viewport);
	const { copy, dispose } = stage(viewport, request.flow, { width, height });
	const options = {
		width,
		height,
		filter,
		...(request.background ? { backgroundColor: groundColor() } : {}),
		style: {
			width: `${width}px`,
			height: `${height}px`,
			transform: `translate(${-region.x}px, ${-region.y}px)`,
			transformOrigin: "0 0",
		},
	};
	try {
		if (request.format === "svg") {
			const svg = await domToForeignObjectSvg(copy, options);
			svg.setAttribute("width", String(width));
			svg.setAttribute("height", String(height));
			const text = new XMLSerializer().serializeToString(svg);
			return new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${text}`], {
				type: "image/svg+xml",
			});
		}
		return await domToBlob(copy, { ...options, type: "image/png", scale: request.scale });
	} finally {
		dispose();
	}
}
