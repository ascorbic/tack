// Who reacted (owner feedback after the first real session): hovering a
// reaction pill names the people behind it, as "👍 You, Kai Andersen and 3
// others".
//
// Two kinds of pill name people this way:
//
// - Stamps on shapes (facilitation.ts): the board's own reactions. Each is a
//   key per person in the document's `stamps` map, carrying their name,
//   colour and login, so who stamped is already known to everyone connected.
// - The reaction count on an issue, pull request or discussion card: the
//   forge's reactions. Card data carries only the total, so who reacted is
//   asked for lazily, when someone hovers or focuses the count, through
//   `GET /api/boards/:id/reactors` (src/server/reactors.ts), and kept a while
//   by the client (src/client/reactions/reactors.ts).
//
// Votes are not reactions: dot votes and decisions' votes never use this,
// and a vote that hides its dots never shows who voted (see Marks.tsx).

/** The most people a reaction names before the rest are "and N others". */
export const MAX_NAMED = 10;

/** GitHub's reaction contents (GraphQL's `ReactionContent`), as emoji, in GitHub's order. */
export const GITHUB_REACTIONS: Readonly<Record<string, string>> = {
	THUMBS_UP: "👍",
	THUMBS_DOWN: "👎",
	LAUGH: "😄",
	HOORAY: "🎉",
	CONFUSED: "😕",
	HEART: "❤️",
	ROCKET: "🚀",
	EYES: "👀",
};

/** Someone who reacted on a forge: their login, and their name where the forge has one. */
export interface Reactor {
	login: string;
	name?: string;
}

/** One kind of reaction on an item: how many, and the first few who left it. */
export interface ReactionGroup {
	emoji: string;
	count: number;
	/** At most `MAX_NAMED`, in the forge's order; `count` may be more. */
	reactors: Reactor[];
}

/** Who reacted to an item, by kind of reaction, in the forge's order. */
export interface ReactorsResult {
	kind: "reactors";
	key: string;
	groups: ReactionGroup[];
}

/** One person to name, and whether it's you. */
export interface Named {
	name: string;
	you?: boolean;
}

/**
 * People as a phrase, you first as "You": "You", "You and Kai Andersen",
 * "Priya Shah, Kai Andersen and Jo Rivera", and past `max` names, "… and 3
 * others". `total` is how many reacted, which may be more than are named.
 * With `whole`, each name's own spaces don't break, so a tooltip wraps
 * between names, never inside one. With `chars`, fewer are named (never
 * fewer than one) until the phrase fits on a line of that many characters.
 */
export function namePeople(
	people: readonly Named[],
	total = people.length,
	{ max = MAX_NAMED, whole = false, chars }: { max?: number; whole?: boolean; chars?: number } = {},
): string {
	const ordered = [...people.filter((p) => p.you).slice(0, 1), ...people.filter((p) => !p.you)].map(
		(p) => (p.you ? "You" : p.name.trim() || "Someone"),
	);
	let count = Math.min(max, ordered.length);
	let phrase = phraseOf(ordered, count, total);
	while (chars !== undefined && count > 1 && phrase.length > chars) {
		phrase = phraseOf(ordered, --count, total);
	}
	return whole
		? phrase.replace(/ /g, (space, at: number) => (inName(phrase, at) ? "\u00a0" : space))
		: phrase;
}

