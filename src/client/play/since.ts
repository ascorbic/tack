import { clock } from "../clock.ts";
import type * as Y from "yjs";
import { shapesMap } from "../../shared/shapes.ts";
import {
	type Actor,
	type CardActivity,
	type CardSnapshot,
	type Digest,
	type EditEntry,
	type EditKind,
	type PushDigest,
	MAX_DIGEST_EDITS,
	cardActivity,
	isNews,
	shapeChanges,
	snapshotOf,
} from "../../shared/since.ts";
import { cardStore } from "../cardStore.ts";
import type { User } from "../presence.ts";
import { type SinceStore, sinceStore } from "../since/store.ts";

// A pretend "since you were here" server for the playground (#46): it
// watches the board's document the way the board's object does, telling
// simulated people's edits apart from yours, and lets time pass: leave,
// let a few days go by while people work, then come back to the digest.

export interface PlayPerson {
	origin: unknown;
	user: User;
}

const DAY = 24 * 60 * 60_000;

export class SimulatedSince {
	/** How far the playground's clock is ahead of the real one. */
	offset = 0;
	private edits = new Map<string, EditEntry>();
	private types = new Map<string, string>();
	private cards = new Map<string, CardSnapshot>();
	private pushes: PushDigest[] = [];
	private extraCards: CardActivity[] = [];
	baseline: number | null = null;

	constructor(
		private doc: Y.Doc,
		/** The simulated people now, to tell whose edit an update was. */
		private people: () => PlayPerson[],
		private store: SinceStore = sinceStore,
	) {}

	/** Watch the board and answer the store, until the returned function is called. */
	start(): () => void {
		const shapes = shapesMap(this.doc);
		for (const [id, shape] of shapes) this.types.set(id, typeName(shape));
		const observer = (events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction) => {
			const person = this.people().find((p) => p.origin === transaction.origin);
			const { changes } = shapeChanges(events, shapes);
			for (const { shape, kind } of changes) {
				if (kind === "added") this.types.set(shape, typeName(shapes.get(shape)));
				if (person) this.note(shape, kind, actorFor(person.user));
			}
		};
		shapes.observeDeep(observer);
		this.store.channel = {
			send: (request) => {
				// "Mark all as seen": the next visit starts from now.
				if (request.type === "since-seen") this.leave();
				this.comeBack();
			},
		};
		clock.now = () => this.now();
		return () => {
			shapes.unobserveDeep(observer);
			clock.now = () => Date.now();
		};
	}

	now(): number {
		return Date.now() + this.offset;
	}

	/** You leave: everything from now on is news when you're back. */
	leave(): void {
		this.baseline = this.now();
		this.edits.clear();
		this.pushes = [];
		this.extraCards = [];
		this.cards.clear();
		for (const shape of shapesMap(this.doc).values()) {
			const ref = shape.get("ref");
			const card = typeof ref === "string" ? cardStore.get(ref) : undefined;
			if (card && !("missing" in card)) this.cards.set(card.key, snapshotOf(card));
		}
	}

	/** Time passes. */
	pass(ms = DAY): void {
		this.offset += ms;
	}

	/** Someone pushed while you were away. */
	pushed(push: Omit<PushDigest, "at">): void {
		this.pushes.unshift({ ...push, at: this.now() });
	}

	/** Card activity the pretend forge can't show by changing the card (seeding). */
	cardActivity(activity: Omit<CardActivity, "at">): void {
		this.extraCards.push({ ...activity, at: this.now() });
	}

	/** You're back: the digest, as the board's object would send it. */
	comeBack(): void {
		this.store.apply({ type: "since", digest: this.digest() });
	}

	digest(): Digest {
		const now = this.now();
		if (this.baseline === null) {
			return { since: null, at: now, edits: [], more: 0, cards: [], pushes: [] };
		}
		const all = [...this.edits.values()].sort((a, b) => b.at - a.at);
		const added = new Set(all.filter((e) => e.kind === "added").map((e) => e.shape));
		const edits = all.filter(
			(e) => e.kind === "added" || e.kind === "removed" || !added.has(e.shape),
		);
		const cards: CardActivity[] = [...this.extraCards];
		for (const [key, before] of this.cards) {
			const card = cardStore.get(key);
			if (!card || "missing" in card) continue;
			cards.push(
				...cardActivity(key, before, [{ at: now - 3_600_000, snapshot: snapshotOf(card) }]),
			);
		}
		return {
			since: this.baseline,
			at: now,
			edits: edits.slice(0, MAX_DIGEST_EDITS),
			more: Math.max(0, edits.length - MAX_DIGEST_EDITS),
			cards: cards.sort((a, b) => b.at - a.at),
			pushes: this.pushes,
		};
	}

	private note(shape: string, kind: EditKind, by: Actor): void {
		const type = this.types.get(shape) ?? "shape";
		if (!isNews(type, kind) || this.baseline === null) return;
		if (kind === "removed") {
			for (const other of ["added", "moved", "changed"]) this.edits.delete(`${shape}:${other}`);
		}
		// Spread the away time out a little, so it reads like days of work.
		const at = this.now() - Math.floor(Math.random() * 6 * 3_600_000);
		this.edits.set(`${shape}:${kind}`, {
			shape,
			kind,
			type,
			at: Math.max(at, this.baseline + 1),
			by,
		});
	}
}

export function actorFor(user: User): Actor {
	const login = user.login ?? user.name.toLowerCase().replace(/[^a-z]+/g, "-");
	return {
		kind: "person",
		id: hash(login),
		login,
		name: user.name,
		...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
	};
}

function typeName(shape: Y.Map<unknown> | undefined): string {
	const type = shape?.get("type");
	return typeof type === "string" ? type : "shape";
}

function hash(text: string): number {
	let h = 0;
	for (const char of text) h = (Math.imul(h, 31) + char.charCodeAt(0)) | 0;
	return Math.abs(h) + 1000;
}
