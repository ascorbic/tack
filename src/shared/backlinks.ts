import { repoKeyOf } from "./refs.ts";

// Backlinks (#33): a comment on an item linking back to the board, and, if
// the person asks for one, a snapshot of the board around it.
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

/**
 * Markdown-safe text for bold link labels and names: on one line, with no
 * brackets, and with emphasis, code and HTML characters escaped.
 */
function plain(text: string): string {
	return text
		.replace(/[[\]\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[\\*_`~<>]/g, (char) => `\\${char}`);
}

export interface BacklinkInput {
	boardUrl: string;
	/** The board's title, when known. */
	boardTitle?: string | null;
	/** The title of the section the item's card sits in, if it's in one. */
	section?: string | null;
	/** The snapshot's public URL, if there is one (snapshots are opt-in). */
	snapshotUrl?: string | null;
	/** Something to say first, if anything. */
	note?: string;
}

/** A backlink comment's body, in Markdown. */
export function backlinkBody({
	boardUrl,
	boardTitle,
	section,
	snapshotUrl,
	note,
}: BacklinkInput): string {
	const title = boardTitle ? plain(boardTitle) : "";
	const where = section ? plain(section) : "";
	const link = title ? `[**${title}**](${boardUrl})` : `[a Tack board](${boardUrl})`;
	const parts: string[] = [];
	if (note?.trim()) parts.push(note.trim());
	parts.push(
		`This is on ${link}${title ? " in Tack" : ""}${where ? `, in the **${where}** section` : ""}.`,
	);
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

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG's size from its header, or null if it isn't a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
	if (bytes.length < 33) return null;
	if (!PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) return null;
	// The first chunk must be IHDR: length 13, then the type.
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(8) !== 13) return null;
	if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
	const width = view.getUint32(16);
	const height = view.getUint32(20);
	if (width === 0 || height === 0) return null;
	return { width, height };
}
