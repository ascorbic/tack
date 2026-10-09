import { useEffect, useRef, useState } from "react";
import { type Card, type MissingCard, isMissing } from "../shared/cards.ts";
import { CiBar, PullStatus } from "./PullStatus.tsx";

const STATE_LABEL: Record<Card["state"], string> = {
	open: "Open",
	closed: "Closed",
	merged: "Merged",
	draft: "Draft",
};

function stateLabel(card: Card): string {
	if (card.state === "closed" && card.stateReason === "not_planned") return "Not planned";
	return STATE_LABEL[card.state];
}

function StateIcon({ card, size = 14 }: { card: Card; size?: number }) {
	if (card.kind === "pull") {
		return (
			<svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
				<circle cx="4" cy="3.5" r="1.75" />
				<circle cx="4" cy="12.5" r="1.75" />
				{card.state === "merged" ? (
					<>
						<circle cx="12" cy="8" r="1.75" />
						<path d="M4 5.25v5.5M4 5.25c0 2.5 2 2.75 6.25 2.75" />
					</>
				) : (
					<>
						<circle cx="12" cy="12.5" r="1.75" />
						<path d="M4 5.25v5.5M12 10.75V6.5a2 2 0 0 0-2-2H7.5" />
					</>
				)}
			</svg>
		);
	}
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
			<circle cx="8" cy="8" r="6.25" />
			{card.state === "open" ? (
				<circle cx="8" cy="8" r="1.6" className="fill" />
			) : card.stateReason === "not_planned" ? (
				<path d="M4.5 11.5l7-7" />
			) : (
				<path d="M5.5 8l2 2 3-3.5" />
			)}
		</svg>
	);
}

type Field = "title" | "state" | "labels" | "comments" | "assignees" | "repo";

interface Changes {
	/** How many times each field has changed since mount. */
	counts: Partial<Record<Field, number>>;
	/** Labels added by the most recent label change. */
	newLabels: Set<string>;
	/** Total updates, for the whole-card ripple. */
	total: number;
}

/**
 * Per-field change counters. Keying animated elements on their field's count
 * replays the animation on each change, and overlapping updates to different
 * fields don't cancel each other's animations.
 */
function useChanges(card: Card): Changes {
	const previous = useRef(card);
	const [changes, setChanges] = useState<Changes>({ counts: {}, newLabels: new Set(), total: 0 });

	useEffect(() => {
		const before = previous.current;
		previous.current = card;
		if (before === card || before.key !== card.key) return;
		const fields: Field[] = [];
		if (before.title !== card.title) fields.push("title");
		if (before.state !== card.state || before.stateReason !== card.stateReason)
			fields.push("state");
		if (before.comments !== card.comments) fields.push("comments");
		const oldLabels = new Set(before.labels.map((l) => l.name));
		const added = new Set(card.labels.map((l) => l.name).filter((name) => !oldLabels.has(name)));
		if (added.size > 0 || oldLabels.size !== card.labels.length) fields.push("labels");
		if (before.assignees.length !== card.assignees.length) fields.push("assignees");
		// The repository was renamed or transferred.
		if (before.repo !== card.repo) fields.push("repo");
		if (fields.length === 0) return;
		setChanges((current) => {
			const counts = { ...current.counts };
			for (const field of fields) counts[field] = (counts[field] ?? 0) + 1;
			return {
				counts,
				newLabels: fields.includes("labels") ? added : current.newLabels,
				total: current.total + 1,
			};
		});
	}, [card]);

	return changes;
}

export interface CardViewProps {
	card: Card | MissingCard | undefined;
	cardKey: string;
	selected?: boolean;
	/** Simplified rendering for low zoom levels. */
	compact?: boolean;
	/** Animate in, for shapes that were just added. */
	enter?: boolean;
}

export function CardView({ card, cardKey, selected, compact, enter }: CardViewProps) {
	if (!card) return <LoadingCard cardKey={cardKey} selected={selected} enter={enter} />;
	if (isMissing(card)) return <MissingCardView card={card} selected={selected} />;
	return <LiveCard card={card} selected={selected} compact={compact} enter={enter} />;
}

