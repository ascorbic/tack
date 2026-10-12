import type * as Y from "yjs";
import { FACILITATION_ORIGIN } from "../../shared/facilitation.ts";
import {
	type Actor,
	type Attribution,
	HistoryLog,
	MemoryHistoryStore,
	type Segment,
	type Timeline,
} from "../../shared/history.ts";
import { addCardShape } from "../../shared/provenance.ts";
import { REPAIR_ORIGIN } from "../../shared/repair.ts";
import { RULE_ORIGIN } from "../../shared/rules.ts";
import { LOCAL_ORIGIN, addShape, nextZ, shapesMap } from "../../shared/shapes.ts";
import { SILENT_ORIGIN } from "../../shared/silent.ts";
import { addConnector, addSection } from "../../shared/structure.ts";
import { cardStore } from "../cardStore.ts";
import type { HistorySource } from "../history/source.ts";
import type { User } from "../presence.ts";
import { PLANNING_CARDS } from "./fixtures.ts";
import { SERVER_ORIGIN } from "./push.ts";
import type { SimulatedBoard } from "./simulator.ts";

// A pretend history server for the playground (#47): the same `HistoryLog`
// the board's Durable Object runs, over memory, recording the playground's
// document as you and the simulated people edit it, and flushing as the
// board's saves would. `?scenario=history` starts with three days of a retro
// already behind it, thinned as the server would have thinned it.

export type HistoryMode = "live" | "slow" | "failing";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The people in the scripted past, by the origin their edits carry. */
export const HISTORY_PEOPLE: Record<string, Actor> = {
	priya: { key: "u:9001", name: "Priya Shah", color: "#b4467a", login: "priya" },
	kai: { key: "u:9002", name: "Kai Andersen", color: "#1f7a6b", login: "kai" },
	tom: { key: "u:9003", name: "Tom Okafor", color: "#a35a12", login: "tom" },
	jo: { key: "u:9004", name: "Jo Rivera", color: "#5b5fc7", login: "jo" },
};

const SYSTEM: Record<string, Actor> = {
	[SERVER_ORIGIN]: { key: "sys:push", name: "Push", color: "", system: "push" },
	[RULE_ORIGIN]: { key: "sys:rule", name: "Rules", color: "", system: "rule" },
	[SILENT_ORIGIN]: { key: "sys:reveal", name: "Silent mode", color: "", system: "reveal" },
	[FACILITATION_ORIGIN]: { key: "sys:timer", name: "Timer", color: "", system: "timer" },
	[REPAIR_ORIGIN]: { key: "sys:repair", name: "Tack", color: "", system: "repair" },
};

export class SimulatedHistory implements HistorySource {
	readonly log: HistoryLog;
	mode: HistoryMode = "live";
	/** The pretend server's clock: real time, unless a script is replaying the past. */
	private clock: number | null = null;
	private timer = 0;

	constructor(
		private readonly sim: Pick<SimulatedBoard, "doc" | "people">,
		private readonly you: () => User,
		/** What it's recorded already, e.g. kept in the browser by the public demo (#75). */
		readonly store = new MemoryHistoryStore(),
	) {
		this.log = new HistoryLog({
			doc: sim.doc,
			store: this.store,
			now: () => this.clock ?? Date.now(),
			attribute: (origin) => this.attribute(origin),
		});
		this.log.start();
		// The board saves every couple of seconds while people edit.
		this.timer = window.setInterval(() => this.log.flush(), 2000);
	}

	destroy(): void {
		clearInterval(this.timer);
		this.log.stop();
	}

	async timeline(): Promise<Timeline> {
		await this.answer();
		this.log.flush();
		// A copy, as if it came over the wire.
		return structuredClone(this.log.timeline());
	}

	async segment(step: number): Promise<Segment> {
		await this.answer();
		const segment = this.log.segment(step);
		if (!segment) throw new Error("No such step");
		return structuredClone(segment);
	}

