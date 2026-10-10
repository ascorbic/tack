import { type ComponentType, memo, useEffect, useMemo, useRef, useState } from "react";
import type { NodeProps } from "@xyflow/react";
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

// What's staged, shown on the shapes it's about: a ghost card behind a
// sticky that's about to become an issue, label chips about to be added
// hanging under a card, a "Will close" flag. They follow the shape as it
// moves, because they're drawn inside its node.

/** How long a change that just landed keeps its landed look. */
const LANDED_MS = 2600;

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
				/>
			</>
		);
	});
}

function LiveMarks({
	shapeId,
	cardKey,
	shapeType,
}: {
	shapeId: string;
	cardKey?: string;
	shapeType?: string;
}) {
	const ui = useChangesUI();
	const changes = useShapeChanges(ui?.store ?? null, shapeId);
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
	text: string;
}

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
	const labels: { change: PendingChange; name: string; mode: "add" | "remove"; repo: string }[] =
		[];
	for (const change of visible) {
		const { op } = change;
		const repo = changeRepo(change, index) ?? "";
		switch (op.kind) {
			case "issue.create":
				flags.push({
					change,
					text: `New ${change.effect?.kind === "place" ? "parent issue" : "issue"}${repo ? ` in ${repoShortName(repo)}` : ""}`,
				});
				for (const name of op.labels ?? []) labels.push({ change, name, mode: "add", repo });
				break;
			case "pr.create":
				flags.push({ change, text: "New pull request" });
				break;
			case "discussion.create":
				flags.push({ change, text: `New discussion · ${op.category}` });
				break;
			case "item.labels":
				for (const name of op.add ?? []) labels.push({ change, name, mode: "add", repo });
				for (const name of op.remove ?? []) labels.push({ change, name, mode: "remove", repo });
				break;
			case "item.state":
				flags.push({
					change,
					text:
						op.state === "open"
							? "Will reopen"
							: op.reason === "not_planned"
								? "Will close as not planned"
								: op.reason === "duplicate"
									? "Will close as a duplicate"
									: "Will close",
				});
				break;
			case "item.comment":
				flags.push({ change, text: "Will comment" });
				break;
			case "item.assignees":
				flags.push({
					change,
					text: [
						...(op.add ?? []).map((login) => `+@${login}`),
						...(op.remove ?? []).map((login) => `−@${login}`),
					].join(" "),
				});
				break;
			case "item.milestone":
				flags.push({ change, text: op.milestone ? `→ ${op.milestone}` : "No milestone" });
				break;
			case "item.subIssue":
				flags.push({
					change,
					text: isThis(op.child)
						? `Sub-issue of ${targetLabel(op.parent, index)}`
						: `Parent of ${targetLabel(op.child, index)}`,
				});
				break;
			case "item.blockedBy":
				flags.push({
					change,
					text: isThis(op.target)
						? `Blocked by ${targetLabel(op.blockedBy, index)}`
						: `Blocks ${targetLabel(op.target, index)}`,
				});
				break;
		}
	}

	const tip = (change: PendingChange) => {
		const what = summarize(change.op, index);
		const forge = changeForge(change, index);
		if (change.status === "failed") return `${what}\nFailed: ${friendlyError(change.error, forge)}`;
		if (change.status === "sending") return `${what}\nSending to ${forge}…`;
		if (change.status === "sent") return `${what}\nSent, waiting for ${forge} to confirm`;
		if (change.status === "applied") return `${what}\nOn ${forge}`;
		const left = change.included === false ? " · left out of the next push" : "";
		return `${what}\nStaged by ${stagerName(change.stagedBy, you)}${left}`;
	};

	const state = (change: PendingChange) => ({
		"data-status": landed.has(change.id) ? "landed" : change.status,
		"data-included": change.included !== false,
	});

	const outline = visible.length > 0 || highlighted;
	const worst =
		visible.find((change) => change.status === "failed") ??
		visible.find((change) => change.status === "sending" || change.status === "sent") ??
		visible[0];

	return (
		<div
			className="staged-marks changes-ui"
			data-highlighted={highlighted || undefined}
			data-has-flags={flags.length > 0 || undefined}
			data-shape={shapeType}
		>
			{ghost && (
				<span className="staged-ghost" aria-hidden="true" {...state(ghost)}>
					<span className="staged-ghost-head">
						<KindIcon op={ghost.op} size={12} />
						<span>#?</span>
					</span>
					<span className="staged-ghost-line" />
					<span className="staged-ghost-line short" />
				</span>
			)}
			{parent?.op.kind === "issue.create" && (
				<span className="staged-parent" aria-hidden="true" {...state(parent)}>
					<span className="staged-parent-card">
						<span className="staged-ghost-head">
							<KindIcon op={parent.op} size={12} />
							<span>#?</span>
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
			{flags.length > 0 && (
				<span className="staged-flags">
					{flags.map(({ change, text }, i) => (
						<button
							key={`${change.id}${i}`}
							type="button"
							className="staged-flag nodrag"
							data-kind={change.op.kind}
							title={tip(change)}
							style={{ "--i": i } as React.CSSProperties}
							onClick={(event) => {
								event.stopPropagation();
								onReveal?.(change);
							}}
							{...state(change)}
						>
							<KindIcon op={change.op} size={12} />
							<span>{text}</span>
						</button>
					))}
				</span>
			)}
			{labels.length > 0 && (
				<span className="staged-labels">
					{labels.map(({ change, name, mode, repo }, i) => (
						<button
							key={`${change.id}${mode}${name}`}
							type="button"
							className="staged-label nodrag"
							title={tip(change)}
							style={{ "--i": i } as React.CSSProperties}
							onClick={(event) => {
								event.stopPropagation();
								onReveal?.(change);
							}}
							{...state(change)}
						>
							<LabelChip name={name} color={labelColorOf(repo, name)} mode={mode} />
						</button>
					))}
				</span>
			)}
		</div>
	);
}
