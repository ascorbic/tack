import { board } from "./boardFixtures.ts";
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
import { matchSearch, parseSearch } from "../../shared/search.ts";
import {
	ACCESS_GALLERY,
	GALLERY_CARDS,
	LABELS,
	PLANNING_CARDS,
	PULL_GALLERY,
	fixture,
} from "./fixtures.ts";
import { RELATED_CARDS, playRelated } from "./related.ts";

// Writing back (M2) in the playground: a board to try the selection actions
// on, and stand-ins for the Worker's repository metadata and snapshot
// uploads, so it all works without a server or GitHub.

const LATER = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

/** Labels, milestones and people for fake repositories. */
export function fakeMeta(repo: string): RepoMeta | null {
	const name = repo.split("/").slice(1).join("/");
	if (!name.includes("/")) return null;
	// The upstream repository doesn't have the app: read-only.
	const writable = !name.startsWith("pixelmill/");
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
		// Nobody to assign in the private vault: Assign says so.
		assignees: name.startsWith("acme/vault") ? [] : ["priya", "kai", "tom", "jo", "ascorbic"],
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
		// The card tool's search, over the playground's own cards.
		async searchItems(host, q) {
			await new Promise((resolve) => setTimeout(resolve, 300));
			if (/\[fail\]/.test(q)) {
				return {
					kind: "error",
					reason: "error",
					message: "The test forge couldn’t search just now.",
				};
			}
			const parsed = parseSearch(q);
			const seen = new Set<string>();
			const items = [
				...PLANNING_CARDS,
				...CARDS,
				...GALLERY_CARDS.map((entry) => entry.card),
				...PULL_GALLERY.map((entry) => entry.card),
			].filter((card) => {
				if (seen.has(card.key) || card.host !== host) return false;
				seen.add(card.key);
				return matchSearch(card, parsed) === "yes";
			});
			return { kind: "search", total: items.length, items: items.slice(0, 10) };
		},
		// Carry over goes to pretend boards (#52).
		async carryTargets() {
			await new Promise((resolve) => setTimeout(resolve, 300));
			return [
				board("Retro, November", { layout: "retro", ago: 20 * 60_000 }),
				board("Sprint 43 planning", { layout: "planning", ago: 3 * 3_600_000 }),
				board("Q4 roadmap", { layout: "sparse", ago: 2 * 86_400_000 }),
			];
		},
		async carryOver(to, shapes) {
			await new Promise((resolve) => setTimeout(resolve, 500));
			const target = board(to === "fail" ? "Nope" : "Retro, November", { id: to });
			return { carried: shapes?.length ?? 0, skipped: 0, board: target };
		},
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
		title: "Custom domains aren’t detected for Skyfold",
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
	// Sub-issues of #412 (see related.ts), whose cards don't say so: the
	// parent issue panel asks, as it does a live board's related route.
	const matrix = RELATED_CARDS.find((c) => c.item === "#441");
	const engines = RELATED_CARDS.find((c) => c.item === "#442");
	for (const c of [...CARDS, ...(upstream ? [upstream] : []), matrix, engines]) {
		if (c) cardStore.set(c);
	}
	const [node18, domains, docs, keep, vault] = CARDS;
	if (!node18 || !domains || !docs || !keep || !vault || !matrix || !engines) return;
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

		// A section whose issues are already sub-issues of #412: making it a
		// parent issue offers to add to #412 instead of making another.
		card(doc, matrix.key, 430, 800);
		card(doc, engines.key, 690, 800);
		sticky(doc, "Drop Node 18 from the docs examples", "green", 430, 960);
		addSection(
			doc,
			{ x: 400, y: 740, w: 560, h: 380 },
			{ title: "Node 20 cleanup", color: "green" },
		);
	});
}
