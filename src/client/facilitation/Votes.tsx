import {
	useContext,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import * as Y from "yjs";
import {
	DOTS_DEFAULT,
	DOTS_MAX,
	type DotVote,
	type TallyRow,
	closeVote,
	closedAt,
	deleteVote,
	dotsLeft,
	formatRemaining,
	isOpen,
	reopenVote,
	startVote,
	tallyVote,
	turnout,
} from "../../shared/dotvotes.ts";
import type { Stamper } from "../../shared/facilitation.ts";
import { readShape, shapesMap } from "../../shared/shapes.ts";
import { UNTITLED_STACK, stackName } from "../../shared/stacks.ts";
import { linkText } from "../../shared/linkPreview.ts";
import { silentOf } from "../../shared/silent.ts";
import { cardStore, useCard } from "../cardStore.ts";
import { DocContext } from "../DocContext.ts";
import { initials } from "../People.tsx";
import type { ToastStore } from "../Toasts.tsx";
import { transactLocal } from "../undo.ts";
import { useServerNow, useVotes } from "./hooks.ts";
import { CloseIcon, DotsIcon, TallyIcon } from "./icons.tsx";
import { facilitation, useFacilitator } from "./store.ts";

// Dot voting's UI (#48): starting a vote (on a section, from its header, or
// the whole board), a bar for each open vote with your dots left and the
// time left, the dot tool, and the results.

type Listener = () => void;

/** Which vote dialog or panel is open, shared by the header buttons and the board. */
class VoteUI {
	starting: { scope: string | null } | null = null;
	tally: string | null = null;
	private listeners = new Set<Listener>();
	private snapshot = { starting: this.starting, tally: this.tally };

	start(scope: string | null): void {
		this.starting = { scope };
		this.emit();
	}
	cancel(): void {
		this.starting = null;
		this.emit();
	}
	showTally(id: string | null): void {
		this.tally = id;
		this.emit();
	}
	get = () => this.snapshot;
	subscribe = (listener: Listener) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	private emit(): void {
		this.snapshot = { starting: this.starting, tally: this.tally };
		for (const listener of this.listeners) listener();
	}
}

export const voteUI = new VoteUI();

const NO_DOC = new Y.Doc();

export function useVoteUI() {
	return useSyncExternalStore(voteUI.subscribe, voteUI.get);
}

/** Whether a vote is open on this section now: one at a time per section. */
export function useVoteOpen(id: string | null): boolean {
	const doc = useContext(DocContext);
	const votes = useVotes(doc ?? NO_DOC);
	const now = useServerNow(30_000);
	return id !== null && votes.some((vote) => vote.scope === id && isOpen(vote, now));
}

function sectionTitle(doc: Y.Doc, id: string | null): string {
	if (id === null) return "the whole board";
	const title = shapesMap(doc).get(id)?.get("title");
	return typeof title === "string" && title ? `“${title}”` : "this section";
}

const MINUTE = 60_000;

/** A vote's length in minutes, for "Custom": a few minutes in the room, up to a working day. */
const CUSTOM_MIN = 1;
const CUSTOM_MAX = 480;
const CUSTOM_DEFAULT = 3;

/**
 * When a vote closes, in two groups: a few minutes in the room (with a
 * custom length last), or over days. `ms: "custom"` is however many minutes
 * are chosen. `chip` is the short label in the dialog.
 */
const ENDINGS: {
	label: string;
	chip: string;
	ms: number | null | "custom";
	group: "session" | "days";
}[] = [
	{ label: "When it’s closed", chip: "When it’s closed", ms: null, group: "session" },
	{ label: "In 2 minutes", chip: "2 min", ms: 2 * MINUTE, group: "session" },
	{ label: "In 5 minutes", chip: "5 min", ms: 5 * MINUTE, group: "session" },
	{ label: "In 10 minutes", chip: "10 min", ms: 10 * MINUTE, group: "session" },
	{ label: "Custom", chip: "Custom", ms: "custom", group: "session" },
	{ label: "In an hour", chip: "In an hour", ms: 3_600_000, group: "days" },
	{ label: "Tomorrow", chip: "Tomorrow", ms: 86_400_000, group: "days" },
	{ label: "In 3 days", chip: "In 3 days", ms: 3 * 86_400_000, group: "days" },
	{ label: "In a week", chip: "In a week", ms: 7 * 86_400_000, group: "days" },
];

const ENDING_GROUPS = [
	{ id: "session", caption: "During the session" },
	{ id: "days", caption: "Over days" },
] as const;

/** Setting up a vote: dots each, when it ends, and whether results wait. */
export function StartVoteDialog({
	doc,
	user,
	now,
	onStarted,
}: {
	doc: Y.Doc;
	user: Stamper;
	now: () => number;
	onStarted?: (id: string) => void;
}) {
	const { starting } = useVoteUI();
	if (!starting) return null;
	return (
		<StartVoteForm
			key={String(starting.scope)}
			doc={doc}
			user={user}
			scope={starting.scope}
			now={now}
			onCancel={() => voteUI.cancel()}
			onStart={(id) => {
				voteUI.cancel();
				onStarted?.(id);
			}}
		/>
	);
}

export function StartVoteForm({
	doc,
	user,
	scope,
	now,
	onCancel,
	onStart,
	autoFocus = true,
}: {
	doc: Y.Doc;
	user: Stamper;
	scope: string | null;
	now: () => number;
	onCancel: () => void;
	onStart: (id: string) => void;
	autoFocus?: boolean;
}) {
	const [dots, setDots] = useState(DOTS_DEFAULT);
	const [ending, setEnding] = useState(0);
	const [minutes, setMinutes] = useState(CUSTOM_DEFAULT);
	const [hidden, setHidden] = useState(false);
	// Off unless asked for: in a room, what's popular on the forge shouldn't
	// outvote what the room chose.
	const [reactions, setReactions] = useState(false);
	const id = useId();
	const first = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (autoFocus) first.current?.focus();
	}, [autoFocus]);
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				onCancel();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [onCancel]);
	const chosen = ENDINGS[ending]?.ms;
	const end = chosen === "custom" ? minutes * MINUTE : chosen;
	return (
		<form
			className="vote-start"
			role="dialog"
			aria-labelledby={`${id}-title`}
			onSubmit={(event) => {
				event.preventDefault();
				const voteId = transactLocal(doc, () =>
					startVote(doc, {
						scope,
						dots,
						hidden,
						reactions,
						...(end ? { endsAt: new Date(now() + end).toISOString() } : {}),
						by: user,
						...(facilitation.you.you ? { starter: facilitation.you.you.author } : {}),
					}),
				);
				onStart(voteId);
			}}
		>
			<header className="vote-start-head">
				<span className="vote-start-icon">
					<DotsIcon size={16} />
				</span>
				<h2 id={`${id}-title`}>Dot vote on {sectionTitle(doc, scope)}</h2>
				<button type="button" className="vote-icon-button" aria-label="Cancel" onClick={onCancel}>
					<CloseIcon />
				</button>
			</header>
			<div className="vote-start-row">
				<span className="vote-start-label" id={`${id}-dots`}>
					Dots each
				</span>
				<span className="vote-stepper" role="group" aria-labelledby={`${id}-dots`}>
					<button
						ref={first}
						type="button"
						aria-label="Fewer dots"
						disabled={dots <= 1}
						onClick={() => setDots((n) => Math.max(1, n - 1))}
					>
						−
					</button>
					<output className="vote-stepper-value" aria-live="polite">
						<span className="vote-stepper-dots" aria-hidden="true">
							{Array.from({ length: Math.min(dots, 10) }, (_, i) => (
								<span
									key={i}
									className="vote-dot"
									style={{ "--dot": user.color } as React.CSSProperties}
								/>
							))}
						</span>
						{dots}
					</output>
					<button
						type="button"
						aria-label="More dots"
						disabled={dots >= DOTS_MAX}
						onClick={() => setDots((n) => Math.min(DOTS_MAX, n + 1))}
					>
						+
					</button>
				</span>
			</div>
			<fieldset className="vote-start-row vote-closes">
				<legend className="vote-start-label">Closes</legend>
				{ENDING_GROUPS.map((group) => (
					<div key={group.id} className="vote-closes-group">
						<span className="vote-closes-caption" id={`${id}-${group.id}`}>
							{group.caption}
						</span>
						<span className="vote-choices" role="radiogroup" aria-labelledby={`${id}-${group.id}`}>
							{ENDINGS.map((option, i) =>
								option.group !== group.id ? null : (
									<label
										key={option.label}
										data-checked={ending === i}
										data-custom={option.ms === "custom" || undefined}
									>
										<input
											type="radio"
											name={`${id}-ending`}
											checked={ending === i}
											onChange={() => setEnding(i)}
										/>
										{option.ms === "custom" && ending === i ? (
											<>
												<input
													className="vote-custom-minutes"
													autoFocus
													type="number"
													min={CUSTOM_MIN}
													max={CUSTOM_MAX}
													step={1}
													value={minutes}
													aria-label="Minutes until the vote closes"
													onChange={(event) => {
														const value = Math.round(Number(event.target.value));
														if (Number.isFinite(value)) {
															setMinutes(Math.min(CUSTOM_MAX, Math.max(CUSTOM_MIN, value)));
														}
													}}
												/>
												min
											</>
										) : (
											option.chip
										)}
									</label>
								),
							)}
						</span>
					</div>
				))}
			</fieldset>
			<label className="vote-toggle">
				<input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
				<span>
					Hide results until it closes
					<small>Others’ dots aren’t shown until then, so nobody follows the crowd</small>
				</span>
			</label>
			<label className="vote-toggle">
				<input
					type="checkbox"
					checked={reactions}
					onChange={(e) => setReactions(e.target.checked)}
				/>
				<span>
					Count 👍 on GitHub as votes
					<small>Each reaction on a card’s issue or pull request counts once</small>
				</span>
			</label>
			<footer className="vote-start-foot">
				<button type="button" onClick={onCancel}>
					Cancel
				</button>
				<button type="submit" className="vote-primary">
					Start voting
				</button>
			</footer>
		</form>
	);
}

