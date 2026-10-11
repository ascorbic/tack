import { useEffect, useId, useState } from "react";
import type { BoardInfo } from "../../shared/boards.ts";
import {
	DEFAULT_DIGEST,
	type DigestRun,
	type DigestSettings,
	type DigestView,
	WEEKDAY_NAMES,
	type Weekday,
	describeDigestError,
	describeSchedule,
	discussionRepoKey,
	maskEmail,
	validEmail,
} from "../../shared/digests.ts";
import { recentRepos } from "../actions/services.ts";
import { relativeTime } from "../boards/api.ts";
import { Modal } from "../boards/Modal.tsx";
import { repoApi } from "../changes/api.ts";
import { safeUrl } from "../changes/inline.ts";
import { Markdown } from "../changes/Markdown.tsx";
import { Segmented } from "../export/ExportDialog.tsx";
import { type DigestApi, type DigestResult, digestApi, localTimeZone } from "./api.ts";
import { DigestPreview } from "./DigestPreview.tsx";
import "../boards/templates.css";
import "../export/export.css";
import "./digests.css";

// Weekly digests (#68), from the board's menu: for everyone signed in, the
// next digest so far and their own email; for the owner, where it goes
// (a Discussion, email, or both) and when, and how the last ones went.

type Board = Pick<BoardInfo, "id" | "title" | "visibility">;

export function DigestDialog({
	board,
	open,
	onClose,
	api,
}: {
	board: Board;
	open: boolean;
	onClose: () => void;
	api?: DigestApi;
}) {
	const headingId = useId();
	return (
		<Modal open={open} onClose={onClose} className="digest-dialog" labelledBy={headingId}>
			{(close) => <DigestPanel board={board} headingId={headingId} onClose={close} api={api} />}
		</Modal>
	);
}

