import type * as Y from "yjs";
import { writeBackOperation } from "../../shared/adr.ts";
import { type ChangeStatus, changesMap, listChanges } from "../../shared/changes.ts";
import { withFallbacks } from "../../shared/connectors.ts";
import {
	addDecision,
	castVote,
	linkWrittenDecisions,
	setDecisionStatus,
	stageWriteBack,
} from "../../shared/decisions.ts";
import type { RepoMeta } from "../../shared/push.ts";
import { boxOf } from "../../shared/sections.ts";
import { type ConnectorEnd, addShape, nextZ, readShape, shapesMap } from "../../shared/shapes.ts";
import { addConnector } from "../../shared/structure.ts";
import { cardStore } from "../cardStore.ts";
import { type RepoApi, repoApi } from "../decisions/api.ts";
import { makeChecks, pullDetails } from "./ci.ts";
import { fixture, PLANNING_CARDS } from "./fixtures.ts";

// Decisions in the playground: a scenario with one in every state, a fake
// of the repository endpoints the write-back needs, and a stand-in for the
// push that applies decisions' write-backs.

const REPO = "fake.tack/acme/imagekit";

const PEOPLE = {
	priya: { name: "Priya Shah", color: "#b4467a", login: "priya" },
	kai: { name: "Kai Andersen", color: "#1f7a6b", login: "kai" },
	tom: { name: "Tom Okafor", color: "#a35a12", login: "tom" },
	jo: { name: "Jo Rivera", color: "#5b5fc7", login: "jo" },
};

