import {
	type ChangeStatus,
	type Operation,
	type OperationKind,
	type PendingChange,
	type Target,
	operationRepo,
	pendingDependencies,
} from "../../shared/changes.ts";
import type { PushResponse, RepoMeta } from "../../shared/push.ts";
import { forgeNameOf, itemOf, parseRepoKey, sentenceCase } from "../../shared/refs.ts";

// How pending changes read to people: what each one does, which repository
// it writes to, how they group, which depend on which, who gets notified,
// and what to say when a push is refused. Pure, so it's unit-tested in Node.

export interface KindInfo {
	/** One change, as a verb phrase's noun: "New issue". */
	label: string;
	/** A group of them, in the push sheet: "New issues". */
	group: string;
	/**
	 * Whether GitHub notifies the repository's watchers. New threads,
	 * comments and closing or reopening do; labels, milestones and links
	 * don't (assigning notifies just the assignee).
	 */
	notifies: boolean;
}

export const KINDS: Record<OperationKind, KindInfo> = {
	"issue.create": { label: "New issue", group: "New issues", notifies: true },
	"pr.create": { label: "New pull request", group: "Pull requests", notifies: true },
	"discussion.create": { label: "New discussion", group: "Discussions", notifies: true },
	"item.comment": { label: "Comment", group: "Comments", notifies: true },
	"item.state": { label: "State", group: "Close and reopen", notifies: true },
	"item.labels": { label: "Labels", group: "Labels", notifies: false },
	"item.assignees": { label: "Assignees", group: "Assignees", notifies: false },
	"item.milestone": { label: "Milestone", group: "Milestones", notifies: false },
	"item.subIssue": { label: "Sub-issue", group: "Sub-issues", notifies: false },
	"item.blockedBy": { label: "Blocked by", group: "Blocked by", notifies: false },
};

/** The order kinds appear in, creations first. */
export const KIND_ORDER: OperationKind[] = [
	"issue.create",
	"pr.create",
	"discussion.create",
	"item.subIssue",
	"item.blockedBy",
	"item.labels",
	"item.assignees",
	"item.milestone",
	"item.state",
	"item.comment",
];

/** Changes that can still be pushed, unstaged or left out. */
export function isPending(change: Pick<PendingChange, "status">): boolean {
	return change.status === "staged" || change.status === "failed";
}

/** Changes a push is working on right now. */
export function isInFlight(change: Pick<PendingChange, "status">): boolean {
	return change.status === "sending" || change.status === "sent";
}

export const STATUS_LABEL: Record<ChangeStatus, string> = {
	staged: "Staged",
	sending: "Sending",
	sent: "Sent",
	applied: "Applied",
	failed: "Failed",
};

/** `github.com/acme/app` → `acme/app`; other hosts keep their host. */
export function repoName(repo: string): string {
	const parsed = parseRepoKey(repo);
	if (!parsed) return repo;
	return parsed.host === "github.com" || parsed.host === "fake.tack"
		? parsed.repo
		: `${parsed.host}/${parsed.repo}`;
}

/** What to call the forge a change goes to: `GitHub`, `the test forge`. */
export function changeForge(change: PendingChange, index: ChangeIndex): string {
	const repo = changeRepo(change, index);
	return forgeNameOf(repo ? [repo] : []);
}

/** What to call the forge (or forges) these changes go to. */
export function changesForge(changes: readonly PendingChange[], index: ChangeIndex): string {
	return forgeNameOf(
		changes.flatMap((change) => {
			const repo = changeRepo(change, index);
			return repo ? [repo] : [];
		}),
	);
}

/** Just the repository's own name: `acme/app` → `app`. */
export function repoShortName(repo: string): string {
	return repoName(repo).split("/").at(-1) ?? repo;
}

export type ChangeIndex = ReadonlyMap<string, PendingChange>;

export function indexChanges(changes: readonly PendingChange[]): Map<string, PendingChange> {
	return new Map(changes.map((change) => [change.id, change]));
}

/**
 * The repository a change writes to. Changes about an issue that's still
 * to be created write to the repository it'll be created in.
 */
export function changeRepo(change: PendingChange, index: ChangeIndex): string | null {
	const direct = operationRepo(change.op);
	if (direct) return direct;
	for (const id of pendingDependencies(change.op)) {
		const created = index.get(id);
		if (created) {
			const repo = operationRepo(created.op);
			if (repo) return repo;
		}
	}
	return null;
}

/** What to call an item: its title where it's known. */
export type TitleOf = (key: string) => string | undefined;

/** A target, for reading: `#412`, or the title of an issue about to be made. */
export function targetLabel(target: Target, index: ChangeIndex): string {
	if ("key" in target) return itemOf(target.key) ?? target.key;
	const created = index.get(target.pending);
	return created?.op.kind === "issue.create" ? `“${created.op.title}”` : "a new issue";
}

/** A target's title, if it has one: the card's, or the new issue's. */
export function targetTitle(target: Target, index: ChangeIndex, titleOf: TitleOf): string | null {
	if ("key" in target) return titleOf(target.key) ?? null;
	const created = index.get(target.pending);
	return created?.op.kind === "issue.create" ? created.op.title : null;
}

