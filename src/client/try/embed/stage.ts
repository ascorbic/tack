import type { ReactFlowInstance, useStoreApi } from "@xyflow/react";
import type * as Y from "yjs";
import type { Rect } from "../../../shared/geometry.ts";
import { readShape, shapesMap } from "../../../shared/shapes.ts";
import { moveShape, type Position } from "../../board.ts";
import type { ChangesUI } from "../../changes/context.ts";
import type { RemotePerson, SimulatedBoard } from "../../play/simulator.ts";
import type { Director } from "./director.ts";

// What a loop plays on: the board (its document, React Flow, the changes
// UI), the people on it as actors whose every movement goes through the
// director's clock, and the embed's own overlay, which draws what a
// remote person's doing that the board doesn't show for them (a marquee
// they're drawing, a click landing).

/** What the overlay draws: a marquee in someone's colour, and clicks as they land. */
export interface Marks {
	marquee: { rect: Rect; color: string } | null;
	clicks: { n: number; x: number; y: number; color: string }[];
}

export class MarksStore {
	private marks: Marks = { marquee: null, clicks: [] };
	private listeners = new Set<() => void>();
	private n = 0;

	get = (): Marks => this.marks;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private set(marks: Marks): void {
		this.marks = marks;
		for (const listener of this.listeners) listener();
	}

	marquee(rect: Rect | null, color = ""): void {
		this.set({ ...this.marks, marquee: rect ? { rect, color } : null });
	}

	/** A click, at a point on the screen: it ripples for a moment, then goes. */
	click(x: number, y: number, color: string): void {
		const click = { n: ++this.n, x, y, color };
		this.set({ ...this.marks, clicks: [...this.marks.clicks.slice(-3), click] });
		setTimeout(() => {
			this.set({ ...this.marks, clicks: this.marks.clicks.filter((c) => c !== click) });
		}, 700);
	}

	clear(): void {
		this.set({ marquee: null, clicks: [] });
	}
}

export interface StageBoard {
	flow: ReactFlowInstance;
	store: ReturnType<typeof useStoreApi>;
	changes: ChangesUI | null;
}

export class Stage {
	constructor(
		readonly d: Director,
		readonly sim: SimulatedBoard,
		readonly board: StageBoard,
		readonly marks: MarksStore,
	) {}

	get doc(): Y.Doc {
		return this.sim.doc;
	}

	actor(person: RemotePerson): Actor {
		return new Actor(person, this);
	}

	/** A shape's id by its text (a sticky's) or its card's key: what loops refer to. */
	find(match: string): string {
		for (const [id, shape] of shapesMap(this.doc)) {
			if (shape.get("text") === match || shape.get("ref") === match) return id;
		}
		throw new Error(`Nothing on the board says “${match}”`);
	}

	box(id: string): Rect | null {
		const node = this.board.flow.getInternalNode(id);
		if (node) {
			const { x, y } = node.internals.positionAbsolute;
			return { x, y, w: node.measured.width ?? 0, h: node.measured.height ?? 0 };
		}
		const shape = shapesMap(this.doc).get(id);
		if (!shape) return null;
		const props = readShape(shape);
		return { x: props.x, y: props.y, w: Number(props.w ?? 180), h: Number(props.h ?? 160) };
	}

	/** Where a point on the screen is on the board. */
	toBoard(x: number, y: number): Position {
		return this.board.flow.screenToFlowPosition({ x, y }, { snapToGrid: false });
	}

	toScreen(at: Position): Position {
		return this.board.flow.flowToScreenPosition(at);
	}

	/** The viewport that shows `area` (16:10), filling the board. */
	viewportFor(area: Rect): { x: number; y: number; zoom: number } {
		const { width, height } = this.board.store.getState();
		const zoom = Math.min(width / area.w, height / area.h);
		return {
			x: (width - area.w * zoom) / 2 - area.x * zoom,
			y: (height - area.h * zoom) / 2 - area.y * zoom,
			zoom,
		};
	}

	/** Glide the camera to show `area`. */
	async look(area: Rect, ms = 1400): Promise<void> {
		const { width, height } = this.board.store.getState();
		const from = this.board.flow.getViewport();
		const to = this.viewportFor(area);
		const centre = (v: { x: number; y: number; zoom: number }) => ({
			x: (width / 2 - v.x) / v.zoom,
			y: (height / 2 - v.y) / v.zoom,
		});
		const a = centre(from);
		const b = centre(to);
		const mix = (p: number, q: number, t: number) => p + (q - p) * t;
		await this.d.tween(ms, (t) => {
			// Zoom eased in its own scale, so the glide feels even.
			const zoom = Math.exp(mix(Math.log(from.zoom), Math.log(to.zoom), t));
			const x = width / 2 - mix(a.x, b.x, t) * zoom;
			const y = height / 2 - mix(a.y, b.y, t) * zoom;
			void this.board.flow.setViewport({ x, y, zoom });
		});
	}

	/** Select shapes, as if this browser had (the actions under a selection are yours). */
	select(ids: string[]): void {
		this.board.store.getState().addSelectedNodes(ids);
	}

	deselect(): void {
		this.board.store.getState().unselectNodesAndEdges();
	}

