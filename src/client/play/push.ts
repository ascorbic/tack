import * as Y from "yjs";
import {
	type ChangeStatus,
	type Operation,
	type PendingChange,
	type PushAs,
	type Stager,
	changesMap,
	includeChanges,
	listChanges,
	resolveTargets,
	stageChange,
} from "../../shared/changes.ts";
import type { AuditEntry, PushRequest, RepoMeta } from "../../shared/push.ts";
import { addShape, nextZ, shapesMap } from "../../shared/shapes.ts";
import type { Card } from "../../shared/cards.ts";
import { cardStore } from "../cardStore.ts";
import type { Loaded, PushClient, PushResult } from "../changes/api.ts";
import {
	changeRepo,
	indexChanges,
	isPending,
	missingDependencies,
	repoName,
	summarize,
} from "../changes/describe.ts";
import { scaledDuration } from "../motion.ts";
import { avatar } from "./ci.ts";
import { LABELS, UPSTREAM, fixture } from "./fixtures.ts";

// A pretend push server for the playground and gallery: it refuses pushes
// for each of the real API's reasons on request, and otherwise walks each
// change through sending → sent → applied (or failed) in the board
// document, as the Board object will, then makes the change on the board's
// cards as the webhooks would.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, scaledDuration(ms)));
const jitter = (ms: number) => ms * (0.7 + Math.random() * 0.6);

/** The origin of the pretend server's writes: never undone by anyone. */
export const SERVER_ORIGIN = "play-server";

export const PEOPLE: Record<string, Stager> = {
	priya: { login: "priya", name: "Priya Shah", color: "#b4467a" },
	kai: { login: "kai", name: "Kai Andersen", color: "#1f7a6b" },
	tom: { login: "tom", name: "Tom Okafor", color: "#a35a12" },
	jo: { login: "jo", name: "Jo Rivera", color: "#5b5fc7" },
};

export const IMAGEKIT = "fake.tack/acme/imagekit";
export const ROADMAP = "fake.tack/acme/roadmap";
export const SHARP = `fake.tack/${UPSTREAM}`;

const META_LABELS = [
	...Object.values(LABELS),
	{ name: "wontfix", color: "ffffff" },
	{ name: "performance", color: "f9d0c4" },
	{ name: "question", color: "d876e3" },
];

export const REPO_META: Record<string, RepoMeta> = {
	[IMAGEKIT]: {
		repo: IMAGEKIT,
		labels: META_LABELS,
		milestones: [{ title: "5.0", dueOn: "2026-11-01" }, { title: "5.1" }],
		assignees: ["priya", "kai", "tom", "jo"],
		discussionCategories: ["Ideas", "Q&A", "Announcements"],
		watchers: 42,
		defaultBranch: "main",
		writable: true,
	},
	[ROADMAP]: {
		repo: ROADMAP,
		labels: [LABELS.docs, { name: "launch", color: "c5def5" }],
		milestones: [],
		assignees: ["priya", "jo"],
		discussionCategories: [],
		watchers: 3,
		defaultBranch: "main",
		writable: true,
	},
	[SHARP]: {
		repo: SHARP,
		labels: [LABELS.bug, LABELS.enhancement, { name: "triage", color: "ededed" }],
		milestones: [],
		assignees: [],
		discussionCategories: ["Ideas"],
		watchers: 1290,
		defaultBranch: "main",
		writable: false,
	},
};

/** How the pretend server answers. */
export type PushMode =
	| "works"
	| "some_fail"
	| "signed_out"
	| "no_write_access"
	| "not_installed"
	| "busy"
	| "offline";

export const PUSH_MODES: { mode: PushMode; label: string }[] = [
	{ mode: "works", label: "Everything lands" },
	{ mode: "some_fail", label: "Some changes fail" },
	{ mode: "signed_out", label: "Refused: signed out" },
	{ mode: "no_write_access", label: "Refused: no write access" },
	{ mode: "not_installed", label: "Refused: app not installed" },
	{ mode: "busy", label: "Refused: someone else is pushing" },
	{ mode: "offline", label: "Can’t reach the server" },
];

const ERRORS = [
	"Label “wontfix” doesn’t exist in acme/imagekit",
	"GitHub accepted it, but it never showed up. Reconciliation found nothing",
	"Validation Failed: title is too long (maximum is 256 characters)",
];

let nextNumber = 520;

