import { repoKeyOf } from "./refs.ts";

// Backlinks (#33): a comment on an item linking back to the board, with a
// snapshot of the board around it.
//
// A snapshot is public (GitHub has to fetch it), and its readers are the
// item's audience: everyone, for an item in a public repository, or the
// people who can read its repository. So the snapshot for an item never
// shows cards or text from another private repository: those cards are
// hidden in the image. Cards from public repositories, and from the item's
// own repository, can always be shown. Unknown visibility counts as private.

/** What the snapshot needs to know about a card on the board. */
export interface CardAudience {
	key: string;
	/** Whether the card's repository is known to be public. */
	public: boolean;
}

/** Everyone, for items in public repositories. */
export const PUBLIC_AUDIENCE = "public";

/** Who'll see a comment on an item: everyone, or the readers of its repository. */
export function audienceOf(item: CardAudience): string {
	return item.public ? PUBLIC_AUDIENCE : repoKeyOf(item.key);
}

/** Cards that must be hidden from an audience: other repositories' private cards. */
export function hiddenFrom(audience: string, cards: readonly CardAudience[]): Set<string> {
	const hidden = new Set<string>();
	for (const card of cards) {
		if (card.public) continue;
		if (audience !== PUBLIC_AUDIENCE && repoKeyOf(card.key) === audience) continue;
		hidden.add(card.key);
	}
	return hidden;
}

/**
 * Group items by audience, so each group shares one snapshot with the same
 * cards hidden. Groups keep the order items first appear in.
 */
export function groupByAudience<T extends CardAudience>(items: readonly T[]): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const audience = audienceOf(item);
		const group = groups.get(audience);
		if (group) group.push(item);
		else groups.set(audience, [item]);
	}
	return groups;
}

/** Markdown-safe text for link labels: no brackets or newlines. */
function plain(text: string): string {
	return text
		.replace(/[[\]\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export interface BacklinkInput {
	boardUrl: string;
	/** The board's title, when known. */
	boardTitle?: string | null;
	/** The snapshot's public URL, if there is one. */
	snapshotUrl?: string | null;
	/** Something to say first, if anything. */
	note?: string;
}

/** A backlink comment's body, in Markdown. */
export function backlinkBody({ boardUrl, boardTitle, snapshotUrl, note }: BacklinkInput): string {
	const title = boardTitle ? plain(boardTitle) : "";
	const link = title ? `[**${title}**](${boardUrl})` : `[a Tack board](${boardUrl})`;
	const parts: string[] = [];
	if (note?.trim()) parts.push(note.trim());
	parts.push(`This is on ${link}${title ? " in Tack" : ""}.`);
	if (snapshotUrl) parts.push(`[![The board around this item](${snapshotUrl})](${boardUrl})`);
	return parts.join("\n\n");
}

// Snapshot uploads -----------------------------------------------------------------

/** The largest snapshot the server accepts, in bytes. */
export const SNAPSHOT_MAX_BYTES = 1_500_000;

/** The largest snapshot, in pixels on either side. */
export const SNAPSHOT_MAX_SIDE = 4096;

/** A snapshot's id: the board object's id (64 hex) then 32 random hex characters. */
export const SNAPSHOT_ID = /^[0-9a-f]{96}$/;
