import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type IssueEdit, editStagedIssue } from "../../shared/actions.ts";
import { type Credit, type CreditBoard, creditFor } from "../../shared/credit.ts";
import { ServicesContext } from "../actions/services.ts";
import type { PendingChange, PushAs } from "../../shared/changes.ts";
import type { AuditEntry, RepoMeta } from "../../shared/push.ts";
import { forgeName, forgeNameOf, sentenceCase } from "../../shared/refs.ts";
import { relativeTime } from "../boards/api.ts";
import { scaledDuration } from "../motion.ts";
import type { User } from "../presence.ts";
import { type Loaded, useRepoMeta } from "./api.ts";
import { type ChangesUI, type SheetMode, signedIn, stagerFor, useChangesUI } from "./context.ts";
import {
	type FailureAction,
	KINDS,
	changeForge,
	changesForge,
	estimateWatchers,
	DRIFT_NOTE,
	failureCopy,
	groupByKind,
	groupByRepo,
	indexChanges,
	isPending,
	isPushable,
	missingDependencies,
	peopleCount,
	pushEta,
	repoName,
	reviewOrder,
	summarize,
	waitingFor,
} from "./describe.ts";
import {
	BellIcon,
	BotIcon,
	CheckIcon,
	CloseIcon,
	ExternalIcon,
	HistoryIcon,
	KindIcon,
	OutboxIcon,
	QuietIcon,
	RetryIcon,
	WarningIcon,
} from "./icons.tsx";
import { ChangePreview } from "./Preview.tsx";
import { ForgeError, IncludeToggle, StagedBy, StagerAvatar, StatusGlyph } from "./parts.tsx";
import { type PushState, useLeftOut, usePushState, useUnwritableLeftOut } from "./session.ts";
import { useChangeList } from "./store.ts";

// The push sheet: review exactly what will be written and who'll hear about
// it, choose who it's written as, push, then watch each change land. And
// the board's history of pushes.

export type HistoryState =
	| { status: "loading" }
	| { status: "ready"; entries: AuditEntry[] }
	| { status: "error"; error: string };

export interface PushSheetViewProps {
	mode: SheetMode;
	onMode: (mode: SheetMode) => void;
	/** Every change on the board. */
	changes: readonly PendingChange[];
	meta: (repo: string) => RepoMeta | undefined;
	state: PushState;
	readOnly: boolean;
	user: User;
	as: PushAs;
	onAs: (as: PushAs) => void;
	signInHref: string;
	installHref: string;
	/** Whether this board can push at all (it has a server to push to). */
	canPush: boolean;
	/** What this person has left out of this push: theirs alone, not the board's. */
	leftOut: ReadonlySet<string>;
	onToggle: (ids: string[], included: boolean) => void;
	/** Correct a staged new issue in review (see `editStagedIssue`). */
	onEdit?: (id: string, edit: IssueEdit) => boolean;
	/**
	 * Whether new issues made from the board link back to it and credit
	 * whoever wrote their sticky, what that says for each, and the switch.
	 */
	credit?: CreditChoice;
	onPush: () => void;
	onRetry: (ids: string[]) => void;
	onResolve: (action: FailureAction) => void;
	onClose: () => void;
	onDone: () => void;
	history: HistoryState;
	onReloadHistory: () => void;
	headingId?: string;
}

export interface CreditChoice {
	on: boolean;
	onChange: (on: boolean) => void;
	/** What the credit line says for a change, if it gets one. */
	of: (change: PendingChange) => Credit | null;
}

/** Whether to credit the board on new issues: on unless this person turned it off here. */
function rememberedCredit(board: string): boolean {
	try {
		return localStorage.getItem(`tack.credit.${board}`) !== "off";
	} catch {
		return true;
	}
}

/** The push sheet on a live board, in a modal dialog. */
export function PushSheet() {
	const ui = useChangesUI();
	if (!ui) return null;
	return <LiveSheet ui={ui} />;
}

function rememberedAs(): PushAs {
	try {
		return localStorage.getItem("tack.pushAs") === "app" ? "app" : "user";
	} catch {
		return "user";
	}
}