/**
 * Closed votes you've put away, so their bar (and the ranks on shapes)
 * don't come back. Remembered in this browser.
 */
class DismissedVotes {
	private ids: ReadonlySet<string> = DismissedVotes.read();
	private listeners = new Set<Listener>();

	private static read(): ReadonlySet<string> {
		try {
			return new Set(JSON.parse(localStorage.getItem("tack:votes-dismissed") ?? "[]") as string[]);
		} catch {
			return new Set();
		}
	}

	dismiss = (id: string): void => {
		this.ids = new Set(this.ids).add(id);
		try {
			localStorage.setItem("tack:votes-dismissed", JSON.stringify([...this.ids].slice(-50)));
		} catch {}
		for (const listener of this.listeners) listener();
	};

	get = (): ReadonlySet<string> => this.ids;
	subscribe = (listener: Listener) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
}

export const dismissedVotes = new DismissedVotes();

export function useDismissedVotes(): ReadonlySet<string> {
	return useSyncExternalStore(dismissedVotes.subscribe, dismissedVotes.get);
}

/**
 * When a vote closes while you're here, everyone sees how it came out: its
 * results open by themselves (not for votes closed before you arrived).
 */
function useResultsOnClose(votes: DotVote[], now: number): void {
	const wasOpen = useRef<Set<string> | null>(null);
	useEffect(() => {
		const open = new Set(votes.filter((vote) => isOpen(vote, now)).map((vote) => vote.id));
		const before = wasOpen.current;
		wasOpen.current = open;
		if (!before) return;
		const closed = votes.find((vote) => before.has(vote.id) && !open.has(vote.id));
		if (closed && voteUI.get().tally === null) voteUI.showTally(closed.id);
	}, [votes, now]);
}

