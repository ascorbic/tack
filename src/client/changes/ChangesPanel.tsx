import { useEffect, useMemo, useRef, useState } from "react";
import type { PendingChange } from "../../shared/changes.ts";
import { useLinger } from "../useLinger.ts";
import "./changes.css";
import { type ChangesUI, signedIn, useChangesUI } from "./context.ts";
import {
	type ChangeIndex,
	friendlyError,
	groupByRepo,
	indexChanges,
	isInFlight,
	isPending,
	repoName,
	summarize,
} from "./describe.ts";
import { CloseIcon, ExternalIcon, HistoryIcon, KindIcon, RetryIcon } from "./icons.tsx";
import { IncludeToggle, StagedBy, StatusGlyph } from "./parts.tsx";
import { setIncluded, unstage, usePushState } from "./session.ts";
import { useChangeList } from "./store.ts";

/** How many landed changes the panel keeps showing; the rest are in the history. */
const LANDED_SHOWN = 5;

/**
 * The board's pending changes, FigJam-panel style: grouped by repository,
 * with who staged each, a toggle for whether it goes in the next push, and
 * unstage. Failed changes say why and offer a retry. Everyone on the board
 * sees the same list, live; view-only people see it but can't change it.
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
	const included = pending.filter((change) => change.included !== false);
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
							: "Staged here, waiting to go to GitHub. Everyone on the board sees this list."}
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
				{empty && <PanelEmpty readOnly={ui.readOnly} />}

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
							{group.changes.map((change) => (
								<PanelRow key={change.id} ui={ui} change={change} index={index} />
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
							{inFlight.map((change) => (
								<PanelRow key={change.id} ui={ui} change={change} index={index} />
							))}
						</ul>
					</section>
				)}

				{landed.length > 0 && (
					<section className="changes-group changes-landed" aria-label="On GitHub">
						<h3 className="changes-repo">
							<span>On GitHub</span>
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

function PanelEmpty({ readOnly }: { readOnly: boolean }) {
	return (
		<div className="changes-empty">
			<div className="changes-empty-art" aria-hidden="true">
				<span className="changes-empty-tray" />
				<span className="changes-empty-note" />
			</div>
			<h3>Nothing staged</h3>
			<p>
				{readOnly
					? "When people turn stickies into issues, add labels or link cards, the changes wait here before they go to GitHub."
					: "Turn a sticky into an issue, add labels or link cards: the changes wait here until you push them, so nothing reaches GitHub by accident."}
			</p>
		</div>
	);
}

function PanelRow({
	ui,
	change,
	index,
}: {
	ui: ChangesUI;
	change: PendingChange;
	index: ChangeIndex;
}) {
	const pending = isPending(change);
	const included = change.included !== false;
	const editable = pending && !ui.readOnly;
	const row = useRef<HTMLLIElement>(null);
	const [flash, setFlash] = useState(0);

	// Picked out from a mark on the board: scroll to it and flash.
	useEffect(() => {
		if (ui.revealed !== change.id) return;
		row.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
		setFlash((n) => n + 1);
	}, [ui.revealed, change.id]);

	const remove = () => {
		const removed = unstage(ui.doc, [change.id], index);
		if (removed.length === 0) return;
		ui.store.highlight([]);
		ui.toasts?.show({
			message: removed.length === 1 ? "Unstaged 1 change" : `Unstaged ${removed.length} changes`,
			action: ui.undo ? { label: "Undo", hint: "⌘Z", run: ui.undo } : undefined,
		});
	};

	const retry = () => {
		void ui.session.push([change.id], change.pushedAs ?? "user", index);
	};

	return (
		<li
			ref={row}
			className="change-row"
			data-status={change.status}
			data-included={included}
			data-flash={flash > 0 || undefined}
			key={flash}
			onPointerEnter={() => ui.store.highlight(change.shapes ?? [])}
			onPointerLeave={() => ui.store.highlight([])}
		>
			{pending ? (
				<IncludeToggle
					checked={included}
					disabled={!editable}
					label={`Include in the next push: ${summarize(change.op, index)}`}
					onChange={(checked) => setIncluded(ui.doc, [change.id], checked, index)}
				/>
			) : (
				<StatusGlyph status={change.status} />
			)}
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
					{change.status === "applied" && change.result?.url ? (
						<a className="change-link" href={change.result.url} target="_blank" rel="noreferrer">
							View on GitHub
							<ExternalIcon />
						</a>
					) : change.status === "sending" ? (
						<span className="change-progress">Sending…</span>
					) : change.status === "sent" ? (
						<span className="change-progress">Sent, waiting for GitHub to confirm</span>
					) : (
						<StagedBy change={change} you={ui.user.login} />
					)}
				</div>
				{change.status === "failed" && (
					<p className="change-error">
						{friendlyError(change.error)}
						{!ui.readOnly && ui.client && signedIn(ui.user) && (
							<button type="button" className="change-retry" onClick={retry}>
								<RetryIcon size={12} />
								Retry
							</button>
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
