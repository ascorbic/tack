import type * as Y from "yjs";
import type { Card } from "../../shared/cards.ts";
import { fakeStackAi } from "../../shared/fakeStackAi.ts";
import { addShape, nextZ, readShape, shapesMap } from "../../shared/shapes.ts";
import { applyGrouping, setStackName, stackUp } from "../../shared/stackEdits.ts";
import { type StackAi, StackNamer } from "../../shared/stackNamer.ts";
import { addSection, readShapes } from "../../shared/structure.ts";
import { cardStore } from "../cardStore.ts";
import { stackStore } from "../stacks/store.ts";
import type { RemoteAi } from "./ai.ts";
import { fixture } from "./fixtures.ts";

// Stacks on /play (#73): `?scenario=stacks` seeds a planning session's
// theming, issues and pull requests among the stickies, and
// `SimulatedStacks` stands in for the board's server, naming stacks and
// answering "Group these" with the same stand-in local dev uses
// (fakeStackAi.ts), in the browser. As the server does, it only names from
// the titles of cards everyone could read (here, a public repository's). Its
// mode is the playground's "AI suggestions" switch: on, slow, failing or off.
// The public demo gives it a real model to ask first (`withRemote`).

const REPO = "ascorbic/unpic";

/** Issues and pull requests on the theming board: one from a private repository. */
export const STACK_CARDS: Card[] = [
	fixture({
		repo: REPO,
		item: "#701",
		title: "Write release notes for the 5.0 migration",
		visibility: "public",
	}),
	fixture({
		repo: REPO,
		item: "#712",
		kind: "pull",
		title: "Changelog entries for the new loader API",
		visibility: "public",
	}),
	fixture({
		repo: REPO,
		item: "#688",
		title: "Version notes skip breaking changes",
		state: "closed",
		stateReason: "completed",
		visibility: "public",
	}),
	fixture({
		repo: REPO,
		item: "#720",
		title: "Dev server lags with large image folders",
		visibility: "public",
	}),
	fixture({
		repo: REPO,
		item: "#722",
		kind: "pull",
		title: "perf: cache srcset results between builds",
		state: "merged",
		visibility: "public",
	}),
	fixture({
		repo: "ascorbic/tack-internal",
		item: "#9",
		title: "Embargoed: the 5.0 launch date",
		visibility: "private",
	}),
];

function card(doc: Y.Doc, item: Card, x: number, y: number): string {
	const id = crypto.randomUUID();
	addShape(doc, id, { type: "card", ref: item.key, x, y, z: nextZ(doc) });
	return id;
}

export type StackAiMode = "on" | "slow" | "failing" | "off";

const AUTHORS = [
	{ name: "Priya Shah", color: "#b4467a" },
	{ name: "Kai Andersen", color: "#1f7a6b" },
	{ name: "Tom Okafor", color: "#a35a12" },
	{ name: "Jo Rivera", color: "#5b5fc7" },
];

/** What people wrote, still to sort: themes the fake recognises, and a few that fit nowhere. */
const LOOSE: [string, string][] = [
	["Provider docs are hard to find, I end up reading source", "yellow"],
	["CI takes 25 minutes on a good day", "pink"],
	["No example for a custom image loader", "yellow"],
	["Flaky e2e on Windows", "pink"],
	["Changelog doesn't credit contributors", "green"],
	["Can't rerun one job in the build", "pink"],
	["Which CDN options exist? Couldn't tell from the docs", "yellow"],
	["Release notes are thin", "green"],
	["A logo?", "blue"],
	["Getting started guide skips the config file", "yellow"],
	["Breaking changes buried in commits, not the release notes", "green"],
];

function sticky(doc: Y.Doc, text: string, color: string, x: number, y: number, i: number): string {
	const id = crypto.randomUUID();
	addShape(doc, id, {
		type: "sticky",
		text,
		color,
		author: AUTHORS[i % AUTHORS.length],
		x,
		y,
		z: nextZ(doc),
	});
	return id;
}

/**
 * A theming session: stickies and cards to sort, a stack someone named, one
 * with a suggested name, and one of stickies, issues and a pull request.
 */
export function seedStacks(doc: Y.Doc): void {
	for (const item of STACK_CARDS) cardStore.set(item);
	const [notes, loader, versions, lags, srcset, embargo] = STACK_CARDS as [
		Card,
		Card,
		Card,
		Card,
		Card,
		Card,
	];
	doc.transact(() => {
		LOOSE.forEach(([text, color], i) => {
			const column = i % 4;
			const row = Math.floor(i / 4);
			// A little scattered, as stickies are after a brainstorm.
			const jitter = ((i * 37) % 23) - 11;
			sticky(doc, text, color, 40 + column * 230 + jitter, 60 + row * 240 + jitter, i);
		});
		// A stack someone named themselves.
		const perf = [
			sticky(doc, "Srcset generation is slow on big sites", "blue", 1080, 80, 0),
			sticky(doc, "Builds got 2x slower in 4.3", "blue", 1100, 100, 1),
			sticky(doc, "Dev server lags with 500 images", "blue", 1120, 120, 2),
		];
		const named = stackUp(doc, perf[0] as string, perf.slice(1));
		if (named) setStackName(doc, named, "Big sites are slow");
		// And one Group these made: its name's a suggestion until someone keeps it.
		const onboarding = [
			sticky(doc, "First-time contributors don't know where to start", "purple", 1080, 420, 3),
			sticky(doc, "Newcomers bounce off the monorepo setup", "purple", 1100, 440, 0),
		];
		applyGrouping(doc, [{ name: "Newcomer onboarding", ids: onboarding, at: { x: 1068, y: 410 } }]);
		// Stickies, issues and a pull request about the same thing: named from
		// all of them, but for the private one, which only counts.
		// The first at the bottom, the sticky on top.
		const release = [
			card(doc, embargo, 1300, 650),
			card(doc, versions, 1300, 650),
			card(doc, loader, 1300, 650),
			card(doc, notes, 1300, 650),
			sticky(doc, "Upgrade notes for 5.0 are missing", "green", 1300, 650, 1),
		];
		stackUp(doc, release[0] as string, release.slice(1));
		// Loose cards, to drag onto a stack.
		card(doc, lags, 40, 760);
		card(doc, srcset, 330, 760);
		// Around it all, taking it in.
		addSection(
			doc,
			{ x: 0, y: 0, w: 1580, h: 920 },
			{ title: "What should 5.0 fix?", color: "blue" },
		);
	});
}

