import * as Y from "yjs";
import type { Card, MissingCard } from "./cards.ts";
import { type Voter, voterKey } from "./decisions.ts";
import { type Author, readShape, shapesMap, type ShapeProps } from "./shapes.ts";

// Dot voting (#48). A vote is an entry in the document's `dotVotes` map:
// its settings, and a nested `ballots` map keyed by voter (as decisions'
// votes are, `voterKey`), each person's ballot replaced whole by them alone,
// so ballots from different people always merge. The ballots map is made
// with the vote, never lazily, so two people's first dots can't race to make
// it and lose one.
//
// A vote covers a section (everything inside it, however deeply) or the
// whole board. Each person has `dots` to spend, and may put several on one
// shape. It's open until someone closes it, or until `endsAt` passes (a
// window that can stay open for days); reopening clears the close, and
// gives it a new end if asked. Several votes can be open at once, on
// different sections: a shape's dots go to the vote of the innermost
// section around it, else the board's.
//
// `hidden` keeps others' dots out of sight until the vote closes. That's a
// courtesy, to stop people following the crowd, not a secret: ballots are in
// the document like everything else (unlike silent mode's text, see
// silent.ts).
//
// Whoever started a vote runs it (`starter`, stamped by the server): they
// and the board's owner close, reopen and delete it, and the server puts
// right anyone else's changes (`VoteGuard` in facilitator.ts).
//
// With `reactions`, 👍 reactions on a card's GitHub item count as votes for
// it, one each. Someone who reacted and also put a dot on that card on the
// board is counted once, by their dots, where their GitHub login is known.

export interface DotVote {
	id: string;
	/** The section it covers, or null for the whole board. */
	scope: string | null;
	/** Dots per person. */
	dots: number;
	title?: string;
	/** Keep others' dots out of sight until it closes. */
	hidden: boolean;
	/** Count 👍 reactions on cards' GitHub items as votes. */
	reactions: boolean;
	/** When it closes by itself, ISO 8601; absent for a live vote someone closes. */
	endsAt?: string;
	/** When someone closed it, ISO 8601. */
	closedAt?: string;
	closedBy?: Author;
	startedAt: string;
	by: Author;
	/**
	 * Who started it, as the server knows them (an author key, see
	 * facilitator.ts): they, and the board's owner, run it.
	 */
	starter?: string;
	ballots: Record<string, Ballot>;
}

/** One person's dots, by shape. */
export interface Ballot {
	name: string;
	color: string;
	login?: string;
	dots: Record<string, number>;
	/** Last changed, ISO 8601. */
	at: string;
}

export const DOTS_DEFAULT = 3;
export const DOTS_MAX = 20;

export function dotVotesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
	return doc.getMap("dotVotes");
}

export interface NewVote {
	scope: string | null;
	dots?: number;
	title?: string;
	hidden?: boolean;
	reactions?: boolean;
	endsAt?: string;
	by: Author;
	/** Your author key, if the server has said (it stamps it anyway). */
	starter?: string;
	at?: string;
}

/** Start a vote, and return its id. Call inside `transactLocal`. */
export function startVote(doc: Y.Doc, vote: NewVote): string {
	const id = crypto.randomUUID();
	const map = new Y.Map<unknown>();
	map.set("scope", vote.scope);
	map.set("dots", clampDots(vote.dots ?? DOTS_DEFAULT));
	if (vote.title?.trim()) map.set("title", vote.title.trim().slice(0, 120));
	map.set("hidden", Boolean(vote.hidden));
	map.set("reactions", Boolean(vote.reactions));
	if (vote.endsAt) map.set("endsAt", vote.endsAt);
	map.set("startedAt", vote.at ?? new Date().toISOString());
	map.set("by", { name: vote.by.name, color: vote.by.color });
	if (vote.starter) map.set("starter", vote.starter);
	map.set("ballots", new Y.Map());
	dotVotesMap(doc).set(id, map);
	return id;
}

function clampDots(dots: number): number {
	return Math.min(DOTS_MAX, Math.max(1, Math.round(Number.isFinite(dots) ? dots : DOTS_DEFAULT)));
}

export function readVote(id: string, map: Y.Map<unknown>): DotVote | null {
	const json = map.toJSON() as Partial<DotVote>;
	if (typeof json.dots !== "number" || typeof json.startedAt !== "string") return null;
	const ballots: Record<string, Ballot> = {};
	for (const [key, ballot] of Object.entries(json.ballots ?? {})) {
		if (isBallot(ballot)) ballots[key] = ballot;
	}
	return {
		id,
		scope: typeof json.scope === "string" ? json.scope : null,
		dots: clampDots(json.dots),
		...(json.title ? { title: json.title } : {}),
		hidden: Boolean(json.hidden),
		reactions: Boolean(json.reactions),
		...(json.endsAt ? { endsAt: json.endsAt } : {}),
		...(json.closedAt ? { closedAt: json.closedAt } : {}),
		...(json.closedBy ? { closedBy: json.closedBy } : {}),
		startedAt: json.startedAt,
		by: json.by ?? { name: "Someone", color: "" },
		...(typeof json.starter === "string" ? { starter: json.starter } : {}),
		ballots,
	};
}