/** A monogram avatar for someone assigned, so nothing hits the network. */
function avatarOf(login: string): string {
	return avatar(login, PEOPLE[login]?.color ?? "#5a5f66");
}

export class SimulatedPush implements PushClient {
	mode: PushMode = "works";
	private log: AuditEntry[] = [];
	private running = 0;

	constructor(
		private doc: Y.Doc,
		private pusher: () => { login: string; name: string | null },
	) {}

	async push({ ids, as }: PushRequest): Promise<PushResult> {
		await sleep(jitter(450));
		const changes = listChanges(this.doc);
		const index = indexChanges(changes);
		const chosen = ids.flatMap((id) => {
			const change = index.get(id);
			return change ? [change] : [];
		});
		const repos = [...new Set(chosen.map((change) => changeRepo(change, index) ?? ""))].filter(
			Boolean,
		);
		switch (this.mode) {
			case "offline":
				return { ok: false, reason: "offline", message: "Couldn’t reach Tack." };
			case "signed_out":
				return { ok: false, reason: "signed_out", message: "Sign in to push." };
			case "no_write_access":
				return {
					ok: false,
					reason: "no_write_access",
					repos: repos.slice(0, 1),
					message: "You don’t have write access.",
				};
			case "not_installed":
				return {
					ok: false,
					reason: "not_installed",
					repos: repos.slice(-1),
					message: "The app isn’t installed.",
				};
			case "busy":
				return { ok: false, reason: "busy", message: "Another push is in progress." };
		}
		// The real server would refuse repositories without the app, too.
		const uninstalled = repos.filter((repo) => REPO_META[repo]?.writable === false);
		if (uninstalled.length > 0) {
			return {
				ok: false,
				reason: "not_installed",
				repos: uninstalled,
				message: "The app isn’t installed on these repositories.",
			};
		}
		if (missingDependencies(ids, index).length > 0) {
			return {
				ok: false,
				reason: "missing_dependency",
				message: "A change depends on an issue that isn’t in this push.",
			};
		}
		const pushId = crypto.randomUUID();
		void this.run(pushId, chosen.filter(isPending), as);
		return { ok: true, pushId };
	}

	async pushes(): Promise<Loaded<AuditEntry[]>> {
		await sleep(jitter(500));
		if (this.mode === "offline") return { ok: false, error: "offline" };
		return { ok: true, value: structuredClone(this.log) };
	}

	async repoMeta(repo: string): Promise<Loaded<RepoMeta>> {
		await sleep(jitter(400));
		const meta = REPO_META[repo];
		return meta
			? { ok: true, value: meta }
			: {
					ok: true,
					value: {
						repo,
						labels: [],
						milestones: [],
						assignees: [],
						discussionCategories: [],
						watchers: 12,
						defaultBranch: "main",
						writable: true,
					},
				};
	}

	/** Seed the audit log, for the history view. */
	seedHistory(entries: AuditEntry[]): void {
		this.log = [...entries, ...this.log];
	}

	private write(id: string, fields: Partial<PendingChange>): void {
		const change = changesMap(this.doc).get(id);
		if (!change) return;
		this.doc.transact(() => {
			for (const [key, value] of Object.entries(fields)) {
				if (value === undefined) change.delete(key);
				else change.set(key, value);
			}
			change.set("updatedAt", new Date().toISOString());
		}, SERVER_ORIGIN);
	}