const short = (repo: string) => repo.replace(/^github\.com\//, "");
const DAYS: Weekday[] = [1, 2, 3, 4, 5, 6, 0];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** "Monday 13 Oct, 9:00", in the owner's time zone. */
function when(at: number, timeZone: string): string {
	try {
		return new Intl.DateTimeFormat(undefined, {
			weekday: "long",
			day: "numeric",
			month: "short",
			hour: "numeric",
			minute: "2-digit",
			timeZone,
		}).format(at);
	} catch {
		return new Date(at).toLocaleString();
	}
}

export function DigestPanel({
	board,
	headingId,
	onClose,
	api = digestApi,
	initial,
	now = Date.now(),
	timeZone = localTimeZone(),
}: {
	board: Board;
	headingId?: string;
	onClose: () => void;
	/** Where digests are set; the gallery and playground pass their own. */
	api?: DigestApi;
	initial?: DigestView;
	now?: number;
	/** The browser's time zone, for a new schedule. */
	timeZone?: string;
}) {
	const [view, setView] = useState<DigestView | null>(initial ?? null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		if (initial) return;
		let cancelled = false;
		void api.get(board.id).then((result) => {
			if (cancelled) return;
			if (!result.ok) setLoadError(result.message ?? describeDigestError(result.error));
			else setView(result.value);
		});
		return () => {
			cancelled = true;
		};
	}, [api, board.id, initial]);

	if (!view) {
		return (
			<div className="digest" aria-busy={!loadError}>
				<div className="digest-side">
					<header className="digest-head">
						<h2 id={headingId}>Weekly digest</h2>
					</header>
					<div className="backup-status" data-tone={loadError ? "error" : "busy"}>
						<span className="backup-dot" aria-hidden="true" />
						<p>{loadError ?? "Gathering this week…"}</p>
					</div>
					<div className="new-board-actions-end digest-done">
						<button type="button" className="new-board-cancel" onClick={onClose}>
							Close
						</button>
					</div>
				</div>
				<div className="digest-preview" aria-hidden="true">
					<div className="digest-preview-head">
						<span>So far this week</span>
					</div>
					<div className="digest-preview-body">
						<div
							className="digest-paper digest-paper-skeleton"
							data-error={loadError ? "" : undefined}
						>
							{[38, 64, 22, 88, 72, 54, 80, 46].map((width, i) => (
								<span key={i} className="skeleton" style={{ width: `${width}%` }} />
							))}
						</div>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="digest" data-owner={view.canManage || undefined}>
			<div className="digest-side">
				<header className="digest-head">
					<h2 id={headingId}>Weekly digest</h2>
					<p>
						{view.settings && view.nextAt ? (
							<>
								Next: <strong>{when(view.nextAt, view.settings.timeZone)}</strong>
							</>
						) : view.canManage ? (
							"Once a week, what happened here: decisions, action items, GitHub and who did what."
						) : (
							"The board’s owner hasn’t turned on a weekly digest yet."
						)}
					</p>
				</header>
				{view.canManage ? (
					<OwnerSettings
						board={board}
						view={view}
						api={api}
						timeZone={timeZone}
						onChange={setView}
					/>
				) : (
					view.settings && <Where view={view} />
				)}
				<YourEmail board={board} view={view} api={api} onChange={setView} />
				{view.runs.length > 0 && <Runs runs={view.runs} now={now} />}
				<div className="new-board-actions-end digest-done">
					<button type="button" className="new-board-cancel" onClick={onClose}>
						Done
					</button>
				</div>
			</div>
			<Preview view={view} />
		</div>
	);
}

/** Where it goes, for people who can't change it. */
function Where({ view }: { view: DigestView }) {
	const { settings } = view;
	if (!settings) return null;
	return (
		<ul className="digest-where">
			{settings.discussion && (
				<li>
					<DiscussionIcon />
					<span>
						Posted in <strong>{short(settings.discussion.repo)}</strong>’s{" "}
						{settings.discussion.category} Discussions
					</span>
				</li>
			)}
			{settings.email && (
				<li>
					<MailIcon />
					<span>Emailed to people who ask for it</span>
				</li>
			)}
			<li>
				<ClockIcon />
				<span>{describeSchedule(settings)}</span>
			</li>
		</ul>
	);
}

function OwnerSettings({
	board,
	view,
	api,
	timeZone,
	onChange,
}: {
	board: Board;
	view: DigestView;
	api: DigestApi;
	timeZone: string;
	onChange: (view: DigestView) => void;
}) {
	const settings = view.settings;
	const [discussionOn, setDiscussionOn] = useState(Boolean(settings?.discussion));
	const [repo, setRepo] = useState(settings?.discussion ? short(settings.discussion.repo) : "");
	const [category, setCategory] = useState(settings?.discussion?.category ?? "");
	const [categories, setCategories] = useState<string[] | null>(null);
	const [email, setEmail] = useState(
		settings ? settings.email : view.emailAvailable && DEFAULT_DIGEST.email,
	);
	const [weekday, setWeekday] = useState<Weekday>(settings?.weekday ?? DEFAULT_DIGEST.weekday);
	const [hour, setHour] = useState(settings?.hour ?? DEFAULT_DIGEST.hour);
	const [busy, setBusy] = useState<"save" | "off" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(0);
	const repoId = useId();
	const categoryId = useId();
	const hourId = useId();
	const zone = settings?.timeZone ?? timeZone;
	const repoKey = discussionRepoKey(repo);

	// The repository's Discussion categories, once it looks like one.
	useEffect(() => {
		if (!discussionOn || !repoKey) {
			setCategories(null);
			return;
		}
		const controller = new AbortController();
		const timer = setTimeout(() => {
			repoApi
				.meta(repoKey, controller.signal)
				.then((meta) => {
					setCategories(meta.discussionCategories);
					setCategory((current) =>
						current && meta.discussionCategories.includes(current)
							? current
							: (meta.discussionCategories.find((c) => /announce/i.test(c)) ??
								meta.discussionCategories[0] ??
								""),
					);
				})
				.catch(() => setCategories(null));
		}, 300);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [discussionOn, repoKey]);

	const next: DigestSettings = {
		discussion: discussionOn && repoKey ? { repo: repoKey, category: category.trim() } : null,
		email,
		weekday,
		hour,
		timeZone: zone,
	};
	const somewhere = Boolean(next.discussion?.category) || next.email;
	const incomplete = discussionOn && (!repoKey || !category.trim());
	const changed = !settings || JSON.stringify(next) !== JSON.stringify(settings);
	const exposed = view.repoPublic === true && board.visibility !== "public" && settings?.discussion;
	const suggestions = recentRepos()
		.map(short)
		.filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r) && r !== repo)
		.slice(0, 4);

	const apply = async (result: Promise<DigestResult>, kind: typeof busy) => {
		setBusy(kind);
		setError(null);
		const answer = await result;
		setBusy(null);
		if (!answer.ok) {
			setError(answer.message ?? describeDigestError(answer.error, repo || undefined));
			return;
		}
		onChange(answer.value);
		if (kind === "save") setSaved((n) => n + 1);
		if (kind === "off") {
			setDiscussionOn(false);
			setEmail(answer.value.emailAvailable);
		}
	};

	return (
		<form
			className="digest-settings"
			onSubmit={(event) => {
				event.preventDefault();
				if (!somewhere || incomplete || !changed || busy) return;
				void apply(api.set(board.id, next), "save");
			}}
		>
			<div className="digest-channel" data-on={discussionOn || undefined}>
				<label className="digest-toggle">
					<DiscussionIcon />
					<span>
						<strong>Post a GitHub Discussion</strong>
						<span>As the Tack app, in a repository where it’s installed and you can write.</span>
					</span>
					<span className="digest-switch">
						<input
							type="checkbox"
							role="switch"
							aria-label="Post a GitHub Discussion"
							checked={discussionOn}
							onChange={(event) => setDiscussionOn(event.target.checked)}
						/>
						<span />
					</span>
				</label>
				{discussionOn && (
					<div className="digest-channel-body">
						<div className="backup-fields">
							<label className="new-board-field" htmlFor={repoId}>
								<span>Repository</span>
								<input
									id={repoId}
									value={repo}
									placeholder="owner/name"
									autoComplete="off"
									spellCheck={false}
									onChange={(event) => setRepo(event.target.value)}
								/>
							</label>
							<label className="new-board-field" htmlFor={categoryId}>
								<span>Category</span>
								{categories && categories.length > 0 ? (
									<select
										id={categoryId}
										value={category}
										onChange={(event) => setCategory(event.target.value)}
									>
										{categories.map((name) => (
											<option key={name} value={name}>
												{name}
											</option>
										))}
									</select>
								) : (
									<input
										id={categoryId}
										value={category}
										placeholder="Announcements"
										autoComplete="off"
										onChange={(event) => setCategory(event.target.value)}
									/>
								)}
							</label>
						</div>
						{categories?.length === 0 && (
							<p className="new-board-hint">Discussions are turned off in {repo}.</p>
						)}
						{!settings?.discussion && !repo && suggestions.length > 0 && (
							<span className="repo-suggestions">
								{suggestions.map((suggestion) => (
									<button
										key={suggestion}
										type="button"
										className="repo-suggestion"
										onClick={() => setRepo(suggestion)}
									>
										{suggestion}
									</button>
								))}
							</span>
						)}
						{exposed && (
							<p className="digest-note" data-tone="warning">
								{short(settings.discussion?.repo ?? "")} is public, so anyone can read these
								digests, though the board itself isn’t. Cards from repositories that aren’t public
								are left out.
							</p>
						)}
					</div>
				)}
			</div>

			<div className="digest-channel" data-on={email || undefined}>
				<label className="digest-toggle" data-disabled={!view.emailAvailable || undefined}>
					<MailIcon />
					<span>
						<strong>Email people who ask for it</strong>
						<span>
							{view.emailAvailable
								? "Each gets only what they can read, and can stop with one click."
								: "This Tack can’t send email yet: its owner needs to set it up."}
						</span>
					</span>
					<span className="digest-switch">
						<input
							type="checkbox"
							role="switch"
							aria-label="Email people who ask for it"
							checked={email}
							disabled={!view.emailAvailable}
							onChange={(event) => setEmail(event.target.checked)}
						/>
						<span />
					</span>
				</label>
				{settings?.email && view.subscribers !== null && (
					<p className="digest-channel-body digest-muted">
						{view.subscribers === 0
							? "Nobody’s asked for it yet."
							: `${view.subscribers} ${view.subscribers === 1 ? "person gets" : "people get"} it.`}
					</p>
				)}
			</div>

			<Segmented
				label="Day"
				value={String(weekday)}
				options={DAYS.map((day) => ({
					value: String(day),
					label: WEEKDAY_NAMES[day].slice(0, 3),
				}))}
				onChange={(value) => setWeekday(Number(value) as Weekday)}
			/>
			<div className="export-row">
				<label className="export-row-label" htmlFor={hourId}>
					Time
				</label>
				<div className="digest-time">
					<select
						id={hourId}
						value={hour}
						onChange={(event) => setHour(Number(event.target.value))}
					>
						{HOURS.map((h) => (
							<option key={h} value={h}>
								{`${h}:00`}
							</option>
						))}
					</select>
					<span className="digest-muted">{zone.replace(/_/g, " ")}</span>
				</div>
			</div>

			{error && (
				<p className="new-board-error" role="alert">
					{error}
				</p>
			)}
			<div className="digest-owner-actions">
				{settings && (
					<button
						type="button"
						className="backup-off"
						disabled={busy !== null}
						onClick={() => void apply(api.off(board.id), "off")}
					>
						{busy === "off" ? "Turning off…" : "Turn off digests"}
					</button>
				)}
				{(changed || busy === "save") && (
					<button
						type="submit"
						className="primary new-board-create"
						disabled={!somewhere || incomplete || busy !== null}
						aria-busy={busy === "save"}
					>
						{busy === "save" ? (
							<>
								<span className="new-board-spinner" aria-hidden="true" />
								Checking…
							</>
						) : settings ? (
							"Save changes"
						) : (
							"Turn on digests"
						)}
					</button>
				)}
				{!changed && saved > 0 && busy === null && (
					<span key={saved} className="digest-saved" role="status">
						<CheckIcon /> Saved
					</span>
				)}
			</div>
		</form>
	);
}