/** Whether you may close or reopen a vote, and delete it (see facilitator.ts). */
export function useVoteControl(): {
	control: (vote: DotVote) => boolean;
	remove: (vote: DotVote) => boolean;
} {
	const facilitator = useFacilitator();
	return useMemo(
		() => ({
			control: (vote: DotVote) => facilitation.mayControl(vote.starter),
			remove: (vote: DotVote) => facilitation.mayDelete(vote.starter),
		}),
		// Re-made whenever who you are, or who's here, changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[facilitator],
	);
}

/**
 * A bar for each vote that's open (or just closed): your dots, how long is
 * left, and the way into placing dots and seeing results.
 */
export function VoteBars({
	doc,
	user,
	readOnly,
	voting,
	onVoting,
	toasts,
}: {
	doc: Y.Doc;
	user: Stamper;
	readOnly: boolean;
	/** The dot tool is on. */
	voting: boolean;
	onVoting: (on: boolean) => void;
	toasts?: ToastStore;
}) {
	const votes = useVotes(doc);
	const now = useServerNow(1000, votes.length > 0);
	const dismissed = useDismissedVotes();
	const { control } = useVoteControl();
	useResultsOnClose(votes, now);
	const shown = votes.filter((vote) => isOpen(vote, now) || !dismissed.has(vote.id));
	const anyOpen = shown.some((vote) => isOpen(vote, now));
	// The dot tool goes back to normal when nothing's open any more.
	useEffect(() => {
		if (voting && !anyOpen) onVoting(false);
	}, [voting, anyOpen, onVoting]);
	useVoteReminders(votes, user, now, toasts, readOnly);
	if (shown.length === 0) return null;
	// Closed votes keep out of the way: while one's open, or behind the
	// latest to close, each is a small results chip in a row of its own.
	const open = shown.filter((vote) => isOpen(vote, now));
	const closed = shown
		.filter((vote) => !isOpen(vote, now))
		.sort((a, b) => (closedAt(b, now) ?? "").localeCompare(closedAt(a, now) ?? ""));
	const full = open.length > 0 ? open : closed.slice(0, 1);
	const chips = open.length > 0 ? closed : closed.slice(1);
	const bar = (vote: DotVote, compact: boolean) => (
		<VoteBar
			key={vote.id}
			vote={vote}
			scopeTitle={sectionTitle(doc, vote.scope)}
			user={user}
			now={now}
			readOnly={readOnly}
			canClose={!readOnly && control(vote)}
			compact={compact}
			voting={voting}
			onVoting={onVoting}
			onClose={() =>
				transactLocal(doc, () => closeVote(doc, vote.id, user, new Date(now).toISOString()))
			}
			onResults={() => voteUI.showTally(vote.id)}
			onDismiss={() => dismissedVotes.dismiss(vote.id)}
		/>
	);
	return (
		<div className="vote-bars">
			{full.map((vote) => bar(vote, false))}
			{chips.length > 0 && (
				<div className="vote-bars-closed">{chips.map((vote) => bar(vote, true))}</div>
			)}
		</div>
	);
}