function LiveSheet({ ui }: { ui: ChangesUI }) {
	const dialog = useRef<HTMLDialogElement>(null);
	const [closing, setClosing] = useState(false);
	const headingId = useId();
	const open = ui.sheet !== null;
	const [mode, setMode] = useState<SheetMode>("review");
	const [as, setAsState] = useState<PushAs>(rememberedAs);
	const changes = useChangeList(ui.store);
	const index = useMemo(() => indexChanges(changes), [changes]);
	const state = usePushState(ui.session);
	useUnwritableLeftOut(ui.session, ui.meta, changes, index);
	const leftOut = useLeftOut(ui.session);
	const repos = useMemo(
		() => [...new Set(groupByRepo(changes, index).map((group) => group.repo))].filter(Boolean),
		[changes, index],
	);
	const meta = useRepoMeta(open ? ui.meta : null, repos);
	const [history, setHistory] = useState<HistoryState>({ status: "loading" });
	const services = useContext(ServicesContext);
	const [credited, setCredited] = useState(() => rememberedCredit(services?.boardId ?? ""));
	const board: CreditBoard | null = services
		? { url: services.boardUrl(), title: services.boardTitle() ?? "" }
		: null;
	const credit: CreditChoice | undefined = board
		? {
				on: credited,
				onChange: (on) => {
					setCredited(on);
					try {
						localStorage.setItem(`tack.credit.${services?.boardId ?? ""}`, on ? "on" : "off");
					} catch {
						// Remembering is a nicety.
					}
				},
				of: (change) => creditFor(ui.doc, change, board),
			}
		: undefined;
	const pushWith = (ids: string[], pushAs: PushAs) =>
		ui.session.push(ids, pushAs, index, credited && board ? board : undefined);

	const setAs = (next: PushAs) => {
		setAsState(next);
		try {
			localStorage.setItem("tack.pushAs", next);
		} catch {
			// Remembering is a nicety.
		}
	};

	const loadHistory = useCallback(() => {
		if (!ui.client) {
			setHistory({ status: "ready", entries: [] });
			return;
		}
		setHistory({ status: "loading" });
		void ui.client
			.pushes()
			.then((result: Loaded<AuditEntry[]>) =>
				setHistory(
					result.ok
						? { status: "ready", entries: result.value }
						: { status: "error", error: result.error },
				),
			);
	}, [ui.client]);

	useEffect(() => {
		if (ui.sheet) setMode(ui.sheet);
	}, [ui.sheet]);

	useEffect(() => {
		if (open && mode === "history") loadHistory();
	}, [open, mode, loadHistory]);

	useEffect(() => {
		const el = dialog.current;
		if (!el) return;
		if (open && !el.open) {
			setClosing(false);
			el.showModal();
		} else if (!open && el.open) {
			el.close();
		}
	}, [open]);

	const close = () => {
		if (closing) return;
		setClosing(true);
		setTimeout(() => {
			dialog.current?.close();
			setClosing(false);
			// A push that's finished is forgotten; one still going carries on.
			const current = ui.session.getSnapshot();
			if (current.phase === "refused") ui.session.reset();
			ui.closeSheet();
		}, scaledDuration(140));
	};

	const included = changes.filter((change) => isPushable(change) && !leftOut.has(change.id));

	const push = () => {
		if (included.length === 0 || ui.readOnly || !signedIn(ui.user)) return;
		void pushWith(
			included.map((change) => change.id),
			as,
		);
	};

	const resolve = (action: FailureAction) => {
		switch (action.kind) {
			case "sign_in":
				location.assign(ui.signInHref);
				break;
			case "install":
				window.open(ui.installHref, "_blank", "noopener");
				ui.meta?.refresh(action.repos);
				break;
			case "leave_out": {
				const repos = new Set(action.repos);
				const ids = included
					.filter((change) => {
						const group = groupByRepo([change], index)[0];
						return group && repos.has(group.repo);
					})
					.map((change) => change.id);
				ui.session.setIncluded(ids, false, index);
				ui.session.reset();
				break;
			}
			case "include_dependencies": {
				const missing = missingDependencies(
					included.map((change) => change.id),
					index,
				);
				ui.session.setIncluded(missing, true, index);
				ui.session.reset();
				break;
			}
			case "retry":
				if (state.phase === "refused") void pushWith(state.ids, state.as);
				else if (state.phase === "pushing" && state.refused) {
					void pushWith(state.refused, state.as);
				}
				break;
		}
	};

	return createPortal(
		<dialog
			ref={dialog}
			className="push-dialog"
			aria-labelledby={headingId}
			data-closing={closing || undefined}
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}
			onClick={(event) => {
				if (event.target === dialog.current) close();
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && mode === "review") {
					event.preventDefault();
					push();
				}
			}}
		>
			{open && (
				<PushSheetView
					mode={mode}
					onMode={setMode}
					changes={changes}
					meta={meta}
					state={state}
					readOnly={ui.readOnly}
					user={ui.user}
					as={as}
					onAs={setAs}
					signInHref={ui.signInHref}
					installHref={ui.installHref}
					canPush={ui.client !== null}
					leftOut={leftOut}
					onToggle={(ids, on) => ui.session.setIncluded(ids, on, index)}
					onEdit={(id, edit) => editStagedIssue(ui.doc, id, edit)}
					credit={credit}
					onPush={push}
					onRetry={(ids) => void pushWith(ids, as)}
					onResolve={resolve}
					onClose={close}
					onDone={() => {
						ui.session.reset();
						close();
					}}
					history={history}
					onReloadHistory={loadHistory}
					headingId={headingId}
				/>
			)}
		</dialog>,
		document.body,
	);
}

