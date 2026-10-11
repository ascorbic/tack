import { type ComponentType, memo, useEffect, useMemo, useRef, useState } from "react";
import { type NodeProps, useStore } from "@xyflow/react";
import type { PendingChange, Target } from "../../shared/changes.ts";
import type { ShapeNode } from "../board.ts";
import { scaledDuration } from "../motion.ts";
import { labelColor, useRepoMeta } from "./api.ts";
import { useChangesUI } from "./context.ts";
import {
	type ChangeIndex,
	changeForge,
	changeRepo,
	friendlyError,
	indexChanges,
	repoShortName,
	summarize,
	targetLabel,
} from "./describe.ts";
import { KindIcon } from "./icons.tsx";
import { LabelChip, stagerName } from "./parts.tsx";
import { useHighlighted, useShapeChanges } from "./store.ts";

// What's staged, shown on the shapes it's about: one mark above each shape
// that sums up everything staged on it ("New issue in imagekit · Sub-issue
// of “Docs” · +enhancement"), opening into a list of each change on hover or
// focus, and shrinking to a dot when the board is zoomed out. A sticky about
// to become an issue shows the card it'll be behind it while it's pointed
// at, selected or being pushed. They follow the shape as it moves, because
// they're drawn inside its node.

/** How long a change that just landed keeps its landed look. */
const LANDED_MS = 2600;

/** Below this zoom, a shape's mark is just a dot in the colour of what's staged. */
export const MARK_DOT_ZOOM = 0.6;

export interface MarksProps {
	shapeId: string;
	/** The card's item key, for working out which end of a link this shape is. */
	cardKey?: string;
	/** The shape's type: sections keep their title clear of the flags. */
	shapeType?: string;
	changes: readonly PendingChange[];
	/** Every change on the board, to name new issues this shape's changes refer to. */
	index?: ChangeIndex;
	highlighted?: boolean;
	/** For the gallery: label colours, without fetching. */
	labelColorOf?: (repo: string, name: string) => string;
	onReveal?: (change: PendingChange) => void;
	you?: string;
	/**
	 * Drawn as a row or mini card in a list (#72): just the outline, and the
	 * mark in one line beside a row, or counted on a mini card.
	 */
	compact?: "row" | "mini";
	/** Zoomed out: the mark is a dot until it's pointed at. */
	far?: boolean;
}

/** Wrap a node type so its staged changes show on it. */
export function withStagedMarks(Node: ComponentType<NodeProps<ShapeNode>>) {
	return memo(function WithStagedMarks(props: NodeProps<ShapeNode>) {
		return (
			<>
				<Node {...props} />
				<LiveMarks
					shapeId={props.id}
					cardKey={props.data.shape.ref}
					shapeType={props.data.shape.type}
					compact={
						props.data.display === "row" || props.data.display === "mini"
							? props.data.display
							: undefined
					}
				/>
			</>
		);
	});
}

function LiveMarks({
	shapeId,
	cardKey,
	shapeType,
	compact,
}: {
	shapeId: string;
	cardKey?: string;
	shapeType?: string;
	compact?: "row" | "mini";
}) {
	const ui = useChangesUI();
	const changes = useShapeChanges(ui?.store ?? null, shapeId);
	const far = useStore((state) => state.transform[2] < MARK_DOT_ZOOM);
	const highlighted = useHighlighted(ui?.store ?? null, shapeId);
	// Re-read whenever this shape's changes do.
	const index = useMemo(
		() => indexChanges(changes.length > 0 && ui ? ui.store.list() : []),
		[ui, changes],
	);
	const repos = useMemo(() => {
		const out = new Set<string>();
		for (const change of changes) {
			if (change.op.kind === "item.labels" || change.op.kind === "issue.create") {
				const repo = changeRepo(change, index);
				if (repo) out.add(repo);
			}
		}
		return [...out];
	}, [changes, index]);
	const meta = useRepoMeta(ui?.meta ?? null, repos);
	if (!ui || (changes.length === 0 && !highlighted)) return null;
	return (
		<StagedMarksView
			shapeId={shapeId}
			cardKey={cardKey}
			shapeType={shapeType}
			changes={changes}
			index={index}
			highlighted={highlighted}
			labelColorOf={(repo, name) => labelColor(meta(repo), name)}
			onReveal={(change) => ui.reveal(change.id)}
			you={ui.user.login}
			compact={compact}
			far={far}
		/>
	);
}

/** Changes that just landed, kept for a moment so they can say so. */
function useLanded(changes: readonly PendingChange[]): Set<string> {
	const seen = useRef(new Map<string, PendingChange["status"]>());
	const [landed, setLanded] = useState<Set<string>>(() => new Set());
	useEffect(() => {
		const fresh: string[] = [];
		for (const change of changes) {
			const before = seen.current.get(change.id);
			if (change.status === "applied" && before && before !== "applied") fresh.push(change.id);
			seen.current.set(change.id, change.status);
		}
		if (fresh.length === 0) return;
		setLanded((current) => new Set([...current, ...fresh]));
		const timer = setTimeout(() => {
			setLanded((current) => new Set([...current].filter((id) => !fresh.includes(id))));
		}, scaledDuration(LANDED_MS));
		return () => clearTimeout(timer);
	}, [changes]);
	return landed;
}

