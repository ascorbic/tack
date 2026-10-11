import { ViewportPortal } from "@xyflow/react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import {
	type DotVote,
	covers,
	dottersOn,
	isOpen,
	placeDot,
	removeDot,
	tallyVote,
	voteFor,
} from "../../shared/dotvotes.ts";
import {
	type StampCount,
	type StampEmoji,
	type Stamper,
	toggleStamp,
} from "../../shared/facilitation.ts";
import { type SizeOf, boxOf } from "../../shared/sections.ts";
import type { ShapeProps } from "../../shared/shapes.ts";
import type { ShapeNode } from "../board.ts";
import { cardStore } from "../cardStore.ts";
import { transactLocal } from "../undo.ts";
import { useServerNow, useStampCounts, useVotes } from "./hooks.ts";
import { facilitation } from "./store.ts";
import { useDismissedVotes } from "./Votes.tsx";

// What people put on shapes in a session: stamps inside a shape's
// bottom-right corner (👍 3 ❤️ 1), and dot votes in its top-right corner.
// Drawn on their own layer above the shapes, in board coordinates, so they
// move with them.

/** Stamp a shape, or take your stamp back off. One undo step. */
export function stampShape(doc: Y.Doc, id: string, emoji: StampEmoji, me: Stamper): boolean {
	return transactLocal(doc, () => toggleStamp(doc, id, emoji, me));
}

export type DotResult = "placed" | "removed" | "none_left" | "no_vote";

/**
 * Put a dot on a shape in the vote that covers it, or with `remove` take
 * one of yours back. One undo step.
 */
export function dotShape(
	doc: Y.Doc,
	votes: readonly DotVote[],
	shapes: ReadonlyMap<string, Pick<ShapeProps, "type" | "parent">>,
	id: string,
	me: Stamper,
	remove = false,
): DotResult {
	const vote = voteFor(votes, shapes, id, facilitation.serverNow());
	if (!vote) return "no_vote";
	return transactLocal(doc, () => {
		if (remove) return removeDot(doc, vote.id, me, id) ? "removed" : "no_vote";
		return placeDot(doc, vote.id, me, id) ? "placed" : "none_left";
	});
}

/** Dots shown one by one before the rest fold into "+N". */
const MAX_DOTS = 8;

export function MarksLayer({
	doc,
	nodes,
	sizeOf,
	me,
	readOnly,
	voting,
}: {
	doc: Y.Doc;
	nodes: ShapeNode[];
	sizeOf: SizeOf;
	me: Stamper;
	readOnly: boolean;
	/** The dot-voting tool is on: show which shapes take dots. */
	voting: boolean;
}) {
	const stamps = useStampCounts(doc, me);
	const votes = useVotes(doc);
	const now = useServerNow(30_000, votes.length > 0);
	const open = useMemo(() => votes.filter((vote) => isOpen(vote, now)), [votes, now]);
	const shapes = useMemo(
		() => new Map(nodes.map((node) => [node.id, node.data.shape] as const)),
		[nodes],
	);
	// A closed vote leaves each shape's rank on it until it's put away.
	const dismissed = useDismissedVotes();
	const ranks = useMemo(() => {
		const out = new Map<string, Rank>();
		for (const vote of votes) {
			if (isOpen(vote, now) || dismissed.has(vote.id)) continue;
			const rows = tallyVote(vote, doc, (ref) => cardStore.get(ref));
			for (const row of rows) {
				out.set(row.shape, { rank: row.rank, total: row.total, of: rows.length });
			}
		}
		return out;
	}, [votes, now, dismissed, doc]);
	if (stamps.size === 0 && open.length === 0 && ranks.size === 0) return null;
	return (
		<ViewportPortal>
			<div className="marks-layer" data-voting={voting}>
				{nodes.map((node) => {
					const shape = node.data.shape;
					const counts = stamps.get(node.id);
					const vote = open.length > 0 ? voteFor(open, shapes, node.id, now) : null;
					const rank = vote ? undefined : ranks.get(node.id);
					if (node.hidden || (!counts && !vote && !rank)) return null;
					// Rows and mini cards in a list count their own, inline (#72).
					const inline = node.data.display === "row" || node.data.display === "mini";
					// A pile's marks sit on its stack, or its tray while it's open (#73).
					const box =
						(inline || node.type === "pile") && node.width && node.height
							? { x: node.position.x, y: node.position.y, w: node.width, h: node.height }
							: boxOf(node.id, { ...shape, x: node.position.x, y: node.position.y }, sizeOf);
					return (
						<ShapeMarks
							key={node.id}
							doc={doc}
							id={node.id}
							x={box.x}
							y={box.y}
							w={box.w}
							h={box.h}
							counts={inline ? undefined : counts}
							vote={inline ? null : vote}
							rank={inline ? undefined : rank}
							me={me}
							readOnly={readOnly}
							voting={voting && vote !== null}
						/>
					);
				})}
			</div>
		</ViewportPortal>
	);
}