/** How long the real model gets before the stand-in answers instead. */
const REMOTE_TIMEOUT_MS = { name: 12_000, group: 30_000 } as const;

/**
 * A real model asked first, with the stand-in answering whenever it doesn't
 * (`remote` answers null): the public demo's (src/client/try/ai.ts).
 */
export function withRemote(remote: RemoteAi, standIn: StackAi): StackAi {
	return {
		name: async (texts) =>
			(await remote.ask({ task: "name", texts: [...texts] }, REMOTE_TIMEOUT_MS.name)) ??
			standIn.name(texts),
		group: async (notes) =>
			(await remote.ask(
				{ task: "group", notes: notes.map(({ id, text }) => ({ id, text })) },
				REMOTE_TIMEOUT_MS.group,
			)) ?? standIn.group(notes),
	};
}

export class SimulatedStacks {
	namer: StackNamer | null = null;
	private mode: StackAiMode = "on";

	/** `remote`, if given, is asked before the stand-in: the public demo's real AI. */
	constructor(
		private readonly doc: Y.Doc,
		private readonly remote: RemoteAi | null = null,
	) {}

	/** Start naming, and answer the board's "Group these". Returns a function to stop. */
	install(): () => void {
		const fake = this.remote ? withRemote(this.remote, fakeStackAi(200)) : fakeStackAi(600);
		const slow = fakeStackAi(4000);
		const failing: StackAi = {
			name: () => new Promise((_, reject) => setTimeout(() => reject(new Error("3040")), 800)),
			group: () => new Promise((_, reject) => setTimeout(() => reject(new Error("3040")), 1200)),
		};
		this.namer = new StackNamer({
			doc: this.doc,
			// As the server: only titles everyone on the board could read.
			cardTitles: async (refs) => {
				const out = new Map<string, string>();
				for (const ref of refs) {
					const entry = cardStore.get(ref);
					if (entry && !("missing" in entry) && entry.visibility === "public") {
						out.set(ref, entry.title);
					}
				}
				return out;
			},
			ai: () =>
				this.mode === "off"
					? null
					: this.mode === "slow"
						? slow
						: this.mode === "failing"
							? failing
							: fake,
			debounceMs: 900,
		});
		this.namer.start();
		stackStore.setAi(this.mode !== "off");
		stackStore.channel = {
			send: (request) => {
				void this.namer?.group(request.ids).then((outcome) =>
					stackStore.apply(
						outcome.ok
							? {
									type: "stack-groups",
									request: request.request,
									stacks: outcome.stacks,
									withheld: outcome.withheld,
								}
							: {
									type: "stack-group-failed",
									request: request.request,
									reason: outcome.reason,
									...(outcome.reason === "too_few" && outcome.withheld > 0
										? { withheld: outcome.withheld }
										: {}),
								},
					),
				);
			},
		};
		return () => {
			this.namer?.stop();
			this.namer = null;
			stackStore.channel = null;
			stackStore.reset();
		};
	}

	setMode(mode: StackAiMode): void {
		this.mode = mode;
		stackStore.setAi(mode !== "off");
		// Try again now, rather than after the last failure's wait.
		if (this.namer && mode !== "off") {
			this.namer.forgetFailures();
			this.namer.schedule(0);
		}
	}

	/** Someone else (on their own `doc`) drops a sticky onto another, as a person would: a new stack. */
	someoneStacks(doc: Y.Doc): string | null {
		const shapes = readShapes(doc);
		const loose = [...shapes]
			.filter(([, shape]) => shape.type === "sticky" && !shape.stack && shape.text)
			.map(([id]) => id);
		const [target, dropped] = loose.slice(-2);
		if (!target || !dropped) return null;
		return stackUp(doc, target, [dropped]);
	}

	/** Someone else adds a word to a stack's top sticky: its suggestion follows. */
	someoneEdits(doc: Y.Doc): void {
		const map = shapesMap(doc);
		for (const [, shape] of map) {
			const props = readShape(shape);
			if (props.type === "sticky" && typeof props.stack === "string" && props.text) {
				doc.transact(() => shape.set("text", `${props.text} (still)`));
				return;
			}
		}
	}
}
