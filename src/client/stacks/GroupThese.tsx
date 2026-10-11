import { useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { type ProposedStack, applyGrouping, planGrouping } from "../../shared/stackEdits.ts";
import { cleanText } from "../../shared/stacks.ts";
import type { SizeOf } from "../../shared/sections.ts";
import { readShapes } from "../../shared/structure.ts";
import { Notice, PopoverHead, SUBMIT_HINT } from "../actions/Popover.tsx";
import { transactLocal } from "../undo.ts";
import { type GroupAnswer, groupFailure, stackStore } from "./store.ts";
import { SparkIcon } from "./StackNode.tsx";

// "Group these" (#73): stacks the board's AI proposes for a selection of
// stickies, previewed before anything's written. The board marks each
// proposed stack's stickies in its colour while the panel's open
// (`stackStore.setProposal`); names can be changed (and are then a person's,
// not a suggestion), stickies left out, stacks dropped, and the rest made in
// one undo step. Nothing's sent to the model but the selected stickies'
// visible text, and that's the server's to decide (stackNamer.ts).

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

export function GroupThese({
	doc,
	stickies,
	sizeOf,
	onMade,
	onClose,
}: {
	doc: Y.Doc;
	/** The selected stickies, as they read now. */
	stickies: readonly StickyInfo[];
	sizeOf?: SizeOf;
	/** The stacks made, and how many stickies went into them. */
	onMade: (stacks: string[], stickies: number) => void;
	onClose: () => void;
}) {
	const [answer, setAnswer] = useState<GroupAnswer | null>(null);
	const [drafts, setDrafts] = useState<Draft[]>([]);
	const [attempt, setAttempt] = useState(0);
	// The same stickies are the same request, however often the selection's re-read.
	const idsKey = stickies.map((sticky) => sticky.id).join(",");
	const ids = useMemo(() => (idsKey ? idsKey.split(",") : []), [idsKey]);
	const byId = useMemo(() => new Map(stickies.map((sticky) => [sticky.id, sticky])), [stickies]);

	// Ask (again, for Try again), and show what came back.
	useEffect(() => {
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
	}, [ids, attempt]);

	// The board shows what's proposed, as it's tweaked; nothing once it closes.
	const proposal = useMemo(() => drafts.filter((draft) => draft.ids.length >= 2), [drafts]);
	useEffect(() => {
		stackStore.setProposal(answer?.ok ? proposal : null);
	}, [answer, proposal]);
	useEffect(() => () => stackStore.setProposal(null), []);

	const edit = (key: number, change: (draft: Draft) => Draft) =>
		setDrafts((current) => current.map((draft) => (draft.key === key ? change(draft) : draft)));
	const grouped = proposal.reduce((sum, draft) => sum + draft.ids.length, 0);
	const left = stickies.filter(
		(sticky) => !proposal.some((draft) => draft.ids.includes(sticky.id)),
	);

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
				<PopoverHead title={title} detail={`Reading ${stickies.length} stickies for themes…`} />
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
				<Notice tone={answer.reason === "failed" ? "error" : "warn"}>
					{groupFailure(answer.reason)}
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
						: `${proposal.length} ${proposal.length === 1 ? "stack" : "stacks"} of ${grouped} stickies: change a name, or leave stickies out`
				}
			/>
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
					{left.length === 1 ? "1 sticky stays" : `${left.length} stickies stay`} where{" "}
					{left.length === 1 ? "it is" : "they are"}.
				</p>
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
	byId: ReadonlyMap<string, StickyInfo>;
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
				<p className="group-thin">Needs two stickies to make a stack</p>
			) : (
				<ul className="group-chips">
					{draft.ids.map((id) => {
						const sticky = byId.get(id);
						const text = cleanText(sticky?.text ?? "");
						return (
							<li key={id} className="group-chip" data-color={sticky?.color ?? "yellow"}>
								<span className="group-chip-paper" aria-hidden="true" />
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

function CrossIcon() {
	return (
		<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
			<path d="M3 3l6 6M9 3l-6 6" />
		</svg>
	);
}
