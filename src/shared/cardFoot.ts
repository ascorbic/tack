import type { Card } from "./cards.ts";
import { type ReactionCount, orderCounts, topReactions } from "./reactions.ts";

// A card's foot, in widths: how many reaction pills fit beside everything
// else in it (the comment count, assignees, upvotes, the volunteers' chip,
// liveness, a provenance badge), with the rest folded into "+N".
//
// The widths are worked out from the stylesheet's sizes and the fonts'
// metrics rather than measured: Geist and Geist Mono are the app's own, so
// their digits are always 0.6em, and an emoji is set in a box 1.25em wide
// (styles.css), whatever the emoji font and however big the browser draws it. That makes it the same on first paint, in tests
// and for every card on a board, at no cost in layout. Keep the numbers in
// step with styles.css (`.card`, `.card-foot`, `.count`, `.avatars`,
// `.liveness`), reactions.css (`.reaction-pill`), provenance.css and
// volunteers.css (`.volunteers`, `.volunteer`).

/** A card's width on the board (`.card`). */
export const CARD_WIDTH = 252;

/** What a card's padding and border take from its width, either side together. */
const CARD_INSET = 2 * 14 + 2 * 1;

/** Between the things in a foot. */
const FOOT_GAP = 12;

/** Between one reaction pill and the next. */
const PILL_GAP = 4;

/** A digit's width, in ems: Geist Mono's, and Geist's tabular figures. */
const DIGIT = 0.6;

/** An emoji's box, in ems. */
const EMOJI = 1.25;

/** Faces shown in the volunteers' chip before the rest fold into "+N", a face of their own. */
export const MAX_FACES = 4;

function digits(n: number): number {
	return String(Math.max(0, Math.round(n))).length;
}