/** Your own email: ask, confirm, stop. */
function YourEmail({
	board,
	view,
	api,
	onChange,
}: {
	board: Board;
	view: DigestView;
	api: DigestApi;
	onChange: (view: DigestView) => void;
}) {
	const [address, setAddress] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [changing, setChanging] = useState(false);
	const inputId = useId();
	const offered = view.settings?.email && view.emailAvailable;
	const subscription = view.subscription;
	if (!offered && !subscription) return null;

	const run = async (result: Promise<DigestResult>) => {
		setBusy(true);
		setError(null);
		const answer = await result;
		setBusy(false);
		if (!answer.ok) {
			setError(answer.message ?? describeDigestError(answer.error));
			return;
		}
		setChanging(false);
		setAddress("");
		onChange(answer.value);
	};
	const schedule = view.settings ? describeSchedule(view.settings) : "";

	if (subscription && !changing) {
		return (
			<section
				className="digest-you"
				data-state={subscription.confirmed ? "on" : "pending"}
				aria-live="polite"
			>
				<MailIcon />
				<div>
					{subscription.confirmed ? (
						<p>
							You get it at <strong>{maskEmail(subscription.email)}</strong>, {schedule}.
						</p>
					) : (
						<p>
							Check <strong>{maskEmail(subscription.email)}</strong> for a link to confirm.
							Nothing’s sent until you follow it.
						</p>
					)}
					{error && (
						<p className="new-board-error" role="alert">
							{error}
						</p>
					)}
					<div className="digest-you-actions">
						{!subscription.confirmed && offered && (
							<button
								type="button"
								disabled={busy}
								onClick={() => void run(api.subscribe(board.id, { email: subscription.email }))}
							>
								Send it again
							</button>
						)}
						{offered && (
							<button type="button" disabled={busy} onClick={() => setChanging(true)}>
								Use another address
							</button>
						)}
						<button
							type="button"
							className="digest-stop"
							disabled={busy}
							onClick={() => void run(api.unsubscribe(board.id))}
						>
							{subscription.confirmed ? "Stop emailing me" : "Cancel"}
						</button>
					</div>
				</div>
			</section>
		);
	}

	const valid = validEmail(address.trim());
	return (
		<form
			className="digest-you"
			data-state="off"
			onSubmit={(event) => {
				event.preventDefault();
				if (!valid || busy) return;
				void run(api.subscribe(board.id, { email: address.trim() }));
			}}
		>
			<MailIcon />
			<div>
				<label htmlFor={inputId}>
					<strong>Email it to me</strong>
					<span className="digest-muted"> {schedule}</span>
				</label>
				<div className="digest-you-field">
					<input
						id={inputId}
						type="email"
						value={address}
						placeholder="you@example.com"
						autoComplete="email"
						onChange={(event) => setAddress(event.target.value)}
					/>
					<button type="submit" className="export-copy" disabled={!valid || busy} aria-busy={busy}>
						{busy ? "Sending…" : "Send a link"}
					</button>
				</div>
				{error && (
					<p className="new-board-error" role="alert">
						{error}
					</p>
				)}
				{changing && (
					<button type="button" className="digest-link" onClick={() => setChanging(false)}>
						Keep {maskEmail(subscription?.email ?? "")}
					</button>
				)}
			</div>
		</form>
	);
}

