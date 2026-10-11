import { widgetDefinition } from "../../shared/widgetRegistry.ts";

// AI's proposals in words (#64), pure: what a proposed widget's config says,
// and what the AI left out of what it read.

const FIELD_LABELS: Record<string, string> = {
	q: "Search",
	repo: "Repository",
	milestone: "Milestone",
	scope: "Waiting on",
	team: "Team",
	event: "Placed by",
	range: "Over",
	from: "From",
	to: "To",
	sort: "Sorted by",
	limit: "At most",
	days: "Quiet for",
	staleDays: "At risk after",
	label: "Labels them",
	source: "Items from",
	section: "Section",
	drafts: "Drafts",
	sections: "Sections",
	skip: "Leaves out",
	contributors: "Thanks contributors",
};

const RANGES: Record<string, string> = {
	"1w": "the last week",
	"2w": "the last two weeks",
	"1m": "the last month",
	"3m": "the last three months",
	fixed: "fixed dates",
};

const SCOPES: Record<string, string> = { me: "whoever’s looking", team: "a team", repo: "anyone" };

export interface ConfigLine {
	label: string;
	value: string;
	/** Code-like: a search or a repository. */
	mono?: boolean;
}

/**
 * The settings of a proposed widget worth reading, in words: those that
 * aren't their kind's defaults, besides its title and forge.
 */
export function describeConfig(kind: string, config: Record<string, unknown>): ConfigLine[] {
	const definition = widgetDefinition(kind);
	const defaults = (definition?.defaults ?? {}) as Record<string, unknown>;
	const lines: ConfigLine[] = [];
	for (const [key, value] of Object.entries(config)) {
		if (key === "title" || key === "host") continue;
		if (value === "" || value === null || value === undefined) continue;
		if (JSON.stringify(value) === JSON.stringify(defaults[key]) && key !== "q" && key !== "repo") {
			continue;
		}
		const label = FIELD_LABELS[key] ?? key;
		lines.push({ label, ...valueOf(key, value) });
	}
	return lines;
}

function valueOf(key: string, value: unknown): { value: string; mono?: boolean } {
	if (key === "q" || key === "repo" || key === "team") return { value: String(value), mono: true };
	if (key === "range") return { value: RANGES[String(value)] ?? String(value) };
	if (key === "scope") return { value: SCOPES[String(value)] ?? String(value) };
	if (key === "days" || key === "staleDays") return { value: `${String(value)} days` };
	if (typeof value === "boolean") return { value: value ? "Yes" : "No" };
	if (Array.isArray(value)) {
		const words = value.map((item) =>
			item && typeof item === "object" && "title" in item ? String(item.title) : String(item),
		);
		return { value: words.join(", ") };
	}
	return { value: String(value) };
}

/** What was left out, in words, or null if nothing was. */
export function leftOutInWords(leftOut: { faceDown: number; private: number }): string | null {
	const parts: string[] = [];
	if (leftOut.faceDown > 0) {
		parts.push(`${leftOut.faceDown} face-down ${leftOut.faceDown === 1 ? "sticky" : "stickies"}`);
	}
	if (leftOut.private > 0) {
		parts.push(`${leftOut.private} private ${leftOut.private === 1 ? "card" : "cards"}`);
	}
	return parts.length > 0 ? `Left out ${parts.join(" and ")}` : null;
}

/** Things to ask for, for this board. */
export function widgetSuggestions(repo: string | null): string[] {
	return repo
		? [
				`Open bugs in ${repo}`,
				"Pull requests waiting for my review",
				`What merged in ${repo} in the last two weeks`,
				`Issues in ${repo} nobody’s touched for a month`,
			]
		: [
				"Pull requests waiting for my review",
				"Issues assigned to me",
				"Open issues labelled good first issue",
			];
}
