import type { MouseEvent, PointerEvent, Ref } from "react";
import { safeUrl } from "../changes/inline.ts";
import {
	type ActionOwner,
	type ActionState,
	type CarriedFrom,
	describeDue,
	dueState,
} from "../../shared/actionItems.ts";
import type { ChangeStatus } from "../../shared/changes.ts";
import { initials } from "../People.tsx";
import { CalendarIcon, CarryIcon, ExternalIcon, LinkIcon, OwnerIcon } from "./icons.tsx";
import "./actionItems.css";

// An action item (#52), without any board behaviour: the board's node and
// the gallery both draw it with this. A row with a checkbox: what's to be
// done, then who, by when, and the issue it follows, each a chip that opens
// its picker. The left edge says how soon it's due.

export type ActionPicker = "owner" | "due" | "link";

/** The issue an action item is linked to, as it shows it. */
export interface ActionLinkView {
	key: string;
	/** `#412`, or `owner/repo#412` from another repository. */
	label: string;
	state: "open" | "closed" | "merged" | "draft" | "unknown";
	title?: string;
	url?: string;
	/** Closing or reopening it is staged. */
	staged?: "close" | "reopen";
}

/** A new issue staged for the item, on its way. */
export interface StagedIssueView {
	/** `owner/name`. */
	repo: string;
	status: ChangeStatus;
	error?: string;
}

export interface ActionItemViewProps {
	text: string;
	owner?: ActionOwner;
	due?: string;
	/** Today, `YYYY-MM-DD`, in the viewer's time zone. */
	today: string;
	state: ActionState;
	link?: ActionLinkView | null;
	stagedIssue?: StagedIssueView | null;
	carried?: CarriedFrom;
	selected?: boolean;
	editing?: boolean;
	enter?: boolean;
	/** Just ticked done here: a little burst from the checkbox. */
	celebrate?: boolean;
	/** Zoomed out: just the box and the words. */
	compact?: boolean;
	readOnly?: boolean;
	/** Whether the checkbox can be ticked here (and if not, why). */
	tick?: { can: true } | { can: false; why: string };
	/** The picker that's open, if any. */
	open?: ActionPicker | null;
	field?: Ref<HTMLTextAreaElement>;
	onText?: (text: string) => void;
	onStopEditing?: () => void;
	onToggle?: () => void;
	onPicker?: (picker: ActionPicker) => void;
	onPointerDown?: (event: PointerEvent) => void;
	onClick?: (event: MouseEvent) => void;
	onDoubleClick?: () => void;
}

const PLACEHOLDER = "What needs doing?";

export function ActionItemView({
	text,
	owner,
	due,
	today,
	state,
	link = null,
	stagedIssue = null,
	carried,
	selected = false,
	editing = false,
	enter = false,
	celebrate = false,
	compact = false,
	readOnly = false,
	tick = { can: true },
	open = null,
	field,
	onText,
	onStopEditing,
	onToggle,
	onPicker,
	...handlers
}: ActionItemViewProps) {
	const done = state.status === "done";
	const pendingTick = link?.staged;
	// A staged close shows as ticked-to-be; a staged reopen as unticked-to-be.
	const shownDone = pendingTick ? pendingTick === "close" : done;
	const dueIn = dueState(due, today, shownDone);
	const checkLabel = shownDone ? "Mark as not done" : "Mark as done";

	return (
		<div
			className="action-item"
			data-status={shownDone ? "done" : "open"}
			data-due={dueIn}
			data-selected={selected}
			data-editing={editing}
			data-enter={enter}
			data-pending={pendingTick ?? undefined}
			data-celebrate={celebrate || undefined}
			data-compact={compact || undefined}
			{...handlers}
		>
			<span className="action-item-rail" aria-hidden="true" />
			<button
				type="button"
				role="checkbox"
				className="action-item-check nodrag"
				aria-checked={shownDone}
				aria-label={checkLabel}
				title={
					tick.can
						? pendingTick
							? `${pendingTick === "close" ? "Closes" : "Reopens"} ${link?.label} when you push`
							: link
								? `${shownDone ? "Reopen" : "Close"} ${link.label} (staged)`
								: checkLabel
						: tick.why
				}
				disabled={readOnly || !tick.can}
				onPointerDown={(event) => event.stopPropagation()}
				onClick={(event) => {
					event.stopPropagation();
					onToggle?.();
				}}
			>
				<svg viewBox="0 0 20 20" aria-hidden="true">
					<circle className="action-item-check-ring" cx="10" cy="10" r="8.25" />
					<circle className="action-item-check-fill" cx="10" cy="10" r="8.25" />
					<path className="action-item-check-mark" d="m6.2 10.3 2.6 2.6 5-5.6" pathLength="1" />
				</svg>
				<span className="action-item-burst" aria-hidden="true">
					{[0, 1, 2, 3, 4, 5].map((i) => (
						<span key={i} style={{ "--i": i } as React.CSSProperties} />
					))}
				</span>
			</button>

			<div className="action-item-main">
				{editing ? (
					<textarea
						ref={field}
						className="action-item-text action-item-input nodrag nowheel"
						aria-label="Action item"
						placeholder={PLACEHOLDER}
						value={text}
						rows={1}
						onChange={(event) => onText?.(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape" || (event.key === "Enter" && !event.shiftKey)) {
								event.preventDefault();
								event.stopPropagation();
								onStopEditing?.();
							}
						}}
						onBlur={() => onStopEditing?.()}
					/>
				) : (
					<div className="action-item-text" data-empty={text.trim() === ""}>
						<span className="action-item-words">{text || (readOnly ? "" : PLACEHOLDER)}</span>
					</div>
				)}

				<div className="action-item-meta">
					<Chip
						kind="owner"
						empty={!owner}
						readOnly={readOnly}
						expanded={open === "owner"}
						label={owner ? `Owner: ${owner.name || owner.login}` : "Choose an owner"}
						onClick={() => onPicker?.("owner")}
					>
						{owner ? (
							<>
								<OwnerAvatar owner={owner} />
								<span className="action-chip-text">{firstName(owner)}</span>
							</>
						) : (
							<>
								<OwnerIcon />
								<span className="action-chip-text">Owner</span>
							</>
						)}
					</Chip>
					<Chip
						kind="due"
						empty={!due}
						readOnly={readOnly}
						expanded={open === "due"}
						due={dueIn}
						label={due ? `Due ${describeDue(due, today)}` : "Set a due date"}
						onClick={() => onPicker?.("due")}
					>
						<CalendarIcon />
						<span className="action-chip-text">
							{due ? describeDue(due, today, shownDone) : "Due"}
						</span>
						{dueIn === "overdue" && <span className="action-chip-pulse" aria-hidden="true" />}
					</Chip>
					<LinkChip
						link={link}
						staged={stagedIssue}
						readOnly={readOnly}
						expanded={open === "link"}
						onClick={() => onPicker?.("link")}
					/>
				</div>
				{carried && (
					<div className="action-item-carried" title={`Carried over ${carriedWhen(carried.at)}`}>
						<CarryIcon />
						From {carried.title}
					</div>
				)}
			</div>
		</div>
	);
}