	/** An element of the board's UI, once it's there. */
	element(find: () => Element | null | undefined, timeout?: number): Promise<HTMLElement | null> {
		return this.d.until(() => {
			const el = find();
			return el instanceof HTMLElement && el.isConnected && el.getClientRects().length > 0
				? el
				: null;
		}, timeout);
	}

	/** A button by its accessible name (its label, or its text). */
	button(name: string | RegExp, within: ParentNode = document): HTMLButtonElement | null {
		const matches = (text: string | null) =>
			text !== null && (typeof name === "string" ? text.trim() === name : name.test(text.trim()));
		for (const el of within.querySelectorAll<HTMLButtonElement>("button")) {
			if (matches(el.getAttribute("aria-label")) || matches(el.textContent)) return el;
		}
		return null;
	}
}

/** Someone on the board, moving as people do: eased, and only while the loop plays. */
export class Actor {
	constructor(
		readonly person: RemotePerson,
		private readonly stage: Stage,
	) {}

	get cursor(): Position {
		return this.person.cursor;
	}

	get color(): string {
		return this.person.user.color;
	}

	/** Put the cursor somewhere at once (null: off the board). */
	place(at: Position | null): void {
		if (at) this.person.cursor = at;
		this.person.awareness.setLocalStateField("cursor", at);
	}

	async moveTo(to: Position, ms = 700): Promise<void> {
		const from = this.person.cursor;
		await this.stage.d.tween(ms, (t) => {
			const at = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
			this.person.cursor = at;
			this.person.awareness.setLocalStateField("cursor", at);
		});
	}

	/** Somewhere on a shape: `fx`, `fy` are fractions of its width and height. */
	async moveOnto(id: string, fx = 0.5, fy = 0.5, ms = 700): Promise<void> {
		const box = this.stage.box(id);
		if (box) await this.moveTo({ x: box.x + box.w * fx, y: box.y + box.h * fy }, ms);
	}

	/** Head to a control on the screen and click it. */
	async click(el: HTMLElement, ms = 650): Promise<void> {
		const rect = el.getBoundingClientRect();
		await this.moveTo(this.stage.toBoard(rect.x + rect.width / 2, rect.y + rect.height / 2), ms);
		await this.stage.d.wait(140);
		this.press();
		el.click();
		await this.stage.d.wait(120);
	}

	/** A click where the cursor is: a ripple in their colour. */
	press(): void {
		const at = this.stage.toScreen(this.person.cursor);
		this.stage.marks.click(at.x, at.y, this.color);
	}

	/**
	 * Pick a shape up and carry it to `to` (its new top left), live, the
	 * cursor holding it where it was picked up; dropped there on their
	 * document. Returns where it ended up.
	 */
	async drag(id: string, to: Position, ms = 1000): Promise<void> {
		const box = this.stage.box(id);
		if (!box) return;
		const grip = { x: box.w * 0.5, y: box.h * 0.35 };
		await this.moveTo({ x: box.x + grip.x, y: box.y + grip.y }, 600);
		await this.stage.d.wait(160);
		this.press();
		const from = { x: box.x, y: box.y };
		const awareness = this.person.awareness;
		await this.stage.d.tween(ms, (t) => {
			const at = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
			this.person.cursor = { x: at.x + grip.x, y: at.y + grip.y };
			awareness.setLocalState({
				...awareness.getLocalState(),
				cursor: this.person.cursor,
				drags: { [id]: at },
			});
		});
		await this.stage.d.wait(120);
		moveShape(this.person.doc, id, to);
		awareness.setLocalStateField("drags", {});
	}

	/** Hold the button down and draw a marquee from one corner to the other. */
	async marquee(rect: Rect, ms = 900): Promise<void> {
		const start = { x: rect.x, y: rect.y };
		await this.moveTo(start, 650);
		await this.stage.d.wait(120);
		this.press();
		try {
			await this.stage.d.tween(ms, (t) => {
				const at = { x: rect.x + rect.w * t, y: rect.y + rect.h * t };
				this.person.cursor = at;
				this.person.awareness.setLocalStateField("cursor", at);
				this.stage.marks.marquee(
					{ x: rect.x, y: rect.y, w: at.x - rect.x, h: at.y - rect.y },
					this.color,
				);
			});
			await this.stage.d.wait(120);
		} finally {
			this.stage.marks.marquee(null);
		}
	}

	/** Cursor chat, typed out, then left to linger. */
	async say(text: string, linger = 1600): Promise<void> {
		const awareness = this.person.awareness;
		awareness.setLocalStateField("chat", { text: "", typing: true });
		await this.stage.d.wait(300);
		let current = "";
		for (const char of text) {
			current += char;
			awareness.setLocalStateField("chat", { text: current, typing: true });
			await this.stage.d.wait(34);
		}
		awareness.setLocalStateField("chat", { text, typing: false });
		await this.stage.d.wait(linger);
		awareness.setLocalStateField("chat", null);
	}

	/** On their own document, as one edit: what they did reaches the board as theirs. */
	edit(change: (doc: Y.Doc) => void): void {
		this.person.doc.transact(() => change(this.person.doc));
	}
}
