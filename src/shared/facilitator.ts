import * as Y from "yjs";
import { type DotVote, dotVotesMap, isOpen, readVotes } from "./dotvotes.ts";
import {
	FACILITATION_ORIGIN,
	type Timer,
	type TimerAction,
	readTimer,
	timerDone,
} from "./facilitation.ts";
import { shapesMap } from "./shapes.ts";
import { parseSession } from "./silent.ts";

// Who runs a session (#50, #48, #49). There's no facilitator role to hand
// out: whoever starts something (the timer, a dot vote, silent mode) runs
// it, and the board's owner can always step in. So that nothing is ever
// stuck, once whoever started something has left the board, any editor may
// take it over.
//
// People are known by their author key, the same one silent mode uses for
// hidden text: `u:{GitHub id}` signed in, `a:{hash of a secret their
// browser keeps}` for a guest, else `c:{connection}`. The server tells each
// connection its own (`facilitation-you`) and everyone who's here
// (`facilitation-present`), and stamps the starter on what's started, so
// clients only offer what the server will allow.

/** Who you are to facilitation, as the board's server knows you. */
export interface FacilitationYou {
	author: string;
	editor: boolean;
	owner: boolean;
}

/**
 * Whether someone may control what `starter` started (pause the timer,
 * close or reopen a vote, reveal silent mode): whoever started it, the
 * board's owner, or once its starter has left the board, any editor.
 * Something from before starters were recorded is anyone's.
 */
export function mayControl(
	you: FacilitationYou | null,
	starter: string | null | undefined,
	present: ReadonlySet<string>,
): boolean {
	if (!you?.editor) return false;
	if (!starter || you.author === starter || you.owner) return true;
	return !present.has(starter);
}

/**
 * Whether someone may delete what `starter` started (a vote, with
 * everyone's ballots): only whoever started it, or the board's owner.
 */
export function mayDelete(
	you: FacilitationYou | null,
	starter: string | null | undefined,
): boolean {
	if (!you?.editor) return false;
	return !starter || you.author === starter || you.owner;
}

/**
 * Whether someone may change the timer: anyone may start one while none is
 * counting down, but pausing, adding to, stopping or replacing a running
 * one is for whoever may control it.
 */
export function mayChangeTimer(
	you: FacilitationYou | null,
	action: TimerAction["action"],
	timer: Timer | null,
	present: ReadonlySet<string>,
	now: number,
): boolean {
	if (!you?.editor) return false;
	if (!timer || (action === "start" && timerDone(timer, now))) return true;
	return mayControl(you, timer.starter, present);
}

/** Whoever started something still running:the timer, an open vote, a silent section. */
export function runningStarters(doc: Y.Doc, now: number): Set<string> {
	const starters = new Set<string>();
	const timer = readTimer(doc);
	if (timer?.starter && !timerDone(timer, now)) starters.add(timer.starter);
	for (const vote of readVotes(doc)) {
		if (vote.starter && isOpen(vote, now)) starters.add(vote.starter);
	}
	for (const shape of shapesMap(doc).values()) {
		if (shape.get("type") !== "section") continue;
		const starter = parseSession(shape.get("silent"))?.starter;
		if (starter) starters.add(starter);
	}
	return starters;
}

/**
 * Whether someone is running the session: the board's owner, or whoever
 * started something still running. Facilitators can take over or end
 * someone else's spotlight.
 */
export function isFacilitator(you: FacilitationYou | null, doc: Y.Doc, now: number): boolean {
	if (!you?.editor) return false;
	return you.owner || runningStarters(doc, now).has(you.author);
}

// --- Keeping votes in the hands of whoever runs them -------------------------------

/** A vote's settings: only whoever may control the vote changes these. */
const SETTINGS = new Set([
	"scope",
	"dots",
	"title",
	"hidden",
	"reactions",
	"endsAt",
	"closedAt",
	"closedBy",
	"startedAt",
	"by",
	"starter",
]);

type VoteJSON = Omit<DotVote, "id" | "ballots"> & { ballots?: Record<string, unknown> };

export interface VoteGuardHost {
	doc: Y.Doc;
	/**
	 * Who made a transaction, from its origin: a person's connection, or
	 * null for the server's own writes, which are always allowed.
	 */
	actor(origin: unknown): FacilitationYou | null;
	/** Author keys of everyone on the board now. */
	present(): ReadonlySet<string>;
	log?(level: "info" | "warn", event: string, context: Record<string, unknown>): void;
}