/** What the fake repository's docs/decisions holds. */
export const EXISTING_RECORDS = [
	"0001-record-architecture-decisions.md",
	"0002-use-sharp-for-transforms.md",
	"README.md",
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Answers like the server would, after a moment, for any repository. */
export const fakeRepoApi: RepoApi = {
	async meta(repo): Promise<RepoMeta> {
		await sleep(250);
		return {
			repo,
			labels: [],
			milestones: [],
			assignees: ["priya", "kai", "tom", "jo"],
			discussionCategories: ["Announcements", "Decisions", "Ideas", "Q&A"],
			watchers: 42,
			defaultBranch: "main",
			writable: true,
		};
	},
	async files() {
		await sleep(350);
		return EXISTING_RECORDS;
	},
};

/** Use the fake repository endpoints until the returned function is called. */
export function installFakeRepoApi(): () => void {
	const saved = { ...repoApi };
	Object.assign(repoApi, fakeRepoApi);
	return () => Object.assign(repoApi, saved);
}

/** The ids of the seeded decisions, for the playground's controls. */
export interface SeededDecisions {
	proposed: string;
	decided: string;
	written: string;
	superseded: string;
}

function connect(doc: Y.Doc, from: ConnectorEnd, to: ConnectorEnd, label?: string, dash?: boolean) {
	const box = (id: string) => {
		const shape = shapesMap(doc).get(id);
		return shape ? boxOf(id, readShape(shape)) : undefined;
	};
	addConnector(doc, { ...withFallbacks(from, to, box), label, dash });
}

const bound = (shape: string): ConnectorEnd => ({ x: 0, y: 0, shape });

/** An ADR pull request on the fake forge, as a card the decision can show. */
function recordPull(item: string, title: string, state: "open" | "merged" = "open") {
	return fixture({
		item,
		kind: "pull",
		state,
		title,
		comments: 2,
		pull: pullDetails({ checks: makeChecks({ passed: 5, pending: state === "open" ? 2 : 0 }) }),
	});
}

/**
 * A board with a decision in every state: being voted on, decided and ready
 * to write back, written back as a pull request, and superseded.
 */
export function seedDecisions(doc: Y.Doc): SeededDecisions {
	for (const card of PLANNING_CARDS) cardStore.set(card);
	const [node18, ciPull, cdn, docs] = PLANNING_CARDS;
	const ids = {
		proposed: "decision-node-20",
		decided: "decision-avif",
		written: "decision-commits",
		superseded: "decision-node-16",
	};
	const card = (key: string | undefined, x: number, y: number) => {
		const id = crypto.randomUUID();
		if (key) addShape(doc, id, { type: "card", ref: key, x, y, z: nextZ(doc) });
		return id;
	};

	doc.transact(() => {
		// Proposed, with votes coming in, linked to the issue and PR it settles.
		addDecision(doc, ids.proposed, {
			x: 80,
			y: 80,
			title: "Require Node 20 in imagekit 5.0",
			text: "Node 18 is end-of-life in April. Keeping it costs a CI runner per job and blocks the native fetch cleanup.",
			author: PEOPLE.priya,
		});
		castVote(doc, ids.proposed, PEOPLE.priya, "agree", null);
		castVote(doc, ids.proposed, PEOPLE.kai, "agree", null);
		castVote(doc, ids.proposed, PEOPLE.tom, "disagree", null);
		const issue = card(node18?.key, 520, 40);
		const pull = card(ciPull?.key, 520, 210);
		connect(doc, bound(ids.proposed), bound(issue));
		connect(doc, bound(ids.proposed), bound(pull));

		// Superseded by the proposal above.
		addDecision(doc, ids.superseded, {
			x: 80,
			y: 480,
			title: "Keep Node 16 until 5.0",
			text: "Enterprise users asked for one more major on 16.",
			author: PEOPLE.kai,
			status: "decided",
		});
		setDecisionStatus(doc, ids.superseded, "superseded", { supersededBy: ids.proposed }, null);
		connect(doc, bound(ids.proposed), bound(ids.superseded), "supersedes", true);

		// Decided, and ready to write back.
		addDecision(doc, ids.decided, {
			x: 920,
			y: 80,
			title: "Serve AVIF by default",
			text: "Every CDN we support can now transcode AVIF, and it's 20–30% smaller than WebP at the same quality.",
			author: PEOPLE.jo,
		});
		for (const [person, choice] of [
			[PEOPLE.jo, "agree"],
			[PEOPLE.priya, "agree"],
			[PEOPLE.kai, "agree"],
			[PEOPLE.tom, "disagree"],
		] as const) {
			castVote(doc, ids.decided, person, choice, null);
		}
		setDecisionStatus(doc, ids.decided, "decided", { by: PEOPLE.jo }, null);
		const cdnCard = card(cdn?.key, 1340, 60);
		const docsCard = card(docs?.key, 1340, 230);
		connect(doc, bound(ids.decided), bound(cdnCard));
		connect(doc, bound(ids.decided), bound(docsCard));

		// Decided, and written back: its ADR pull request shows live.
		addDecision(doc, ids.written, {
			x: 920,
			y: 480,
			title: "Adopt Conventional Commits",
			text: "So release notes and version bumps can be generated from history.",
			author: PEOPLE.tom,
		});
		castVote(doc, ids.written, PEOPLE.tom, "agree", null);
		castVote(doc, ids.written, PEOPLE.jo, "agree", null);
		setDecisionStatus(doc, ids.written, "decided", { by: PEOPLE.tom }, null);
	}, null);

	// Staged as this browser would, then applied as a push would.
	const record = recordPull("#431", "ADR 0003: Adopt Conventional Commits");
	cardStore.set(record);
	const op = writeBackOperation(
		{
			title: "Adopt Conventional Commits",
			status: "decided",
			date: new Date().toISOString().slice(0, 10),
			context: "So release notes and version bumps can be generated from history.",
			decision: "Adopt Conventional Commits",
			consequences: "",
		},
		{ kind: "pr", repo: REPO, number: 3 },
	);
	const change = stageWriteBack(doc, ids.written, op, PEOPLE.tom);
	if (change) {
		setChange(doc, change, "applied", { key: record.key, url: record.url });
		linkWrittenDecisions(doc, null);
	}
	return ids;
}

function setChange(
	doc: Y.Doc,
	id: string,
	status: ChangeStatus,
	result?: { key?: string; url?: string },
): void {
	doc.transact(() => {
		const change = changesMap(doc).get(id);
		if (!change) return;
		change.set("status", status);
		change.set("updatedAt", new Date().toISOString());
		if (result) change.set("result", result);
	}, null);
}

let nextRecordItem = 432;
let nextDiscussion = 18;

/**
 * Stand in for a push of every staged decision write-back: each goes
 * sending, then sent, then applied, with a pull request (whose card then
 * shows live on the decision) or a Discussion post. Returns how many.
 */
export async function pushWriteBacks(doc: Y.Doc, ms = 500): Promise<number> {
	const writeBacks = new Set(
		[...shapesMap(doc).values()]
			.filter((shape) => shape.get("type") === "decision")
			.map((shape) => shape.get("writeback")),
	);
	const staged = listChanges(doc).filter(
		(change) =>
			writeBacks.has(change.id) && change.status === "staged" && change.included !== false,
	);
	for (const change of staged) setChange(doc, change.id, "sending");
	await sleep(ms);
	for (const change of staged) setChange(doc, change.id, "sent");
	await sleep(ms);
	for (const change of staged) {
		const { op } = change;
		if (op.kind === "pr.create") {
			const card = recordPull(`#${nextRecordItem++}`, op.title);
			cardStore.set(card);
			setChange(doc, change.id, "applied", { key: card.key, url: card.url });
		} else if (op.kind === "discussion.create") {
			setChange(doc, change.id, "applied", {
				url: `https://fake.tack/acme/imagekit/discussions/${nextDiscussion++}`,
			});
		}
	}
	linkWrittenDecisions(doc, null);
	return staged.length;
}

/** Merge every decision record's pull request, as if someone merged them. */
export function mergeRecords(doc: Y.Doc): number {
	let merged = 0;
	for (const shape of shapesMap(doc).values()) {
		const ref = shape.get("ref");
		if (shape.get("type") !== "decision" || typeof ref !== "string") continue;
		const card = cardStore.get(ref);
		if (!card || "missing" in card || card.state === "merged") continue;
		cardStore.set({
			...card,
			state: "merged",
			pull: card.pull && { ...card.pull, checks: makeChecks({ passed: 7 }) },
			updatedAt: new Date().toISOString(),
		});
		merged++;
	}
	return merged;
}

/** Decisions still open to votes, for simulated people to vote on. */
export function proposedDecisions(doc: Y.Doc): string[] {
	return [...shapesMap(doc).entries()]
		.filter(([, shape]) => shape.get("type") === "decision" && shape.get("status") === "proposed")
		.map(([id]) => id);
}