function isBallot(value: unknown): value is Ballot {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Ballot).name === "string" &&
		typeof (value as Ballot).dots === "object"
	);
}

export function readVotes(doc: Y.Doc): DotVote[] {
	const votes: DotVote[] = [];
	for (const [id, map] of dotVotesMap(doc)) {
		if (!(map instanceof Y.Map)) continue;
		const vote = readVote(id, map);
		if (vote) votes.push(vote);
	}
	return votes.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
}

/** Whether a vote is open at `now` (epoch ms). */
export function isOpen(vote: Pick<DotVote, "closedAt" | "endsAt">, now: number): boolean {
	if (vote.closedAt) return false;
	return !vote.endsAt || Date.parse(vote.endsAt) > now;
}

/** When it closed: closed by someone, or when its window ended. */
export function closedAt(vote: DotVote, now: number): string | null {
	if (vote.closedAt) return vote.closedAt;
	if (vote.endsAt && Date.parse(vote.endsAt) <= now) return vote.endsAt;
	return null;
}

/** Close a vote now. */
export function closeVote(doc: Y.Doc, id: string, by: Author, at = new Date().toISOString()) {
	const map = dotVotesMap(doc).get(id);
	if (!map) return;
	map.set("closedAt", at);
	map.set("closedBy", { name: by.name, color: by.color });
}

/** Reopen a vote, live or until `endsAt`. */
export function reopenVote(doc: Y.Doc, id: string, endsAt?: string) {
	const map = dotVotesMap(doc).get(id);
	if (!map) return;
	map.delete("closedAt");
	map.delete("closedBy");
	if (endsAt) map.set("endsAt", endsAt);
	else map.delete("endsAt");
}

/** Remove a vote altogether. */
export function deleteVote(doc: Y.Doc, id: string) {
	dotVotesMap(doc).delete(id);
}

/** Shapes people vote on: anything but sections, connectors and widgets. */
export function isVotable(shape: Pick<ShapeProps, "type"> | undefined): boolean {
	return (
		!!shape && shape.type !== "section" && shape.type !== "connector" && shape.type !== "widget"
	);
}

/** The sections around a shape, innermost first. */
export function sectionsAround(
	shapes: ReadonlyMap<string, Pick<ShapeProps, "type" | "parent">>,
	id: string,
): string[] {
	const out: string[] = [];
	let parent = shapes.get(id)?.parent ?? null;
	while (parent && !out.includes(parent) && shapes.get(parent)?.type === "section") {
		out.push(parent);
		parent = shapes.get(parent)?.parent ?? null;
	}
	return out;
}

/** Whether a vote covers a shape. */
export function covers(
	vote: Pick<DotVote, "scope">,
	shapes: ReadonlyMap<string, Pick<ShapeProps, "type" | "parent">>,
	id: string,
): boolean {
	if (!isVotable(shapes.get(id))) return false;
	return vote.scope === null || sectionsAround(shapes, id).includes(vote.scope);
}

/**
 * The open vote a shape's dots go to: the innermost section's around it
 * with one open, else the board's.
 */
export function voteFor(
	votes: readonly DotVote[],
	shapes: ReadonlyMap<string, Pick<ShapeProps, "type" | "parent">>,
	id: string,
	now: number,
): DotVote | null {
	if (!isVotable(shapes.get(id))) return null;
	const open = votes.filter((vote) => isOpen(vote, now));
	for (const section of sectionsAround(shapes, id)) {
		const vote = open.find((v) => v.scope === section);
		if (vote) return vote;
	}
	return open.find((v) => v.scope === null) ?? null;
}

export function ballotOf(vote: DotVote, voter: Voter): Ballot | undefined {
	return vote.ballots[voterKey(voter)];
}

export function dotsUsed(ballot: Ballot | undefined): number {
	return Object.values(ballot?.dots ?? {}).reduce((n, dots) => n + Math.max(0, dots), 0);
}

export function dotsLeft(vote: DotVote, voter: Voter): number {
	return Math.max(0, vote.dots - dotsUsed(ballotOf(vote, voter)));
}

/**
 * Put one of your dots on a shape, if you have any left. Returns whether it
 * was placed. Call inside `transactLocal`.
 */
export function placeDot(
	doc: Y.Doc,
	voteId: string,
	voter: Voter & { color: string },
	shape: string,
	at = new Date().toISOString(),
): boolean {
	return changeDots(doc, voteId, voter, shape, +1, at);
}

/** Take one of your dots back off a shape. Returns whether there was one. */
export function removeDot(
	doc: Y.Doc,
	voteId: string,
	voter: Voter & { color: string },
	shape: string,
	at = new Date().toISOString(),
): boolean {
	return changeDots(doc, voteId, voter, shape, -1, at);
}

