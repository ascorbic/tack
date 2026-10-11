import type * as Y from "yjs";
import { fakeStackAi } from "../../shared/fakeStackAi.ts";
import { addShape, nextZ, readShape, shapesMap } from "../../shared/shapes.ts";
import { applyGrouping, setStackName, stackUp } from "../../shared/stackEdits.ts";
import { type StackAi, StackNamer } from "../../shared/stackNamer.ts";
import { addSection, readShapes } from "../../shared/structure.ts";
import { stackStore } from "../stacks/store.ts";

// Stacks on /play (#73): `?scenario=stacks` seeds a planning session's
// theming, and `SimulatedStacks` stands in for the board's server, naming
// stacks and answering "Group these" with the same stand-in local dev uses
// (fakeStackAi.ts), in the browser. Its mode is the playground's "AI
// suggestions" switch: on, slow, failing or off.

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

/** A theming session: stickies to sort, a stack someone named, and one with a suggested name. */
export function seedStacks(doc: Y.Doc): void {
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
			sticky(doc, "Srcset generation is slow on big sites", "orange", 1080, 80, 0),
			sticky(doc, "Builds got 2x slower in 4.3", "orange", 1100, 100, 1),
			sticky(doc, "Dev server lags with 500 images", "orange", 1120, 120, 2),
		];
		const named = stackUp(doc, perf[0] as string, perf.slice(1));
		if (named) setStackName(doc, named, "Big sites are slow");
		// And one Group these made: its name's a suggestion until someone keeps it.
		const onboarding = [
			sticky(doc, "First-time contributors don't know where to start", "purple", 1080, 420, 3),
			sticky(doc, "Newcomers bounce off the monorepo setup", "purple", 1100, 440, 0),
		];
		applyGrouping(doc, [{ name: "Newcomer onboarding", ids: onboarding, at: { x: 1068, y: 410 } }]);
		// Around it all, taking it in.
		addSection(
			doc,
			{ x: 0, y: 0, w: 1500, h: 900 },
			{ title: "What should 5.0 fix?", color: "blue" },
		);
	});
}

export class SimulatedStacks {
	private namer: StackNamer | null = null;
	private mode: StackAiMode = "on";

	constructor(private readonly doc: Y.Doc) {}

	/** Start naming, and answer the board's "Group these". Returns a function to stop. */
	install(): () => void {
		const fake = fakeStackAi(600);
		const slow = fakeStackAi(4000);
		const failing: StackAi = {
			name: () => new Promise((_, reject) => setTimeout(() => reject(new Error("3040")), 800)),
			group: () => new Promise((_, reject) => setTimeout(() => reject(new Error("3040")), 1200)),
		};
		this.namer = new StackNamer({
			doc: this.doc,
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
				void this.namer
					?.group(request.ids)
					.then((outcome) =>
						stackStore.apply(
							outcome.ok
								? { type: "stack-groups", request: request.request, stacks: outcome.stacks }
								: { type: "stack-group-failed", request: request.request, reason: outcome.reason },
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