/** Once per vote per visit: a nudge when it closes within a day and you've dots left. */
function useVoteReminders(
	votes: DotVote[],
	user: Stamper,
	now: number,
	toasts: ToastStore | undefined,
	readOnly: boolean,
) {
	const reminded = useRef(new Set<string>());
	useEffect(() => {
		if (!toasts || readOnly) return;
		for (const vote of votes) {
			if (reminded.current.has(vote.id) || !isOpen(vote, now) || !vote.endsAt) continue;
			const left = Date.parse(vote.endsAt) - now;
			const dots = dotsLeft(vote, user);
			if (left > 86_400_000 || dots === 0) continue;
			// A vote of a few minutes in the room: only a nudge at the very end.
			const length = Date.parse(vote.endsAt) - Date.parse(vote.startedAt);
			if (length < 15 * MINUTE && left > 30_000) continue;
			reminded.current.add(vote.id);
			toasts.show({
				message: `Voting closes in ${formatRemaining(left)}: you have ${dots} ${dots === 1 ? "dot" : "dots"} left`,
			});
		}
	}, [votes, user, now, toasts, readOnly]);
}

export function VoteBar({
	vote,
	scopeTitle,
	user,
	now,
	readOnly,
	canClose = !readOnly,
	compact = false,
	voting,
	onVoting,
	onClose,
	onResults,
	onDismiss,
}: {
	vote: DotVote;
	scopeTitle: string;
	user: Stamper;
	now: number;
	readOnly: boolean;
	/** You started it, or own the board: Close vote is yours. */
	canClose?: boolean;
	/** Closed, and out of the way: just its results and a way to put it away. */
	compact?: boolean;
	voting: boolean;
	onVoting: (on: boolean) => void;
	onClose: () => void;
	onResults: () => void;
	onDismiss: () => void;
}) {
	const open = isOpen(vote, now);
	const left = dotsLeft(vote, user);
	const { voters } = turnout(vote);
	const ends = vote.endsAt ? Date.parse(vote.endsAt) - now : null;
	const soon = open && ends !== null && ends < 86_400_000;
	// A dot leaving your hand: the last one used pops.
	const [spent, setSpent] = useState(0);
	const lastLeft = useRef(left);
	useEffect(() => {
		if (left < lastLeft.current) setSpent((n) => n + 1);
		lastLeft.current = left;
	}, [left]);
	if (compact && !open) {
		return (
			<section
				className="vote-bar"
				data-open={false}
				data-compact
				aria-label={`Vote on ${scopeTitle}`}
			>
				<button
					type="button"
					className="vote-bar-results"
					title={`Vote closed: ${voters} ${voters === 1 ? "person" : "people"} voted`}
					onClick={onResults}
				>
					<TallyIcon size={13} />
					<span className="vote-bar-chip-title">{scopeTitle}</span>
					<span className="vote-bar-chip-note">results</span>
				</button>
				<button
					type="button"
					className="vote-icon-button"
					aria-label="Put this vote away"
					onClick={onDismiss}
				>
					<CloseIcon />
				</button>
			</section>
		);
	}
	return (
		<section
			className="vote-bar"
			data-open={open}
			data-voting={voting && open}
			data-soon={soon || undefined}
			aria-label={`Vote on ${scopeTitle}`}
			style={{ "--me": user.color || "var(--accent)" } as React.CSSProperties}
		>
			<span className="vote-bar-icon" aria-hidden="true">
				<DotsIcon size={15} />
			</span>
			<span className="vote-bar-title">
				<span className="vote-bar-verb">{open ? "Voting on" : "Vote closed:"}</span>{" "}
				<strong>{scopeTitle}</strong>
			</span>
			{open && !readOnly && (
				<span
					className="vote-bar-dots"
					role="img"
					aria-label={`${left} of ${vote.dots} dots left`}
					data-tooltip={`${left} of ${vote.dots} dots left`}
				>
					{Array.from({ length: Math.min(vote.dots, 12) }, (_, i) => (
						<span
							key={i}
							className="vote-dot"
							data-used={i >= left}
							data-spent={i === left && spent > 0 ? spent : undefined}
						/>
					))}
				</span>
			)}
			<span className="vote-bar-meta">
				{open
					? ends !== null
						? `closes in ${formatRemaining(ends)}`
						: "open until closed"
					: `${voters} ${voters === 1 ? "person" : "people"} voted`}
				{open && voters > 0 && ` · ${voters} voted`}
				{vote.hidden && open && " · results hidden"}
			</span>
			{open && !readOnly && (
				<button
					type="button"
					className="vote-bar-place"
					aria-pressed={voting}
					onClick={() => onVoting(!voting)}
				>
					{voting ? "Done" : left > 0 ? "Place dots" : "Move dots"}
				</button>
			)}
			<button type="button" className="vote-bar-results" onClick={onResults}>
				<TallyIcon size={14} />
				Results
			</button>
			{open && canClose && (
				<button type="button" className="vote-bar-close" onClick={onClose}>
					Close vote
				</button>
			)}
			{!open && (
				<button
					type="button"
					className="vote-icon-button"
					aria-label="Put this vote away"
					onClick={onDismiss}
				>
					<CloseIcon />
				</button>
			)}
		</section>
	);
}