/**
 * Dot votes are in the document, which every editor can write, so the
 * server puts right what people mayn't do (as `SilentHub.reconcile` does
 * for silent marks): a new vote's starter is whoever made it; only those
 * who may control a vote (`mayControl`) close, reopen or change it; and
 * only its starter or the owner deletes it (`mayDelete`), else it comes
 * back, ballots and all. Ballots themselves are everyone's to change.
 */
export class VoteGuard {
	/** Each vote as last allowed, to put back what shouldn't have changed. */
	private shadow = new Map<string, VoteJSON>();
	private fixes: (() => void)[] = [];
	private scheduled = false;

	constructor(private readonly host: VoteGuardHost) {
		const votes = dotVotesMap(host.doc);
		for (const [id, map] of votes) this.remember(id, map);
		votes.observeDeep((events, transaction) => this.check(events, transaction));
	}

	private remember(id: string, map: unknown): void {
		if (map instanceof Y.Map) this.shadow.set(id, map.toJSON() as VoteJSON);
		else this.shadow.delete(id);
	}

	private check(events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction): void {
		const votes = dotVotesMap(this.host.doc);
		const actor =
			transaction.origin === FACILITATION_ORIGIN ? null : this.host.actor(transaction.origin);
		const touched = new Set<string>();
		for (const event of events) {
			if (event.target === votes) {
				for (const [id, change] of event.changes.keys) {
					touched.add(id);
					if (!actor) continue;
					const before = this.shadow.get(id);
					if (change.action === "add" && !before) {
						const map = votes.get(id);
						if (map instanceof Y.Map && map.get("starter") !== actor.author) {
							this.fix(() => {
								if (votes.get(id) === map) map.set("starter", actor.author);
							});
						}
					} else if (change.action === "delete" && before) {
						if (!mayDelete(actor, before.starter)) {
							this.refuse("delete", id);
							this.fix(() => {
								if (!votes.has(id)) votes.set(id, rebuild(before));
							});
						}
					} else if (before && !mayControl(actor, before.starter, this.host.present())) {
						this.refuse("replace", id);
						this.fix(() => votes.set(id, rebuild(before)));
					}
				}
				continue;
			}
			const id = event.path[0];
			if (typeof id !== "string") continue;
			touched.add(id);
			// Inside a ballot (someone's dots) is anyone's.
			if (!actor || event.path.length !== 1) continue;
			const before = this.shadow.get(id);
			const map = event.target as Y.Map<unknown>;
			if (!before) continue;
			const allowed = mayControl(actor, before.starter, this.host.present());
			for (const key of event.changes.keys.keys()) {
				// Nobody changes who started a vote but the server.
				const settled = key === "starter" || (SETTINGS.has(key) && !allowed);
				const ballots = key === "ballots" && !allowed;
				if (!settled && !ballots) continue;
				this.refuse(key, id);
				const old = (before as Record<string, unknown>)[key];
				this.fix(() => {
					if (votes.get(id) !== map) return;
					if (key === "ballots") map.set("ballots", ballotsMap(before.ballots));
					else if (old === undefined) map.delete(key);
					else map.set(key, old);
				});
			}
		}
		for (const id of touched) this.remember(id, votes.get(id));
	}

	private refuse(what: string, vote: string): void {
		this.host.log?.("warn", "vote.refused", { vote, what });
	}

	private fix(fix: () => void): void {
		this.fixes.push(fix);
		if (this.scheduled) return;
		this.scheduled = true;
		// After this transaction, as one of the server's own.
		queueMicrotask(() => {
			this.scheduled = false;
			const fixes = this.fixes;
			this.fixes = [];
			this.host.doc.transact(() => {
				for (const fix of fixes) fix();
			}, FACILITATION_ORIGIN);
		});
	}
}

function ballotsMap(ballots: Record<string, unknown> | undefined): Y.Map<unknown> {
	const map = new Y.Map<unknown>();
	for (const [key, ballot] of Object.entries(ballots ?? {})) map.set(key, ballot);
	return map;
}

/** A vote as it was, made again. */
function rebuild(json: VoteJSON): Y.Map<unknown> {
	const map = new Y.Map<unknown>();
	for (const [key, value] of Object.entries(json)) {
		if (key === "ballots") continue;
		if (value !== undefined) map.set(key, value);
	}
	map.set("ballots", ballotsMap(json.ballots));
	return map;
}
