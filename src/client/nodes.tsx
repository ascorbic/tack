import type { NodeProps } from "@xyflow/react";
import { createContext, memo, useContext } from "react";
import type * as Y from "yjs";
import { type Card, isMissing } from "../shared/cards.ts";
import { type ShapeNode, setStickyText } from "./board.ts";
import { useCard } from "./cardStore.ts";

export const DocContext = createContext<Y.Doc | null>(null);

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

function StateIcon({ card }: { card: Card }) {
	if (card.kind === "pull") {
		return (
			<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
				<circle cx="4" cy="3.5" r="1.75" />
				<circle cx="4" cy="12.5" r="1.75" />
				<circle cx="12" cy="12.5" r="1.75" />
				<path d="M4 5.25v5.5M12 10.75V6.5a2 2 0 0 0-2-2H7.5" />
			</svg>
		);
	}
	return (
		<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
			<circle cx="8" cy="8" r="6.25" />
			{card.state === "open" ? (
				<circle cx="8" cy="8" r="1.6" className="fill" />
			) : (
				<path d="M5.5 8l2 2 3-3.5" />
			)}
		</svg>
	);
}

export const CardNode = memo(function CardNode({ data, selected }: NodeProps<ShapeNode>) {
	const ref = data.shape.ref ?? "";
	const card = useCard(ref);

	if (!card) {
		return (
			<article className="card loading" data-selected={selected}>
				<div className="card-head mono">{ref}</div>
				<div className="card-title muted">Loading…</div>
			</article>
		);
	}
	if (isMissing(card)) {
		return (
			<article className="card missing" data-selected={selected}>
				<div className="card-head mono">{ref}</div>
				<div className="card-title muted">
					{card.reason === "forbidden"
						? "You don’t have access to this repository."
						: card.reason === "not_found"
							? "Not found."
							: "Couldn’t load from GitHub."}
				</div>
			</article>
		);
	}

	return (
		<article className="card" data-state={card.state} data-selected={selected}>
			<div className="card-head">
				<span className="state-icon">
					<StateIcon card={card} />
				</span>
				<span className="mono">
					{card.repo.split("/")[1]} #{card.number}
				</span>
				<span className="chip state">{stateLabel(card)}</span>
			</div>
			<a className="card-title nodrag" href={card.url} target="_blank" rel="noreferrer">
				{card.title}
			</a>
			{card.labels.length > 0 && (
				<div className="labels">
					{card.labels.slice(0, 4).map((label) => (
						<span key={label.name} className="chip" style={{ background: `#${label.color}33` }}>
							{label.name}
						</span>
					))}
				</div>
			)}
			<div className="card-foot">
				<span className="avatars">
					{card.assignees.slice(0, 3).map((a) => (
						<img key={a.login} src={a.avatarUrl} alt={a.login} title={a.login} />
					))}
				</span>
				<span>{card.comments} comments</span>
				{card.reactions > 0 && <span>{card.reactions} reactions</span>}
			</div>
		</article>
	);
});

export const StickyNode = memo(function StickyNode({ data, selected }: NodeProps<ShapeNode>) {
	const doc = useContext(DocContext);
	return (
		<div className="sticky" data-color={data.shape.color} data-selected={selected}>
			<textarea
				className="nodrag"
				aria-label="Sticky note"
				placeholder="Type something…"
				value={data.shape.text ?? ""}
				onChange={(event) => doc && setStickyText(doc, data.id, event.target.value)}
			/>
		</div>
	);
});

export const nodeTypes = { card: CardNode, sticky: StickyNode };