/** One row's label: the sticky's text, the card's title, or what it is. */
function RowLabel({ doc, row }: { doc: Y.Doc; row: TallyRow }) {
	const map = shapesMap(doc).get(row.shape);
	const shape = map ? readShape(map) : null;
	const card = useCard(shape?.type === "card" ? (shape.ref ?? "") : "");
	if (!shape) return <span className="tally-label tally-label-gone">Removed</span>;
	if (shape.type === "card") {
		const title = card && !("missing" in card) ? card.title : (shape.ref ?? "Card");
		const number = card && !("missing" in card) ? card.item : "";
		return (
			<span className="tally-label">
				{number && <span className="tally-number mono">{number}</span>} {title}
			</span>
		);
	}
	if (shape.type === "link") {
		const { title, host } = linkText(shape);
		return (
			<span className="tally-label">
				<span className="tally-number mono">{host}</span> {title}
			</span>
		);
	}
	if (shape.type === "sticky") {
		const faceDown = silentOf(shape) !== null;
		return (
			<span className="tally-label" data-color={shape.color ?? "yellow"}>
				<span className="tally-paper" aria-hidden="true" />
				{faceDown
					? `${shape.author?.name ?? "Someone"}’s sticky (face down)`
					: shape.text || "Empty sticky"}
			</span>
		);
	}
	if (shape.type === "stack") {
		return (
			<span className="tally-label" data-color="yellow">
				<span className="tally-paper" aria-hidden="true" />
				{stackName(shape) ?? UNTITLED_STACK} (a stack)
			</span>
		);
	}
	return <span className="tally-label">{shape.text || shape.title || shape.type}</span>;
}

