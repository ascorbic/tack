import type { Operation, PendingChange } from "./changes.ts";
import type { DecisionStatus } from "./shapes.ts";

// Writing a decision back to the forge: as an architecture decision record
// (a pull request adding `docs/decisions/NNNN-slug.md`) or as a Discussion
// post. Everything here is pure, so the template and numbering are
// unit-tested and the server can build the same documents.
//
// The record follows the common ADR layout (Michael Nygard's, as adr-tools
// writes it): a numbered title, then Status, Context, Decision and
// Consequences, plus the items the decision was linked to on the board and
// a link back to the board itself.

/** Where decision records live in a repository. */
export const DECISIONS_DIR = "docs/decisions";

/**
 * Where projects keep their decision records, most common first: a
 * repository with records in one of these gets its next one there.
 */
export const ADR_DIRS: readonly string[] = [
	DECISIONS_DIR,
	"docs/adr",
	"adr",
	"doc/adr",
	"docs/adrs",
	"docs/architecture/decisions",
	"decisions",
];

/**
 * A folder someone typed for records, tidied (`/docs/adr/` → `docs/adr`),
 * or null if it isn't a plain relative path inside the repository.
 */
export function recordDir(input: string): string | null {
	const dir = input
		.trim()
		.replace(/^\/+|\/+$/g, "")
		.replace(/\/{2,}/g, "/");
	if (!dir || dir.length > 200) return null;
	const parts = dir.split("/");
	return parts.every(
		(part) => /^[\w.@ -]+$/.test(part) && part !== "." && part !== ".." && part !== ".git",
	)
		? dir
		: null;
}

/**
 * The folder a repository's records are in: the first of `ADR_DIRS` whose
 * listing has a numbered record, else `docs/decisions`.
 */
export function detectRecordDir(listings: ReadonlyMap<string, readonly string[]>): string {
	for (const dir of ADR_DIRS) {
		if ((listings.get(dir) ?? []).some((name) => recordNumber(name) !== null)) return dir;
	}
	return DECISIONS_DIR;
}

/** An item linked to the decision, as it appears in the record. */
export interface AdrLink {
	/** The item's key, e.g. `github.com/acme/imagekit#412`. */
	key: string;
	/** Its title, if known. */
	title?: string;
	url: string;
}

export interface AdrInput {
	title: string;
	status: DecisionStatus;
	/** The day it was decided (or proposed), `YYYY-MM-DD`. */
	date: string;
	context: string;
	decision: string;
	consequences: string;
	links?: AdrLink[];
	/** The board the decision was made on. */
	boardUrl?: string;
	votes?: { agree: number; disagree: number };
	/** The record's number; only records written as files have one. */
	number?: number;
	/** What superseded it, for superseded records. */
	supersededBy?: { title: string; url?: string };
}

const STATUS_WORDS: Record<DecisionStatus, string> = {
	proposed: "Proposed",
	decided: "Accepted",
	superseded: "Superseded",
};

/** The ADR status word for a decision's status: decided records are "Accepted". */
export function adrStatus(status: DecisionStatus): string {
	return STATUS_WORDS[status];
}

/** A record number as it appears in file names and titles: `0007`. */
export function padNumber(n: number): string {
	return String(Math.max(0, Math.floor(n))).padStart(4, "0");
}

/**
 * A file-name slug: lowercase ASCII words joined by hyphens, accents
 * folded, at most `max` characters and never cut mid-word.
 */