	/** Run `edits` as if they'd happened `ago` ms before now, each flushed as its own save. */
	past(script: readonly ScriptStep[]): void {
		const now = Date.now();
		// A board with no history yet: it starts just before the script does.
		const steps = this.store.steps();
		const first = script[0];
		if (steps.length === 1 && steps[0]?.origin && first) {
			const at = now - first.ago - 60_000;
			this.store.putStep({ ...steps[0], at, until: at }, null);
		}
		for (const step of script) {
			this.clock = now - step.ago;
			this.sim.doc.transact(() => step.edit(this.sim.doc), step.who);
			this.log.flush();
		}
		this.clock = null;
		// What the server would have done with it by now.
		this.log.compact(now);
	}

	private attribute(origin: unknown): Attribution {
		if (origin === LOCAL_ORIGIN) {
			const user = this.you();
			const key = user.login ? `u:you-${user.login}` : "g:you";
			return { key, actor: { key, name: user.name, color: user.color, login: user.login } };
		}
		if (typeof origin === "string") {
			const person = HISTORY_PEOPLE[origin];
			if (person) return { key: person.key, actor: person };
			const system = SYSTEM[origin];
			if (system) return { key: system.key, actor: system };
		}
		const person = this.sim.people.find((p) => p.origin === origin);
		if (person) {
			const key = `g:${person.user.name}`;
			return { key, actor: { key, name: person.user.name, color: person.user.color } };
		}
		return {
			key: "sys:server",
			actor: { key: "sys:server", name: "Tack", color: "", system: "server" },
		};
	}