/** A vote's results: the winners first, with who voted, and closing or reopening it. */
export function TallyPanel({
	doc,
	voteId,
	user,
	readOnly,
	onClose,
	onReveal,
}: {
	doc: Y.Doc;
	voteId: string;
	user: Stamper;
	readOnly: boolean;
	onClose: () => void;
	onReveal: (shape: string) => void;
}) {
	const votes = useVotes(doc);
	const now = useServerNow(1000);
	const vote = votes.find((v) => v.id === voteId);
	const { control, remove } = useVoteControl();
	// Live card data (for 👍) re-tallies as it arrives.
	const [cardsVersion, setCardsVersion] = useState(0);
	const refs = useMemo(
		() =>
			[...shapesMap(doc).values()]
				.filter((shape) => shape.get("type") === "card")
				.map((shape) => String(shape.get("ref"))),
		[doc, vote],
	);
	useEffect(() => {
		const stops = refs.map((ref) => cardStore.subscribe(ref, () => setCardsVersion((n) => n + 1)));
		return () => {
			for (const stop of stops) stop();
		};
	}, [refs]);
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !(event.target as Element | null)?.closest("input, textarea")) {
				onClose();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	const rows = useMemo(
		() => (vote ? tallyVote(vote, doc, (ref) => cardStore.get(ref)) : []),
		// cardsVersion: card data changed.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[vote, doc, cardsVersion],
	);
	if (!vote) return null;
	return (
		<TallyView
			doc={doc}
			vote={vote}
			rows={rows}
			now={now}
			user={user}
			readOnly={readOnly}
			canControl={!readOnly && control(vote)}
			canDelete={!readOnly && remove(vote)}
			onClose={onClose}
			onReveal={onReveal}
		/>
	);
}

