import { useCallback, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import {
	type AiError,
	type AiLeftOut,
	type DecisionDraft,
	type SummaryDraft,
	decisionBody,
	summaryText,
} from "../../shared/ai.ts";
import { placeDecision, placeSummary } from "../../shared/aiPlace.ts";
import type { SizeOf } from "../../shared/sections.ts";
import type { Author } from "../../shared/shapes.ts";
import { Notice, PopoverHead, SUBMIT_HINT } from "../actions/Popover.tsx";
import { transactLocal } from "../undo.ts";
import { leftOutInWords } from "./describe.ts";
import { DraftDecisionIcon, SparkIcon, SummariseIcon } from "./icons.tsx";
import type { AiService } from "./service.ts";
import "./ai.css";

// Summarise and draft a decision (#64), from the selection's action bar: the
// AI reads what's selected (on the server, as you may see it: never silent
// mode's hidden text, never cards you can't read), and its draft opens here
// to read and edit. Placing it puts it beside the selection as your own
// edit, one undo step: a summary as a text block, a decision as a proposed
// decision linked to the selected cards.

export type DraftMode = "summary" | "decision";

/** What's being edited, once the draft's here. */
export interface DraftEdit {
	title: string;
	text: string;
}

export type DraftState =
	| { status: "loading" }
	| { status: "error"; error: AiError }
	| { status: "ready"; edit: DraftEdit; read: number; leftOut: AiLeftOut };

/** A draft as the panel edits it. */
export function draftEdit(draft: SummaryDraft | DecisionDraft): DraftEdit {
	return draft.kind === "summary"
		? { title: "", text: summaryText(draft) }
		: { title: draft.title, text: decisionBody(draft) };
}

const TITLES: Record<DraftMode, string> = {
	summary: "Summarise",
	decision: "Draft a decision",
};

/** The panel, without a board or the AI: the gallery draws every state with it. */
export function DraftPanelView({
	mode,
	state,
	what,
	onEdit,
	onPlace,
	onRetry,
}: {
	mode: DraftMode;
	state: DraftState;
	/** What's selected, in words: "6 stickies", "the Retro section". */
	what: string;
	onEdit: (edit: DraftEdit) => void;
	onPlace: () => void;
	onRetry: () => void;
}) {
	const first = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
	const ready = state.status === "ready";
	useEffect(() => {
		if (ready) first.current?.focus({ preventScroll: true });
	}, [ready]);
	const head = (
		<PopoverHead
			title={
				<span className="ai-draft-title">
					{mode === "summary" ? <SummariseIcon /> : <DraftDecisionIcon />}
					{TITLES[mode]}
				</span>
			}
			detail={`From ${what}`}
		/>
	);

	if (state.status === "loading") {
		return (
			<div className="ai-draft" aria-busy="true" data-mode={mode}>
				{head}
				<p className="ai-thinking" role="status">
					<SparkIcon size={14} />
					{mode === "summary" ? "Reading and summarising…" : "Reading and drafting…"}
				</p>
				<div className="ai-draft-skeleton">
					<span className="action-skeleton" />
					<span className="action-skeleton" />
					<span className="action-skeleton" />
					<span className="action-skeleton short" />
				</div>
			</div>
		);
	}
	if (state.status === "error") {
		return (
			<div className="ai-draft" data-mode={mode}>
				{head}
				<Notice tone={state.error.reason === "rate_limited" ? "warn" : "error"}>
					{state.error.message}
				</Notice>
				{state.error.reason !== "off" &&
					state.error.reason !== "forbidden" &&
					state.error.reason !== "empty" && (
						<footer className="action-foot">
							<span className="action-summary">Nothing was changed.</span>
							<button type="button" className="action-secondary" data-autofocus onClick={onRetry}>
								Try again
							</button>
						</footer>
					)}
			</div>
		);
	}
	const { edit } = state;
	const leftOut = leftOutInWords(state.leftOut);
	const empty = !edit.text.trim() || (mode === "decision" && !edit.title.trim());
	return (
		<form
			className="ai-draft"
			data-mode={mode}
			onSubmit={(event) => {
				event.preventDefault();
				if (!empty) onPlace();
			}}
		>
			{head}
			{mode === "decision" && (
				<label className="action-field">
					<span>Decision</span>
					<input
						ref={first}
						value={edit.title}
						onChange={(event) => onEdit({ ...edit, title: event.target.value })}
						onKeyDown={(event) => {
							// Placing is ⌘↵ (or the button): Enter alone in the title shouldn't.
							if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
								event.preventDefault();
							}
						}}
					/>
				</label>
			)}
			<label className="action-field">
				<span>{mode === "summary" ? "Summary" : "Context and options"}</span>
				<textarea
					ref={mode === "summary" ? first : undefined}
					className="ai-draft-text"
					value={edit.text}
					rows={Math.min(14, Math.max(6, edit.text.split("\n").length + 1))}
					onChange={(event) => onEdit({ ...edit, text: event.target.value })}
				/>
			</label>
			<p className="ai-draft-note">
				<SparkIcon size={12} />
				<span>
					Drafted from {state.read} {state.read === 1 ? "item" : "items"}
					{leftOut ? `. ${leftOut}.` : "."} Read it through: it goes on the board as yours.
				</span>
			</p>
			<footer className="action-foot">
				<button type="button" className="action-secondary" onClick={onRetry}>
					Try again
				</button>
				<button type="submit" className="action-primary" disabled={empty}>
					{mode === "summary" ? "Place summary" : "Place decision"}
					<kbd>{SUBMIT_HINT}</kbd>
				</button>
			</footer>
		</form>
	);
}

