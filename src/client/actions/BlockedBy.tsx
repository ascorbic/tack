import { useEffect, useMemo, useState } from "react";
import type * as Y from "yjs";
import { type BlockEnd, blockEnds, stageBlockedBy } from "../../shared/actions.ts";
import { listChanges } from "../../shared/changes.ts";
import type { History } from "../undo.ts";
import type { User } from "../presence.ts";
import type { ToastStore } from "../Toasts.tsx";
import { ArrowDownIcon, BlockedIcon, CheckIcon, IssueIcon, SwapIcon } from "./icons.tsx";
import { Notice, Popover, PopoverHead, SUBMIT_HINT } from "./Popover.tsx";
import { type ActionRequests, isCard, useCards } from "./selection.ts";
import { stagerFor } from "./services.ts";
import { undoToast } from "./toast.ts";

// A connector between two issues becomes "blocked by" (#32). The arrow
// points from the blocker to what it blocks, so A → B stages "B is blocked
// by A"; arrows without a direction, or the wrong one, can be swapped.

const PROBLEMS: Record<NonNullable<BlockEnd["problem"]>, (end: BlockEnd) => string> = {
	loose: () => "Connect both ends to issues first.",
	pull: (end) => `${end.label} is a pull request: only issues can block or be blocked.`,
	sticky: (end) => `Make “${end.label}” an issue first, then link it.`,
	unsupported: () => "Only issues, and stickies being made into issues, can be linked.",
	loading: () => "Loading…",
};

function EndRow({ end, role }: { end: BlockEnd; role: string }) {
	const cards = useCards(end.key ? [end.key] : []);
	const card = end.key ? cards.get(end.key) : undefined;
	const title = isCard(card) ? card.title : end.key ? null : end.label;
	return (
		<div className="blocked-end" data-role={role}>
			<IssueIcon />
			{end.key && <span className="mono blocked-ref">{end.label}</span>}
			<span className="blocked-title">{title ?? (end.key ? "" : end.label)}</span>
			{!end.key && end.target && <span className="issue-preview-body">new</span>}
		</div>
	);
}

/**
 * The blocked-by button in a connector's toolbar, and its panel. Shown only
 * for connectors with something at both ends.
 */
export function BlockedByAction({
	doc,
	connector,
	user,
	toasts,
	history,
	requests,
	defaultOpen = false,
}: {
	doc: Y.Doc;
	connector: string;
	user: User;
	toasts: ToastStore;
	history: History;
	requests: ActionRequests;
	/** Start open, for the gallery. */
	defaultOpen?: boolean;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const [swapped, setSwapped] = useState(false);
	// Card kinds arrive asynchronously: re-read the ends as they do.
	const raw = blockEnds(doc, connector, () => "issue");
	const keys = [raw?.from.key, raw?.to.key].filter((k): k is string => !!k);
	const cards = useCards(keys);
	const ends = useMemo(
		() =>
			blockEnds(doc, connector, (key) => {
				const card = cards.get(key);
				return isCard(card) ? card.kind : undefined;
			}),
		// The document isn't reactive here; the toolbar re-renders with it.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[doc, connector, cards, open],
	);

	useEffect(
		() =>
			requests.register((id) => {
				if (id !== "blockedBy") return false;
				setOpen(true);
				return true;
			}),
		[requests],
	);

	if (!ends || !ends.from.shape || !ends.to.shape) return null;
	const blocker = swapped ? ends.to : ends.from;
	const blocked = swapped ? ends.from : ends.to;
	const problem = [blocker, blocked].find((end) => end.problem);
	const staged = listChanges(doc).find(
		(change) => change.effect?.kind === "connect" && change.effect.shape === connector,
	);

	const stage = () => {
		if (!blocker.target || !blocked.target) return;
		stageBlockedBy(
			doc,
			{
				blocked: blocked.target,
				blocker: blocker.target,
				connector,
				shapes: [blocked.shape, blocker.shape].filter((s): s is string => !!s),
			},
			stagerFor(user),
		);
		setOpen(false);
		undoToast(toasts, history, `Staged: ${blocked.label} blocked by ${blocker.label}`);
	};

	return (
		<>
			<span className="connector-toolbar-divider" />
			<button
				type="button"
				className="blocked-button"
				aria-label="Blocked by"
				title="Stage as blocked-by (⌥B)"
				aria-expanded={open}
				data-staged={staged ? true : undefined}
				onClick={() => setOpen((o) => !o)}
			>
				{staged ? <CheckIcon /> : <BlockedIcon />}
				<span>Blocked by</span>
			</button>
			{open && (
				<Popover label="Blocked by" className="blocked-popover" onClose={() => setOpen(false)}>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							if (!problem && !staged) stage();
						}}
					>
						<PopoverHead
							title="Blocked by"
							detail={
								ends.arrow === "end"
									? "The arrow points from the blocker to what it blocks."
									: "This connector has no single direction: check which way round."
							}
						/>
						<div className="blocked-pair" data-swapped={swapped || undefined}>
							<EndRow key={`a${swapped}`} end={blocker} role="blocker" />
							<div className="blocked-verb">
								<ArrowDownIcon />
								<span>blocks</span>
								<button
									type="button"
									className="action-secondary blocked-swap"
									onClick={() => setSwapped((s) => !s)}
									aria-label="Swap which blocks which"
								>
									<SwapIcon />
									Swap
								</button>
							</div>
							<EndRow key={`b${swapped}`} end={blocked} role="blocked" />
						</div>
						{problem?.problem ? (
							<Notice tone={problem.problem === "loading" ? "note" : "warn"}>
								{PROBLEMS[problem.problem](problem)}
							</Notice>
						) : staged ? (
							<Notice>Already staged.</Notice>
						) : (
							<Notice>
								{blocked.label} will be marked as blocked by {blocker.label}.
							</Notice>
						)}
						<footer className="action-foot">
							<span className="action-summary">Not written until pushed.</span>
							<button
								type="submit"
								className="action-primary"
								data-autofocus
								disabled={!!problem || !!staged}
							>
								Stage
								<kbd>{SUBMIT_HINT}</kbd>
							</button>
						</footer>
					</form>
				</Popover>
			)}
		</>
	);
}
