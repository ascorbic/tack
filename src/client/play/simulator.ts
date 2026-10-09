import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import type { Card } from "../../shared/cards.ts";
import { type ShapeFont, shapesMap } from "../../shared/shapes.ts";
import type { Status } from "../activity.ts";
import { STICKY_COLORS, addCard, addSticky, moveShape, type Position } from "../board.ts";
import { cardStore } from "../cardStore.ts";
import { CHAT_LINGER_MS } from "../chat.ts";
import { type PresenceState, randomUser, type User } from "../presence.ts";
import type { View } from "../viewport.ts";

// A board that runs entirely in the browser, with simulated people and
// simulated forge events. Each remote person has their own Y.Doc and
// Awareness, synced with the local ones exactly as a provider would.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Ease from 0 to 1 over ms, calling step each frame. */
function tween(ms: number, step: (t: number) => void) {
	return new Promise<void>((resolve) => {
		const start = performance.now();
		const frame = (now: number) => {
			const t = Math.min(1, (now - start) / ms);
			step(easeInOut(t));
			if (t < 1) requestAnimationFrame(frame);
			else resolve();
		};
		requestAnimationFrame(frame);
	});
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Animate from a to b over ms, calling step each frame. */
function animate(from: Position, to: Position, ms: number, step: (p: Position) => void) {
	return tween(ms, (t) => step({ x: mix(from.x, to.x, t), y: mix(from.y, to.y, t) }));
}

export class SimulatedBoard {
	doc = new Y.Doc();
	awareness = new Awareness(this.doc);
	people: RemotePerson[] = [];

	join(user: User = randomUser()): RemotePerson {
		const person = new RemotePerson(this, user);
		this.people.push(person);
		return person;
	}

	leave(person: RemotePerson): void {
		person.dispose();
		this.people = this.people.filter((p) => p !== person);
	}

	destroy(): void {
		for (const person of this.people) person.dispose();
		this.people = [];
		this.awareness.destroy();
		this.doc.destroy();
	}

	/** Pretend a forge webhook changed a card. */
	updateCard(key: string, change: (card: Card) => Partial<Card>): void {
		const card = cardStore.get(key);
		if (!card || "missing" in card) return;
		cardStore.set({ ...card, ...change(card), updatedAt: new Date().toISOString() });
	}

	cardKeys(): string[] {
		const keys: string[] = [];
		for (const shape of shapesMap(this.doc).values()) {
			const ref = shape.get("ref");
			if (typeof ref === "string") keys.push(ref);
		}
		return keys;
	}

	shapeIds(type?: "card" | "sticky"): string[] {
		return [...shapesMap(this.doc).entries()]
			.filter(([, shape]) => !type || shape.get("type") === type)
			.map(([id]) => id);
	}

	/**
	 * The shape this browser made most recently (not a simulated person), to
	 * show that undo leaves other people's work on it alone.
	 */
	lastLocalShape(): string | null {
		let latest: { id: string; clock: number } | null = null;
		for (const [id, shape] of shapesMap(this.doc)) {
			const item = shape._item;
			if (item?.id.client === this.doc.clientID && (!latest || item.id.clock > latest.clock)) {
				latest = { id, clock: item.id.clock };
			}
		}
		return latest?.id ?? null;
	}

	shapePosition(id: string): Position | null {
		const shape = shapesMap(this.doc).get(id);
		if (!shape) return null;
		return { x: Number(shape.get("x")), y: Number(shape.get("y")) };
	}
}

export class RemotePerson {
	doc = new Y.Doc();
	awareness: Awareness;
	cursor: Position = { x: 0, y: 0 };
	/** The part of the board they're looking at, as their window would. */
	view: View = { x: -80, y: -60, width: 1440, height: 860 };
	status: Status = "active";
	private origin = Symbol("remote");
	private followTimer = 0;
	private cleanups: (() => void)[] = [];

	constructor(
		private board: SimulatedBoard,
		public user: User,
	) {
		Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(board.doc));
		this.awareness = new Awareness(this.doc);

		const toRemote = (update: Uint8Array, origin: unknown) => {
			if (origin !== this.origin) Y.applyUpdate(this.doc, update, this.origin);
		};
		const toLocal = (update: Uint8Array, origin: unknown) => {
			if (origin !== this.origin) Y.applyUpdate(board.doc, update, this.origin);
		};
		board.doc.on("update", toRemote);
		this.doc.on("update", toLocal);

		const forwardAwareness = ({ added, updated, removed }: Record<string, number[]>) => {
			const changed = [...(added ?? []), ...(updated ?? []), ...(removed ?? [])];
			applyAwarenessUpdate(
				board.awareness,
				encodeAwarenessUpdate(this.awareness, changed),
				this.origin,
			);
		};
		this.awareness.on("update", forwardAwareness);

		this.cleanups.push(() => {
			board.doc.off("update", toRemote);
			this.doc.off("update", toLocal);
			this.awareness.off("update", forwardAwareness);
		});

		this.cursor = { x: 200 + Math.random() * 400, y: 150 + Math.random() * 300 };
		this.view = {
			x: -160 + Math.random() * 240,
			y: -120 + Math.random() * 160,
			width: 1280 + Math.random() * 400,
			height: 800,
		};
		const state: PresenceState = {
			user,
			cursor: this.cursor,
			drags: {},
			view: this.view,
			status: "active",
			chat: null,
			following: null,
		};
		this.awareness.setLocalState(state);
	}

	async moveTo(target: Position, ms = 700): Promise<void> {
		await animate(this.cursor, target, ms, (p) => {
			this.cursor = p;
			this.awareness.setLocalStateField("cursor", p);
		});
	}

	async wander(steps = 4): Promise<void> {
		for (let i = 0; i < steps; i++) {
			await this.moveTo(
				{ x: 100 + Math.random() * 900, y: 80 + Math.random() * 500 },
				600 + Math.random() * 600,
			);
			await sleep(150 + Math.random() * 400);
		}
	}

	/** Grab a shape, drag it somewhere, and drop it, committing on drop. */
	async drag(id: string, to: Position, ms = 1100): Promise<void> {
		const from = this.board.shapePosition(id);
		if (!from) return;
		await this.moveTo({ x: from.x + 40, y: from.y + 20 }, 500);
		await sleep(120);
		await animate(from, to, ms, (p) => {
			this.cursor = { x: p.x + 40, y: p.y + 20 };
			this.awareness.setLocalState({
				...this.awareness.getLocalState(),
				cursor: this.cursor,
				drags: { [id]: p },
			});
		});
		this.doc.transact(() => moveShape(this.doc, id, to));
		this.awareness.setLocalStateField("drags", {});
	}

	async type(id: string, text: string): Promise<void> {
		const position = this.board.shapePosition(id);
		if (position) await this.moveTo({ x: position.x + 30, y: position.y + 40 }, 500);
		const shape = shapesMap(this.doc).get(id);
		if (!shape) return;
		const existing = shape.get("text");
		let current = typeof existing === "string" ? existing : "";
		if (current) current += " ";
		for (const char of text) {
			current += char;
			shape.set("text", current);
			await sleep(45 + Math.random() * 90);
		}
	}

	async addCard(key: string, at: Position): Promise<void> {
		await this.moveTo(at, 600);
		addCard(this.doc, key, at);
	}

	/** Place a sticky with this person's name on it, then type into it. */
	async addSticky(at: Position, text: string, font?: ShapeFont): Promise<void> {
		await this.moveTo(at, 600);
		const color = STICKY_COLORS[Math.floor(Math.random() * STICKY_COLORS.length)];
		const id = addSticky(this.doc, at, { color, author: this.user, font });
		await sleep(250);
		await this.type(id, text);
	}

	/** Cursor chat: open it, type a message, and let it linger and fade. */
	async say(text: string): Promise<void> {
		this.awareness.setLocalStateField("chat", { text: "", typing: true });
		await sleep(700);
		let current = "";
		for (const char of text) {
			current += char;
			this.awareness.setLocalStateField("chat", { text: current, typing: true });
			await sleep(35 + Math.random() * 80);
		}
		await sleep(300);
		this.awareness.setLocalStateField("chat", { text, typing: false });
		await sleep(CHAT_LINGER_MS);
		this.awareness.setLocalStateField("chat", null);
	}

	/** Pan and zoom their own view, with the cursor drifting along. */
	async lookAt(target: View, ms = 1600): Promise<void> {
		const from = this.view;
		const cursorFrom = this.cursor;
		const cursorTo = { x: target.x + target.width * 0.45, y: target.y + target.height * 0.4 };
		await tween(ms, (t) => {
			this.view = {
				x: mix(from.x, target.x, t),
				y: mix(from.y, target.y, t),
				width: mix(from.width, target.width, t),
				height: mix(from.height, target.height, t),
			};
			this.cursor = { x: mix(cursorFrom.x, cursorTo.x, t), y: mix(cursorFrom.y, cursorTo.y, t) };
			this.awareness.setLocalState({
				...this.awareness.getLocalState(),
				view: this.view,
				cursor: this.cursor,
			});
		});
	}

	/** Wander around the board, zooming in and out. */
	async lookAround(stops = 3): Promise<void> {
		for (let i = 0; i < stops; i++) {
			const width = 700 + Math.random() * 1500;
			await this.lookAt({
				x: -300 + Math.random() * 1300,
				y: -200 + Math.random() * 700,
				width,
				height: width * 0.62,
			});
			await sleep(500 + Math.random() * 600);
		}
	}

	setStatus(status: Status): void {
		this.status = status;
		this.awareness.setLocalStateField("status", status);
	}

	/** Follow another client, copying their view as it changes. */
	follow(clientId: number | null): void {
		clearInterval(this.followTimer);
		this.awareness.setLocalStateField("following", clientId);
		if (clientId === null) return;
		this.followTimer = window.setInterval(() => {
			const leader = this.board.awareness.getStates().get(clientId) as PresenceState | undefined;
			if (!leader) return this.follow(null);
			if (leader.view) {
				this.view = leader.view;
				this.awareness.setLocalStateField("view", leader.view);
			}
		}, 200);
	}

	get following(): number | null {
		return (this.awareness.getLocalState() as PresenceState | null)?.following ?? null;
	}

	dispose(): void {
		clearInterval(this.followTimer);
		this.awareness.setLocalState(null);
		for (const cleanup of this.cleanups) cleanup();
		this.awareness.destroy();
		this.doc.destroy();
	}
}