/** A reaction's pill: border, padding (a stamp's), a 12px emoji, a gap, and its count in 11px mono. */
export function pillWidth(count: number): number {
	return 2 + 6 + 12 * EMOJI + 3 + digits(count) * 11 * DIGIT + 7;
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
 * left as fit beside a "+N" pill for the rest, still in GitHub's order; and
 * where not even one does, "+N" alone stands for them all (but a lone kind
 * keeps its pill).
 */
export function fitPills(counts: readonly ReactionCount[], room: number): FittedPills {
	const ordered = orderCounts(counts);
	if (pillsWidth(ordered, 0) <= room) return { shown: ordered, rest: [] };
	// A lone kind keeps its pill: "+1" would say less in nearly as much room.
	const floor = ordered.length > 1 ? 0 : 1;
	for (let keep = ordered.length - 1; keep >= floor; keep--) {
		const top = new Set(topReactions(ordered, keep).map((c) => c.emoji));
		const shown = ordered.filter((c) => top.has(c.emoji));
		const rest = ordered.filter((c) => !top.has(c.emoji));
		if (keep === floor || pillsWidth(shown, rest.length) <= room) return { shown, rest };
	}
	return { shown: ordered, rest: [] };
}

/** A card's pills at rest, and as they are while something beside them opens. */
export interface UnfoldedPills {
	rest: FittedPills;
	/** Fitted again to the room left: those that no longer fit fold into "+N". */
	open: FittedPills;
	/** Whether "+N" shows then: not where even it doesn't fit. */
	more: boolean;
	restWidth: number;
	/** What they take then. */
	fitWidth: number;
}

/**
 * A card's pills at rest, and fitted again to the room left while the
 * volunteers' ghost ✋ shows beside them, or "Assign" opens over their end:
 * those that no longer fit fold into "+N", rather than anything sliding
 * under anything else. Where even "+N" doesn't fit then, it folds too.
 */
export function unfoldPills(
	counts: readonly ReactionCount[],
	room: number,
	unfoldedRoom: number,
): UnfoldedPills {
	const rest = fitPills(counts, room);
	let open = fitPills(counts, unfoldedRoom);
	// Not even a lone kind's pill fits: it folds too.
	if (pillsWidth(open.shown, open.rest.length) > unfoldedRoom && open.shown.length > 0) {
		open = { shown: [], rest: [...open.shown, ...open.rest] };
	}
	const more = open.rest.length > 0 && pillsWidth(open.shown, open.rest.length) <= unfoldedRoom;
	return {
		rest,
		open,
		more,
		restWidth: pillsWidth(rest.shown, rest.rest.length),
		fitWidth: pillsWidth(open.shown, more ? open.rest.length : 0),
	};
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
 * The volunteers' chip: border, padding, a 19px ✋, a gap, then 18px faces,
 * each over the last by 4px, and a pixel's padding at its end. It sits 4px
 * closer to the reactions than the foot's other things are to each other.
 */
export function volunteersWidth(volunteers: number): number {
	return 2 + 3 + 19 + 1 + 4 + Math.min(volunteers, MAX_FACES) * 14 + 1;
}

/** How much closer the chip (or its ghost) sits to the reactions. */
const CHIP_CLOSER = 4;

/**
 * What "Assign" takes as it opens: at the chip's end, where the foot has
 * room to spare for it; otherwise over the end of the reactions, from the
 * chip's start, with a little air before it. Either way the chip's ✋ and
 * faces stay exactly where they were, under the pointer.
 */
export const ASSIGN_WIDTH = 48;
const ASSIGN_OVER = 50 - (FOOT_GAP - CHIP_CLOSER) + 4;

/**
 * The ghost of the chip, before anyone's volunteered: ✋ and a dashed
 * circle where your face will be, as wide as the chip with you in it, so
 * pressing it changes nothing's place. It shows as you point at or select
 * the card, and takes no room otherwise.
 */
export const GHOST_WIDTH = volunteersWidth(1);

/**
 * What a provenance badge's label adds as it opens ("From the “Bugs” list"):
 * its 11px text, a little generously, and the padding it gains.
 */
export function provenanceLabelWidth(label: string): number {
	return label.length * 6.2 + 5 + 5;
}

/** What else a card's foot holds beside its own data. */
export interface FootExtras {
	/** How many have volunteered: the chip after the reactions, or its ghost with none. */
	volunteers?: number;
	/** The ghost ✋ showing, where the chip will be, while nobody's volunteered. */
	ghost?: boolean;
	/** A provenance badge (what brought the card), at rest: its glyph. */
	provenance?: boolean;
	/** "Not live", or "Live" just after it became so. */
	liveness?: "lazy" | "upgraded" | null;
}

type FootCard = Pick<Card, "assignees" | "author" | "comments" | "discussion">;

/**
 * The room a card's reaction pills have, in pixels: its foot's width less
 * everything else in it and the gaps between them.
 */
export function pillRoom(
	card: FootCard,
	extras: FootExtras = {},
	width: number = CARD_WIDTH,
): number {
	const discussion = card.discussion;
	const chip = extras.volunteers
		? volunteersWidth(extras.volunteers)
		: extras.ghost
			? GHOST_WIDTH
			: 0;
	const beside = [
		card.assignees.length > 0 ? facesWidth(Math.min(card.assignees.length, 3)) : 0,
		discussion && card.author ? facesWidth(1) : 0,
		// Its visually hidden "Upvotes: " adds a hair.
		discussion?.upvotes !== undefined ? countWidth(discussion.upvotes) + 1 : 0,
		countWidth(card.comments),
		discussion?.locked ? 12 : 0,
		chip,
		extras.provenance ? 20 : 0,
		extras.liveness === "lazy" ? 65 : extras.liveness === "upgraded" ? 47 : 0,
	].filter((w) => w > 0);
	const taken =
		beside.reduce((sum, w) => sum + w, 0) + FOOT_GAP * beside.length - (chip ? CHIP_CLOSER : 0);
	return width - CARD_INSET - taken;
}

/** The pills' width at rest in `room`: none, a total in words, or fitted. */
function restPillsWidth(card: Pick<Card, "reactions" | "reactionCounts">, room: number): number {
	if (card.reactions <= 0) return 0;
	const counts = card.reactionCounts;
	// "9 reactions": the total, in words.
	if (!counts || counts.length === 0) return 75;
	const { shown, rest } = fitPills(counts, room);
	return pillsWidth(shown, rest.length);
}

/**
 * How a card's foot lays out (CardView.tsx, volunteers.css): the room for
 * its reactions at rest; the room they have while the ghost ✋ shows, or
 * while "Assign" opens over their end; which end of the chip "Assign" opens
 * at; and the room spare at the foot's end, where a provenance badge's
 * label opens, at rest and while the ghost or "Assign" is showing.
 */
export interface FootPlan {
	room: number;
	unfold?: { kind: "ghost" | "chip"; room: number };
	assign?: "start" | "end";
	spare: number;
	openSpare: number;
}

export function planFoot(
	card: FootCard & Pick<Card, "reactions" | "reactionCounts">,
	extras: FootExtras & { unfolds?: boolean },
	width: number = CARD_WIDTH,
): FootPlan {
	const room = pillRoom(card, extras, width);
	const restWidth = restPillsWidth(card, room);
	const spare = room - restWidth;
	const counts = card.reactions > 0 ? card.reactionCounts : undefined;
	const counted = !!counts && counts.length > 0;
	if (extras.volunteers === 0) {
		const ghostRoom = pillRoom(card, { ...extras, ghost: true }, width);
		const open = counted ? unfoldPills(counts, room, ghostRoom).fitWidth : restWidth;
		return {
			room,
			// A total in words doesn't fold: it keeps its place.
			unfold: counted ? { kind: "ghost", room: ghostRoom } : undefined,
			spare,
			openSpare: ghostRoom - open,
		};
	}
	if (!extras.volunteers || !extras.unfolds) return { room, spare, openSpare: spare };
	// Room to spare at the foot's end: "Assign" opens there, and nothing else moves.
	if (spare >= ASSIGN_WIDTH) return { room, assign: "end", spare, openSpare: spare - ASSIGN_WIDTH };
	// Otherwise over the reactions' end, which fold to make way for it.
	return {
		room,
		assign: "start",
		unfold: counted ? { kind: "chip", room: restWidth - ASSIGN_OVER } : undefined,
		spare,
		openSpare: spare,
	};
}