export function PushSheetView(props: PushSheetViewProps) {
	const { mode, onMode, state, onClose, headingId, changes } = props;
	const progress = mode === "review" && state.phase === "pushing";
	// Named for where these changes go: what's to push, or what's being pushed.
	const forge = useMemo(() => {
		const index = indexChanges(changes);
		const ids = state.phase === "pushing" ? new Set(state.ids) : null;
		const shown = changes.filter((change) => (ids ? ids.has(change.id) : isPending(change)));
		return changesForge(shown.length > 0 ? shown : changes, index);
	}, [changes, state]);
	return (
		<div className="push-sheet changes-ui" data-mode={progress ? "progress" : mode}>
			<header className="push-head">
				<span className="push-head-icon" aria-hidden="true">
					{mode === "history" ? <HistoryIcon size={18} /> : <OutboxIcon size={18} />}
				</span>
				<h2 id={headingId}>{mode === "history" ? "Push history" : `Push to ${forge}`}</h2>
				<div className="push-tabs" role="tablist" aria-label="Push sheet">
					<button
						type="button"
						role="tab"
						aria-selected={mode === "review"}
						onClick={() => onMode("review")}
					>
						{progress ? "Progress" : "Review"}
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={mode === "history"}
						onClick={() => onMode("history")}
					>
						History
					</button>
				</div>
				<button type="button" className="changes-icon-button" aria-label="Close" onClick={onClose}>
					<CloseIcon />
				</button>
			</header>
			{mode === "history" ? (
				<HistoryView {...props} />
			) : progress ? (
				<ProgressView {...props} forge={forge} />
			) : (
				<ReviewView {...props} forge={forge} />
			)}
		</div>
	);
}