	private async answer(): Promise<void> {
		if (this.mode === "failing") {
			await sleep(400);
			throw new Error(
				"Couldn’t load the board’s history: the pretend server is failing on purpose.",
			);
		}
		await sleep(this.mode === "slow" ? 1600 : 120);
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ScriptStep {
	/** How long before now it happened. */
	ago: number;
	/** Who did it: a key of `HISTORY_PEOPLE`. */
	who: string;
	edit(doc: Y.Doc): void;
}

function sticky(
	doc: Y.Doc,
	id: string,
	text: string,
	color: string,
	x: number,
	y: number,
	who: string,
	parent: string | null = null,
) {
	const author = HISTORY_PEOPLE[who];
	addShape(doc, id, {
		type: "sticky",
		x,
		y,
		z: nextZ(doc),
		text,
		color,
		parent,
		author: author ? { name: author.name, color: author.color } : undefined,
	});
}

const set = (doc: Y.Doc, id: string, props: Record<string, unknown>) => {
	const shape = shapesMap(doc).get(id);
	if (shape) for (const [key, value] of Object.entries(props)) shape.set(key, value);
};

/**
 * Three days of a retro: sections made, stickies written, moved and sorted,
 * cards added, a sticky deleted ("Flaky CI on Windows", to bring back), a
 * whole section removed ("Parking lot"), and today's tidying up.
 */
export function retroHistory(now = Date.now()): ScriptStep[] {
	// Morning, three days ago.
	const day = (n: number, hour: number, minute = 0) => {
		const date = new Date(now - n * DAY);
		date.setHours(hour, minute, 0, 0);
		return Math.max(MINUTE, now - date.getTime());
	};
	const steps: ScriptStep[] = [];
	const at = (ago: number, who: string, edit: (doc: Y.Doc) => void) =>
		steps.push({ ago, who, edit });

	at(day(3, 10, 2), "priya", (doc) => {
		addSection(
			doc,
			{ x: 0, y: 0, w: 620, h: 520 },
			{ id: "well", title: "What went well", color: "green" },
		);
		addSection(
			doc,
			{ x: 680, y: 0, w: 620, h: 520 },
			{ id: "hurts", title: "What hurts", color: "red" },
		);
		addSection(
			doc,
			{ x: 1360, y: 0, w: 620, h: 520 },
			{ id: "ideas", title: "Ideas", color: "blue" },
		);
	});
	at(day(3, 10, 4), "priya", (doc) => {
		addSection(
			doc,
			{ x: 0, y: 600, w: 620, h: 360 },
			{ id: "parking", title: "Parking lot", color: "grey" },
		);
	});
	const well = [
		["shipped", "Shipped image CDN support on time", "green", 40, 60, "priya"],
		["docs", "The new docs search is great", "yellow", 240, 60, "kai"],
		["reviews", "Reviews got faster this cycle", "green", 40, 260, "tom"],
	] as const;
	const hurts = [
		["flaky", "Flaky CI on Windows", "pink", 720, 60, "kai"],
		["release", "Release notes by hand take hours", "yellow", 920, 60, "tom"],
		["oncall", "On-call handover is unclear", "pink", 720, 260, "jo"],
	] as const;
	const ideas = [
		["bot", "A bot that drafts release notes", "blue", 1400, 60, "jo"],
		["matrix", "Trim the CI matrix", "purple", 1600, 60, "kai"],
	] as const;
	let minute = 6;
	for (const [id, text, color, x, y, who] of [...well, ...hurts, ...ideas]) {
		const section = x < 640 ? "well" : x < 1320 ? "hurts" : "ideas";
		at(day(3, 10, minute), who, (doc) => sticky(doc, id, "", color, x, y, who, section));
		at(day(3, 10, minute) - 20_000, who, (doc) => set(doc, id, { text }));
		minute += 2;
	}
	at(day(3, 10, 40), "priya", (doc) => {
		sticky(doc, "later-1", "Monorepo?", "yellow", 40, 660, "priya", "parking");
		sticky(doc, "later-2", "Rename the CLI", "yellow", 240, 660, "priya", "parking");
	});
	at(day(3, 14, 30), "jo", (doc) => {
		const [first, second] = PLANNING_CARDS;
		if (first) {
			cardStore.set(first);
			addCardShape(doc, "card-a", { ref: first.key, x: 1400, y: 280, parent: "ideas" });
		}
		if (second) {
			cardStore.set(second);
			addCardShape(doc, "card-b", { ref: second.key, x: 1700, y: 300, parent: "ideas" });
		}
	});
	at(day(3, 14, 32), "jo", (doc) => {
		addConnector(doc, {
			from: { x: 1488, y: 236, shape: "matrix" },
			to: { x: 1500, y: 280, shape: "card-b" },
		});
	});
	// Two days ago: sorting.
	at(day(2, 9, 15), "kai", (doc) => {
		set(doc, "release", { x: 940, y: 300 });
		set(doc, "oncall", { color: "yellow" });
	});
	at(day(2, 9, 18), "kai", (doc) => shapesMap(doc).delete("flaky"));
	at(day(2, 16, 40), "tom", (doc) => {
		set(doc, "hurts", { w: 700, h: 560 });
		set(doc, "release", { text: "Release notes by hand take hours (every time!)" });
	});
	// Yesterday: the parking lot goes.
	at(day(1, 11, 5), "priya", (doc) => {
		shapesMap(doc).delete("later-1");
		shapesMap(doc).delete("later-2");
		shapesMap(doc).delete("parking");
	});
	at(day(1, 11, 9), "jo", (doc) =>
		sticky(doc, "handbook", "Write an on-call handbook", "green", 1400, 260, "jo", "ideas"),
	);
	// Today.
	at(2 * HOUR, "kai", (doc) => {
		sticky(doc, "cache", "Cache the toolchain in CI", "purple", 1600, 260, "kai", "ideas");
		set(doc, "handbook", { y: 300, x: 1600 });
	});
	at(20 * MINUTE, "tom", (doc) => set(doc, "docs", { x: 260, y: 280, color: "green" }));
	at(6 * MINUTE, "priya", (doc) => set(doc, "well", { title: "What went well 🎉" }));
	return steps;
}
