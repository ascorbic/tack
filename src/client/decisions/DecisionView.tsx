import {
	type FocusEvent,
	type KeyboardEvent,
	type MouseEvent,
	type PointerEvent,
	type Ref,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { isMissing } from "../../shared/cards.ts";
import type { ChangeStatus } from "../../shared/changes.ts";
import type { Tally } from "../../shared/decisions.ts";
import type { Author, DecisionStatus, Vote, VoteChoice } from "../../shared/shapes.ts";
import { useCard } from "../cardStore.ts";
import { StateIcon, stateLabel } from "../CardView.tsx";
import { CiBar } from "../PullStatus.tsx";
import {
	AgreeIcon,
	ArrowIcon,
	DisagreeIcon,
	DiscussionIcon,
	GavelIcon,
	MoreIcon,
	RecordIcon,
} from "./icons.tsx";
import "./decisions.css";

export type DecisionField = "title" | "body";

const STATUS_LABEL: Record<DecisionStatus, string> = {
	proposed: "Proposed",
	decided: "Decided",
	superseded: "Superseded",
};

/** A decision's write-back, as the decision shows it. */
export interface WriteBackView {
	kind: "pr" | "discussion";
	status: ChangeStatus;
	/** `ADR 0007`, or the Discussion category. */
	label: string;
	/** The created pull request, once applied: its card shows live. */
	cardKey?: string;
	url?: string;
	error?: string;
}

export interface OtherDecision {
	id: string;
	title: string;
	status: DecisionStatus;
}

export interface DecisionViewProps {
	title: string;
	text: string;
	/** What becomes easier or harder because of it, as written for its record. */
	consequences?: string;
	status: DecisionStatus;
	votes: Tally;
	/** Your own vote, if you've cast one. */
	myVote?: VoteChoice | null;
	author?: Author;
	decidedBy?: Author;
	decidedAt?: string;
	/** Keys of the linked items. */
	linked?: string[];
	writeBack?: WriteBackView | null;
	supersededBy?: { title: string } | null;
	/** Decisions this one could be superseded by, for the menu. */
	others?: OtherDecision[];
	selected?: boolean;
	editing?: boolean;
	/** Which field takes focus when editing starts. */
	focusField?: DecisionField;
	enter?: boolean;
	/** Play the stamp, as when it's just been decided (the gallery forces it). */
	stamp?: boolean;
	readOnly?: boolean;
	field?: Ref<HTMLTextAreaElement>;
	onTitle?: (title: string) => void;
	onText?: (text: string) => void;
	onStopEditing?: () => void;
	onVote?: (choice: VoteChoice | null) => void;
	onStatus?: (status: DecisionStatus) => void;
	onWriteBack?: () => void;
	onSupersedeWithNew?: () => void;
	onSupersededBy?: (id: string) => void;
	onShowSuperseder?: () => void;
	onPointerDown?: (event: PointerEvent) => void;
	onClick?: (event: MouseEvent) => void;
	onDoubleClick?: (event: MouseEvent) => void;
}

const TITLE_PLACEHOLDER = "What did you decide?";
const BODY_PLACEHOLDER = "The decision, and why: what you considered, what it changes…";

/** Buttons inside a node act without selecting it or starting a drag. */
function act(fn?: () => void) {
	return (event: MouseEvent) => {
		event.stopPropagation();
		fn?.();
	};
}

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

function formatDate(iso?: string): string | null {
	if (!iso) return null;
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? null : dateFormat.format(date);
}

/**
 * A decision on the board, without any board behaviour (the gallery uses it
 * too): a weighty sheet with a status rail, its title set in the display
 * face, votes while it's proposed, a stamp once it's decided, and its
 * write-back once it's staged.
 */
export function DecisionView({
	title,
	text,
	consequences = "",
	status,
	votes,
	myVote = null,
	author,
	decidedBy,
	decidedAt,
	linked = [],
	writeBack = null,
	supersededBy = null,
	others = [],
	selected = false,
	editing = false,
	focusField = "title",
	enter = false,
	stamp = false,
	readOnly = false,
	field,
	onTitle,
	onText,
	onStopEditing,
	onVote,
	onStatus,
	onWriteBack,
	onSupersedeWithNew,
	onSupersededBy,
	onShowSuperseder,
	...handlers
}: DecisionViewProps) {
	const root = useRef<HTMLElement>(null);
	const stamping = useStamp(status, stamp);
	// Links and the write-back animate in when they change, not when a board loads.
	const firstLinks = useRef(new Set(linked));
	const writeBackState = `${status}:${writeBack?.status ?? ""}`;
	const firstWriteBack = useRef(writeBackState);
	const writeBackChanged = stamp || writeBackState !== firstWriteBack.current;
	const [menuOpen, setMenuOpen] = useState(false);
	// Someone disagrees: deciding asks once more, so nobody decides mid-vote by accident.
	const [confirming, setConfirming] = useState(false);
	const id = useId();
	const contested = votes.disagree.length > 0;
	useEffect(() => {
		if (!confirming) return;
		const timer = setTimeout(() => setConfirming(false), 6000);
		return () => clearTimeout(timer);
	}, [confirming]);
	useEffect(() => {
		if (!selected) setMenuOpen(false);
	}, [selected]);

	// Editing ends when focus leaves the decision, not when it moves between
	// its title and body.
	const onBlur = (event: FocusEvent) => {
		const next = event.relatedTarget as Node | null;
		if (next && root.current?.contains(next)) return;
		onStopEditing?.();
	};
	const onTitleKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Escape") {
			event.stopPropagation();
			onStopEditing?.();
		} else if (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey)) {
			// Titles are one paragraph: Enter moves on to the body.
			event.preventDefault();
			root.current?.querySelector<HTMLTextAreaElement>("textarea[data-field=body]")?.focus();
		}
	};
	const onBodyKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
			event.preventDefault();
			event.stopPropagation();
			onStopEditing?.();
		} else if (event.key === "Tab" && event.shiftKey) {
			event.preventDefault();
			root.current?.querySelector<HTMLTextAreaElement>("textarea[data-field=title]")?.focus();
		}
	};

	const decided = formatDate(decidedAt);
	return (
		<article
			ref={root}
			className="decision"
			data-status={status}
			data-selected={selected}
			data-editing={editing}
			data-enter={enter}
			aria-label={`Decision: ${title || "untitled"}`}
			{...handlers}
		>
			<header className="decision-head">
				<span className="decision-kicker">
					<GavelIcon size={13} />
					Decision
				</span>
				{status === "proposed" ? (
					<span className="decision-status" key={status} data-pop={stamping > 0}>
						{STATUS_LABEL[status]}
					</span>
				) : (
					// Once decided, the status is a stamp, and it lands when someone decides.
					<span
						className="decision-stamp"
						key={`${status}${stamping}`}
						data-status={status}
						data-new={stamping > 0}
					>
						{STATUS_LABEL[status]}
					</span>
				)}
				{!readOnly && (
					<button
						type="button"
						className="decision-more nodrag"
						aria-label="Decision options"
						aria-haspopup="menu"
						aria-expanded={menuOpen}
						onPointerDown={(event) => event.stopPropagation()}
						onClick={act(() => setMenuOpen((open) => !open))}
					>
						<MoreIcon />
					</button>
				)}
			</header>

			{menuOpen && (
				<DecisionMenu
					status={status}
					others={others}
					onClose={() => setMenuOpen(false)}
					onStatus={onStatus}
					onSupersedeWithNew={onSupersedeWithNew}
					onSupersededBy={onSupersededBy}
				/>
			)}

			<div className="decision-sizer decision-title" data-value={title || TITLE_PLACEHOLDER}>
				{editing ? (
					<textarea
						ref={focusField === "title" ? field : undefined}
						className="nodrag nowheel"
						data-field="title"
						rows={1}
						aria-label="Decision title"
						placeholder={TITLE_PLACEHOLDER}
						value={title}
						onChange={(event) => onTitle?.(event.target.value.replace(/\n/g, " "))}
						onKeyDown={onTitleKey}
						onBlur={onBlur}
					/>
				) : (
					<h3 data-field="title" data-empty={title === ""}>
						{title || TITLE_PLACEHOLDER}
					</h3>
				)}
			</div>

			{(text !== "" || editing) && (
				<div
					className="decision-sizer decision-body"
					data-value={`${text || BODY_PLACEHOLDER}${text.endsWith("\n") ? "​" : ""}`}
				>
					{editing ? (
						<textarea
							ref={focusField === "body" ? field : undefined}
							className="nodrag nowheel"
							data-field="body"
							rows={1}
							aria-label="Decision body"
							placeholder={BODY_PLACEHOLDER}
							value={text}
							onChange={(event) => onText?.(event.target.value)}
							onKeyDown={onBodyKey}
							onBlur={onBlur}
						/>
					) : (
						<p data-field="body" data-empty={text === ""}>
							{text || BODY_PLACEHOLDER}
						</p>
					)}
				</div>
			)}

			{consequences.trim() !== "" && (
				<div className="decision-consequences">
					<span className="decision-consequences-label">Consequences</span>
					<p>{consequences}</p>
				</div>
			)}

			{linked.length > 0 && (
				<LinkedItems keys={linked} isNew={(key) => !firstLinks.current.has(key)} />
			)}

			{status === "superseded" && (
				<button
					type="button"
					className="decision-superseded nodrag"
					disabled={!supersededBy || !onShowSuperseder}
					onPointerDown={(event) => event.stopPropagation()}
					onClick={act(onShowSuperseder)}
				>
					<span className="decision-superseded-label">Superseded by</span>
					<span className="decision-superseded-title">
						{supersededBy ? supersededBy.title || "an untitled decision" : "a later decision"}
					</span>
					{supersededBy && <ArrowIcon />}
				</button>
			)}

			<footer className="decision-foot" data-animate={writeBackChanged}>
				{status === "proposed" ? (
					<>
						<Votes votes={votes} mine={myVote} readOnly={readOnly} onVote={onVote} />
						{!readOnly && (
							<button
								type="button"
								className="decision-decide nodrag"
								data-confirming={confirming || undefined}
								aria-describedby={confirming ? `${id}-split` : undefined}
								onPointerDown={(event) => event.stopPropagation()}
								onBlur={() => setConfirming(false)}
								onClick={act(() => {
									if (contested && !confirming) {
										setConfirming(true);
										return;
									}
									setConfirming(false);
									onStatus?.("decided");
								})}
							>
								<GavelIcon size={14} />
								{confirming ? "Decide anyway" : "Decide"}
							</button>
						)}
						{confirming && (
							<p className="decision-contested" id={`${id}-split`} role="status">
								{votes.agree.length} agree, {votes.disagree.length} disagree
							</p>
						)}
					</>
				) : (
					<>
						<VoteSummary votes={votes} />
						{status === "decided" && (
							<WriteBack writeBack={writeBack} readOnly={readOnly} onWriteBack={onWriteBack} />
						)}
					</>
				)}
			</footer>

			{(decided || author) && (
				<p className="decision-byline">
					{status !== "proposed" && decided
						? `Decided ${decided}${decidedBy ? ` by ${decidedBy.name}` : ""}`
						: author
							? `Proposed by ${author.name}`
							: null}
				</p>
			)}
		</article>
	);
}