function ReviewView({
	changes,
	meta,
	state,
	readOnly,
	user,
	as,
	onAs,
	signInHref,
	installHref,
	canPush,
	leftOut,
	onToggle,
	onEdit,
	credit,
	onPush,
	onResolve,
	onClose,
	forge,
}: PushSheetViewProps & { forge: string }) {
	const index = useMemo(() => indexChanges(changes), [changes]);
	const pending = changes.filter(isPending);
	const isIn = (change: PendingChange) => isPushable(change) && !leftOut.has(change.id);
	const included = pending.filter(isIn);
	const groups = groupByRepo(pending, index);
	const estimate = estimateWatchers(included, index, meta);
	const requesting = state.phase === "requesting";
	const refusal = state.phase === "refused" ? state.refusal : null;
	const you = signedIn(user);
	const repoCount = new Set(groupByRepo(included, index).map((group) => group.repo)).size;
	const creditable = credit ? included.filter((change) => credit.of(change)) : [];

	if (pending.length === 0) {
		return (
			<div className="push-body push-nothing">
				<p className="push-nothing-title">Nothing to push</p>
				<p>Stage some changes on the board first: they’ll show up here to review.</p>
				<button type="button" onClick={onClose}>
					Back to the board
				</button>
			</div>
		);
	}

	return (
		<>
			<div className="push-body">
				<p className="push-lede">
					{included.length === 0
						? "Everything’s left out. Turn on the changes you want to push."
						: `${included.length === 1 ? "1 change" : `${included.length} changes`} to ${repoCount === 1 ? "1 repository" : `${repoCount} repositories`}. Nothing is written until you push.`}
				</p>

				{refusal && (
					<Refusal
						refusal={refusal}
						onResolve={onResolve}
						signInHref={signInHref}
						installHref={installHref}
					/>
				)}

				{groups.map((group) => {
					const info = meta(group.repo);
					const repoIncluded = group.changes.filter(isIn);
					const noisy = repoIncluded.some((change) => KINDS[change.op.kind].notifies);
					return (
						<section key={group.repo} className="push-repo" aria-label={repoName(group.repo)}>
							<header className="push-repo-head">
								<h3 className="mono">{repoName(group.repo) || "Unknown repository"}</h3>
								{info === undefined ? (
									<span className="push-notify" data-loading="true">
										Checking watchers…
									</span>
								) : noisy ? (
									<span className="push-notify" data-noisy={info.watchers > 0 || undefined}>
										<BellIcon size={13} />
										{info.watchers === 0 ? "No watchers" : `Notifies ${peopleCount(info.watchers)}`}
									</span>
								) : (
									<span className="push-notify">
										<QuietIcon size={13} />
										Quiet
									</span>
								)}
							</header>
							{info?.writable === false && (
								<p className="push-repo-warning">
									<WarningIcon size={14} />
									<span>
										Tack’s app isn’t installed here, so it can’t write these yet.{" "}
										<a href={installHref} target="_blank" rel="noreferrer">
											Install the app
										</a>
									</span>
								</p>
							)}
							{groupByKind(group.changes).map((kind) => {
								const on = kind.changes.filter(isIn);
								const choosable = kind.changes.filter(isPushable);
								return (
									<div key={kind.kind} className="push-kind">
										<div className="push-kind-head">
											<IncludeToggle
												checked={on.length > 0 && on.length === choosable.length}
												disabled={readOnly || choosable.length === 0}
												label={`Include all: ${KINDS[kind.kind].group}`}
												onChange={(checked) =>
													onToggle(
														choosable.map((change) => change.id),
														checked,
													)
												}
											/>
											<h4>
												{KINDS[kind.kind].group}
												<span>
													{on.length === kind.changes.length
														? kind.changes.length
														: `${on.length} of ${kind.changes.length}`}
												</span>
											</h4>
										</div>
										<ul>
											{kind.changes.map((change) => (
												<li
													key={change.id}
													className="push-change"
													data-included={isIn(change)}
													data-status={change.status}
													data-drift={change.drift}
												>
													<IncludeToggle
														checked={isIn(change)}
														disabled={readOnly || !isPushable(change)}
														label={`Include: ${summarize(change.op, index)}`}
														onChange={(checked) => onToggle([change.id], checked)}
													/>
													<div className="push-change-main">
														<ChangePreview
															change={change}
															index={index}
															meta={meta}
															as={as}
															user={user}
															onEdit={
																onEdit && !readOnly ? (edit) => onEdit(change.id, edit) : undefined
															}
															credit={credit?.on ? credit.of(change) : null}
														/>
														<div className="push-change-foot">
															<StagedBy change={change} you={user.login} />
															{change.drift && (
																<span className="push-change-drift" data-drift={change.drift}>
																	{DRIFT_NOTE[change.drift]}
																</span>
															)}
															{change.effect?.kind === "replace" && (
																<span className="push-change-effect">
																	On the board, its sticky turns into the new card
																</span>
															)}
															{change.effect?.kind === "place" && (
																<span className="push-change-effect">
																	On the board, its card lands above its sub-issues
																</span>
															)}
															{change.status === "failed" && (
																<span className="push-change-failed">
																	Failed last time:{" "}
																	<ForgeError
																		error={change.error}
																		detail={change.errorDetail}
																		forge={changeForge(change, index)}
																	/>
																</span>
															)}
															{info?.writes && !info.writes.includes(change.op.kind) && (
																<span className="push-change-failed">
																	{repoName(group.repo)} doesn’t support this kind of change
																</span>
															)}
														</div>
													</div>
												</li>
											))}
										</ul>
									</div>
								);
							})}
						</section>
					);
				})}
			</div>

			<footer className="push-foot">
				<fieldset className="push-as" disabled={readOnly || !you}>
					<legend>Push as</legend>
					<label data-checked={as === "user"}>
						<input
							type="radio"
							name="push-as"
							checked={as === "user"}
							onChange={() => onAs("user")}
						/>
						<StagerAvatar stager={stagerFor(user)} avatarUrl={user.avatarUrl} size={26} />
						<span>
							<strong>{you ? `You, @${user.login}` : "You"}</strong>
							<small>{sentenceCase(forge)} shows it’s you, “via Tack”</small>
						</span>
					</label>
					<label data-checked={as === "app"}>
						<input
							type="radio"
							name="push-as"
							checked={as === "app"}
							onChange={() => onAs("app")}
						/>
						<span className="push-as-bot" aria-hidden="true">
							<BotIcon size={16} />
						</span>
						<span>
							<strong>Tack’s bot</strong>
							<small>Written by the app, not by you</small>
						</span>
					</label>
				</fieldset>

				{credit && creditable.length > 0 && (
					<label className="push-credit">
						<input
							type="checkbox"
							checked={credit.on}
							disabled={readOnly}
							onChange={(event) => credit.onChange(event.target.checked)}
						/>
						<span className="include-toggle-box" aria-hidden="true">
							<CheckIcon size={12} />
						</span>
						<span>
							<strong>Say where {creditable.length === 1 ? "it" : "they"} came from</strong>
							<small>A line linking back to this board, crediting whoever wrote each sticky</small>
						</span>
					</label>
				)}

				<p className="push-estimate" data-noisy={estimate.noisyRepos.length > 0 || undefined}>
					{estimate.noisyRepos.length > 0 ? <BellIcon /> : <QuietIcon />}
					<span>
						{estimate.noisyRepos.length === 0
							? included.length === 0
								? "Nothing will be sent."
								: "Won’t notify watchers: labels, milestones and links are quiet."
							: estimate.loading
								? "Checking who’s watching…"
								: estimate.watchers === 0
									? `Nobody’s watching ${listRepos(estimate.noisyRepos)}, so no watchers are notified.`
									: `Notifies ${peopleCount(estimate.watchers)} watching ${listRepos(estimate.noisyRepos)}.`}
						{estimate.assignees.length > 0 &&
							` ${estimate.assignees.map((login) => `@${login}`).join(", ")} ${estimate.assignees.length === 1 ? "hears" : "hear"} about being assigned.`}
					</span>
				</p>

				<div className="push-actions">
					<button type="button" onClick={onClose}>
						Cancel
					</button>
					{!canPush || readOnly ? (
						<span className="push-cant">
							{readOnly
								? "View only: you can’t push from this board"
								: "Pushing isn’t available here"}
						</span>
					) : !you ? (
						<a className="push-button primary" href={signInHref}>
							Sign in to push
						</a>
					) : (
						<button
							type="button"
							className="push-button primary"
							disabled={included.length === 0 || requesting}
							data-busy={requesting || undefined}
							onClick={onPush}
						>
							<span className="push-button-label">
								{requesting
									? "Starting…"
									: `Push ${included.length === 1 ? "1 change" : `${included.length} changes`}`}
							</span>
							<kbd>⌘↵</kbd>
						</button>
					)}
				</div>
			</footer>
		</>
	);
}

