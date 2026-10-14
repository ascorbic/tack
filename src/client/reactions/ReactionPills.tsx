import type { ReactNode } from "react";
import type { Card } from "../../shared/cards.ts";
import {
	type ReactionCount,
	type ReactionGroup,
	LINE_CHARS,
	REACTION_ORDER,
	namePeople,
	namedPerLine,
	namedReactors,
	pillsFor,
	reactionCount,
	topReactions,
} from "../../shared/reactions.ts";
import { knownName, selfLogin } from "./names.ts";
import { ReactionTip, TipLine, useTip } from "./ReactionTip.tsx";
import { type ReactorsState, useReactors } from "./reactors.ts";

// A card's reactions as GitHub shows them: a pill for each emoji with its
// count (👍 11 ❤️ 6 🎉 3), in GitHub's order, looking as stamps do so
// reactions read the same everywhere on the board. Past the room there is,
// the most left keep their pills and the rest fold into "+N".
//
// Hovering, focusing or tapping a pill says who left that one: "👍 Kai
// Andersen, Priya Shah and 9 others". Names are asked for then, once for
// the whole card (reactors.ts); until they come it says how many with three
// dots breathing, and when they can't be had (no token, a forge that can't
// say) just how many. Card data cached before Tack read each emoji's count
// shows the total alone, in words, until the card is next fetched.

/** What the gallery shows without hovering: which pill, and as what. */
export interface ShowReactors {
	/** The emoji's pill, "more" for "+N", or "total" for card data with only a total. */
	pill: string;
	state?: ReactorsState;
}

export function ReactionPills({
	card,
	room,
	show,
}: {
	card: Pick<Card, "key" | "reactions" | "reactionCounts">;
	/** How many pills fit, "+N" included. */
	room: number;
	show?: ShowReactors;
}) {
	const total = card.reactions;
	if (total <= 0) return null;
	const counts = card.reactionCounts;
	if (!counts || counts.length === 0) {
		return (
			<span className="reaction-pills">
				<GroupPill
					cardKey={card.key}
					total={total}
					emojis={null}
					label={reactionCount(total)}
					show={show?.pill === "total" ? show : undefined}
				>
					<span className="reaction-pill-count">{total}</span>
					<span className="reaction-pill-word">{total === 1 ? "reaction" : "reactions"}</span>
				</GroupPill>
			</span>
		);
	}
	const { shown, rest } = pillsFor(counts, room);
	return (
		<span className="reaction-pills" role="group" aria-label="Reactions">
			{shown.map((count) => (
				<EmojiPill
					key={count.emoji}
					cardKey={card.key}
					total={total}
					count={count}
					show={show?.pill === count.emoji ? show : undefined}
				/>
			))}
			{rest.length > 0 && (
				<GroupPill
					cardKey={card.key}
					total={total}
					emojis={rest.map((c) => c.emoji)}
					label={`${rest.length} more: ${rest.map((c) => `${c.emoji} ${c.count}`).join(", ")}`}
					show={show?.pill === "more" ? show : undefined}
				>
					<span className="reaction-pill-count">+{rest.length}</span>
				</GroupPill>
			)}
		</span>
	);
}

/** One emoji's pill: 👍 11, and who on hover. */
function EmojiPill({
	cardKey,
	total,
	count,
	show,
}: {
	cardKey: string;
	total: number;
	count: ReactionCount;
	show?: ShowReactors;
}) {
	const tip = useTip({ tapOpens: true });
	const fetched = useReactors(cardKey, total, tip.open || Boolean(show));
	const state = show?.state ?? fetched;
	const group = state.status === "ready" ? state.groups.find((g) => g.emoji === count.emoji) : null;
	// One line: fewer names rather than a wrap.
	const names = group ? phrase(group, count.count, undefined, LINE_CHARS) : null;
	return (
		<Pill
			tip={tip}
			label={`${count.emoji} ${count.count}${names ? `: ${names.said}` : ""}`}
			force={Boolean(show)}
			pill={
				<>
					<span className="reaction-pill-emoji" aria-hidden="true">
						{count.emoji}
					</span>
					<span className="reaction-pill-count" aria-hidden="true">
						{count.count}
					</span>
				</>
			}
		>
			<TipLine emoji={count.emoji} oneLine>
				{names ? (
					names.shown
				) : (
					<Quiet loading={state.status === "loading"}>{namePeople([], count.count)}</Quiet>
				)}
			</TipLine>
		</Pill>
	);
}