export function slugify(title: string, max = 60): string {
	const words = title
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/['’]/g, "")
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	let slug = "";
	for (const word of words) {
		const next = slug ? `${slug}-${word}` : word;
		if (next.length > max) {
			if (!slug) slug = word.slice(0, max);
			break;
		}
		slug = next;
	}
	return slug || "decision";
}

/** The number at the start of a record's file name (`0007-foo.md` → 7), or null. */
export function recordNumber(path: string): number | null {
	const name = path.split("/").at(-1) ?? "";
	const match = /^(\d+)[-_]/.exec(name);
	return match ? Number(match[1]) : null;
}

/**
 * The next free record number: one more than the highest already in the
 * directory or claimed by a record staged on this board, so two decisions
 * written back in the same push don't collide. Starts at 1.
 */
export function nextAdrNumber(existing: Iterable<string>, staged: Iterable<string> = []): number {
	let highest = 0;
	for (const path of [...existing, ...staged]) {
		const n = recordNumber(path);
		if (n !== null && n > highest) highest = n;
	}
	return highest + 1;
}

/**
 * Record paths in `repo` claimed by write-backs on this board that haven't
 * failed: staged, being pushed, or opened but perhaps not merged yet (so not
 * in the directory listing).
 */
export function stagedRecordPaths(
	changes: Iterable<PendingChange>,
	repo: string,
	dir = DECISIONS_DIR,
): string[] {
	const paths: string[] = [];
	for (const change of changes) {
		const { op } = change;
		if (op.kind !== "pr.create" || op.repo !== repo || change.status === "failed") continue;
		for (const file of op.files) {
			const rest = file.path.startsWith(`${dir}/`) ? file.path.slice(dir.length + 1) : null;
			if (rest !== null && !rest.includes("/")) paths.push(file.path);
		}
	}
	return paths;
}

export function adrPath(number: number, title: string, dir = DECISIONS_DIR): string {
	return `${dir}/${padNumber(number)}-${slugify(title)}.md`;
}

/** Text for inside a link's square brackets. */
function linkText(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.trim()
		.replace(/([[\]\\])/g, "\\$1");
}

/** A paragraph, or a placeholder when it's empty. */
function section(text: string, placeholder: string): string {
	const trimmed = text.replace(/\r\n/g, "\n").trim();
	return trimmed || `_${placeholder}_`;
}

function shortRef(key: string): string {
	// `github.com/acme/imagekit#412` → `acme/imagekit#412`
	const slash = key.indexOf("/");
	return slash === -1 ? key : key.slice(slash + 1);
}

function statusLine(input: AdrInput): string {
	const word = adrStatus(input.status);
	if (input.status === "superseded" && input.supersededBy) {
		const { title, url } = input.supersededBy;
		const by = url ? `[${linkText(title)}](${url})` : title;
		return `${word} by ${by}`;
	}
	const parts = [input.status === "proposed" ? word : `${word} on ${input.date}`];
	const votes = input.votes;
	if (votes && votes.agree + votes.disagree > 0) {
		parts.push(`(${votes.agree} agree, ${votes.disagree} disagree)`);
	}
	return parts.join(" ");
}

/** The body shared by records and Discussion posts: everything below the title. */
function body(input: AdrInput): string {
	const blocks = [
		`Date: ${input.date}`,
		`## Status\n\n${statusLine(input)}`,
		`## Context\n\n${section(input.context, "No context recorded.")}`,
		`## Decision\n\n${section(input.decision, "No decision recorded.")}`,
		`## Consequences\n\n${section(input.consequences, "None recorded yet.")}`,
	];
	const links = input.links ?? [];
	if (links.length > 0 || input.boardUrl) {
		const lines = links.map((link) => {
			const ref = shortRef(link.key);
			const label = link.title ? `${ref}: ${link.title}` : ref;
			return `- [${linkText(label)}](${link.url})`;
		});
		if (input.boardUrl) lines.push(`- Decided on [the Tack board](${input.boardUrl})`);
		blocks.push(`## Links\n\n${lines.join("\n")}`);
	}
	return blocks.join("\n\n");
}

/** The decision record, as the Markdown file a pull request adds. */
export function adrMarkdown(input: AdrInput): string {
	const title = input.title.replace(/\s+/g, " ").trim() || "Untitled decision";
	const heading = input.number !== undefined ? `# ${input.number}. ${title}` : `# ${title}`;
	return `${heading}\n\n${body(input)}\n`;
}

/** The same record as a Discussion post's body: the post has its own title. */
export function discussionMarkdown(input: AdrInput): string {
	return `${body(input)}\n`;
}

export type WriteBackTarget =
	/** `dir` is the folder the record goes in, `docs/decisions` unless the repository uses another. */
	| { kind: "pr"; repo: string; number: number; dir?: string }
	| { kind: "discussion"; repo: string; category: string };

/**
 * The forge write for a decision: a pull request adding its record on a
 * new branch, or a Discussion post in a category.
 */
export function writeBackOperation(input: AdrInput, target: WriteBackTarget): Operation {
	const title = input.title.replace(/\s+/g, " ").trim() || "Untitled decision";
	if (target.kind === "discussion") {
		return {
			kind: "discussion.create",
			repo: target.repo,
			category: target.category,
			title: `Decision: ${title}`,
			body: discussionMarkdown(input),
		};
	}
	const record = { ...input, number: target.number };
	const path = adrPath(target.number, title, target.dir);
	const where = input.boardUrl ? `, decided on [the Tack board](${input.boardUrl})` : "";
	const prBody = [
		`Records the decision **${title}**${where}, as \`${path}\`.`,
		...(input.links?.length
			? [`Linked: ${input.links.map((link) => shortRef(link.key)).join(", ")}`]
			: []),
	].join("\n\n");
	return {
		kind: "pr.create",
		repo: target.repo,
		title: `ADR ${padNumber(target.number)}: ${title}`,
		body: prBody,
		branch: `tack/adr-${padNumber(target.number)}-${slugify(title, 40)}`,
		files: [{ path, content: adrMarkdown(record) }],
	};
}

/** A web URL for an item key when the card's own isn't known (GitHub only). */
export function itemUrl(key: string): string | undefined {
	const match = /^github\.com\/(.+?)#(\d+)$/.exec(key);
	// GitHub redirects /issues/N to /pull/N for pull requests.
	return match ? `https://github.com/${match[1]}/issues/${match[2]}` : undefined;
}