function LiveCard({
	card,
	selected,
	compact,
	enter,
}: {
	card: Card;
	selected?: boolean;
	compact?: boolean;
	enter?: boolean;
}) {
	const { counts, newLabels, total } = useChanges(card);
	/** Key and flag for an element that animates when `field` changes. */
	const anim = (field: Field, prefix: string) => ({
		key: `${prefix}${counts[field] ?? 0}`,
		on: (counts[field] ?? 0) > 0,
	});
	const state = anim("state", "s");
	const title = anim("title", "t");
	const comments = anim("comments", "m");
	const repo = anim("repo", "r");
	const repoName = card.repo.split("/").at(-1);
	const checks = card.pull?.checks;

	if (compact) {
		return (
			<article
				className="card compact"
				data-state={card.state}
				data-ci={checks?.state}
				data-selected={selected}
				data-enter={enter}
			>
				{total > 0 && <span key={total} className="card-pulse" aria-hidden="true" />}
				<span className="state-icon" key={`s${state.key}`} data-pop={state.on}>
					<StateIcon card={card} size={28} />
				</span>
				<span className="compact-title">{card.title}</span>
				{checks && checks.state !== "none" && <CiBar checks={checks} />}
			</article>
		);
	}

	return (
		<article className="card" data-state={card.state} data-selected={selected} data-enter={enter}>
			{total > 0 && <span key={total} className="card-pulse" aria-hidden="true" />}
			<div className="card-head">
				<span className="state-icon" key={`i${state.key}`} data-pop={state.on}>
					<StateIcon card={card} />
				</span>
				<span className="mono">
					<span key={repo.key} data-flash={repo.on}>
						{repoName}
					</span>{" "}
					{card.item}
				</span>
				<span className="chip state" key={`c${state.key}`} data-pop={state.on}>
					{stateLabel(card)}
				</span>
			</div>
			<a className="card-title" href={card.url} target="_blank" rel="noreferrer" draggable={false}>
				<span key={title.key} data-flash={title.on}>
					{card.title}
				</span>
			</a>
			{card.labels.length > 0 && (
				<div className="labels">
					{card.labels.slice(0, 4).map((label) => (
						<span
							key={label.name}
							className="chip label"
							data-new={newLabels.has(label.name)}
							style={{ "--label": `#${label.color}` } as React.CSSProperties}
						>
							{label.name}
						</span>
					))}
				</div>
			)}
			{card.pull && <PullStatus pull={card.pull} />}
			<div className="card-foot">
				{card.assignees.length > 0 && (
					<span className="avatars">
						{card.assignees.slice(0, 3).map((a) => (
							<img
								key={a.login}
								src={a.avatarUrl}
								alt={a.login}
								title={a.login}
								draggable={false}
							/>
						))}
					</span>
				)}
				<span className="count" key={comments.key} data-tick={comments.on}>
					<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
						<path d="M2.5 3h11v7.5H7l-3 2.5v-2.5H2.5z" />
					</svg>
					{card.comments}
				</span>
				{card.reactions > 0 && (
					<span className="count">
						<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
							<path d="M8 13.5s-5.5-3.2-5.5-7A3 3 0 0 1 8 4.8a3 3 0 0 1 5.5 1.7c0 3.8-5.5 7-5.5 7z" />
						</svg>
						{card.reactions}
					</span>
				)}
			</div>
		</article>
	);
}

function LoadingCard({
	cardKey,
	selected,
	enter,
}: {
	cardKey: string;
	selected?: boolean;
	enter?: boolean;
}) {
	return (
		<article className="card loading" data-selected={selected} data-enter={enter} aria-busy="true">
			<div className="card-head mono">{cardKey.split("/").slice(1).join("/")}</div>
			<div className="skeleton" style={{ width: "86%" }} />
			<div className="skeleton" style={{ width: "58%" }} />
			<div className="skeleton short" />
		</article>
	);
}

function MissingCardView({ card, selected }: { card: MissingCard; selected?: boolean }) {
	const message = {
		forbidden: "You don’t have access to this repository.",
		not_found: "This item doesn’t exist, or was deleted.",
		unsupported: "This forge isn’t supported yet.",
		error: "Couldn’t reach the forge. Retrying…",
		private: "Private reference.",
	}[card.reason];
	return (
		<article className="card missing" data-selected={selected}>
			<div className="card-head mono">{card.key.split("/").slice(1).join("/")}</div>
			<div className="missing-message">{message}</div>
		</article>
	);
}