/**
 * Counts status changes into "decided" while mounted, so the stamp lands
 * when someone decides (here or elsewhere) but not when a board loads.
 */
function useStamp(status: DecisionStatus, force: boolean): number {
	const previous = useRef(status);
	const [count, setCount] = useState(force ? 1 : 0);
	useEffect(() => {
		if (previous.current !== status && status !== "proposed") setCount((n) => n + 1);
		previous.current = status;
	}, [status]);
	return count;
}

function initials(name: string): string {
	const parts = name.trim().split(/\s+/);
	return (
		(parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")
	).toUpperCase();
}

const voterId = (vote: Vote) => vote.login ?? vote.name;

function Voters({
	votes,
	known,
	max = 3,
}: {
	votes: Vote[];
	/** Voters already shown when the decision mounted: they don't pop in again. */
	known: Set<string>;
	max?: number;
}) {
	if (votes.length === 0) return null;
	const shown = votes.slice(0, max);
	return (
		<span className="decision-voters" aria-hidden="true">
			{shown.map((vote) => (
				<span
					key={voterId(vote)}
					data-new={!known.has(voterId(vote))}
					className="decision-voter"
					title={vote.name}
					style={{ "--voter": vote.color || "var(--muted)" } as React.CSSProperties}
				>
					{initials(vote.name)}
				</span>
			))}
			{votes.length > max && <span className="decision-voter more">+{votes.length - max}</span>}
		</span>
	);
}

function Votes({
	votes,
	mine,
	readOnly,
	onVote,
}: {
	votes: Tally;
	mine: VoteChoice | null;
	readOnly: boolean;
	onVote?: (choice: VoteChoice | null) => void;
}) {
	const options: { choice: VoteChoice; label: string; list: Vote[]; icon: React.ReactNode }[] = [
		{ choice: "agree", label: "Agree", list: votes.agree, icon: <AgreeIcon /> },
		{ choice: "disagree", label: "Disagree", list: votes.disagree, icon: <DisagreeIcon /> },
	];
	const share = votes.total === 0 ? 0.5 : votes.agree.length / votes.total;
	// What was there on mount stays still; only votes cast since then animate.
	const [first] = useState(() => ({
		mine,
		counts: { agree: votes.agree.length, disagree: votes.disagree.length },
		voters: new Set([...votes.agree, ...votes.disagree].map(voterId)),
	}));
	return (
		<div className="decision-votes" role="group" aria-label="Votes">
			<span
				className="decision-split"
				data-empty={votes.total === 0}
				style={{ "--share": share } as React.CSSProperties}
				aria-hidden="true"
			/>
			{options.map(({ choice, label, list, icon }) => (
				<button
					key={choice}
					type="button"
					className="decision-vote nodrag"
					data-choice={choice}
					aria-pressed={mine === choice}
					data-new={mine === choice && mine !== first.mine}
					aria-label={`${label}: ${list.length} ${list.length === 1 ? "vote" : "votes"}`}
					title={list.length > 0 ? list.map((vote) => vote.name).join(", ") : label}
					disabled={readOnly}
					onPointerDown={(event) => event.stopPropagation()}
					onClick={act(() => onVote?.(mine === choice ? null : choice))}
				>
					{icon}
					{/* The word invites the first vote; after that, faces say who. */}
					{list.length === 0 ? (
						<span className="decision-vote-label">{label}</span>
					) : (
						<span
							className="decision-vote-count"
							key={list.length}
							data-new={list.length !== first.counts[choice]}
						>
							{list.length}
						</span>
					)}
					<Voters votes={list} known={first.voters} />
				</button>
			))}
		</div>
	);
}

function VoteSummary({ votes }: { votes: Tally }) {
	if (votes.total === 0) return <span className="decision-tally">No votes</span>;
	return (
		<span className="decision-tally" title={describeVotes(votes)}>
			<span data-choice="agree">
				<AgreeIcon />
				{votes.agree.length}
			</span>
			<span data-choice="disagree">
				<DisagreeIcon />
				{votes.disagree.length}
			</span>
		</span>
	);
}

function describeVotes(votes: Tally): string {
	const names = (list: Vote[]) => list.map((vote) => vote.name).join(", ") || "nobody";
	return `Agree: ${names(votes.agree)}. Disagree: ${names(votes.disagree)}.`;
}

function LinkedItems({ keys, isNew }: { keys: string[]; isNew: (key: string) => boolean }) {
	const shown = keys.slice(0, 3);
	return (
		<ul className="decision-linked" aria-label="Linked items">
			{shown.map((key) => (
				<LinkedItem key={key} cardKey={key} isNew={isNew(key)} />
			))}
			{keys.length > shown.length && (
				<li className="decision-linked-more">+{keys.length - shown.length} more</li>
			)}
		</ul>
	);
}

function LinkedItem({ cardKey, isNew }: { cardKey: string; isNew: boolean }) {
	const card = useCard(cardKey);
	const item = cardKey.match(/[#!]\d+$/)?.[0] ?? cardKey;
	if (!card || isMissing(card)) {
		return (
			<li className="decision-link" data-state="unknown" data-new={isNew}>
				<span className="mono">{item}</span>
			</li>
		);
	}
	return (
		<li className="decision-link" data-state={card.state} data-new={isNew}>
			<span className="state-icon">
				<StateIcon card={card} size={12} />
			</span>
			<span className="mono">{card.item}</span>
			<span className="decision-link-title">{card.title}</span>
		</li>
	);
}

const PENDING_WORDS: Partial<Record<ChangeStatus, string>> = {
	staged: "Staged",
	sending: "Pushing…",
	sent: "Confirming…",
};

/** The write-back: an offer once decided, then its progress, then the live pull request. */
function WriteBack({
	writeBack,
	readOnly,
	onWriteBack,
}: {
	writeBack: WriteBackView | null;
	readOnly: boolean;
	onWriteBack?: () => void;
}) {
	if (!writeBack) {
		if (readOnly) return null;
		return (
			<button
				type="button"
				className="decision-writeback-offer nodrag"
				onPointerDown={(event) => event.stopPropagation()}
				onClick={act(onWriteBack)}
			>
				<RecordIcon />
				Write back
			</button>
		);
	}
	const icon = writeBack.kind === "pr" ? <RecordIcon /> : <DiscussionIcon />;
	if (writeBack.status === "failed") {
		return (
			<span className="decision-writeback" data-status="failed" title={writeBack.error}>
				{icon}
				<span>Write-back failed</span>
				{!readOnly && (
					<button
						type="button"
						className="decision-retry nodrag"
						onPointerDown={(event) => event.stopPropagation()}
						onClick={act(onWriteBack)}
					>
						Retry
					</button>
				)}
			</span>
		);
	}
	if (writeBack.status === "applied") {
		if (writeBack.kind === "pr" && writeBack.cardKey) {
			return <RecordPull cardKey={writeBack.cardKey} label={writeBack.label} url={writeBack.url} />;
		}
		return (
			<a
				className="decision-writeback nodrag"
				data-status="applied"
				href={writeBack.url}
				target="_blank"
				rel="noreferrer"
				onClick={(event) => event.stopPropagation()}
			>
				{icon}
				<span>{writeBack.kind === "pr" ? writeBack.label : "Posted to Discussions"}</span>
				<ArrowIcon />
			</a>
		);
	}
	return (
		<span
			className="decision-writeback"
			data-status={writeBack.status}
			title={
				writeBack.status === "staged"
					? "Written when someone pushes the board's changes"
					: undefined
			}
		>
			<span className="decision-pulse" aria-hidden="true" />
			{icon}
			<span>
				{writeBack.kind === "pr" ? writeBack.label : "Discussion"} ·{" "}
				{PENDING_WORDS[writeBack.status] ?? writeBack.status}
			</span>
		</span>
	);
}

/** The record's pull request, live: its state, CI, and a link to it. */
function RecordPull({ cardKey, label, url }: { cardKey: string; label: string; url?: string }) {
	const card = useCard(cardKey);
	const live = card && !isMissing(card) ? card : null;
	const checks = live?.pull?.checks;
	return (
		<a
			className="decision-record nodrag"
			data-state={live?.state ?? "unknown"}
			href={live?.url ?? url}
			target="_blank"
			rel="noreferrer"
			onClick={(event) => event.stopPropagation()}
		>
			<span className="decision-record-head">
				{live ? (
					<span className="state-icon">
						<StateIcon card={live} size={13} />
					</span>
				) : (
					<RecordIcon size={13} />
				)}
				<span className="decision-record-label">{label}</span>
				<span className="mono">{live?.item ?? cardKey.match(/[#!]\d+$/)?.[0]}</span>
				{live && (
					<span className="chip state" key={live.state} data-pop="true">
						{stateLabel(live)}
					</span>
				)}
			</span>
			{checks && checks.state !== "none" && <CiBar checks={checks} />}
		</a>
	);
}

function DecisionMenu({
	status,
	others,
	onClose,
	onStatus,
	onSupersedeWithNew,
	onSupersededBy,
}: {
	status: DecisionStatus;
	others: OtherDecision[];
	onClose: () => void;
	onStatus?: (status: DecisionStatus) => void;
	onSupersedeWithNew?: () => void;
	onSupersededBy?: (id: string) => void;
}) {
	const menu = useRef<HTMLDivElement>(null);
	/** Choosing which decision this one was superseded by: a step of its own. */
	const [picking, setPicking] = useState(false);
	useEffect(() => {
		menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
	}, [picking]);
	useEffect(() => {
		const onDown = (event: globalThis.PointerEvent) => {
			const target = event.target as Element | null;
			if (!menu.current?.contains(target) && !target?.closest(".decision-more")) onClose();
		};
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("pointerdown", onDown, true);
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("pointerdown", onDown, true);
			window.removeEventListener("keydown", onKey, true);
		};
	}, [onClose]);

	const item = (label: string, run?: () => void, hint?: string) => (
		<button
			key={label}
			type="button"
			role="menuitem"
			className="decision-menu-item"
			onPointerDown={(event) => event.stopPropagation()}
			onClick={act(() => {
				run?.();
				onClose();
			})}
		>
			<span>{label}</span>
			{hint && <span className="decision-menu-hint">{hint}</span>}
		</button>
	);

	const candidates = others.filter((other) => other.status !== "superseded");
	if (picking) {
		return (
			<div
				ref={menu}
				className="decision-menu nodrag nowheel"
				role="menu"
				aria-label="Superseded by which decision?"
				data-step="pick"
			>
				<button
					type="button"
					role="menuitem"
					className="decision-menu-back"
					onPointerDown={(event) => event.stopPropagation()}
					onClick={act(() => setPicking(false))}
				>
					<span aria-hidden="true">‹</span>
					Superseded by which decision?
				</button>
				{candidates.map((other) => (
					<button
						key={other.id}
						type="button"
						role="menuitem"
						className="decision-menu-item"
						data-status={other.status}
						onPointerDown={(event) => event.stopPropagation()}
						onClick={act(() => {
							onSupersededBy?.(other.id);
							onClose();
						})}
					>
						<span className="decision-menu-dot" data-status={other.status} />
						<span className="decision-menu-title">{other.title || "Untitled decision"}</span>
					</button>
				))}
			</div>
		);
	}
	return (
		<div ref={menu} className="decision-menu nodrag nowheel" role="menu" aria-label="Decision">
			{status === "proposed" && item("Mark decided", () => onStatus?.("decided"))}
			{status === "decided" && item("Reopen as proposed", () => onStatus?.("proposed"))}
			{status === "superseded" && item("Reinstate as decided", () => onStatus?.("decided"))}
			{status !== "superseded" &&
				item("Supersede with a new decision", onSupersedeWithNew, "Adds one beside it")}
			{status !== "superseded" && candidates.length > 0 && (
				<button
					type="button"
					role="menuitem"
					aria-haspopup="menu"
					className="decision-menu-item"
					onPointerDown={(event) => event.stopPropagation()}
					onClick={act(() => setPicking(true))}
				>
					<span>Mark as superseded by…</span>
					<span className="decision-menu-hint" aria-hidden="true">
						›
					</span>
				</button>
			)}
		</div>
	);
}
