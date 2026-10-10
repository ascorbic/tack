import type * as Y from "yjs";
import {
	placeDot,
	readVotes,
	startVote,
	closeVote,
	isOpen,
	covers,
} from "../../shared/dotvotes.ts";
import {
	EMOTES,
	type Emote,
	FACILITATION_ORIGIN,
	type HighFive,
	STAMPS,
	type Spotlight,
	type TimerAction,
	applyTimer,
	readTimer,
	toggleStamp,
} from "../../shared/facilitation.ts";
import { readShape, shapesMap, type ShapeProps } from "../../shared/shapes.ts";
import { type SilentRequest, parseSession } from "../../shared/silent.ts";
import { MemorySilentStore, type SilentPeer, SilentHub } from "../../shared/silentHub.ts";
import {
	type FacilitationIncoming,
	type FacilitationOutgoing,
	facilitation,
} from "../facilitation/store.ts";
import type { RemotePerson, SimulatedBoard } from "./simulator.ts";

// The board's server, as far as facilitation goes, running in the browser
// for the playground: the clock (which can be wound forward, to watch time
// pass), the timer, spotlight, and silent mode's hidden text, kept per
// author exactly as the Durable Object keeps it (the same SilentHub). The
// people the simulator plays connect to it too, with their own identities,
// so their silent stickies are face down for you until the reveal.

const LOCAL = "local";
const LATENCY_MS = 40;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function pick<T>(list: readonly T[]): T | undefined {
	return list[Math.floor(Math.random() * list.length)];
}

export class SimulatedFacilitator {
	readonly store = new MemorySilentStore();
	readonly hub: SilentHub;
	/** How far the pretend server's clock is ahead of this browser's. */
	skew = 0;
	private spotlight: (Spotlight & { peer: string }) | null = null;

	constructor(
		readonly sim: SimulatedBoard,
		/** Whether you own this board (owners can always reveal). */
		private readonly owner = true,
	) {
		this.hub = new SilentHub({
			doc: sim.doc,
			store: this.store,
			peers: () => this.peers(),
			send: (peer, message) => {
				if (peer === LOCAL) this.toLocal(message);
			},
			now: () => this.now(),
		});
		sim.silentText = (person, id, text) => this.hub.text(this.peerOf(person), id, text);
	}

	now(): number {
		return Date.now() + this.skew;
	}

	/** Answer this browser's requests, as the board's server would. */
	install(): () => void {
		facilitation.reset();
		const previous = facilitation.channel;
		facilitation.channel = { send: (request) => void this.receive(request) };
		facilitation.connected();
		return () => {
			facilitation.channel = previous;
			facilitation.disconnected();
			facilitation.reset();
		};
	}

	/** Wind the clock forward, as if time had passed. */
	advance(ms: number): void {
		this.skew += ms;
		facilitation.resetClock();
		facilitation.apply({ type: "clock", t: Date.now(), now: this.now() });
	}

	private local(): SilentPeer {
		return { id: LOCAL, author: "you", canEdit: !this.sim.viewOnly, owner: this.owner };
	}

	private peerOf(person: RemotePerson): SilentPeer {
		return {
			id: `person:${person.awareness.clientID}`,
			author: `person:${person.user.name}`,
			canEdit: true,
			owner: false,
		};
	}

	private peers(): SilentPeer[] {
		return [this.local(), ...this.sim.people.map((person) => this.peerOf(person))];
	}

	private toLocal(message: FacilitationIncoming): void {
		setTimeout(() => facilitation.apply(message), LATENCY_MS);
	}

	private async receive(request: FacilitationOutgoing): Promise<void> {
		await sleep(LATENCY_MS);
		const peer = this.local();
		switch (request.type) {
			case "clock":
				this.toLocal({ type: "clock", t: request.t, now: this.now() + LATENCY_MS });
				return;
			case "timer": {
				if (!peer.canEdit)
					return this.toLocal({
						type: "facilitation-refused",
						request: "timer",
						reason: "not_editor",
					});
				const { type: _type, by, ...command } = request;
				applyTimer(this.sim.doc, command as TimerAction, this.now(), by, FACILITATION_ORIGIN);
				return;
			}
			case "spotlight":
				if (!peer.canEdit) return;
				if (!request.on) {
					if (this.spotlight?.peer === LOCAL) this.setSpotlight(null);
					return;
				}
				if (typeof request.clientId === "number" && request.user) {
					this.setSpotlight({
						peer: LOCAL,
						clientId: request.clientId,
						user: request.user,
						since: this.now(),
					});
				}
				return;
			case "silent-hello":
				this.hub.hello(peer);
				return;
			default:
				this.hub.request(peer, request as SilentRequest);
		}
	}

	private setSpotlight(spotlight: (Spotlight & { peer: string }) | null): void {
		this.spotlight = spotlight;
		const { peer: _peer, ...rest } = spotlight ?? { peer: "" };
		this.toLocal({ type: "spotlight", spotlight: spotlight ? (rest as Spotlight) : null });
	}