/** The first `count` of `names` as a phrase, with how many more there are. */
function phraseOf(names: readonly string[], count: number, total: number): string {
	const named = names.slice(0, count);
	const others = Math.max(0, Math.max(total, names.length) - named.length);
	if (named.length === 0) return others === 1 ? "1 person" : `${others} people`;
	if (others > 0) return `${named.join(", ")} and ${others} ${others === 1 ? "other" : "others"}`;
	if (named.length === 1) return named[0]!;
	return `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
}

/** Whether the space at `at` is inside a name, not between names ("…, " or " and "). */
function inName(phrase: string, at: number): boolean {
	if (phrase[at - 1] === ",") return false;
	if (phrase.startsWith(" and ", at)) return false;
	if (phrase.slice(at - 4, at) === " and") return false;
	return true;
}

/** How many to name on each line when several kinds of reaction share a tooltip. */
export function namedPerLine(lines: number): number {
	return lines <= 1 ? MAX_NAMED : Math.max(3, Math.floor(MAX_NAMED / lines));
}

/** About how many characters fit on one line of a tooltip, after its emoji. */
export const LINE_CHARS = 40;

/** "👍 You and Kai Andersen": one reaction, with who left it. */
export function reactionLine(emoji: string, people: readonly Named[], total?: number): string {
	return `${emoji} ${namePeople(people, total)}`;
}

/** "9 reactions", "1 reaction". */
export function reactionCount(count: number): string {
	return `${count} ${count === 1 ? "reaction" : "reactions"}`;
}

/**
 * Reactors as people to name: a name Tack knows for their login (`known`:
 * people on the board, its members and visitors), else the forge's name,
 * else the login. You're "You", by login.
 */
export function namedReactors(
	reactors: readonly Reactor[],
	self: string | undefined,
	known: (login: string) => string | null | undefined,
): Named[] {
	const me = self?.toLowerCase();
	return reactors.map((reactor) => ({
		name: known(reactor.login) || reactor.name || reactor.login,
		...(me && reactor.login.toLowerCase() === me ? { you: true } : {}),
	}));
}

/** Whether a value from the server is a `ReactorsResult`, checked enough to render. */
export function isReactorsResult(value: unknown): value is ReactorsResult {
	if (typeof value !== "object" || value === null) return false;
	const result = value as Partial<ReactorsResult>;
	return (
		result.kind === "reactors" &&
		Array.isArray(result.groups) &&
		result.groups.every(
			(group) =>
				typeof group?.emoji === "string" &&
				typeof group.count === "number" &&
				Array.isArray(group.reactors) &&
				group.reactors.every((r) => typeof r?.login === "string"),
		)
	);
}

/** Made-up people who react on the fake forge and in the playground. */
const FAKE_REACTORS: Reactor[] = [
	{ login: "kai", name: "Kai Andersen" },
	{ login: "priya", name: "Priya Shah" },
	{ login: "tom", name: "Tom Okafor" },
	{ login: "jo", name: "Jo Rivera" },
	{ login: "mina-l", name: "Mina Larsen" },
	// No name on their profile: named by their login.
	{ login: "ola-n" },
	{ login: "sam-k", name: "Sam Kim" },
	{ login: "ana-r", name: "Ana Ruiz" },
	{ login: "leo-b", name: "Leo Brandt" },
	{ login: "noor", name: "Noor Haddad" },
	{ login: "ines-m", name: "Inês Moreau" },
	{ login: "felix-w" },
];

/**
 * Who reacted to an item on the fake forge (and in the playground): `count`
 * reactions spread over 👍, ❤️, 🎉 and 🚀, half to the first, by made-up
 * people chosen from the item's number, so the same item always has the same
 * people.
 */
export function fakeReactors(key: string, count: number): ReactionGroup[] {
	const n = Number(/(\d+)$/.exec(key)?.[1] ?? 0);
	const kinds = ["👍", "❤️", "🎉", "🚀"];
	const groups: ReactionGroup[] = [];
	let left = Math.max(0, Math.floor(count));
	for (let k = 0; left > 0 && k < kinds.length; k++) {
		const take = k === kinds.length - 1 ? left : Math.ceil(left / 2);
		const start = (n + k * 5) % FAKE_REACTORS.length;
		groups.push({
			emoji: kinds[k]!,
			count: take,
			reactors: Array.from(
				{ length: Math.min(take, MAX_NAMED) },
				(_, i) => FAKE_REACTORS[(start + i) % FAKE_REACTORS.length]!,
			),
		});
		left -= take;
	}
	return groups;
}
