import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import type { Card } from "../../shared/cards.ts";
import { shapesMap } from "../../shared/shapes.ts";
import { addCard, moveShape, type Position } from "../board.ts";
import { cardStore } from "../cardStore.ts";
import { randomUser, type User } from "../presence.ts";

// A board that runs entirely in the browser, with simulated people and
// simulated forge events. Each remote person has their own Y.Doc and
// Awareness, synced with the local ones exactly as a provider would.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Animate from a to b over ms, calling step each frame. */
function animate(from: Position, to: Position, ms: number, step: (p: Position) => void) {
	return new Promise<void>((resolve) => {
		const start = performance.now();
		const frame = (now: number) => {
			const t = Math.min(1, (now - start) / ms);
			const e = easeInOut(t);
			step({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e });
			if (t < 1) requestAnimationFrame(frame);
			else resolve();
		};
		requestAnimationFrame(frame);
	});
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
	private origin = Symbol("remote");
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
		this.awareness.setLocalState({ user, cursor: this.cursor, drags: {} });
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

	dispose(): void {
		this.awareness.setLocalState(null);
		for (const cleanup of this.cleanups) cleanup();
		this.awareness.destroy();
		this.doc.destroy();
	}
}