/** The panel on a board: asks as it opens, and places what's kept. */
export function DraftPanel({
	mode,
	ai,
	doc,
	shapes,
	what,
	author,
	sizeOf,
	onPlaced,
}: {
	mode: DraftMode;
	ai: AiService;
	doc: Y.Doc;
	/** The selection's shapes. */
	shapes: string[];
	what: string;
	author?: Author;
	sizeOf?: SizeOf;
	/** Placed: select these, and say so (undoably). */
	onPlaced: (ids: string[], message: string) => void;
}) {
	const [state, setState] = useState<DraftState>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);
	const key = shapes.join(",");
	useEffect(() => {
		const controller = new AbortController();
		setState({ status: "loading" });
		const request =
			mode === "summary"
				? { task: "summary" as const, shapes: key.split(",") }
				: { task: "decision" as const, shapes: key.split(",") };
		ai.ask(request, controller.signal).then(
			(answer) => {
				if (controller.signal.aborted) return;
				if (answer.kind === "error") setState({ status: "error", error: answer });
				else if (answer.kind === "summary" || answer.kind === "decision") {
					setState({
						status: "ready",
						edit: draftEdit(answer),
						read: answer.read,
						leftOut: answer.leftOut,
					});
				}
			},
			() => {},
		);
		return () => controller.abort();
	}, [ai, mode, key, attempt]);

	const place = useCallback(() => {
		if (state.status !== "ready") return;
		const { edit } = state;
		if (mode === "summary") {
			const id = transactLocal(doc, () => placeSummary(doc, edit.text.trim(), shapes, sizeOf));
			onPlaced([id], `Placed a summary of ${what}`);
		} else {
			const placed = transactLocal(doc, () =>
				placeDecision(
					doc,
					{ title: edit.title.trim(), text: edit.text.trim() },
					shapes,
					author,
					sizeOf,
				),
			);
			const links = placed.connectors.length;
			onPlaced(
				[placed.decision],
				`Placed a decision to make${links > 0 ? `, linked to ${links} ${links === 1 ? "card" : "cards"}` : ""}`,
			);
		}
	}, [state, mode, doc, shapes, sizeOf, author, what, onPlaced]);

	return (
		<DraftPanelView
			mode={mode}
			state={state}
			what={what}
			onEdit={(edit) =>
				setState((current) => (current.status === "ready" ? { ...current, edit } : current))
			}
			onPlace={place}
			onRetry={() => setAttempt((n) => n + 1)}
		/>
	);
}