function listRepos(repos: string[]): string {
	const names = repos.map(repoName);
	if (names.length <= 2) return names.join(" and ");
	return `${names.length} repositories`;
}

function Refusal({
	refusal,
	onResolve,
	signInHref,
	installHref,
}: {
	refusal: NonNullable<Extract<PushState, { phase: "refused" }>["refusal"]>;
	onResolve: (action: FailureAction) => void;
	signInHref: string;
	installHref: string;
}) {
	const copy = failureCopy(refusal);
	return (
		<div className="push-refusal" role="alert" data-reason={refusal.reason}>
			<WarningIcon size={18} />
			<div>
				<strong>{copy.title}</strong>
				<p>{copy.body}</p>
				<div className="push-refusal-actions">
					{copy.actions.map((action) => {
						switch (action.kind) {
							case "sign_in":
								return (
									<a key="sign_in" className="push-refusal-primary" href={signInHref}>
										Sign in with GitHub
									</a>
								);
							case "install":
								return (
									<a
										key="install"
										className="push-refusal-primary"
										href={installHref}
										target="_blank"
										rel="noreferrer"
										onClick={() => onResolve(action)}
									>
										Install the app
									</a>
								);
							case "leave_out":
								return (
									<button key="leave_out" type="button" onClick={() => onResolve(action)}>
										Leave {action.repos.length === 1 ? "its" : "their"} changes out
									</button>
								);
							case "include_dependencies":
								return (
									<button
										key="deps"
										type="button"
										className="push-refusal-primary"
										onClick={() => onResolve(action)}
									>
										Include it
									</button>
								);
							case "retry":
								return (
									<button
										key="retry"
										type="button"
										className="push-refusal-primary"
										onClick={() => onResolve(action)}
									>
										<RetryIcon size={12} />
										Try again
									</button>
								);
						}
					})}
				</div>
			</div>
		</div>
	);
}