/**
 * A pill for several emoji at once (`emojis`, or every one with null):
 * "+2" for those past the room, or a total for card data with no more.
 * Its tip has a line for each.
 */
function GroupPill({
	cardKey,
	total,
	emojis,
	label,
	show,
	children,
}: {
	cardKey: string;
	total: number;
	emojis: string[] | null;
	label: string;
	show?: ShowReactors;
	children: ReactNode;
}) {
	const tip = useTip({ tapOpens: true });
	const fetched = useReactors(cardKey, total, tip.open || Boolean(show));
	const state = show?.state ?? fetched;
	const groups =
		state.status === "ready"
			? state.groups
					.filter((g) => g.count > 0 && (!emojis || emojis.includes(g.emoji)))
					.sort((a, b) => rank(a.emoji) - rank(b.emoji))
			: [];
	const max = namedPerLine(groups.length);
	const chars = groups.length > 1 ? LINE_CHARS : undefined;
	const lines = groups.map((group) => ({
		emoji: group.emoji,
		...phrase(group, group.count, max, chars),
	}));
	return (
		<Pill
			tip={tip}
			label={
				lines.length > 0
					? `${label}: ${lines.map((line) => `${line.emoji} ${line.said}`).join("; ")}`
					: label
			}
			force={Boolean(show)}
			more
			pill={children}
		>
			{lines.length > 0 ? (
				lines.map((line) => (
					<TipLine key={line.emoji} emoji={line.emoji} oneLine={chars !== undefined}>
						{line.shown}
					</TipLine>
				))
			) : (
				<Quiet loading={state.status === "loading"}>{emojis ? label : reactionCount(total)}</Quiet>
			)}
		</Pill>
	);
}

function Pill({
	tip,
	label,
	force,
	more = false,
	pill,
	children,
}: {
	tip: ReturnType<typeof useTip>;
	label: string;
	force: boolean;
	more?: boolean;
	pill: ReactNode;
	children: ReactNode;
}) {
	return (
		<>
			<button
				type="button"
				ref={(el) => {
					tip.ref.current = el;
				}}
				className="reaction-pill nodrag nopan"
				data-more={more || undefined}
				data-open={tip.open || force || undefined}
				aria-label={label}
				{...tip.handlers}
				onClick={(event) => {
					tip.tookClick(event);
				}}
			>
				{pill}
			</button>
			{/* Below the pill: it sits in the card's foot, so the tip covers none of the card. */}
			<ReactionTip tip={tip} force={force} prefer="below">
				{children}
			</ReactionTip>
		</>
	);
}

/** Where an emoji comes in GitHub's order. */
function rank(emoji: string): number {
	const at = REACTION_ORDER.indexOf(emoji);
	return at === -1 ? REACTION_ORDER.length : at;
}

/** How many, quietly, with three dots breathing while names are on their way. */
function Quiet({ loading, children }: { loading: boolean; children: ReactNode }) {
	return (
		<span className="reaction-tip-quiet">
			{children}
			{loading && (
				<span className="reaction-tip-loading" role="status" aria-label="Loading names">
					<span />
					<span />
					<span />
				</span>
			)}
		</span>
	);
}

/** Who left one reaction: to show (whole names) and to say. */
function phrase(group: ReactionGroup, count: number, max?: number, chars?: number) {
	const people = namedReactors(group.reactors, selfLogin(), knownName);
	return {
		shown: namePeople(people, count, { max, chars, whole: true }),
		said: namePeople(people, count, { max, chars }),
	};
}

/**
 * The top one or two reactions, small and not to be pressed: for rows,
 * mini cards and cards zoomed out, where a pill each wouldn't fit. Card
 * data with only a total says how many.
 */
export function TopReactions({
	card,
	top = 2,
}: {
	card: Pick<Card, "reactions" | "reactionCounts">;
	top?: number;
}) {
	if (card.reactions <= 0) return null;
	const counts = card.reactionCounts;
	if (!counts || counts.length === 0) {
		return (
			<span className="top-reactions" role="img" aria-label={reactionCount(card.reactions)}>
				{reactionCount(card.reactions)}
			</span>
		);
	}
	const best = topReactions(counts, top);
	return (
		<span
			className="top-reactions"
			role="img"
			aria-label={`Reactions: ${counts.map((c) => `${c.emoji} ${c.count}`).join(", ")}`}
		>
			{best.map((count) => (
				<span key={count.emoji} className="top-reaction">
					<span className="top-reaction-emoji">{count.emoji}</span>
					{count.count}
				</span>
			))}
		</span>
	);
}
