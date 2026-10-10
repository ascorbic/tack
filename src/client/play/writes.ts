import type * as Y from "yjs";
import type { Card } from "../../shared/cards.ts";
import { OPERATION_KINDS } from "../../shared/changes.ts";
import { withFallbacks } from "../../shared/connectors.ts";
import type { RepoMeta } from "../../shared/push.ts";
import { boxOf } from "../../shared/sections.ts";
import { type ConnectorEnd, addShape, nextZ, readShape, shapesMap } from "../../shared/shapes.ts";
import { addConnector, addSection } from "../../shared/structure.ts";
import type { WriteServices } from "../actions/services.ts";
import { cardStore } from "../cardStore.ts";
import { ACCESS_GALLERY, LABELS, fixture } from "./fixtures.ts";
import { playRelated } from "./related.ts";

// Writing back (M2) in the playground: a board to try the selection actions
// on, and stand-ins for the Worker's repository metadata and snapshot
// uploads, so it all works without a server or GitHub.

const LATER = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

/** Labels, milestones and people for fake repositories. */
export function fakeMeta(repo: string): RepoMeta | null {
	const name = repo.split("/").slice(1).join("/");
	if (!name.includes("/")) return null;
	// The upstream repository doesn't have the app: read-only.
	const writable = !name.startsWith("lovell/");
	return {
		repo,
		labels: [
			...Object.values(LABELS),
			{ name: "performance", color: "f9d0c4", description: "Faster, smaller, lighter" },
			{ name: "question", color: "d876e3", description: "Further information is requested" },
			{ name: "wontfix", color: "e4e669" },
		].map((label) => ({
			...label,
			description:
				"description" in label
					? label.description
					: label.name === "bug"
						? "Something isn’t working"
						: undefined,
		})),
		milestones: [
			{ title: "5.0", dueOn: LATER(18) },
			{ title: "5.1", dueOn: LATER(60) },
			{ title: "Someday", dueOn: null },
		],
		assignees: ["priya", "kai", "tom", "jo", "ascorbic"],
		discussionCategories: ["Ideas", "Q&A"],
		watchers: 214,
		defaultBranch: "main",
		writable,
		writes: [...OPERATION_KINDS],
	};
}

/** Snapshots the playground has "uploaded", newest last, for poking at. */
export const uploadedSnapshots: { url: string; bytes: number }[] = [];

export function playServices(): WriteServices {
	// For poking at from the console, and for the e2e tests.
	Object.assign(window, { tackSnapshots: uploadedSnapshots });
	return {
		boardId: "play",
		boardUrl: () => `${location.origin}/play`,
		boardTitle: () => "Playground",
		async repoMeta(repo) {
			// A little latency, so the loading states get seen.
			await new Promise((resolve) => setTimeout(resolve, 250));
			return fakeMeta(repo);
		},
		async uploadSnapshot(png) {
			await new Promise((resolve) => setTimeout(resolve, 400));
			const url = URL.createObjectURL(png);
			uploadedSnapshots.push({ url, bytes: png.size });
			return url;
		},
		related: playRelated,
	};
}

// The scenario ---------------------------------------------------------------------

const VAULT = "acme/vault";

const CARDS: Card[] = [
	fixture({
		item: "#412",
		title: "Drop Node 18 support",
		labels: [LABELS.breaking, LABELS.enhancement],
		comments: 14,
		visibility: "public",
	}),
	fixture({
		item: "#377",
		title: "Custom domains aren’t detected for Cloudinary",
		labels: [LABELS.bug, LABELS.provider],
		comments: 9,
		visibility: "public",
	}),
	fixture({
		item: "#431",
		title: "Document every provider’s options",
		labels: [LABELS.docs],
		visibility: "public",
	}),
	fixture({
		item: "#398",
		state: "closed",
		stateReason: "not_planned",
		title: "Keep Node 18 support in the 5.x line",
		visibility: "public",
	}),
	fixture({
		repo: VAULT,
		item: "#7",
		title: "Rotate the signing keys before the 5.0 launch",
		labels: [LABELS.breaking],
		visibility: "private",
	}),
];

export const WRITES_CARDS = CARDS;

function sticky(doc: Y.Doc, text: string, color: string, x: number, y: number): string {
	const id = crypto.randomUUID();
	addShape(doc, id, {
		type: "sticky",
		text,
		color,
		author: { name: "Priya Shah", color: "#b4467a" },
		x,
		y,
		z: nextZ(doc),
	});
	return id;
}

function card(doc: Y.Doc, key: string, x: number, y: number): string {
	const id = crypto.randomUUID();
	addShape(doc, id, { type: "card", ref: key, x, y, z: nextZ(doc), parent: null });
	return id;
}

const bound = (shape: string): ConnectorEnd => ({ x: 0, y: 0, shape });

function connect(doc: Y.Doc, from: string, to: string, label?: string): string {
	const box = (id: string) => {
		const shape = shapesMap(doc).get(id);
		return shape ? boxOf(id, readShape(shape)) : undefined;
	};
	return addConnector(doc, { ...withFallbacks(bound(from), bound(to), box), label });
}

export function seedWrites(doc: Y.Doc): void {
	const upstream = ACCESS_GALLERY[0]?.card;
	for (const c of [...CARDS, ...(upstream ? [upstream] : [])]) cardStore.set(c);
	const [node18, domains, docs, keep, vault] = CARDS;
	if (!node18 || !domains || !docs || !keep || !vault) return;
	doc.transact(() => {
		// Brainstormed stickies, ready to become issues.
		sticky(
			doc,
			"Benchmarks in CI\nRun them on every PR and comment with the diff",
			"yellow",
			60,
			60,
		);
		sticky(doc, "A provider playground", "pink", 250, 70);
		sticky(doc, "Codemods for 5.0", "green", 140, 250);

		// A section to turn into a parent issue with sub-issues.
		card(doc, docs.key, 470, 100);
		card(doc, keep.key, 470, 280);
		sticky(doc, "Write the migration guide first", "blue", 740, 100);
		sticky(doc, "Generate one docs page per provider", "purple", 740, 290);
		addSection(doc, { x: 440, y: 40, w: 500, h: 450 }, { title: "Docs for 5.0", color: "blue" });

		// Two issues with an arrow between them: blocked-by.
		const a = card(doc, node18.key, 40, 540);
		const b = card(doc, domains.key, 400, 540);
		connect(doc, a, b);

		// A private repository's card next to public ones, for backlinks.
		card(doc, vault.key, 700, 540);
		if (upstream) card(doc, upstream.key, 40, 760);
	});
}
