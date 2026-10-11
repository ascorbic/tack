import { useEffect, useMemo, useRef, useState } from "react";
import { boardRepos, moveSubIssueHere } from "../../shared/actions.ts";
import type { PendingChange } from "../../shared/changes.ts";
import { forgeNameOf } from "../../shared/refs.ts";
import { useLinger } from "../useLinger.ts";
import "./changes.css";
import { type ChangesUI, signedIn, useChangesUI } from "./context.ts";
import {
	type ChangeIndex,
	type ChangeRow,
	DRIFT_NOTE,
	batchRows,
	changeForge,
	changeRepo,
	groupByRepo,
	indexChanges,
	isInFlight,
	isPending,
	isPushable,
	repoName,
	summarize,
	summarizeBatch,
} from "./describe.ts";
import { ChevronIcon, CloseIcon, ExternalIcon, HistoryIcon, KindIcon } from "./icons.tsx";
import { FailureActions, ForgeError, StagedBy, StatusGlyph } from "./parts.tsx";
import { unstage, useLeftOut, usePushState, useUnwritableLeftOut } from "./session.ts";
import { safeUrl } from "./inline.ts";
import { useChangeList } from "./store.ts";

/** How many landed changes the panel keeps showing; the rest are in the history. */
const LANDED_SHOWN = 5;

/**
 * The board's pending changes, FigJam-panel style: grouped by repository,
 * in the order they were staged (each action's in board order), with who
 * staged each and unstage. What one action staged together reads as one
 * row that opens up. Failed changes say why and offer a retry. Everyone on
 * the board sees the same list, live; view-only people see it but can't
 * change it. What goes in a push is chosen in the push sheet, by whoever
 * pushes.
 */
export function ChangesPanel() {
	const ui = useChangesUI();
	const shown = useLinger(ui?.panelOpen ? true : null, 200);
	if (!ui || !shown.value) return null;
	return <PanelBody ui={ui} leaving={shown.leaving} />;
}

function PanelBody({ ui, leaving }: { ui: ChangesUI; leaving: boolean }) {
	const changes = useChangeList(ui.store);
	const index = useMemo(() => indexChanges(changes), [changes]);
	const pending = changes.filter(isPending);
	const inFlight = changes.filter(isInFlight);
	const landed = changes
		.filter((change) => change.status === "applied")
		.sort((a, b) => ((a.updatedAt ?? "") < (b.updatedAt ?? "") ? 1 : -1));
	useUnwritableLeftOut(ui.session, ui.meta, changes, index);
	const leftOut = useLeftOut(ui.session);
	const included = pending.filter((change) => isPushable(change) && !leftOut.has(change.id));
	const groups = groupByRepo(pending, index);
	const push = usePushState(ui.session);
	const panel = useRef<HTMLElement>(null);

	// Escape closes the panel, unless something inside wants it.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !ui.sheet && panel.current?.contains(document.activeElement)) {
				ui.setPanelOpen(false);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [ui]);

	// Back from the push sheet: if focus had nowhere to go back to (the
	// review button is disabled once everything's pushed), keep it in the
	// panel, so Escape still closes it.
	const sheetOpen = ui.sheet !== null;
	const hadSheet = useRef(sheetOpen);
	useEffect(() => {
		const closed = hadSheet.current && !sheetOpen;
		hadSheet.current = sheetOpen;
		const lost = !document.activeElement || document.activeElement === document.body;
		if (closed && lost) panel.current?.focus({ preventScroll: true });
	}, [sheetOpen]);

	const empty = changes.length === 0;
	const failed = pending.filter((change) => change.status === "failed");
	// Named for where the changes go; with none yet, where the board's cards are from.
	const repoOf = (change: PendingChange) => {
		const repo = changeRepo(change, index);
		return repo ? [repo] : [];
	};
	const towards = (pending.length > 0 ? pending : changes).flatMap(repoOf);
	const forge = forgeNameOf(
		towards.length > 0 ? towards : boardRepos(ui.doc).map(({ repo }) => repo),
	);
	const landedForge = forgeNameOf(landed.flatMap(repoOf));

	return (
		<aside
			ref={panel}
			tabIndex={-1}
			className="changes-panel changes-ui"
			aria-label="Pending changes"
			data-leaving={leaving || undefined}
			onPointerLeave={() => ui.store.highlight([])}
		>
			<header className="changes-panel-head">
				<div>
					<h2>
						Changes
						{pending.length > 0 && (
							<span className="changes-count" key={pending.length}>
								{pending.length}
							</span>
						)}
					</h2>
					<p>
						{ui.readOnly
							? "What’s staged on this board. You can look, but not change it."
							: `Staged here, waiting to go to ${forge}. Everyone on the board sees this list; whoever pushes picks what goes.`}
					</p>
				</div>
				<button
					type="button"
					className="changes-icon-button"
					aria-label="Close changes"
					onClick={() => ui.setPanelOpen(false)}
				>
					<CloseIcon />
				</button>
			</header>

			<div className="changes-panel-body">
				{empty && <PanelEmpty readOnly={ui.readOnly} forge={forge} />}

				{failed.length > 0 && (
					<p className="changes-attention" role="status">
						<strong>
							{failed.length === 1 ? "1 change" : `${failed.length} changes`} didn’t make it.
						</strong>{" "}
						{ui.readOnly ? "Someone who can push can retry." : "Retry, or unstage to let it go."}
					</p>
				)}

				{groups.map((group) => (
					<section key={group.repo} className="changes-group" aria-label={repoName(group.repo)}>
						<h3 className="changes-repo">
							<span className="mono">{repoName(group.repo) || "Unknown repository"}</span>
							<span className="changes-repo-count">{group.changes.length}</span>
						</h3>
						<ul>
							{batchRows(group.changes).map((row) => (
								<PanelItem key={rowKey(row)} ui={ui} row={row} index={index} />
							))}
						</ul>
					</section>
				))}

				{inFlight.length > 0 && (
					<section className="changes-group" aria-label="Pushing">
						<h3 className="changes-repo">
							<span>Pushing</span>
							<span className="changes-repo-count">{inFlight.length}</span>
						</h3>
						<ul>
							{batchRows(inFlight).map((row) => (
								<PanelItem key={rowKey(row)} ui={ui} row={row} index={index} />
							))}
						</ul>
					</section>
				)}

				{landed.length > 0 && (
					<section className="changes-group changes-landed" aria-label={`On ${landedForge}`}>
						<h3 className="changes-repo">
							<span>On {landedForge}</span>
							<span className="changes-repo-count">{landed.length}</span>
						</h3>
						<ul>
							{landed.slice(0, LANDED_SHOWN).map((change) => (
								<PanelRow key={change.id} ui={ui} change={change} index={index} />
							))}
						</ul>
						{landed.length > LANDED_SHOWN && (
							<button
								type="button"
								className="changes-more"
								onClick={() => ui.openSheet("history")}
							>
								{landed.length - LANDED_SHOWN} more in the history
							</button>
						)}
					</section>
				)}
			</div>

			<footer className="changes-panel-foot">
				<button
					type="button"
					className="changes-history-button"
					onClick={() => ui.openSheet("history")}
				>
					<HistoryIcon />
					History
				</button>
				{!ui.readOnly && ui.client && (
					<button
						type="button"
						className="primary changes-review-button"
						disabled={included.length === 0 && push.phase !== "pushing"}
						onClick={() => ui.openSheet("review")}
					>
						{push.phase === "pushing" && inFlight.length > 0
							? "Show progress"
							: included.length === 0
								? "Nothing to push"
								: signedIn(ui.user)
									? `Review and push ${included.length}`
									: `Review ${included.length}`}
					</button>
				)}
			</footer>
		</aside>
	);
}