const ShapeMarks = memo(function ShapeMarks({
	doc,
	id,
	x,
	y,
	w,
	h,
	counts,
	vote,
	rank,
	me,
	readOnly,
	voting,
}: {
	doc: Y.Doc;
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
	counts: StampCount[] | undefined;
	vote: DotVote | null;
	rank?: Rank;
	me: Stamper;
	readOnly: boolean;
	voting: boolean;
}) {
	return (
		<>
			{voting && (
				<div
					className="vote-target"
					aria-hidden="true"
					style={{ transform: `translate(${x}px, ${y}px)`, width: w, height: h }}
				/>
			)}
			{vote && (
				<div className="vote-dots-anchor" style={{ transform: `translate(${x + w}px, ${y}px)` }}>
					<VoteDots
						vote={vote}
						shape={id}
						me={me}
						onRemoveMine={
							voting && !readOnly
								? () => transactLocal(doc, () => removeDot(doc, vote.id, me, id))
								: undefined
						}
					/>
				</div>
			)}
			{rank && (
				<div className="vote-dots-anchor" style={{ transform: `translate(${x + w}px, ${y}px)` }}>
					<VoteRank rank={rank} />
				</div>
			)}
			{counts && (
				<div className="stamps-anchor" style={{ transform: `translate(${x + w}px, ${y + h}px)` }}>
					<StampRow
						counts={counts}
						onToggle={readOnly ? undefined : (emoji) => stampShape(doc, id, emoji, me)}
					/>
				</div>
			)}
		</>
	);
});

/** Where a shape came in a closed vote. */
export interface Rank {
	rank: number;
	total: number;
	/** How many shapes got votes. */
	of: number;
}

const ORDINALS = ["1st", "2nd", "3rd"];

/** A closed vote's result on a shape: its rank, and how many votes it got. */
export function VoteRank({ rank }: { rank: Rank }) {
	const place = ORDINALS[rank.rank - 1] ?? `${rank.rank}th`;
	const label = `${place} of ${rank.of}: ${rank.total} ${rank.total === 1 ? "vote" : "votes"}`;
	return (
		<div
			className="vote-rank"
			data-podium={rank.rank <= 3 ? rank.rank : undefined}
			role="img"
			aria-label={label}
			data-tooltip={label}
		>
			<span className="vote-rank-place">{rank.rank}</span>
			<span className="vote-rank-total">{rank.total}</span>
		</div>
	);
}

/** A shape's stamps, counted: click one to add yours, or take it back. */
export function StampRow({
	counts,
	onToggle,
}: {
	counts: StampCount[];
	onToggle?: (emoji: StampEmoji) => void;
}) {
	return (
		<div className="stamps nodrag nopan" role="group" aria-label="Stamps">
			{counts.map((count) => (
				<StampChip key={count.emoji} count={count} onToggle={onToggle} />
			))}
		</div>
	);
}

