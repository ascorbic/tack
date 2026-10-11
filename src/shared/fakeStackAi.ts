import type { StackAi } from "./stackNamer.ts";
import type { GroupNote } from "./stackNaming.ts";

// A stand-in for Workers AI (#73), for local development (`TACK_AI=fake`, the
// default in `vp dev`, which has no Workers AI) and the playground: it
// answers as the model is asked to, in the same shape, from the notes' words
// alone, a beat later. Names come from themes it recognises in the words,
// else the words the notes share most. It's never used in production unless
// someone sets `TACK_AI=fake` on purpose.

const STOP = new Set(
	`a an and are as at be but by can do does for from has have how i if in into is it its
	it's me my no not of on or our so that the their them then there they this to too up us
	was we what when where which who why will with you your would could should just still
	only more most much very really can't don't doesn't isn't i'm we're it'd get gets got
	need needs want wants make makes use used using one two lot lots all any some every
	other than about after before again also always never often`.split(/\s+/),
);

/** Themes it recognises: words in the notes, and what a facilitator would write. */
const THEMES: { words: RegExp; name: string }[] = [
	{
		words: /\b(docs?|documentation|readme|guide|examples?|tutorial)\b/i,
		name: "Hard-to-find docs",
	},
	{ words: /\b(ci|build|pipeline|flaky|e2e|tests?|rerun)\b/i, name: "Unreliable CI" },
	{ words: /\b(release|changelog|notes|version|semver)\b/i, name: "Thin release notes" },
	{ words: /\b(credit|contributors?|thanks|recogni[sz]e)\b/i, name: "Credit for contributors" },
	{ words: /\b(slow|perf|performance|latency|fast(er)?|speed)\b/i, name: "Speed and performance" },
	{
		words: /\b(onboard(ing)?|newcomers?|first[- ]time|getting started)\b/i,
		name: "Newcomer onboarding",
	},
	{ words: /\b(cdn|cache|caching|images?|loader)\b/i, name: "Image loading at the edge" },
	{ words: /\b(plugins?|extensions?|api|hooks?)\b/i, name: "Plugin API gaps" },
	{ words: /\b(triage|issues?|backlog|labels?)\b/i, name: "Backlog triage" },
	{ words: /\b(meetings?|sync|calls?|async|timezones?)\b/i, name: "How we meet" },
	{ words: /\b(security|auth|permissions?|tokens?|secrets?)\b/i, name: "Security and access" },
];

function words(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s'-]/gu, " ")
		.split(/\s+/)
		.map((word) => word.replace(/^['-]+|['-]+$/g, ""))
		.filter((word) => word.length > 2 && !STOP.has(word));
}

function capitalise(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A name for some notes, as the fake would give it. */
export function fakeName(texts: readonly string[]): string {
	let best: { name: string; hits: number } | null = null;
	for (const theme of THEMES) {
		const hits = texts.filter((text) => theme.words.test(text)).length;
		if (hits > 0 && (!best || hits > best.hits)) best = { name: theme.name, hits };
	}
	if (best && best.hits * 2 >= texts.length) return best.name;
	const counts = new Map<string, number>();
	for (const text of texts)
		for (const word of new Set(words(text))) {
			counts.set(word, (counts.get(word) ?? 0) + 1);
		}
	const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
	return best?.name ?? (top ? `${capitalise(top)} worries` : "Loose ends");
}

/** Stacks for some notes: by theme where one fits, else by the words they share. */
export function fakeGroups(notes: readonly GroupNote[]): { name: string; notes: string[] }[] {
	const groups = new Map<string, string[]>();
	for (const note of notes) {
		const theme = THEMES.find((candidate) => candidate.words.test(note.text));
		const key = theme?.name ?? fakeName([note.text]);
		groups.set(key, [...(groups.get(key) ?? []), note.id]);
	}
	return [...groups]
		.filter(([, ids]) => ids.length >= 2)
		.sort((a, b) => b[1].length - a[1].length)
		.slice(0, 8)
		.map(([name, ids]) => ({ name, notes: ids }));
}

/** The fake, answering as Workers AI's structured output would, after `delayMs`. */
export function fakeStackAi(delayMs = 600): StackAi {
	const later = <T>(value: T) =>
		new Promise<T>((resolve) => setTimeout(() => resolve(value), delayMs));
	return {
		name: (texts) => later({ name: fakeName(texts) }),
		group: (notes) => later({ groups: fakeGroups(notes) }),
	};
}
