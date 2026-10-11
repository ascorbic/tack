import { useState } from "react";
import {
	type ChangeStatus,
	type PendingChange,
	type Stager,
	type Target,
	retryCanWork,
} from "../../shared/changes.ts";
import { isMissing } from "../../shared/cards.ts";
import { relativeTime } from "../boards/api.ts";
import { useCard } from "../cardStore.ts";
import { initials } from "../People.tsx";
import { type ChangeIndex, STATUS_LABEL, friendlyError, targetLabel } from "./describe.ts";
import { CheckIcon, CloseIcon, MoveIcon, RetryIcon } from "./icons.tsx";
import "./changes.css";

// Small pieces shared by the panel, the push sheet and the marks on shapes.

/** Who staged a change: their GitHub avatar when we know who they are, else initials. */
export function StagerAvatar({
	stager,
	size = 18,
	avatarUrl,
}: {
	stager: Stager;
	size?: number;
	avatarUrl?: string;
}) {
	const [loaded, setLoaded] = useState(false);
	const [failed, setFailed] = useState(false);
	const src =
		avatarUrl ??
		(stager.id && stager.id > 0
			? `https://avatars.githubusercontent.com/u/${stager.id}?s=${size * 2}`
			: null);
	return (
		<span
			className="stager-avatar"
			style={
				{ "--avatar": stager.color ?? "var(--muted)", "--size": `${size}px` } as React.CSSProperties
			}
			aria-hidden="true"
		>
			{initials(stager.name || stager.login || "?")}
			{src && !failed && (
				<img
					src={src}
					alt=""
					data-loaded={loaded}
					onLoad={() => setLoaded(true)}
					onError={() => setFailed(true)}
				/>
			)}
		</span>
	);
}

export function stagerName(stager: Stager, you?: string): string {
	if (you && stager.login && stager.login === you) return "You";
	return stager.name || (stager.login ? `@${stager.login}` : "Someone");
}

/** "Priya · 2 min ago" */
export function StagedBy({ change, you }: { change: PendingChange; you?: string }) {
	return (
		<span className="staged-by">
			<StagerAvatar stager={change.stagedBy} size={16} />
			<span className="staged-by-name">{stagerName(change.stagedBy, you)}</span>
			<span aria-hidden="true">·</span>
			<time dateTime={change.stagedAt}>{relativeTime(Date.parse(change.stagedAt))}</time>
		</span>
	);
}

/** A label as GitHub draws it, in the label's colour, marked as added or removed. */
export function LabelChip({
	name,
	color,
	mode = "plain",
}: {
	name: string;
	color: string;
	mode?: "add" | "remove" | "plain";
}) {
	return (
		<span
			className="chip label change-label"
			data-mode={mode}
			style={{ "--label": color } as React.CSSProperties}
		>
			{mode === "add" && (
				<span className="change-label-sign" aria-label="add">
					+
				</span>
			)}
			{mode === "remove" && (
				<span className="change-label-sign" aria-label="remove">
					−
				</span>
			)}
			{name}
		</span>
	);
}

/** An item a change is about: its number, and its title where we have it. */
export function TargetRef({ target, index }: { target: Target; index: ChangeIndex }) {
	const key = "key" in target ? target.key : "";
	const card = useCard(key);
	const title = "key" in target ? (card && !isMissing(card) ? card.title : null) : null;
	if (!("key" in target)) {
		return (
			<span className="target-ref" data-pending="true">
				<span className="target-ref-new">new</span>
				{targetLabel(target, index)}
			</span>
		);
	}
	return (
		<span className="target-ref">
			<span className="mono">{targetLabel(target, index)}</span>
			{title && <span className="target-ref-title">{title}</span>}
		</span>
	);
}

/** The status of a change as a glyph: a ring that fills, spins, then checks. */
export function StatusGlyph({ status, size = 18 }: { status: ChangeStatus; size?: number }) {
	return (
		<span
			className="status-glyph"
			data-status={status}
			style={{ "--size": `${size}px` } as React.CSSProperties}
			role="img"
			aria-label={STATUS_LABEL[status]}
		>
			<svg className="status-ring" viewBox="0 0 20 20" aria-hidden="true">
				<circle className="status-track" cx="10" cy="10" r="8" />
				<circle className="status-arc" cx="10" cy="10" r="8" pathLength="100" />
			</svg>
			{(status === "sent" || status === "applied") && <CheckIcon size={size * 0.6} />}
			{status === "failed" && <CloseIcon size={size * 0.5} />}
		</span>
	);
}

/** A switch for whether a change is in the next push. */
export function IncludeToggle({
	checked,
	disabled,
	label,
	onChange,
}: {
	checked: boolean;
	disabled?: boolean;
	label: string;
	onChange: (checked: boolean) => void;
}) {
	return (
		<label className="include-toggle" data-checked={checked} data-disabled={disabled || undefined}>
			<input
				type="checkbox"
				checked={checked}
				disabled={disabled}
				aria-label={label}
				onChange={(event) => onChange(event.target.checked)}
			/>
			<span className="include-toggle-box" aria-hidden="true">
				<CheckIcon size={12} />
			</span>
		</label>
	);
}

/**
 * Why a change failed, as Tack puts it, with what the forge said itself
 * behind "Details", for whoever needs to look it up.
 */
export function ForgeError({
	error,
	detail,
	forge,
}: {
	error: string | undefined;
	detail?: string;
	forge?: string;
}) {
	const [open, setOpen] = useState(false);
	return (
		<span className="forge-error">
			{friendlyError(error, forge)}
			{detail && (
				<>
					{" "}
					<button
						type="button"
						className="forge-error-toggle"
						aria-expanded={open}
						onClick={(event) => {
							event.stopPropagation();
							setOpen(!open);
						}}
					>
						{open ? "Hide details" : "Details"}
					</button>
					{open && <code className="forge-error-detail">{detail}</code>}
				</>
			)}
		</span>
	);
}

/**
 * What can be done about a failed change: a retry, unless it can't work
 * unchanged (`retryCanWork`); for a sub-issue that already has a parent,
 * moving it here instead; and, for refusals a retry won't fix by itself,
 * leaving it out.
 */
export function FailureActions({
	change,
	index,
	onRetry,
	onMove,
	onLeaveOut,
}: {
	change: PendingChange;
	index: ChangeIndex;
	onRetry?: () => void;
	onMove?: () => void;
	onLeaveOut?: () => void;
}) {
	const { op, problem } = change;
	const movable =
		problem?.code === "has_parent" && op.kind === "item.subIssue" && !op.replaceParent;
	const retry = retryCanWork(problem);
	const from = problem?.parent ? targetLabel({ key: problem.parent }, index) : null;
	if (!(movable && onMove) && !(retry && onRetry) && !(problem && onLeaveOut)) return null;
	return (
		<span className="change-fixes" data-problem={problem?.code}>
			{movable && onMove && (
				<button
					type="button"
					className="change-retry change-move"
					title={`Take it off ${from ?? "the parent it has"} and put it here`}
					onClick={onMove}
				>
					<MoveIcon size={12} />
					Move it here
				</button>
			)}
			{retry && onRetry && (
				<button type="button" className="change-retry" onClick={onRetry}>
					<RetryIcon size={12} />
					Retry
				</button>
			)}
			{problem && onLeaveOut && (
				<button type="button" className="change-leave" onClick={onLeaveOut}>
					Leave it out
				</button>
			)}
		</span>
	);
}