	private async run(pushId: string, changes: PendingChange[], as: PushAs): Promise<void> {
		this.running++;
		const pusher = this.pusher();
		const pushedBy: Stager = { login: pusher.login, name: pusher.name ?? pusher.login };
		const index = indexChanges(listChanges(this.doc));
		const entry: AuditEntry = {
			pushId,
			at: new Date().toISOString(),
			by: pusher,
			as,
			changes: changes.map((change) => ({
				id: change.id,
				summary: summarize(change.op, index),
				status: "sent",
			})),
		};
		this.log.unshift(entry);
		const record = (
			id: string,
			status: "applied" | "sent" | "failed",
			extra: { url?: string; error?: string } = {},
		) => {
			const item = entry.changes.find((change) => change.id === id);
			if (item) Object.assign(item, { status, ...extra });
		};

		// Creations first, so the changes about them have something to refer to.
		const creates = new Set(["issue.create", "pr.create", "discussion.create"]);
		const ordered = [
			...changes.filter((change) => creates.has(change.op.kind)),
			...changes.filter((change) => !creates.has(change.op.kind)),
		];
		for (const change of ordered) {
			this.write(change.id, { pushId, pushedBy, pushedAs: as, error: undefined, status: "staged" });
		}
		const failing = new Map<string, string>();
		if (this.mode === "some_fail") {
			const others = ordered.filter((change) => !creates.has(change.op.kind));
			const first = others[0] ?? ordered[0];
			if (first) failing.set(first.id, ERRORS[0] ?? "");
			const second = others.at(-1);
			if (second && second !== first) failing.set(second.id, ERRORS[1] ?? "");
		}

		const created = new Map<string, string>();
		const confirmations: Promise<void>[] = [];
		for (const change of ordered) {
			this.write(change.id, { status: "sending" satisfies ChangeStatus });
			await sleep(jitter(520));
			const error = failing.get(change.id);
			// Rejected outright by the forge.
			if (error && error === ERRORS[0]) {
				this.write(change.id, { status: "failed", error });
				record(change.id, "failed", { error });
				continue;
			}
			const result = this.result(change, created);
			this.write(change.id, { status: "sent", result });
			record(change.id, "sent", { url: result.url });
			// The webhook confirms it a little later, or never does.
			confirmations.push(
				sleep(jitter(1300)).then(() => {
					if (error) {
						this.write(change.id, { status: "failed", error });
						record(change.id, "failed", { error });
						return;
					}
					this.apply(change, created);
					this.write(change.id, { status: "applied" });
					record(change.id, "applied", { url: result.url });
				}),
			);
		}
		await Promise.all(confirmations);
		this.running--;
	}

	/** What the forge says it made or changed. */
	private result(
		change: PendingChange,
		created: Map<string, string>,
	): { key?: string; url?: string } {
		const op = resolveTargets(change.op, created) ?? change.op;
		const repo = changeRepo(change, indexChanges(listChanges(this.doc))) ?? IMAGEKIT;
		const path = repoName(repo);
		if (op.kind === "issue.create" || op.kind === "pr.create" || op.kind === "discussion.create") {
			const number = nextNumber++;
			const key = `${repo}#${number}`;
			created.set(change.id, key);
			const section =
				op.kind === "pr.create"
					? "pull"
					: op.kind === "discussion.create"
						? "discussions"
						: "issues";
			return { key, url: `https://fake.tack/${path}/${section}/${number}` };
		}
		const target = "target" in op ? op.target : op.kind === "item.subIssue" ? op.child : null;
		const key = target && "key" in target ? target.key : undefined;
		const card = key ? cardStore.get(key) : undefined;
		return { key, url: card && !("missing" in card) ? card.url : undefined };
	}

