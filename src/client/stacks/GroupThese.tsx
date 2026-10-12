import { useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { type ProposedStack, applyGrouping, planGrouping } from "../../shared/stackEdits.ts";
import { cleanText, countMembers } from "../../shared/stacks.ts";
import type { SizeOf } from "../../shared/sections.ts";
import { readShapes } from "../../shared/structure.ts";
import { Notice, PopoverHead, SUBMIT_HINT } from "../actions/Popover.tsx";
import { transactLocal } from "../undo.ts";
import { type GroupAnswer, groupFailure, stackStore } from "./store.ts";
import { SparkIcon } from "./StackNode.tsx";

// "Group these" (#73): stacks the board's AI proposes for a selection of
// stickies (and, if asked, the cards selected with them: "Include cards"),
// previewed before anything's written. The board marks each
// proposed stack's stickies in its colour while the panel's open
// (`stackStore.setProposal`); names can be changed (and are then a person's,
// not a suggestion), stickies left out, stacks dropped, and the rest made in
// one undo step. Nothing's sent to the model but the selected stickies'
// visible text and the titles of cards everyone on the board can read, and
// that's the server's to decide (stackNamer.ts).

/** How many proposed stacks get their own colour; past that they repeat. */
export const PROPOSAL_COLORS = ["blue", "orange", "green", "purple", "red", "yellow"] as const;

interface Draft extends ProposedStack {
	key: number;
}

export interface StickyInfo {
	id: string;
	text: string;
	color?: string;
}

/** A card selected with them: its title, number and state, as this person sees it. */
export interface CardInfo {
	id: string;
	text: string;
	ref?: string;
	state?: string;
}

export function GroupThese({
	doc,
	stickies,
	cards = [],
	sizeOf,
	onMade,
	onClose,
	preview,
	initialCards = false,
}: {
	doc: Y.Doc;
	/** The selected stickies, as they read now. */
	stickies: readonly StickyInfo[];
	/** Cards selected with them, which join in only when asked to. */
	cards?: readonly CardInfo[];
	sizeOf?: SizeOf;
	/** The stacks made, and what went into them, in words ("5 stickies"). */
	onMade: (stacks: string[], grouped: string) => void;
	onClose: () => void;
	/** For the gallery: this answer (or "thinking", none yet), never asking. */
	preview?: GroupAnswer | "thinking";
	/** For the gallery: Include cards already ticked. */
	initialCards?: boolean;
}) {
	const [answer, setAnswer] = useState<GroupAnswer | null>(null);
	const [drafts, setDrafts] = useState<Draft[]>([]);
	const [attempt, setAttempt] = useState(0);
	// Cards stay out unless asked in: a theme's usually the stickies'.
	const [withCards, setWithCards] = useState(initialCards);
	const items = useMemo<(StickyInfo | CardInfo)[]>(
		() => (withCards ? [...stickies, ...cards] : [...stickies]),
		[withCards, stickies, cards],
	);
	// The same selection is the same request, however often it's re-read.
	const idsKey = items.map((item) => item.id).join(",");
	const ids = useMemo(() => (idsKey ? idsKey.split(",") : []), [idsKey]);
	const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
	const cardIds = useMemo(() => new Set(cards.map((card) => card.id)), [cards]);

	// Ask (again, for Try again), and show what came back.
	useEffect(() => {
		if (preview) {
			const shown = preview === "thinking" ? null : preview;
			setAnswer(shown);
			if (shown?.ok) setDrafts(shown.stacks.map((stack, key) => ({ ...stack, key })));
			return;
		}
		let live = true;
		setAnswer(null);
		void stackStore.group(ids).then((result) => {
			if (!live) return;
			setAnswer(result);
			if (result.ok) setDrafts(result.stacks.map((stack, key) => ({ ...stack, key })));
		});
		return () => {
			live = false;
		};
	}, [ids, attempt, preview]);

	// The board shows what's proposed, as it's tweaked; nothing once it closes.
	const proposal = useMemo(() => drafts.filter((draft) => draft.ids.length >= 2), [drafts]);
	useEffect(() => {
		if (!preview) stackStore.setProposal(answer?.ok ? proposal : null);
	}, [answer, proposal, preview]);
	useEffect(() => () => stackStore.setProposal(null), []);

	const edit = (key: number, change: (draft: Draft) => Draft) =>
		setDrafts((current) => current.map((draft) => (draft.key === key ? change(draft) : draft)));
	const left = items.filter((item) => !proposal.some((draft) => draft.ids.includes(item.id)));
	const groupedIds = proposal.flatMap((draft) => draft.ids);
	const grouped = countMembers(groupedIds.map((id) => (cardIds.has(id) ? "card" : "sticky")));
	const leftWords = countMembers(left.map((item) => (cardIds.has(item.id) ? "card" : "sticky")));

	const make = () => {
		const named = proposal.filter((draft) => draft.name.trim() || draft.named);
		if (named.length === 0) return;
		const made = transactLocal(doc, () =>
			applyGrouping(doc, planGrouping(readShapes(doc), named, sizeOf), sizeOf),
		);
		stackStore.setProposal(null);
		onMade(made, grouped);
	};

	const title = (
		<span className="group-title">
			<SparkIcon />
			Group these
		</span>
	);

	if (!answer) {
		return (
			<div className="group-these" aria-busy="true">
				<PopoverHead
					title={title}
					detail={`Reading ${countMembers(items.map((item) => (cardIds.has(item.id) ? "card" : "sticky")))} for themes…`}
				/>
				{cards.length > 0 && (
					<IncludeCards count={cards.length} checked={withCards} onChange={setWithCards} />
				)}
				<div className="group-thinking" aria-hidden="true">
					{[0, 1, 2].map((i) => (
						<div key={i} className="group-thinking-row" style={{ "--i": i } as React.CSSProperties}>
							<span className="action-skeleton short" />
							<span className="group-thinking-chips">
								<span />
								<span />
								<span />
							</span>
						</div>
					))}
				</div>
				<footer className="action-foot">
					<button type="button" className="action-secondary" onClick={onClose}>
						Cancel
					</button>
				</footer>
			</div>
		);
	}

	if (!answer.ok) {
		return (
			<div className="group-these">
				<PopoverHead title={title} />
				{cards.length > 0 && (
					<IncludeCards count={cards.length} checked={withCards} onChange={setWithCards} />
				)}
				<Notice tone={answer.reason === "failed" ? "error" : "warn"}>
					{groupFailure(answer.reason, answer.withheld)}
				</Notice>
				<footer className="action-foot">
					<button type="button" className="action-secondary" onClick={onClose}>
						Close
					</button>
					{(answer.reason === "failed" || answer.reason === "limited") && (
						<button
							type="button"
							className="action-primary"
							onClick={() => setAttempt((n) => n + 1)}
						>
							Try again
						</button>
					)}
				</footer>
			</div>
		);
	}

	return (
		<form
			className="group-these"
			onSubmit={(event) => {
				event.preventDefault();
				make();
			}}
		>
			<PopoverHead
				title={title}
				detail={
					proposal.length === 0
						? "No stacks left to make"
						: `${proposal.length} ${proposal.length === 1 ? "stack" : "stacks"} of ${grouped}: change a name, or leave some out`
				}
			/>
			{cards.length > 0 && (
				<IncludeCards count={cards.length} checked={withCards} onChange={setWithCards} />
			)}
			<ol className="group-list">
				{drafts.map((draft, i) => (
					<ProposedRow
						key={draft.key}
						draft={draft}
						color={PROPOSAL_COLORS[i % PROPOSAL_COLORS.length] as string}
						number={i + 1}
						byId={byId}
						onName={(name) => edit(draft.key, (d) => ({ ...d, name, named: true }))}
						onLeaveOut={(id) =>
							edit(draft.key, (d) => ({ ...d, ids: d.ids.filter((other) => other !== id) }))
						}
						onDrop={() =>
							setDrafts((current) => current.filter((other) => other.key !== draft.key))
						}
					/>
				))}
			</ol>
			{left.length > 0 && (
				<p className="group-left">
					{leftWords} {left.length === 1 ? "stays where it is" : "stay where they are"}.
				</p>
			)}
			{(answer.withheld ?? 0) > 0 && (
				<Notice>
					{answer.withheld === 1
						? "A card was left out: its title can’t be shared with everyone on this board."
						: `${answer.withheld} cards were left out: their titles can’t be shared with everyone on this board.`}
				</Notice>
			)}
			<footer className="action-foot">
				<button type="button" className="action-secondary" onClick={() => setAttempt((n) => n + 1)}>
					Try again
				</button>
				<button type="button" className="action-secondary" onClick={onClose}>
					Cancel
				</button>
				<button type="submit" className="action-primary" disabled={proposal.length === 0}>
					{proposal.length === 1 ? "Make the stack" : `Make ${proposal.length} stacks`}
					<kbd>{SUBMIT_HINT}</kbd>
				</button>
			</footer>
		</form>
	);
}

function ProposedRow({
	draft,
	color,
	number,
	byId,
	onName,
	onLeaveOut,
	onDrop,
}: {
	draft: Draft;
	color: string;
	number: number;
	byId: ReadonlyMap<string, StickyInfo | CardInfo>;
	onName: (name: string) => void;
	onLeaveOut: (id: string) => void;
	onDrop: () => void;
}) {
	const field = useRef<HTMLInputElement>(null);
	const thin = draft.ids.length < 2;
	return (
		<li className="group-row" data-color={color} data-thin={thin || undefined}>
			<div className="group-row-head">
				<span className="group-number" aria-hidden="true">
					{number}
				</span>
				<label className="group-name">
					{!draft.named && (
						<span className="group-spark" aria-label="Suggested">
							✨
						</span>
					)}
					<input
						ref={field}
						value={draft.name}
						maxLength={60}
						aria-label={`Name of stack ${number}`}
						placeholder="Untitled stack"
						onChange={(event) => onName(event.target.value)}
					/>
				</label>
				<button
					type="button"
					className="group-drop"
					aria-label={`Don’t make stack ${number}`}
					title="Don’t make this stack"
					onClick={onDrop}
				>
					<CrossIcon />
				</button>
			</div>
			{thin ? (
				<p className="group-thin">Needs two to make a stack</p>
			) : (
				<ul className="group-chips">
					{draft.ids.map((id) => {
						const item = byId.get(id);
						const text = cleanText(item?.text ?? "");
						const card = item && "ref" in item ? item : null;
						return (
							<li
								key={id}
								className="group-chip"
								data-color={item && "color" in item ? (item.color ?? "yellow") : "yellow"}
								data-card={card ? true : undefined}
								data-state={card?.state}
							>
								{card ? (
									<span className="group-chip-ref">{card.ref}</span>
								) : (
									<span className="group-chip-paper" aria-hidden="true" />
								)}
								<span className="group-chip-text">{text || "Empty sticky"}</span>
								<button
									type="button"
									aria-label={`Leave “${text.slice(0, 40)}” out`}
									title="Leave it out"
									onClick={() => onLeaveOut(id)}
								>
									<CrossIcon />
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</li>
	);
}

/** Whether the cards selected with the stickies join in. */
function IncludeCards({
	count,
	checked,
	onChange,
}: {
	count: number;
	checked: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<label className="group-include">
			<input
				type="checkbox"
				checked={checked}
				onChange={(event) => onChange(event.target.checked)}
			/>
			<span>
				Include cards <span className="group-include-count">({count} selected)</span>
			</span>
		</label>
	);
}

function CrossIcon() {
	return (
		<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
			<path d="M3 3l6 6M9 3l-6 6" />
		</svg>
	);
}