function changeDots(
	doc: Y.Doc,
	voteId: string,
	voter: Voter & { color: string },
	shape: string,
	by: 1 | -1,
	at: string,
): boolean {
	const map = dotVotesMap(doc).get(voteId);
	const ballots = map?.get("ballots");
	if (!map || !(ballots instanceof Y.Map)) return false;
	const vote = readVote(voteId, map);
	if (!vote) return false;
	const key = voterKey(voter);
	const ballot = vote.ballots[key];
	const dots = { ...ballot?.dots };
	const current = dots[shape] ?? 0;
	if (by > 0 && dotsUsed(ballot) >= vote.dots) return false;
	if (by < 0 && current <= 0) return false;
	if (current + by > 0) dots[shape] = current + by;
	else delete dots[shape];
	const next: Ballot = {
		name: voter.name,
		color: voter.color,
		...(voter.login ? { login: voter.login } : {}),
		dots,
		at,
	};
	ballots.set(key, next);
	return true;
}

/** Take all of your dots back. */
export function clearBallot(doc: Y.Doc, voteId: string, voter: Voter) {
	const ballots = dotVotesMap(doc).get(voteId)?.get("ballots");
	if (ballots instanceof Y.Map) ballots.delete(voterKey(voter));
}

/** Who put dots on one shape, and how many each. */
export interface Dotter {
	key: string;
	name: string;
	color: string;
	login?: string;
	dots: number;
}

export function dottersOn(vote: DotVote, shape: string): Dotter[] {
	const out: Dotter[] = [];
	for (const [key, ballot] of Object.entries(vote.ballots)) {
		const dots = ballot.dots[shape] ?? 0;
		if (dots > 0) {
			out.push({
				key,
				name: ballot.name,
				color: ballot.color,
				...(ballot.login ? { login: ballot.login } : {}),
				dots,
			});
		}
	}
	return out;
}

/** 👍 reactions that count as votes on a card, less those of people who voted on it here. */
export function reactionVotes(
	thumbsUp: Card["thumbsUp"] | undefined,
	dotters: readonly Pick<Dotter, "login">[],
): { count: number; logins: string[] } {
	if (!thumbsUp || thumbsUp.count <= 0) return { count: 0, logins: [] };
	const voted = new Set(dotters.flatMap((d) => (d.login ? [d.login.toLowerCase()] : [])));
	const known = thumbsUp.logins ?? [];
	const counted = known.filter((login) => !voted.has(login.toLowerCase()));
	const unknown = Math.max(0, thumbsUp.count - known.length);
	return { count: counted.length + unknown, logins: counted };
}

/** One row of a vote's tally. */
export interface TallyRow {
	shape: string;
	type: ShapeProps["type"];
	/** Dots on the board. */
	dots: number;
	/** 👍 on the forge counted as votes (reactions votes only). */
	reactions: number;
	total: number;
	dotters: Dotter[];
	/** Reactors counted, by login, when known. */
	reactors: string[];
	/** 1 for the most votes; shapes tied share a rank. */
	rank: number;
}

/**
 * A vote's results, most votes first: every shape it covers that has votes.
 * `card` looks up live card data, for reactions.
 */
export function tallyVote(
	vote: DotVote,
	doc: Y.Doc,
	card: (ref: string) => Card | MissingCard | undefined = () => undefined,
): TallyRow[] {
	const shapes = new Map<string, ShapeProps>();
	for (const [id, shape] of shapesMap(doc)) shapes.set(id, readShape(shape));
	const rows: Omit<TallyRow, "rank">[] = [];
	for (const [id, shape] of shapes) {
		if (!covers(vote, shapes, id)) continue;
		const dotters = dottersOn(vote, id);
		const dots = dotters.reduce((n, d) => n + d.dots, 0);
		let reactions = { count: 0, logins: [] as string[] };
		if (vote.reactions && shape.type === "card" && shape.ref) {
			const data = card(shape.ref);
			if (data && !("missing" in data)) reactions = reactionVotes(data.thumbsUp, dotters);
		}
		const total = dots + reactions.count;
		if (total === 0) continue;
		rows.push({
			shape: id,
			type: shape.type,
			dots,
			reactions: reactions.count,
			total,
			dotters,
			reactors: reactions.logins,
		});
	}
	rows.sort((a, b) => b.total - a.total || b.dots - a.dots || a.shape.localeCompare(b.shape));
	let rank = 0;
	let last = Number.NaN;
	return rows.map((row, i) => {
		if (row.total !== last) rank = i + 1;
		last = row.total;
		return { ...row, rank };
	});
}

/** How many people have voted, and how many dots are down. */
export function turnout(vote: DotVote): { voters: number; dots: number } {
	let voters = 0;
	let dots = 0;
	for (const ballot of Object.values(vote.ballots)) {
		const used = dotsUsed(ballot);
		if (used > 0) voters++;
		dots += used;
	}
	return { voters, dots };
}

/** "2d 4h", "3h 20m", "12m", "45s": how long until a time, roughly. */
export function formatRemaining(ms: number): string {
	if (ms <= 0) return "0s";
	const s = Math.ceil(ms / 1000);
	const d = Math.floor(s / 86_400);
	const h = Math.floor((s % 86_400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
	if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
	// Short votes count down by the second, like the timer.
	if (m < 10) return `${m}:${String(s % 60).padStart(2, "0")}`;
	return `${m}m`;
}