function list(items: readonly string[]): string {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const CLOSE_REASON: Record<string, string> = {
	completed: "as completed",
	not_planned: "as not planned",
	duplicate: "as a duplicate",
};

/**
 * One line saying what a change does, for lists and the audit log:
 * "Create issue “Better errors”", "Add bug to #412", "Close #398 as not planned".
 */
export function summarize(op: Operation, index: ChangeIndex = new Map()): string {
	const target = (t: Target) => targetLabel(t, index);
	switch (op.kind) {
		case "issue.create":
			return `Create issue “${op.title}”`;
		case "pr.create":
			return `Open pull request “${op.title}”`;
		case "discussion.create":
			return `Start discussion “${op.title}”`;
		case "item.comment":
			return `Comment on ${target(op.target)}`;
		case "item.state":
			return op.state === "closed"
				? `Close ${target(op.target)}${op.reason ? ` ${CLOSE_REASON[op.reason] ?? ""}` : ""}`.trim()
				: `Reopen ${target(op.target)}`;
		case "item.labels": {
			const parts = [];
			if (op.add?.length) parts.push(`add ${list(op.add)}`);
			if (op.remove?.length) parts.push(`remove ${list(op.remove)}`);
			const text = parts.join(", ") || "change labels";
			return `${text[0]?.toUpperCase()}${text.slice(1)} ${op.add?.length && !op.remove?.length ? "to" : "on"} ${target(op.target)}`;
		}
		case "item.assignees": {
			const parts = [];
			if (op.add?.length) parts.push(`assign ${list(op.add.map((login) => `@${login}`))}`);
			if (op.remove?.length) parts.push(`unassign ${list(op.remove.map((login) => `@${login}`))}`);
			const text = parts.join(", ") || "change assignees";
			return `${text[0]?.toUpperCase()}${text.slice(1)} ${op.add?.length && !op.remove?.length ? "to" : "on"} ${target(op.target)}`;
		}
		case "item.milestone":
			return op.milestone === null
				? `Clear the milestone on ${target(op.target)}`
				: `Move ${target(op.target)} to ${op.milestone}`;
		case "item.subIssue":
			return `Make ${target(op.child)} a sub-issue of ${target(op.parent)}`;
		case "item.blockedBy":
			return `Mark ${target(op.target)} blocked by ${target(op.blockedBy)}`;
	}
}

/** The primary target of a change, if it has one (what a card shows it on). */
export function primaryTarget(op: Operation): Target | null {
	switch (op.kind) {
		case "item.subIssue":
			return op.child;
		case "item.blockedBy":
			return op.target;
		default:
			return "target" in op ? op.target : null;
	}
}

/**
 * These changes plus everything they depend on (the issues they refer to
 * that aren't made yet), so a push never leaves a dependency behind.
 */
export function withDependencies(ids: Iterable<string>, index: ChangeIndex): Set<string> {
	const out = new Set<string>();
	const visit = (id: string) => {
		if (out.has(id)) return;
		const change = index.get(id);
		if (!change) return;
		out.add(id);
		for (const dep of pendingDependencies(change.op)) {
			const created = index.get(dep);
			// An issue that's already been made needs nothing more.
			if (created && created.status !== "applied" && created.status !== "sent") visit(dep);
		}
	};
	for (const id of ids) visit(id);
	return out;
}

/**
 * These changes plus everything that depends on them, so leaving out or
 * unstaging an issue takes the changes about it along.
 */
export function withDependents(ids: Iterable<string>, index: ChangeIndex): Set<string> {
	const out = new Set<string>(ids);
	let grew = true;
	while (grew) {
		grew = false;
		for (const change of index.values()) {
			if (out.has(change.id)) continue;
			if (pendingDependencies(change.op).some((dep) => out.has(dep))) {
				out.add(change.id);
				grew = true;
			}
		}
	}
	return out;
}

/**
 * The changes that depend on this one and aren't in `ids`, i.e. those a
 * push of `ids` would refuse (`missing_dependency`).
 */
export function missingDependencies(ids: Iterable<string>, index: ChangeIndex): string[] {
	const chosen = new Set(ids);
	return [...withDependencies(chosen, index)].filter((id) => !chosen.has(id));
}

export interface RepoGroup<T = PendingChange> {
	/** The repository key, or "" for changes that don't name one. */
	repo: string;
	changes: T[];
}

/** Group changes by repository, in order of first appearance. */
export function groupByRepo(changes: readonly PendingChange[], index: ChangeIndex): RepoGroup[] {
	const groups = new Map<string, PendingChange[]>();
	for (const change of changes) {
		const repo = changeRepo(change, index) ?? "";
		let group = groups.get(repo);
		if (!group) groups.set(repo, (group = []));
		group.push(change);
	}
	return [...groups].map(([repo, changes]) => ({ repo, changes }));
}

/** Group one repository's changes by kind, creations first. */
export function groupByKind(
	changes: readonly PendingChange[],
): { kind: OperationKind; changes: PendingChange[] }[] {
	return KIND_ORDER.map((kind) => ({
		kind,
		changes: changes.filter((change) => change.op.kind === kind),
	})).filter((group) => group.changes.length > 0);
}

/** "~40 people", "1 person", "~1.2k people": watcher counts are rough by nature. */
export function peopleCount(count: number): string {
	if (count === 1) return "1 person";
	if (count < 10) return `${count} people`;
	if (count < 1000) return `~${count} people`;
	const thousands = count / 1000;
	return `~${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, "") : Math.round(thousands)}k people`;
}

export interface WatcherEstimate {
	/** Watchers notified, summed over the repositories with noisy changes. */
	watchers: number;
	/** Repositories whose watchers hear about this push. */
	noisyRepos: string[];
	/** People notified because they're assigned. */
	assignees: string[];
	/** Whether any repository's watcher count is still loading. */
	loading: boolean;
}

/**
 * Who a push will notify: everyone watching a repository hears about new
 * issues, pull requests, discussions, comments and closes there; assignees
 * hear about being assigned. Labels, milestones and links are quiet.
 */
export function estimateWatchers(
	changes: readonly PendingChange[],
	index: ChangeIndex,
	meta: (repo: string) => RepoMeta | undefined,
): WatcherEstimate {
	const noisy = new Set<string>();
	const assignees = new Set<string>();
	for (const change of changes) {
		const repo = changeRepo(change, index);
		if (KINDS[change.op.kind].notifies && repo) noisy.add(repo);
		if (change.op.kind === "item.assignees")
			for (const login of change.op.add ?? []) assignees.add(login);
		if (change.op.kind === "issue.create")
			for (const login of change.op.assignees ?? []) assignees.add(login);
	}
	let watchers = 0;
	let loading = false;
	for (const repo of noisy) {
		const info = meta(repo);
		if (info) watchers += info.watchers;
		else loading = true;
	}
	return { watchers, noisyRepos: [...noisy], assignees: [...assignees], loading };
}

/** What to do about a refused push. */
export type FailureAction =
	| { kind: "sign_in" }
	| { kind: "install"; repos: string[] }
	| { kind: "leave_out"; repos: string[] }
	| { kind: "include_dependencies" }
	| { kind: "retry" };

export interface FailureCopy {
	title: string;
	body: string;
	actions: FailureAction[];
}

type Refusal =
	| Extract<PushResponse, { ok: false }>
	| { ok: false; reason: "offline"; message?: string };

function repoList(repos: readonly string[] | undefined): string {
	if (!repos?.length) return "these repositories";
	return list(repos.map(repoName));
}

/** A helpful message, and what can be done, for every reason a push is refused. */
export function failureCopy(refusal: Refusal): FailureCopy {
	const repos = "repos" in refusal ? refusal.repos : undefined;
	// The server says exactly what's in the way for these (another push, a
	// change edited meanwhile, an unreachable forge), so use its words.
	const said = refusal.message?.trim() || undefined;
	switch (refusal.reason) {
		case "signed_out":
			return {
				title: "Sign in to push",
				body: "Changes go to GitHub as a person, so Tack needs to know who you are. Anyone can stage changes; pushing needs a GitHub sign-in.",
				actions: [{ kind: "sign_in" }],
			};
		case "no_write_access":
			return {
				title: "You can stage but not push here",
				body: `${sentenceCase(forgeNameOf(repos ?? []))} says you can’t write to ${repoList(repos)}. Someone with write access can push these, or leave them out and push the rest.`,
				actions: [{ kind: "leave_out", repos: repos ?? [] }],
			};
		case "not_installed":
			return {
				title: "Install the app on these repos",
				body: `Tack’s GitHub App isn’t installed on ${repoList(repos)}, so it can’t write there yet. Install it (it takes a minute), or leave those changes out.`,
				actions: [
					{ kind: "install", repos: repos ?? [] },
					{ kind: "leave_out", repos: repos ?? [] },
				],
			};
		case "missing_dependency":
			return {
				title: "A change needs an issue that isn’t in this push",
				body:
					said ??
					"Some changes refer to an issue that’s still to be created. Include it too, so it’s made first.",
				actions: [{ kind: "include_dependencies" }],
			};
		case "busy":
			return {
				title: "Couldn’t start the push",
				body:
					said ??
					"Another push is still going. Give it a moment, then try again: nothing has been sent twice.",
				actions: [{ kind: "retry" }],
			};
		case "offline":
			return {
				title: "Couldn’t reach Tack",
				body: "Nothing was sent. Check your connection, then try again.",
				actions: [{ kind: "retry" }],
			};
	}
}

/** Make an error message from the forge readable: a full stop, no shouting. */
export function friendlyError(error: string | undefined, forge = "GitHub"): string {
	const text = (error ?? "").trim();
	if (!text) return `${sentenceCase(forge)} didn’t say why.`;
	return /[.!?]$/.test(text) ? text : `${text}.`;
}