function StampChip({
	count,
	onToggle,
}: {
	count: StampCount;
	onToggle?: (emoji: StampEmoji) => void;
}) {
	// Pop when the count goes up while you watch.
	const [pop, setPop] = useState(0);
	const last = useRef(count.count);
	useEffect(() => {
		if (count.count > last.current) setPop((n) => n + 1);
		last.current = count.count;
	}, [count.count]);
	const names = count.people.map((p) => p.name).join(", ");
	const label = `${count.emoji} ${count.count}: ${names}${count.mine ? " (including you)" : ""}`;
	return (
		<button
			type="button"
			className="stamp"
			data-mine={count.mine}
			data-pop={pop > 0 || undefined}
			key={pop}
			aria-label={label}
			aria-pressed={count.mine}
			data-tooltip={names}
			disabled={!onToggle}
			onPointerDown={(event) => event.stopPropagation()}
			onClick={(event) => {
				event.stopPropagation();
				onToggle?.(count.emoji);
			}}
		>
			<span className="stamp-emoji" aria-hidden="true">
				{count.emoji}
			</span>
			{count.count > 1 && (
				<span className="stamp-count" aria-hidden="true">
					{count.count}
				</span>
			)}
		</button>
	);
}

/**
 * Dots on a shape, in each voter's colour, yours ringed. While a vote hides
 * its results, you see only your own.
 */
export function VoteDots({
	vote,
	shape,
	me,
	onRemoveMine,
}: {
	vote: DotVote;
	shape: string;
	me: Stamper;
	/** While voting: your own dots can be clicked to take them back. */
	onRemoveMine?: () => void;
}) {
	const mineKey = me.login ? `@${me.login.toLowerCase()}` : `~${me.name}`;
	const dotters = dottersOn(vote, shape);
	const shown = vote.hidden ? dotters.filter((d) => d.key === mineKey) : dotters;
	const dots = shown.flatMap((d) =>
		Array.from({ length: d.dots }, (_, i) => ({
			key: `${d.key}:${i}`,
			color: d.color,
			mine: d.key === mineKey,
			name: d.name,
		})),
	);
	// Mine first, so they're easy to find and take back.
	dots.sort((a, b) => Number(b.mine) - Number(a.mine));
	if (dots.length === 0) return null;
	const extra = dots.length - MAX_DOTS;
	const total = dotters.reduce((n, d) => n + d.dots, 0);
	const label = vote.hidden
		? `Your dots: ${dots.length}`
		: `${total} ${total === 1 ? "dot" : "dots"}: ${dotters.map((d) => `${d.name} ${d.dots}`).join(", ")}`;
	return (
		<div className="vote-dots" role="img" aria-label={label} data-tooltip={label}>
			{dots.slice(0, extra > 0 ? MAX_DOTS - 1 : MAX_DOTS).map((dot) =>
				dot.mine && onRemoveMine ? (
					<button
						type="button"
						key={dot.key}
						className="vote-dot nodrag nopan"
						data-mine
						aria-label="Take this dot back"
						style={{ "--dot": dot.color || "var(--accent)" } as React.CSSProperties}
						onPointerDown={(event) => event.stopPropagation()}
						onClick={(event) => {
							event.stopPropagation();
							onRemoveMine();
						}}
					/>
				) : (
					<span
						key={dot.key}
						className="vote-dot"
						data-mine={dot.mine}
						style={{ "--dot": dot.color || "var(--accent)" } as React.CSSProperties}
					/>
				),
			)}
			{extra > 0 && <span className="vote-dot-more">+{extra + 1}</span>}
		</div>
	);
}

/** Whether any open vote covers a shape (for the dot tool's hints). */
export function anyVoteCovers(
	votes: readonly DotVote[],
	shapes: ReadonlyMap<string, Pick<ShapeProps, "type" | "parent">>,
	id: string,
	now: number,
): boolean {
	return votes.some((vote) => isOpen(vote, now) && covers(vote, shapes, id));
}