	/** Make the change on the board, as the forge's webhooks would. */
	private apply(change: PendingChange, created: Map<string, string>): void {
		const op = resolveTargets(change.op, created) ?? change.op;
		const update = (key: string, fn: (card: Card) => Partial<Card>) => {
			const card = cardStore.get(key);
			if (card && !("missing" in card)) {
				cardStore.set({ ...card, ...fn(card), updatedAt: new Date().toISOString() });
			}
		};
		const colour = (repo: string, name: string) =>
			REPO_META[repo]?.labels.find((label) => label.name === name)?.color ?? "ededed";
		switch (op.kind) {
			case "issue.create": {
				const key = created.get(change.id);
				if (!key) return;
				const [, path = "acme/imagekit"] = /^[^/]+\/(.+)#\d+$/.exec(key) ?? [];
				const card = fixture({
					repo: path,
					item: key.slice(key.lastIndexOf("#")),
					title: op.title,
					labels: (op.labels ?? []).map((name) => ({ name, color: colour(op.repo, name) })),
					assignees: (op.assignees ?? []).map((login) => ({ login, avatarUrl: avatarOf(login) })),
				});
				cardStore.set({ ...card, key });
				if (change.effect?.kind === "replace") this.replace(change.effect.shapes, key);
				break;
			}
			case "item.labels":
				if ("key" in op.target) {
					const repo = op.target.key.replace(/[#!]\d+$/, "");
					update(op.target.key, (card) => ({
						labels: [
							...card.labels.filter((label) => !op.remove?.includes(label.name)),
							...(op.add ?? [])
								.filter((name) => !card.labels.some((label) => label.name === name))
								.map((name) => ({ name, color: colour(repo, name) })),
						],
					}));
				}
				break;
			case "item.state":
				if ("key" in op.target) {
					update(op.target.key, () => ({
						state: op.state,
						stateReason: op.state === "closed" ? (op.reason ?? "completed") : null,
					}));
				}
				break;
			case "item.comment":
				if ("key" in op.target) update(op.target.key, (card) => ({ comments: card.comments + 1 }));
				break;
			case "item.assignees":
				if ("key" in op.target) {
					update(op.target.key, (card) => ({
						assignees: [
							...card.assignees.filter((a) => !op.remove?.includes(a.login)),
							...(op.add ?? []).map((login) => ({ login, avatarUrl: avatarOf(login) })),
						],
					}));
				}
				break;
			default:
				break;
		}
	}

	/** Turn the shapes an issue was made from into its card, in place. */
	private replace(shapes: string[], key: string): void {
		const map = shapesMap(this.doc);
		const first = shapes.map((id) => map.get(id)).find(Boolean);
		if (!first) return;
		const x = Number(first.get("x"));
		const y = Number(first.get("y"));
		const parent = (first.get("parent") as string | null | undefined) ?? null;
		this.doc.transact(() => {
			for (const id of shapes) map.delete(id);
			addShape(this.doc, crypto.randomUUID(), {
				type: "card",
				ref: key,
				x,
				y,
				z: nextZ(this.doc),
				parent,
			});
		}, SERVER_ORIGIN);
	}
}

/** Mark a change as failed, as a push that went wrong would have. */
export function failChange(
	doc: Y.Doc,
	id: string,
	error: string,
	by: Stager = PEOPLE.kai as Stager,
): void {
	const change = changesMap(doc).get(id);
	if (!change) return;
	doc.transact(() => {
		change.set("status", "failed");
		change.set("error", error);
		change.set("pushId", "earlier-push");
		change.set("pushedBy", by);
		change.set("pushedAs", "user");
		change.set("updatedAt", new Date().toISOString());
	}, SERVER_ORIGIN);
}

/** Stage a change as someone else would have, outside this client's undo history. */
export function stageAs(
	doc: Y.Doc,
	op: Operation,
	by: Stager,
	options: {
		shapes?: string[];
		effect?: PendingChange["effect"];
		included?: boolean;
		minutesAgo?: number;
	} = {},
): string {
	// A scratch document stands in for their client: its writes reach ours
	// as remote updates.
	const theirs = new Y.Doc();
	Y.applyUpdate(theirs, Y.encodeStateAsUpdate(doc));
	const id = stageChange(theirs, op, by, { shapes: options.shapes, effect: options.effect });
	const change = changesMap(theirs).get(id);
	if (change && options.minutesAgo) {
		theirs.transact(() => {
			change.set(
				"stagedAt",
				new Date(Date.now() - (options.minutesAgo ?? 0) * 60_000).toISOString(),
			);
		});
	}
	if (options.included === false) includeChanges(theirs, [id], false);
	Y.applyUpdate(doc, Y.encodeStateAsUpdate(theirs, Y.encodeStateVector(doc)), SERVER_ORIGIN);
	theirs.destroy();
	return id;
}

/** A few past pushes, for the history view. */
export function pastPushes(now = Date.now()): AuditEntry[] {
	const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
	return [
		{
			pushId: "past-2",
			at: at(95),
			by: { login: "jo", name: "Jo Rivera" },
			as: "app",
			changes: [
				{
					id: "p2a",
					summary: "Create issue “Benchmark AVIF against WebP”",
					status: "applied",
					url: "https://fake.tack/acme/imagekit/issues/431",
				},
				{ id: "p2b", summary: "Add performance to #431", status: "applied" },
				{
					id: "p2c",
					summary: "Move #398 to 5.1",
					status: "failed",
					error: "Milestone “5.1” is closed",
				},
			],
		},
		{
			pushId: "past-1",
			at: at(60 * 26),
			by: { login: "priya", name: "Priya Shah" },
			as: "user",
			changes: [
				{
					id: "p1a",
					summary: "Close #391 as completed",
					status: "applied",
					url: "https://fake.tack/acme/imagekit/issues/391",
				},
				{
					id: "p1b",
					summary: "Comment on #409",
					status: "applied",
					url: "https://fake.tack/acme/imagekit/pull/409",
				},
			],
		},
	];
}