function Chip({
	kind,
	empty,
	readOnly,
	expanded,
	label,
	due,
	onClick,
	children,
}: {
	kind: ActionPicker;
	empty: boolean;
	readOnly: boolean;
	expanded: boolean;
	label: string;
	due?: string;
	onClick: () => void;
	children: React.ReactNode;
}) {
	if (readOnly) {
		return empty ? null : (
			<span className="action-chip" data-kind={kind} data-due={due} aria-label={label}>
				{children}
			</span>
		);
	}
	return (
		<button
			type="button"
			className="action-chip nodrag"
			data-kind={kind}
			data-empty={empty || undefined}
			data-due={due}
			aria-label={label}
			aria-haspopup="dialog"
			aria-expanded={expanded}
			onPointerDown={(event) => event.stopPropagation()}
			onClick={(event) => {
				event.stopPropagation();
				onClick();
			}}
		>
			{children}
		</button>
	);
}

function LinkChip({
	link,
	staged,
	readOnly,
	expanded,
	onClick,
}: {
	link: ActionLinkView | null;
	staged: StagedIssueView | null;
	readOnly: boolean;
	expanded: boolean;
	onClick: () => void;
}) {
	if (link) {
		return (
			<span className="action-chip-group">
				<Chip
					kind="link"
					empty={false}
					readOnly={readOnly}
					expanded={expanded}
					label={`Linked to ${link.label}${link.title ? `: ${link.title}` : ""}`}
					onClick={onClick}
				>
					<span className="action-chip-state" data-state={link.state} aria-hidden="true" />
					<span className="action-chip-text mono">{link.label}</span>
				</Chip>
				{safeUrl(link.url) && (
					<a
						className="action-chip-out nodrag"
						href={safeUrl(link.url)}
						target="_blank"
						rel="noreferrer"
						aria-label={`Open ${link.label}`}
						onPointerDown={(event) => event.stopPropagation()}
						onClick={(event) => event.stopPropagation()}
					>
						<ExternalIcon />
					</a>
				)}
			</span>
		);
	}
	if (staged) {
		const failed = staged.status === "failed";
		const going = staged.status === "sending" || staged.status === "sent";
		return (
			<Chip
				kind="link"
				empty={false}
				readOnly={readOnly}
				expanded={expanded}
				label={
					failed
						? `Couldn’t make the issue: ${staged.error ?? "try again from Changes"}`
						: `New issue in ${staged.repo}, ${going ? "being made" : "staged"}`
				}
				onClick={onClick}
			>
				<span
					className="action-chip-state"
					data-state={failed ? "failed" : going ? "sending" : "staged"}
					aria-hidden="true"
				/>
				<span className="action-chip-text">
					{failed ? "Issue failed" : going ? "Making issue…" : "New issue"}
				</span>
			</Chip>
		);
	}
	return (
		<Chip
			kind="link"
			empty
			readOnly={readOnly}
			expanded={expanded}
			label="Link an issue, or make one"
			onClick={onClick}
		>
			<LinkIcon />
			<span className="action-chip-text">Issue</span>
		</Chip>
	);
}

/** Someone's face, or their initials while it loads (and if it doesn't). */
export function OwnerAvatar({ owner, size = 18 }: { owner: ActionOwner; size?: number }) {
	const src =
		owner.avatarUrl || `https://github.com/${encodeURIComponent(owner.login)}.png?size=48`;
	return (
		<span
			className="action-owner-avatar"
			data-initial={initials(owner.name || owner.login)}
			style={{ width: size, height: size }}
		>
			<img
				src={src}
				alt=""
				width={size}
				height={size}
				loading="lazy"
				onError={(event) => {
					event.currentTarget.hidden = true;
				}}
			/>
		</span>
	);
}

function firstName(owner: ActionOwner): string {
	const name = owner.name?.trim();
	return name ? (name.split(/\s+/)[0] ?? name) : owner.login;
}

function carriedWhen(at: string): string {
	const date = new Date(at);
	return Number.isNaN(date.getTime())
		? ""
		: `on ${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}
