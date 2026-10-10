import * as Y from "yjs";
import {
	type ChangeStatus,
	type Operation,
	type PendingChange,
	type Stager,
	changesMap,
} from "../../shared/changes.ts";
import { IMAGEKIT, PEOPLE, ROADMAP, SHARP } from "./push.ts";

// Pending changes as plain objects, for the changes gallery: every kind,
// every status, from a few people.

const person = (login: string): Stager => PEOPLE[login] ?? { name: login };

let next = 0;

/** Changes the person reviewing has left out of their push, in the gallery's samples. */
export const LEFT_OUT = new Set<string>();

export function change(
	op: Operation,
	by: string,
	extra: Partial<PendingChange> & { minutesAgo?: number; leftOut?: boolean } = {},
): PendingChange {
	const { minutesAgo = 5, leftOut = false, ...rest } = extra;
	const id = `g${next++}`;
	if (leftOut) LEFT_OUT.add(id);
	return {
		id,
		op,
		status: "staged",
		stagedBy: person(by),
		stagedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
		...rest,
	};
}

const key = (item: string) => `${IMAGEKIT}${item}`;

/** One of everything, in two repositories plus one without the app. */
export function everyKind(): PendingChange[] {
	const migration = change(
		{
			kind: "issue.create",
			repo: IMAGEKIT,
			title: "Write the 5.0 migration guide",
			body: "Before the code: what changes, why, and a codemod where we can.\n\n- [x] list the breaking changes\n- [ ] draft the guide\n\ncc @jo",
			labels: ["docs"],
			assignees: ["jo"],
			milestone: "5.0",
		},
		"kai",
		{ minutesAgo: 14, shapes: ["sticky-a"], effect: { kind: "replace", shapes: ["sticky-a"] } },
	);
	return [
		change(
			{
				kind: "issue.create",
				repo: IMAGEKIT,
				title: "Better errors when the CDN isn’t recognised",
				body: "When `detect()` can’t match a URL it silently falls back to the default provider.\n\n**Instead**, warn once with the URL.",
				labels: ["enhancement", "provider"],
			},
			"priya",
			{ minutesAgo: 16 },
		),
		migration,
		change(
			{ kind: "item.subIssue", parent: { key: key("#412") }, child: { pending: migration.id } },
			"kai",
			{ minutesAgo: 13 },
		),
		change(
			{ kind: "item.blockedBy", target: { key: key("#423") }, blockedBy: { key: key("#418") } },
			"tom",
			{ minutesAgo: 12 },
		),
		change(
			{
				kind: "item.labels",
				target: { key: key("#412") },
				add: ["needs review"],
				remove: ["enhancement"],
			},
			"tom",
			{ minutesAgo: 11 },
		),
		change(
			{ kind: "item.assignees", target: { key: key("#423") }, add: ["priya"], remove: ["tom"] },
			"jo",
			{
				minutesAgo: 10,
			},
		),
		change({ kind: "item.milestone", target: { key: key("#409") }, milestone: "5.0" }, "kai", {
			minutesAgo: 9,
		}),
		change(
			{ kind: "item.state", target: { key: key("#377") }, state: "closed", reason: "completed" },
			"jo",
			{ minutesAgo: 8 },
		),
		change({ kind: "item.state", target: { key: key("#398") }, state: "open" }, "priya", {
			minutesAgo: 7,
			leftOut: true,
		}),
		change(
			{
				kind: "item.comment",
				target: { key: key("#418") },
				body: "We agreed to land this for **5.0** once CI is green. @kai can you review?",
			},
			"priya",
			{ minutesAgo: 6 },
		),
		change(
			{
				kind: "pr.create",
				repo: IMAGEKIT,
				title: "Decision: drop Node 18 in 5.0",
				body: "Records the decision from the planning board.",
				branch: "tack/decision-drop-node-18",
				files: [
					{
						path: "docs/decisions/0007-drop-node-18.md",
						content: "# Drop Node 18 in 5.0\n\nStatus: decided\n\n5.0 needs Node 20 or later.\n",
					},
				],
			},
			"jo",
			{ minutesAgo: 5 },
		),
		change(
			{
				kind: "discussion.create",
				repo: ROADMAP,
				category: "Ideas",
				title: "A provider playground?",
				body: "Somewhere to paste an image URL and see what every provider does with it.",
			},
			"tom",
			{ minutesAgo: 4 },
		),
		change({ kind: "item.labels", target: { key: `${SHARP}#4012` }, add: ["question"] }, "tom", {
			minutesAgo: 3,
			leftOut: true,
		}),
	];
}

/** A few staged changes, one failed. */
export function someStaged(): PendingChange[] {
	const all = everyKind();
	return [
		...all.slice(0, 2),
		{
			...(all[6] as PendingChange),
			status: "failed",
			error: "Milestone “5.0” is closed on acme/imagekit",
		},
		...all.slice(7, 9),
	];
}

/** A push under way: one of each status. */
export function midPush(): PendingChange[] {
	const statuses: ChangeStatus[] = ["applied", "applied", "sent", "sending", "staged", "failed"];
	return everyKind()
		.slice(0, statuses.length)
		.map((c, i) => {
			const status = statuses[i] ?? "staged";
			return {
				...c,
				status,
				pushId: "gallery-push",
				pushedAs: "user",
				result:
					status === "applied" || status === "sent"
						? { key: key(`#${530 + i}`), url: `https://fake.tack/acme/imagekit/issues/${530 + i}` }
						: undefined,
				error: status === "failed" ? "Resource not accessible by integration" : undefined,
			};
		});
}

/** Write changes into a document, as if they'd synced from the server. */
export function docWith(changes: PendingChange[]): Y.Doc {
	const doc = new Y.Doc();
	doc.transact(() => {
		for (const c of changes) {
			const map = new Y.Map<unknown>();
			for (const [field, value] of Object.entries(c))
				if (value !== undefined) map.set(field, value);
			changesMap(doc).set(c.id, map);
		}
	}, "gallery");
	return doc;
}