function PanelEmpty({ readOnly, forge }: { readOnly: boolean; forge: string }) {
	return (
		<div className="changes-empty">
			<div className="changes-empty-art" aria-hidden="true">
				<span className="changes-empty-tray" />
				<span className="changes-empty-note" />
			</div>
			<h3>Nothing staged</h3>
			<p>
				{readOnly
					? `When people turn stickies into issues, add labels or link cards, the changes wait here before they go to ${forge}.`
					: `Turn a sticky into an issue, add labels or link cards: the changes wait here until you push them, so nothing reaches ${forge} by accident.`}
			</p>
		</div>
	);
}

function rowKey(row: ChangeRow): string {
	return row.kind === "batch" ? row.id : row.change.id;
}

function PanelItem({ ui, row, index }: { ui: ChangesUI; row: ChangeRow; index: ChangeIndex }) {
	return row.kind === "batch" ? (
		<BatchRow ui={ui} changes={row.changes} index={index} />
	) : (
		<PanelRow ui={ui} change={row.change} index={index} />
	);
}

/** Toast for unstaged changes, with Undo. */
function unstaged(ui: ChangesUI, removed: string[]) {
	if (removed.length === 0) return;
	ui.store.highlight([]);
	ui.toasts?.show({
		message: removed.length === 1 ? "Unstaged 1 change" : `Unstaged ${removed.length} changes`,
		action: ui.undo ? { label: "Undo", hint: "⌘Z", run: ui.undo } : undefined,
	});
}

/**
 * Changes one action staged together, as one row: what they do, who
 * staged them, unstage all. It opens to show each, and opens by itself
 * when one of them is picked out on the board or fails.
 */