interface Flag {
	change: PendingChange;
	/** What the change does, in a few words; empty for one that's only labels. */
	text: string;
	labels: { name: string; mode: "add" | "remove"; repo: string }[];
}

/** Changes that make something new, which lead a shape's mark. */
const CREATES = new Set(["issue.create", "pr.create", "discussion.create"]);

/** Which matters most in a shape's mark: failures, then what's under way, then the rest. */
const STATUS_RANK: Record<string, number> = {
	failed: 0,
	sending: 1,
	sent: 2,
	staged: 3,
	landed: 4,
	applied: 5,
};

export function StagedMarksView({
	shapeId,
	cardKey,
	shapeType,
	changes,
	index: all,
	highlighted = false,
	labelColorOf = () => "#8b9098",
	onReveal,
	you,
	compact,
	far = false,
}: MarksProps) {
	const landed = useLanded(changes);
	const index = useMemo(() => all ?? indexChanges(changes), [all, changes]);
	const visible = changes.filter((change) => change.status !== "applied" || landed.has(change.id));

	/** Whether a target is this shape: its card, or the issue it's about to become. */
	const isThis = (target: Target) =>
		"key" in target
			? target.key === cardKey
			: (index.get(target.pending)?.shapes ?? []).includes(shapeId);

	// Only a shape that will turn into the new item's card gets the ghost card
	// behind it; a section that becomes a parent issue stays a section.
	const ghost = visible.find(
		(change) =>
			change.op.kind === "issue.create" &&
			change.status !== "applied" &&
			change.effect?.kind === "replace" &&
			change.effect.shapes.includes(shapeId),
	);
	// A section that's about to become a parent issue: where its card will
	// land (above it, if nothing's in the way) and the connector joining them.
	const parent = visible.find(
		(change) =>
			change.op.kind === "issue.create" &&
			change.status !== "applied" &&
			change.effect?.kind === "place" &&
			change.effect.near.length === 1 &&
			change.effect.near[0] === shapeId,
	);
	const flags: Flag[] = [];
	for (const change of visible) {
		const { op } = change;
		const repo = changeRepo(change, index) ?? "";
		const flag = (text: string, labels: Flag["labels"] = []) =>
			flags.push({ change, text, labels });
		switch (op.kind) {
			case "issue.create":
				flag(
					`New ${change.effect?.kind === "place" ? "parent issue" : "issue"}${repo ? ` in ${repoShortName(repo)}` : ""}`,
					(op.labels ?? []).map((name) => ({ name, mode: "add", repo })),
				);
				break;
			case "pr.create":
				flag("New pull request");
				break;
			case "discussion.create":
				flag(`New discussion · ${op.category}`);
				break;
			case "item.labels":
				flag("", [
					...(op.add ?? []).map((name) => ({ name, mode: "add" as const, repo })),
					...(op.remove ?? []).map((name) => ({ name, mode: "remove" as const, repo })),
				]);
				break;
			case "item.state":
				flag(
					op.state === "open"
						? "Will reopen"
						: op.reason === "not_planned"
							? "Will close as not planned"
							: op.reason === "duplicate"
								? "Will close as a duplicate"
								: "Will close",
				);
				break;
			case "item.comment":
				flag("Will comment");
				break;
			case "item.assignees":
				flag(
					[
						...(op.add ?? []).map((login) => `+@${login}`),
						...(op.remove ?? []).map((login) => `−@${login}`),
					].join(" "),
				);
				break;
			case "item.milestone":
				flag(op.milestone ? `→ ${op.milestone}` : "No milestone");
				break;
			case "item.subIssue":
				flag(
					isThis(op.child)
						? op.replaceParent
							? `Moves to ${targetLabel(op.parent, index)}${op.previousParent ? ` from ${targetLabel({ key: op.previousParent }, index)}` : ""}`
							: `Sub-issue of ${targetLabel(op.parent, index)}`
						: `Parent of ${targetLabel(op.child, index)}${op.replaceParent ? " (moved here)" : ""}`,
				);
				break;
			case "item.blockedBy":
				flag(
					isThis(op.target)
						? `Blocked by ${targetLabel(op.blockedBy, index)}`
						: `Blocks ${targetLabel(op.target, index)}`,
				);
				break;
		}
	}
	// What leads the mark: a new item first, then whatever else was staged first.
	const lead = flags.find((flag) => CREATES.has(flag.change.op.kind)) ?? flags[0];
	const ordered = lead ? [lead, ...flags.filter((flag) => flag !== lead)] : flags;
	const summary = ordered
		.flatMap(({ text, labels }) => [
			...(text ? [text] : []),
			...labels.map(({ name, mode }) => `${mode === "add" ? "+" : "−"}${name}`),
		])
		.join(" · ");

	const tip = (change: PendingChange) => {
		const what = summarize(change.op, index);
		const forge = changeForge(change, index);
		if (change.status === "failed") return `${what}\nFailed: ${friendlyError(change.error, forge)}`;
		if (change.status === "sending") return `${what}\nSending to ${forge}…`;
		if (change.status === "sent") return `${what}\nSent, waiting for ${forge} to confirm`;
		if (change.status === "applied") return `${what}\nOn ${forge}`;
		return `${what}\nStaged by ${stagerName(change.stagedBy, you)}`;
	};

	const state = (change: PendingChange) => ({
		"data-status": landed.has(change.id) ? "landed" : change.status,
	});

	const outline = visible.length > 0 || highlighted;
	const statusOf = (change: PendingChange) => (landed.has(change.id) ? "landed" : change.status);
	const worst = [...visible].sort(
		(a, b) => (STATUS_RANK[statusOf(a)] ?? 9) - (STATUS_RANK[statusOf(b)] ?? 9),
	)[0];
	const markStatus = worst ? statusOf(worst) : undefined;
	// The mark takes the colour of what leads it, unless something's gone wrong or is under way.
	const markKind = lead?.change.op.kind;

	return (
		<div
			className="staged-marks changes-ui"
			data-highlighted={highlighted || undefined}
			data-has-flags={flags.length > 0 || undefined}
			data-shape={shapeType}
			data-compact={compact}
		>
			{compact === "mini" && visible.length > 0 && worst && (
				<button
					type="button"
					className="staged-count nodrag"
					title={visible.map(tip).join("\n\n")}
					onClick={(event) => {
						event.stopPropagation();
						onReveal?.(worst);
					}}
					{...state(worst)}
				>
					<KindIcon op={worst.op} size={10} />
					{visible.length}
				</button>
			)}
			{ghost && !compact && (
				<span className="staged-ghost" aria-hidden="true" {...state(ghost)}>
					<span className="staged-ghost-head">
						<KindIcon op={ghost.op} size={12} />
						<NewChip />
					</span>
					<span className="staged-ghost-line" />
					<span className="staged-ghost-line short" />
				</span>
			)}
			{parent?.op.kind === "issue.create" && !compact && (
				<span className="staged-parent" aria-hidden="true" {...state(parent)}>
					<span className="staged-parent-card">
						<span className="staged-ghost-head">
							<KindIcon op={parent.op} size={12} />
							<NewChip />
						</span>
						<span className="staged-parent-title">{parent.op.title}</span>
						<span className="staged-ghost-line short" />
					</span>
					<span className="staged-parent-stem" />
				</span>
			)}
			{outline && (
				<span className="staged-outline" aria-hidden="true" {...(worst ? state(worst) : {})} />
			)}
			{lead && worst && compact !== "mini" && (
				<span className="staged-mark" data-far={far || undefined}>
					<button
						type="button"
						className="staged-flag nodrag"
						data-kind={markKind}
						data-status={markStatus}
						aria-label={`${summary}${ordered.length > 1 ? ` (${ordered.length} changes)` : ""}`}
						onClick={(event) => {
							event.stopPropagation();
							onReveal?.(worst.status === "failed" ? worst : lead.change);
						}}
					>
						<KindIcon op={lead.change.op} size={12} />
						<span className="staged-flag-text">{summary}</span>
						{ordered.length > 1 && (
							<span className="staged-flag-count" aria-hidden="true">
								{ordered.length}
							</span>
						)}
					</button>
					<span className="staged-details" role="list" aria-label="Staged on this">
						{ordered.map(({ change, text, labels }, i) => (
							<button
								key={change.id}
								type="button"
								role="listitem"
								className="staged-detail nodrag"
								data-kind={change.op.kind}
								title={tip(change)}
								style={{ "--i": i } as React.CSSProperties}
								onClick={(event) => {
									event.stopPropagation();
									onReveal?.(change);
								}}
								{...state(change)}
							>
								<span className="staged-detail-icon">
									<KindIcon op={change.op} size={12} />
								</span>
								<span className="staged-detail-text">
									{text && <span>{text}</span>}
									{labels.map(({ name, mode, repo }) => (
										<span key={`${mode}${name}`} className="staged-label" {...state(change)}>
											<LabelChip name={name} color={labelColorOf(repo, name)} mode={mode} />
										</span>
									))}
								</span>
								<span className="staged-detail-status">{statusWord(statusOf(change))}</span>
							</button>
						))}
					</span>
				</span>
			)}
		</div>
	);
}

/** What a placeholder card shows where its number will be. */
function NewChip() {
	return <span className="staged-new">New</span>;
}

/** A change's state, in a word, for the list in a shape's mark. */
function statusWord(status: string): string {
	switch (status) {
		case "failed":
			return "Failed";
		case "sending":
			return "Sending";
		case "sent":
			return "Sent";
		case "landed":
		case "applied":
			return "Done";
		default:
			return "Staged";
	}
}