function Runs({ runs, now }: { runs: DigestRun[]; now: number }) {
	return (
		<section className="digest-runs" aria-label="Recent digests">
			<h3>Recent digests</h3>
			<ul>
				{runs.slice(0, 4).map((run) => (
					<li key={`${run.week}${run.channel}`} data-status={run.status}>
						<span className="backup-dot" aria-hidden="true" />
						<span>
							{run.channel === "discussion" ? (
								run.status === "sent" ? (
									<>
										Posted{" "}
										{run.url ? (
											<a href={safeUrl(run.url)} target="_blank" rel="noreferrer">
												the Discussion
											</a>
										) : (
											"the Discussion"
										)}
									</>
								) : run.status === "quiet" ? (
									"A quiet week: no Discussion"
								) : (
									<>Couldn’t post the Discussion: {run.error}</>
								)
							) : run.status === "quiet" ? (
								"A quiet week: no emails"
							) : (
								<>
									Emailed {run.sent ?? 0} {run.sent === 1 ? "person" : "people"}
									{run.failed ? (
										<span className="digest-late">
											{" "}
											· {run.failed} didn’t go{run.error ? `: ${run.error}` : ""}
										</span>
									) : null}
								</>
							)}
							<span className="digest-muted"> · {relativeTime(run.at, now)}</span>
						</span>
					</li>
				))}
			</ul>
		</section>
	);
}