function BatchRow({
	ui,
	changes,
	index,
}: {
	ui: ChangesUI;
	changes: PendingChange[];
	index: ChangeIndex;
}) {
	const [first] = changes;
	const failed = changes.filter((change) => change.status === "failed").length;
	const revealed = changes.some((change) => change.id === ui.revealed);
	const [open, setOpen] = useState(false);
	useEffect(() => {
		if (revealed || failed > 0) setOpen(true);
	}, [revealed, failed]);
	if (!first) return null;
	const shapes = [...new Set(changes.flatMap((change) => change.shapes ?? []))];
	const editable = !ui.readOnly && changes.some(isPending);
	const status = failed > 0 ? "failed" : first.status;
	const summary = summarizeBatch(changes, index);
	return (
		<li className="change-batch" data-open={open || undefined} data-status={status}>
			<div
				className="change-row"
				data-status={status}
				onPointerEnter={() => ui.store.highlight(shapes)}
				onPointerLeave={() => ui.store.highlight([])}
			>
				<button
					type="button"
					className="change-batch-toggle"
					aria-expanded={open}
					aria-label={open ? `Fold up: ${summary}` : `Show each: ${summary}`}
					onClick={() => setOpen(!open)}
				>
					<ChevronIcon />
				</button>
				<span className="change-kind" data-kind={first.op.kind}>
					<KindIcon op={first.op} />
				</span>
				<div className="change-main">
					<button
						type="button"
						className="change-summary"
						title={shapes.length ? "Show on the board" : undefined}
						onClick={() => shapes.length && ui.focusShapes(shapes)}
					>
						{summary}
					</button>
					<div className="change-meta">
						<StagedBy change={first} you={ui.user.login} />
						{failed > 0 && <span className="change-batch-failed">{failed} didn’t make it</span>}
					</div>
				</div>
				{editable && (
					<button
						type="button"
						className="change-unstage"
						aria-label={`Unstage all: ${summary}`}
						title="Unstage all"
						onClick={() =>
							unstaged(
								ui,
								unstage(
									ui.doc,
									changes.map((change) => change.id),
									index,
								),
							)
						}
					>
						<CloseIcon size={12} />
					</button>
				)}
			</div>
			{open && (
				<ul className="change-batch-items">
					{changes.map((change) => (
						<PanelRow key={change.id} ui={ui} change={change} index={index} nested />
					))}
				</ul>
			)}
		</li>
	);
}

function PanelRow({
	ui,
	change,
	index,
	nested = false,
}: {
	ui: ChangesUI;
	change: PendingChange;
	index: ChangeIndex;
	/** Inside a batch's row, which already says who staged it. */
	nested?: boolean;
}) {
	const pending = isPending(change);
	const editable = pending && !ui.readOnly;
	const forge = changeForge(change, index);
	const row = useRef<HTMLLIElement>(null);
	const [flash, setFlash] = useState(0);

	// Picked out from a mark on the board: scroll to it and flash.
	useEffect(() => {
		if (ui.revealed !== change.id) return;
		row.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
		setFlash((n) => n + 1);
	}, [ui.revealed, change.id]);

	const remove = () => unstaged(ui, unstage(ui.doc, [change.id], index));

	const retry = () => {
		void ui.session.push([change.id], change.pushedAs ?? "user", index);
	};

	// Take the sub-issue off the parent it has and put it here, at once.
	const move = () => {
		if (moveSubIssueHere(ui.doc, change.id)) retry();
	};

	return (
		<li
			ref={row}
			className="change-row"
			data-status={change.status}
			data-drift={change.drift}
			data-nested={nested || undefined}
			data-flash={flash > 0 || undefined}
			key={flash}
			onPointerEnter={() => ui.store.highlight(change.shapes ?? [])}
			onPointerLeave={() => ui.store.highlight([])}
		>
			<StatusGlyph status={change.status} />
			<span className="change-kind" data-kind={change.op.kind}>
				<KindIcon op={change.op} />
			</span>
			<div className="change-main">
				<button
					type="button"
					className="change-summary"
					title={change.shapes?.length ? "Show on the board" : undefined}
					onClick={() => change.shapes?.length && ui.focusShapes(change.shapes)}
				>
					{summarize(change.op, index)}
				</button>
				<div className="change-meta">
					{change.status === "applied" && safeUrl(change.result?.url) ? (
						<a
							className="change-link"
							href={safeUrl(change.result?.url)}
							target="_blank"
							rel="noreferrer"
						>
							View on {forge}
							<ExternalIcon />
						</a>
					) : change.status === "sending" ? (
						<span className="change-progress">Sending…</span>
					) : change.status === "sent" ? (
						<span className="change-progress">Sent, waiting for {forge} to confirm</span>
					) : nested ? null : (
						<StagedBy change={change} you={ui.user.login} />
					)}
					{pending && change.drift && (
						<span className="change-drift" data-drift={change.drift}>
							{DRIFT_NOTE[change.drift]}
						</span>
					)}
				</div>
				{change.status === "failed" && (
					<p className="change-error">
						<ForgeError error={change.error} detail={change.errorDetail} forge={forge} />
						{!ui.readOnly && (
							<FailureActions
								change={change}
								index={index}
								onRetry={ui.client && signedIn(ui.user) ? retry : undefined}
								onMove={ui.client && signedIn(ui.user) ? move : undefined}
								onLeaveOut={remove}
							/>
						)}
					</p>
				)}
			</div>
			{editable && (
				<button
					type="button"
					className="change-unstage"
					aria-label={`Unstage: ${summarize(change.op, index)}`}
					title="Unstage"
					onClick={remove}
				>
					<CloseIcon size={12} />
				</button>
			)}
		</li>
	);
}