export function TallyView({
	doc,
	vote,
	rows,
	now,
	user,
	readOnly,
	canControl = !readOnly,
	canDelete = !readOnly,
	onClose,
	onReveal,
}: {
	doc: Y.Doc;
	vote: DotVote;
	rows: TallyRow[];
	now: number;
	user: Stamper;
	readOnly: boolean;
	/** Close and reopen: whoever started it, and the owner. */
	canControl?: boolean;
	/** Delete it, ballots and all: the same, but never just because they've left. */
	canDelete?: boolean;
	onClose: () => void;
	onReveal: (shape: string) => void;
}) {
	const [confirming, setConfirming] = useState(false);
	const open = isOpen(vote, now);
	const hidden = open && vote.hidden;
	const { voters, dots } = turnout(vote);
	const top = rows[0]?.total ?? 0;
	const closed = closedAt(vote, now);
	const [reopening, setReopening] = useState(false);
	const scope = sectionTitle(doc, vote.scope);
	const mineKey = user.login ? `@${user.login.toLowerCase()}` : `~${user.name}`;
	const shownRows = hidden
		? rows.filter((row) => row.dotters.some((d) => d.key === mineKey))
		: rows;
	return (
		<aside className="tally-panel" role="dialog" aria-label="Vote results">
			<header className="tally-head">
				<span className="tally-head-icon">
					<TallyIcon size={16} />
				</span>
				<div>
					<h2>Results</h2>
					<p>
						{open ? "Voting on" : "Voted on"} {scope} · {vote.dots}{" "}
						{vote.dots === 1 ? "dot" : "dots"} each
						{vote.reactions && " · 👍 on GitHub count"}
					</p>
				</div>
				<button
					type="button"
					className="vote-icon-button"
					aria-label="Close results"
					onClick={onClose}
				>
					<CloseIcon />
				</button>
			</header>
			<div className="tally-status" data-open={open}>
				<span className="tally-status-dot" aria-hidden="true" />
				{open
					? vote.endsAt
						? `Open · closes in ${formatRemaining(Date.parse(vote.endsAt) - now)}`
						: "Open until someone closes it"
					: `Closed ${closed ? new Date(closed).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : ""}${vote.closedBy ? ` by ${vote.closedBy.name}` : ""}`}
				<span className="tally-turnout">
					{voters} {voters === 1 ? "person" : "people"} · {dots} {dots === 1 ? "dot" : "dots"}
				</span>
			</div>
			{hidden && (
				<p className="tally-hidden">
					Results are hidden until the vote closes. These are your own dots.
				</p>
			)}
			{shownRows.length === 0 ? (
				<p className="tally-empty">
					{hidden ? "You haven’t placed any dots yet." : "No votes yet."}
				</p>
			) : (
				<ol className="tally-rows">
					{shownRows.map((row, i) => (
						<li key={row.shape} style={{ "--i": i } as React.CSSProperties}>
							<button
								type="button"
								className="tally-row"
								data-rank={hidden ? undefined : row.rank}
								onClick={() => onReveal(row.shape)}
							>
								<span className="tally-rank" aria-label={hidden ? undefined : `Rank ${row.rank}`}>
									{hidden ? "•" : row.rank}
								</span>
								<RowLabel doc={doc} row={row} />
								<span className="tally-total" aria-label={`${row.total} votes`}>
									{hidden ? row.dotters.find((d) => d.key === mineKey)?.dots : row.total}
								</span>
								{!hidden && (
									<span className="tally-bar" aria-hidden="true">
										<span
											className="tally-bar-dots"
											style={{ width: `${(row.dots / Math.max(1, top)) * 100}%` }}
										/>
										<span
											className="tally-bar-reactions"
											style={{ width: `${(row.reactions / Math.max(1, top)) * 100}%` }}
										/>
									</span>
								)}
								{!hidden && (
									<span className="tally-voters">
										{row.dotters.slice(0, 6).map((d) => (
											<span
												key={d.key}
												className="tally-voter"
												style={{ "--avatar": d.color } as React.CSSProperties}
												title={`${d.name}: ${d.dots}`}
											>
												{initials(d.name)}
												{d.dots > 1 && <sub>{d.dots}</sub>}
											</span>
										))}
										{row.reactions > 0 && (
											<span
												className="tally-reactions"
												title={
													row.reactors.length > 0
														? `👍 on GitHub: ${row.reactors.join(", ")}${row.reactions > row.reactors.length ? ` and ${row.reactions - row.reactors.length} more` : ""}`
														: `${row.reactions} 👍 on GitHub`
												}
											>
												👍 {row.reactions}
											</span>
										)}
									</span>
								)}
							</button>
						</li>
					))}
				</ol>
			)}
			{(canControl || canDelete) && (
				<footer className="tally-foot">
					{!canControl ? null : open ? (
						<button
							type="button"
							onClick={() =>
								transactLocal(doc, () => closeVote(doc, vote.id, user, new Date(now).toISOString()))
							}
						>
							Close vote
						</button>
					) : reopening ? (
						<span className="tally-reopen">
							Reopen
							{ENDINGS.filter((option) => option.ms !== "custom").map((option) => (
								<button
									key={option.label}
									type="button"
									onClick={() => {
										transactLocal(doc, () =>
											reopenVote(
												doc,
												vote.id,
												typeof option.ms === "number"
													? new Date(now + option.ms).toISOString()
													: undefined,
											),
										);
										setReopening(false);
									}}
								>
									{typeof option.ms === "number"
										? option.label.replace(/^In /, "for ")
										: "until closed"}
								</button>
							))}
						</span>
					) : (
						<button type="button" onClick={() => setReopening(true)}>
							Reopen…
						</button>
					)}
					{canDelete &&
						(confirming ? (
							<span className="tally-confirm" role="group" aria-label="Delete this vote?">
								<span>Everyone’s dots go too.</span>
								<button type="button" onClick={() => setConfirming(false)}>
									Keep it
								</button>
								<button
									type="button"
									className="tally-delete-confirm"
									autoFocus
									onClick={() => {
										transactLocal(doc, () => deleteVote(doc, vote.id));
										onClose();
									}}
								>
									Delete vote
								</button>
							</span>
						) : (
							<button type="button" className="tally-delete" onClick={() => setConfirming(true)}>
								Delete vote…
							</button>
						))}
				</footer>
			)}
		</aside>
	);
}