	// --- What the simulated people do ----------------------------------------------

	timer(person: RemotePerson, command: TimerAction): boolean {
		return applyTimer(this.sim.doc, command, this.now(), person.user, FACILITATION_ORIGIN);
	}

	get timerRunning(): boolean {
		return readTimer(this.sim.doc) !== null;
	}

	/** Someone spotlights, then looks around, so everyone following goes along. */
	async spotlightBy(person: RemotePerson): Promise<void> {
		this.setSpotlight({
			peer: `person:${person.awareness.clientID}`,
			clientId: person.awareness.clientID,
			user: person.user,
			since: this.now(),
		});
		await sleep(900);
		await person.lookAround(2);
	}

	stopSpotlight(): void {
		if (this.spotlight && this.spotlight.peer !== LOCAL) this.setSpotlight(null);
	}

	/** A person left: their spotlight goes with them. */
	left(person: RemotePerson): void {
		if (this.spotlight?.peer === `person:${person.awareness.clientID}`) this.setSpotlight(null);
	}

	startSilent(person: RemotePerson, section: string): boolean {
		return this.hub.start(this.peerOf(person), section, person.user);
	}

	revealBy(person: RemotePerson | null, section: string): boolean {
		const session = parseSession(shapesMap(this.sim.doc).get(section)?.get("silent"));
		if (!session) return false;
		return this.hub.reveal(person ? this.peerOf(person) : this.local(), session.id);
	}
}

// --- People's gestures, beyond the simulator's ------------------------------------

let emotes = 0;

export async function emote(person: RemotePerson, emoji = pick(EMOTES.slice(0, 7)) ?? "🎉") {
	for (let i = 0; i < 3; i++) {
		const value: Emote = { n: ++emotes, emoji, x: person.cursor.x, y: person.cursor.y };
		person.awareness.setLocalStateField("emote", value);
		await sleep(180 + Math.random() * 120);
	}
}

/** Hold a hand out, and bring it to `target` (someone's cursor). */
export async function highFive(person: RemotePerson, target: { x: number; y: number }) {
	person.awareness.setLocalStateField("highFive", { at: Date.now() } satisfies HighFive);
	await person.moveTo({ x: target.x + 6, y: target.y + 4 }, 900);
	await sleep(4_000);
	person.awareness.setLocalStateField("highFive", null);
}

/** Stamp a few shapes, as someone moving around the board. */
export async function stampAround(person: RemotePerson, doc: Y.Doc, count = 3) {
	const ids = votable(doc);
	for (let i = 0; i < count; i++) {
		const id = pick(ids);
		if (!id) return;
		const shape = readShape(shapesMap(doc).get(id)!);
		await person.moveTo({ x: shape.x + 30, y: shape.y + 120 }, 600);
		await sleep(200);
		person.doc.transact(() =>
			toggleStamp(person.doc, id, pick(STAMPS.slice(0, 5)) ?? "👍", person.user),
		);
		await sleep(250);
	}
}

/** Shapes people can vote on or stamp. */
export function votable(doc: Y.Doc): string[] {
	return [...shapesMap(doc).entries()]
		.filter(([, shape]) => {
			const type = shape.get("type") as ShapeProps["type"];
			return type !== "section" && type !== "connector";
		})
		.map(([id]) => id);
}

/** Spend all of someone's dots in the open votes, heading to each shape. */
export async function voteAround(person: RemotePerson, now: number) {
	const doc = person.doc;
	const shapes = new Map([...shapesMap(doc)].map(([id, shape]) => [id, readShape(shape)]));
	for (const vote of readVotes(doc).filter((v) => isOpen(v, now))) {
		const options = [...shapes.keys()].filter((id) => covers(vote, shapes, id));
		// Favourites: a few shapes get most of the dots.
		const favourites = options.sort(() => Math.random() - 0.5).slice(0, 3);
		for (let i = 0; i < vote.dots; i++) {
			const id = pick(favourites);
			const shape = id ? shapes.get(id) : undefined;
			if (!id || !shape) break;
			await person.moveTo({ x: shape.x + 150, y: shape.y + 10 }, 450);
			await sleep(120);
			doc.transact(() => placeDot(doc, vote.id, person.user, id));
		}
	}
}

export function startBoardVote(
	person: RemotePerson,
	scope: string | null,
	options: { endsAt?: string; hidden?: boolean } = {},
) {
	return startVote(person.doc, { scope, by: person.user, dots: 3, reactions: true, ...options });
}

export function closeOpenVotes(person: RemotePerson, now: number) {
	for (const vote of readVotes(person.doc)) {
		if (isOpen(vote, now)) closeVote(person.doc, vote.id, person.user, new Date(now).toISOString());
	}
}