/** The latest known state of each change in a push, even once it's gone from the board. */
function usePushedChanges(ids: string[], changes: readonly PendingChange[]): PendingChange[] {
	const known = useRef(new Map<string, PendingChange>());
	const byId = new Map(changes.map((change) => [change.id, change]));
	return ids.flatMap((id) => {
		const change = byId.get(id) ?? known.current.get(id);
		if (change) known.current.set(id, change);
		return change ? [change] : [];
	});
}

function ProgressView({
	changes,
	state,
	user,
	onRetry,
	onDone,
	onMode,
	onResolve,
	signInHref,
	installHref,
	forge,
}: PushSheetViewProps & { forge: string }) {
	const ids = state.phase === "pushing" ? state.ids : [];
	const index = useMemo(() => indexChanges(changes), [changes]);
	// In the order they were reviewed in, not the order they're written in
	// (which puts what depends on a new issue after it).
	const pushed = reviewOrder(usePushedChanges(ids, changes), index);
	const total = pushed.length;
	const applied = pushed.filter((change) => change.status === "applied").length;
	const sent = pushed.filter((change) => change.status === "sent").length;
	const failed = pushed.filter((change) => change.status === "failed");
	const working = pushed.filter(
		(change) => change.status === "sending" || change.status === "staged",
	).length;
	const settled = working === 0 && sent === 0;
	const allLanded = settled && failed.length === 0 && total > 0;
	const as = state.phase === "pushing" ? state.as : "user";

	const title = allLanded
		? total === 1
			? `It’s on ${forge}`
			: `All ${total} changes are on ${forge}`
		: settled
			? `${applied} landed, ${failed.length} didn’t`
			: working > 0
				? `Pushing ${total === 1 ? "1 change" : `${total} changes`}…`
				: `Sent. Waiting for ${forge} to confirm…`;

	return (
		<>
			<div className="push-body push-progress" data-done={allLanded || undefined}>
				<div className="push-meter" aria-live="polite">
					<ProgressRing
						total={total}
						applied={applied}
						sent={sent}
						failed={failed.length}
						done={allLanded}
						forge={forge}
					/>
					<div>
						<p className="push-meter-title" key={title}>
							{title}
						</p>
						<p className="push-meter-sub">
							{as === "app"
								? "Written by Tack’s bot"
								: `Written as you${user.login ? `, @${user.login}` : ""}, via Tack`}
							{" · "}
							{settled
								? "Everyone on the board sees this too"
								: `${pushEta(working)}You can close this: it carries on, and the changes panel follows along`}
						</p>
					</div>
				</div>

				{state.phase === "pushing" && state.refusal && (
					<Refusal
						refusal={state.refusal}
						onResolve={onResolve}
						signInHref={signInHref}
						installHref={installHref}
					/>
				)}

				<ol className="push-steps">
					{pushed.map((change, i) => (
						<li
							key={change.id}
							className="push-step"
							data-status={change.status}
							style={{ "--i": i } as React.CSSProperties}
						>
							<StatusGlyph status={change.status} size={20} />
							<span className="change-kind" data-kind={change.op.kind}>
								<KindIcon op={change.op} />
							</span>
							<div className="push-step-main">
								<span className="push-step-summary">{summarize(change.op, index)}</span>
								<span className="push-step-status">
									{change.status === "applied" ? (
										change.result?.url ? (
											<a href={change.result.url} target="_blank" rel="noreferrer">
												On {changeForge(change, index)}
												{change.result.key && (
													<span className="mono">
														{" "}
														{change.result.key.replace(/^.*?([#!]\d+)$/, "$1")}
													</span>
												)}
												<ExternalIcon />
											</a>
										) : (
											`On ${changeForge(change, index)}`
										)
									) : change.status === "sent" ? (
										`Sent, waiting for ${changeForge(change, index)} to confirm`
									) : change.status === "failed" ? (
										<span className="push-step-error">
											<ForgeError
												error={change.error}
												detail={change.errorDetail}
												forge={changeForge(change, index)}
											/>
										</span>
									) : waitingFor(change, index) ? (
										`Waits for ${waitingFor(change, index)} to be made`
									) : change.status === "sending" ? (
										"Sending…"
									) : (
										"Waiting its turn"
									)}
								</span>
							</div>
							{change.status === "failed" && (
								<button type="button" className="change-retry" onClick={() => onRetry([change.id])}>
									<RetryIcon size={12} />
									Retry
								</button>
							)}
						</li>
					))}
				</ol>
			</div>
			<footer className="push-foot push-foot-progress">
				<button type="button" className="changes-history-button" onClick={() => onMode("history")}>
					<HistoryIcon />
					History
				</button>
				<div className="push-actions">
					{settled && failed.length > 0 && (
						<button type="button" onClick={() => onRetry(failed.map((change) => change.id))}>
							<RetryIcon size={12} />
							Retry {failed.length === 1 ? "it" : `all ${failed.length}`}
						</button>
					)}
					<button type="button" className={settled ? "primary" : undefined} onClick={onDone}>
						{settled ? "Done" : "Close"}
					</button>
				</div>
			</footer>
		</>
	);
}

/**
 * A ring that fills as changes land: a pale arc for sent, a solid one for
 * confirmed, red for failures. When everything lands it becomes a check,
 * and a little burst of pins goes off.
 */
export function ProgressRing({
	total,
	applied,
	sent,
	failed,
	done,
	forge = "GitHub",
}: {
	total: number;
	applied: number;
	sent: number;
	failed: number;
	done: boolean;
	/** Where they land, for the label. */
	forge?: string;
}) {
	const share = (n: number) => (total === 0 ? 0 : (n / total) * 100);
	return (
		<span
			className="push-ring"
			data-done={done || undefined}
			role="img"
			aria-label={`${applied} of ${total} on ${forge}`}
		>
			<svg viewBox="0 0 48 48" aria-hidden="true">
				<circle className="push-ring-track" cx="24" cy="24" r="20" />
				<circle
					className="push-ring-sent"
					cx="24"
					cy="24"
					r="20"
					pathLength="100"
					style={{ strokeDasharray: `${share(applied + sent)} 100` }}
				/>
				<circle
					className="push-ring-applied"
					cx="24"
					cy="24"
					r="20"
					pathLength="100"
					style={{ strokeDasharray: `${share(applied)} 100` }}
				/>
				{failed > 0 && (
					<circle
						className="push-ring-failed"
						cx="24"
						cy="24"
						r="20"
						pathLength="100"
						style={{
							strokeDasharray: `${share(failed)} 100`,
							strokeDashoffset: `${-share(applied + sent)}`,
						}}
					/>
				)}
			</svg>
			<span className="push-ring-count">
				{done ? (
					<svg className="push-ring-check" viewBox="0 0 24 24" aria-hidden="true">
						<path d="M6 12.5l4 4 8-9" pathLength="1" />
					</svg>
				) : (
					<>
						{applied}
						<small>/{total}</small>
					</>
				)}
			</span>
			{done && (
				<span className="push-burst" aria-hidden="true">
					{BURST.map((spark, i) => (
						<span
							key={i}
							style={
								{
									"--angle": `${spark.angle}deg`,
									"--distance": `${spark.distance}px`,
									"--delay": `${spark.delay}ms`,
									"--hue": spark.color,
								} as React.CSSProperties
							}
						/>
					))}
				</span>
			)}
		</span>
	);
}

const BURST_COLORS = [
	"var(--sticky-yellow)",
	"var(--sticky-pink)",
	"var(--sticky-blue)",
	"var(--sticky-green)",
	"var(--sticky-purple)",
	"var(--accent)",
];
const BURST = Array.from({ length: 14 }, (_, i) => ({
	angle: (i / 14) * 360 + (i % 2) * 9,
	distance: 34 + ((i * 7) % 5) * 5,
	delay: (i % 3) * 30,
	color: BURST_COLORS[i % BURST_COLORS.length],
}));

/** What to call the forge a link goes to, by its host. */
function forgeOfUrl(url: string): string {
	try {
		return forgeName(new URL(url).host);
	} catch {
		return forgeNameOf([]);
	}
}

function HistoryView({ history, onReloadHistory, user }: PushSheetViewProps) {
	return (
		<div className="push-body push-history">
			{history.status === "loading" && (
				<ul className="push-history-list" aria-busy="true">
					{[0, 1, 2].map((i) => (
						<li key={i} className="push-entry push-entry-skeleton">
							<span className="skeleton" />
							<span className="skeleton short" />
						</li>
					))}
				</ul>
			)}
			{history.status === "error" && (
				<div className="push-nothing">
					<p className="push-nothing-title">Couldn’t load the history</p>
					<p>{history.error === "offline" ? "Couldn’t reach Tack." : "Something went wrong."}</p>
					<button type="button" onClick={onReloadHistory}>
						Try again
					</button>
				</div>
			)}
			{history.status === "ready" && history.entries.length === 0 && (
				<div className="push-nothing">
					<p className="push-nothing-title">No pushes yet</p>
					<p>
						Every push from this board is logged here: who pushed, as whom, and what it changed.
					</p>
				</div>
			)}
			{history.status === "ready" && history.entries.length > 0 && (
				<ol className="push-history-list">
					{history.entries.map((entry) => {
						const failed = entry.changes.filter((change) => change.status === "failed").length;
						return (
							<li key={entry.pushId} className="push-entry">
								<header>
									{entry.as === "app" ? (
										<span className="push-as-bot" aria-hidden="true">
											<BotIcon size={14} />
										</span>
									) : (
										<StagerAvatar
											stager={{ name: entry.by.name ?? entry.by.login, login: entry.by.login }}
											size={24}
										/>
									)}
									<span className="push-entry-who">
										<strong>
											{entry.by.login === user.login
												? "You"
												: (entry.by.name ?? `@${entry.by.login}`)}
										</strong>{" "}
										pushed{" "}
										{entry.changes.length === 1 ? "1 change" : `${entry.changes.length} changes`}
										{entry.as === "app" ? " as Tack’s bot" : ""}
									</span>
									<time dateTime={entry.at}>{relativeTime(Date.parse(entry.at))}</time>
									{failed > 0 && <span className="push-entry-failed">{failed} failed</span>}
								</header>
								<ul>
									{entry.changes.map((change) => (
										<li key={change.id} data-status={change.status}>
											<StatusGlyph status={change.status} size={14} />
											<span className="push-entry-summary">{change.summary}</span>
											{change.url && (
												<a
													href={change.url}
													target="_blank"
													rel="noreferrer"
													aria-label={`Open on ${forgeOfUrl(change.url)}: ${change.summary}`}
												>
													<ExternalIcon />
												</a>
											)}
											{change.error && (
												<span className="push-step-error">
													<ForgeError
														error={change.error}
														detail={change.detail}
														forge={change.url ? forgeOfUrl(change.url) : undefined}
													/>
												</span>
											)}
										</li>
									))}
								</ul>
							</li>
						);
					})}
				</ol>
			)}
		</div>
	);
}