function Preview({ view }: { view: DigestView }) {
	const [tab, setTab] = useState<"email" | "discussion">("email");
	const { preview } = view;
	const hasDiscussion = preview.discussion !== null && preview.markdown !== null;
	const shown = tab === "discussion" && hasDiscussion ? "discussion" : "email";
	return (
		<div className="digest-preview" aria-label="The next digest so far">
			<div className="digest-preview-head">
				<span>So far this week</span>
				{hasDiscussion && (
					<Segmented
						label="Preview"
						value={shown}
						options={[
							{ value: "email", label: "Your email" },
							{ value: "discussion", label: "Discussion" },
						]}
						onChange={setTab}
					/>
				)}
			</div>
			<div className="digest-preview-body" key={shown}>
				{shown === "discussion" && preview.markdown ? (
					<div className="digest-paper digest-markdown">
						<p className="digest-paper-brand">💬 Discussion · {preview.discussion?.board.title}</p>
						<Markdown source={preview.markdown} />
					</div>
				) : (
					<DigestPreview digest={preview.email} label="Your email, so far" />
				)}
			</div>
		</div>
	);
}

function DiscussionIcon() {
	return (
		<svg className="digest-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<path d="M2.5 3.5h8v5.5h-4l-2.5 2v-2h-1.5Z" />
			<path d="M10.5 6h3v5.5H12v1.8L9.8 11.5H7" />
		</svg>
	);
}

function MailIcon() {
	return (
		<svg className="digest-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<rect x="2" y="3.5" width="12" height="9" rx="1.5" />
			<path d="m2.5 4.5 5.5 4.5 5.5-4.5" />
		</svg>
	);
}

function ClockIcon() {
	return (
		<svg className="digest-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<circle cx="8" cy="8" r="6" />
			<path d="M8 4.5V8l2.5 1.5" />
		</svg>
	);
}

function CheckIcon() {
	return (
		<svg className="digest-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
			<path d="m3.5 8.5 3 3 6-7" />
		</svg>
	);
}
