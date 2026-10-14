import type { Card } from "./cards.ts";
import { type ReactionCount, orderCounts, topReactions } from "./reactions.ts";

// A card's foot, in widths: how many reaction pills fit beside everything
// else in it (the comment count, assignees, upvotes, the volunteers' chip,
// liveness, a provenance badge), with the rest folded into "+N".
//
// The widths are worked out from the stylesheet's sizes and the fonts'
// metrics rather than measured: Geist and Geist Mono are the app's own, so
// their digits are always 0.6em, and a colour emoji is 1.25em in Apple's
// and Noto's fonts alike. That makes it the same on first paint, in tests
// and for every card on a board, at no cost in layout. Keep the numbers in
// step with styles.css (`.card`, `.card-foot`, `.count`, `.avatars`,
// `.liveness`), reactions.css (`.reaction-pill`), provenance.css and
// volunteers.css (`.volunteers`, `.volunteer`).

/** A card's width on the board (`.card`). */
export const CARD_WIDTH = 252;

/** What a card's padding and border take from its width, either side together. */
const CARD_INSET = 2 * 14 + 2 * 1;

/** Between the things in a foot, and a little closer beside the volunteers' chip. */
const FOOT_GAP = 12;
const FOOT_GAP_VOLUNTEERS = 8;

/** Between one reaction pill and the next. */
const PILL_GAP = 4;

/** A digit's width, in ems: Geist Mono's, and Geist's tabular figures. */
const DIGIT = 0.6;

/** A colour emoji's width, in ems. */
const EMOJI = 1.25;

/** Faces shown in the volunteers' chip before the rest fold into "+N", a face of their own. */
export const MAX_FACES = 4;

function digits(n: number): number {
	return String(Math.max(0, Math.round(n))).length;
}

/** A reaction's pill: border, padding, a 12px emoji, a gap, and its count in 11px mono. */
export function pillWidth(count: number): number {
	return 2 + 5 + 12 * EMOJI + 3 + digits(count) * 11 * DIGIT + 7;
}

/** The "+N" pill for `n` folded reactions. */
export function morePillWidth(n: number): number {
	return 2 + 7 + (1 + digits(n)) * 11 * DIGIT + 7;
}

/** Pills side by side: those `shown`, then "+N" for `folded` more, if any. */
export function pillsWidth(shown: readonly ReactionCount[], folded: number): number {
	const pills = shown.length + (folded > 0 ? 1 : 0);
	return (
		shown.reduce((sum, c) => sum + pillWidth(c.count), 0) +
		(folded > 0 ? morePillWidth(folded) : 0) +
		PILL_GAP * Math.max(0, pills - 1)
	);
}

/** Which reactions have a pill of their own, and which fold into "+N". */
export interface FittedPills {
	shown: ReactionCount[];
	rest: ReactionCount[];
}

/**
 * Which of a card's reactions get a pill of their own in `room` pixels:
 * all of them if they fit, in GitHub's order; otherwise as many of the most
 * left as fit beside a "+N" pill for the rest, still in GitHub's order.
 * At least `least` keep their pills, however little room there is: one at
 * rest, so a card always says what it's mostly had; none beside the
 * unfolded volunteers' chip, where "+N" alone stands for them all.
 */
export function fitPills(counts: readonly ReactionCount[], room: number, least = 1): FittedPills {
	const ordered = orderCounts(counts);
	if (pillsWidth(ordered, 0) <= room) return { shown: ordered, rest: [] };
	const floor = Math.min(least, ordered.length);
	for (let keep = ordered.length - 1; keep >= floor; keep--) {
		const top = new Set(topReactions(ordered, keep).map((c) => c.emoji));
		const shown = ordered.filter((c) => top.has(c.emoji));
		const rest = ordered.filter((c) => !top.has(c.emoji));
		if (keep === floor || pillsWidth(shown, rest.length) <= room) return { shown, rest };
	}
	return { shown: ordered, rest: [] };
}

/**
 * A card's pills at rest, and as they are while the volunteers' chip beside
 * them is unfolded to Assign: fitted again to the room that leaves, so those
 * that no longer fit fold into "+N" rather than slide under the chip.
 * `fitWidth` is what they take then; `openWidth` is their box while the
 * chip's only pointed at, narrowing by no more than the chip widens, so the
 * chip's far edge never moves back from under the pointer that unfolded it
 * (which would fold it again, and so on).
 */
export function unfoldPills(
	counts: readonly ReactionCount[],
	room: number,
	unfoldedRoom: number,
): {
	rest: FittedPills;
	open: FittedPills;
	restWidth: number;
	fitWidth: number;
	openWidth: number;
} {
	const rest = fitPills(counts, room);
	const open = fitPills(counts, unfoldedRoom, 0);
	const restWidth = pillsWidth(rest.shown, rest.rest.length);
	const fitWidth = pillsWidth(open.shown, open.rest.length);
	// A pixel to spare, so the chip's edge errs outwards.
	const openWidth = Math.max(fitWidth, restWidth - (room - unfoldedRoom) + 1);
	return { rest, open, restWidth, fitWidth, openWidth };
}

/** A count with its 12px icon (comments, upvotes), in 11.5px tabular figures. */
function countWidth(n: number): number {
	return 12 + 4 + digits(n) * 11.5 * DIGIT;
}

/** Overlapping 20px faces, each over the next by 6px (`.avatars`). */
function facesWidth(n: number): number {
	return n * 14;
}

/**
 * The volunteers' chip at rest: border, padding, a 19px ✋, then 18px faces,
 * each over the last by 4px, and wider by "Assign" when it's unfolded.
 */
export function volunteersWidth(volunteers: number, unfolded = false): number {
	return 2 + 4 + 19 + 2 + Math.min(volunteers, MAX_FACES) * 14 + (unfolded ? ASSIGN_WIDTH : 0);
}

/** What "Assign" adds to the volunteers' chip as it unfolds: a button of 11px text. */
const ASSIGN_WIDTH = 48;

/** What else a card's foot holds beside its own data. */
export interface FootExtras {
	/** How many have volunteered: the chip after the reactions. */
	volunteers?: number;
	/** The chip unfolded to Assign. */
	unfolded?: boolean;
	/** A provenance badge (what brought the card), at rest: its glyph. */
	provenance?: boolean;
	/** "Not live", or "Live" just after it became so. */
	liveness?: "lazy" | "upgraded" | null;
}

/**
 * The room a card's reaction pills have, in pixels: its foot's width less
 * everything else in it and the gaps between them.
 */
export function pillRoom(
	card: Pick<Card, "assignees" | "author" | "comments" | "discussion">,
	extras: FootExtras = {},
	width: number = CARD_WIDTH,
): number {
	const discussion = card.discussion;
	const beside = [
		card.assignees.length > 0 ? facesWidth(Math.min(card.assignees.length, 3)) : 0,
		discussion && card.author ? facesWidth(1) : 0,
		// Its visually hidden "Upvotes: " adds a hair.
		discussion?.upvotes !== undefined ? countWidth(discussion.upvotes) + 1 : 0,
		countWidth(card.comments),
		discussion?.locked ? 12 : 0,
		extras.volunteers ? volunteersWidth(extras.volunteers, extras.unfolded) : 0,
		extras.provenance ? 20 : 0,
		extras.liveness === "lazy" ? 65 : extras.liveness === "upgraded" ? 47 : 0,
	].filter((w) => w > 0);
	const gap = extras.volunteers ? FOOT_GAP_VOLUNTEERS : FOOT_GAP;
	const taken = beside.reduce((sum, w) => sum + w, 0) + gap * beside.length;
	return width - CARD_INSET - taken;
}
