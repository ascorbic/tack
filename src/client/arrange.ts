import type { Rect } from "./snapping.ts";

// Align, distribute and tidy a multi-selection. Each takes the selected
// shapes' bounding boxes and returns the new top-left position of every shape
// that moves.

export interface Item extends Rect {
	id: string;
}

export type Position = { x: number; y: number };

export type Alignment = "left" | "center" | "right" | "top" | "middle" | "bottom";

export type Direction = "horizontal" | "vertical";

/** The gap tidy-up leaves between shapes. */
export const TIDY_GAP = 32;

function moved(items: Item[], place: (item: Item) => Position): Map<string, Position> {
	const out = new Map<string, Position>();
	for (const item of items) {
		const next = place(item);
		const x = Math.round(next.x);
		const y = Math.round(next.y);
		if (x !== Math.round(item.x) || y !== Math.round(item.y)) out.set(item.id, { x, y });
	}
	return out;
}

/** Line up edges or centres with the selection's bounding box. */
export function align(items: Item[], alignment: Alignment): Map<string, Position> {
	if (items.length < 2) return new Map();
	const left = Math.min(...items.map((i) => i.x));
	const top = Math.min(...items.map((i) => i.y));
	const right = Math.max(...items.map((i) => i.x + i.width));
	const bottom = Math.max(...items.map((i) => i.y + i.height));
	return moved(items, (item) => {
		switch (alignment) {
			case "left":
				return { x: left, y: item.y };
			case "right":
				return { x: right - item.width, y: item.y };
			case "center":
				return { x: (left + right) / 2 - item.width / 2, y: item.y };
			case "top":
				return { x: item.x, y: top };
			case "bottom":
				return { x: item.x, y: bottom - item.height };
			case "middle":
				return { x: item.x, y: (top + bottom) / 2 - item.height / 2 };
		}
	});
}

/**
 * Space shapes evenly between the first and last along an axis, so the gaps
 * between neighbours are equal. The outermost shapes stay where they are.
 */
export function distribute(items: Item[], direction: Direction): Map<string, Position> {
	if (items.length < 3) return new Map();
	const horizontal = direction === "horizontal";
	const start = (i: Item) => (horizontal ? i.x : i.y);
	const size = (i: Item) => (horizontal ? i.width : i.height);
	const sorted = [...items].sort((a, b) => start(a) - start(b) || a.id.localeCompare(b.id));
	const first = sorted[0] as Item;
	const end = Math.max(...sorted.map((i) => start(i) + size(i)));
	const total = sorted.reduce((sum, i) => sum + size(i), 0);
	const gap = (end - start(first) - total) / (sorted.length - 1);
	const positions = new Map<string, number>();
	let cursor = start(first);
	for (const item of sorted) {
		positions.set(item.id, cursor);
		cursor += size(item) + gap;
	}
	return moved(items, (item) => {
		const at = positions.get(item.id) ?? start(item);
		return horizontal ? { x: at, y: item.y } : { x: item.x, y: at };
	});
}

/**
 * Tidy up, FigJam-style: shapes that roughly share a row become a row, rows
 * stack into a grid with even gaps, and every shape keeps its place in
 * reading order. The grid starts at the selection's top-left corner.
 */
export function tidy(items: Item[], gap = TIDY_GAP): Map<string, Position> {
	if (items.length < 2) return new Map();
	const rows: Item[][] = [];
	let band: { top: number; bottom: number } | null = null;
	for (const item of [...items].sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2))) {
		const middle = item.y + item.height / 2;
		const row = rows.at(-1);
		if (row && band && middle >= band.top && middle <= band.bottom) {
			row.push(item);
			band = {
				top: Math.min(band.top, item.y),
				bottom: Math.max(band.bottom, item.y + item.height),
			};
		} else {
			rows.push([item]);
			band = { top: item.y, bottom: item.y + item.height };
		}
	}
	for (const row of rows) row.sort((a, b) => a.x - b.x || a.id.localeCompare(b.id));

	const columns = Math.max(...rows.map((row) => row.length));
	const widths = Array.from({ length: columns }, (_, c) =>
		Math.max(0, ...rows.map((row) => row[c]?.width ?? 0)),
	);
	const heights = rows.map((row) => Math.max(...row.map((item) => item.height)));
	const left = Math.min(...items.map((i) => i.x));
	const top = Math.min(...items.map((i) => i.y));

	const positions = new Map<string, Position>();
	let y = top;
	rows.forEach((row, r) => {
		let x = left;
		row.forEach((item, c) => {
			positions.set(item.id, { x, y });
			x += (widths[c] ?? 0) + gap;
		});
		y += (heights[r] ?? 0) + gap;
	});
	return moved(items, (item) => positions.get(item.id) ?? item);
}
