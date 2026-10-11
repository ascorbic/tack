import { useEffect, useId, useState } from "react";
import {
	BACKUP_INTERVALS,
	type BackupInterval,
	DEFAULT_BACKUP_BRANCH,
	backupRepoKey,
	describeBackupError,
	validBranchName,
} from "../../shared/backups.ts";
import type { BoardInfo } from "../../shared/boards.ts";
import { recentRepos } from "../actions/services.ts";
import { relativeTime } from "../boards/api.ts";
import { Modal } from "../boards/Modal.tsx";
import { type BackupResult, type BackupView, backupApi } from "./api.ts";
import { Segmented } from "./ExportDialog.tsx";
import "../boards/templates.css";
import "./export.css";
import { safeUrl } from "../changes/inline.ts";

// Backups to a branch (#59), from the board's menu, for its owner: where
// the board's JSON goes, how often, how the last backup went, and what it
// means, in plain words, before anything's turned on.

type Api = typeof backupApi;

export function BackupDialog({
	board,
	open,
	onClose,
}: {
	board: Pick<BoardInfo, "id" | "title" | "visibility">;
	open: boolean;
	onClose: () => void;
}) {
	const headingId = useId();
	return (
		<Modal open={open} onClose={onClose} className="backup-dialog" labelledBy={headingId}>
			{(close) => <BackupPanel board={board} headingId={headingId} onClose={close} />}
		</Modal>
	);
}

const short = (repo: string) => repo.replace(/^github\.com\//, "");

export function BackupPanel({
	board,
	headingId,
	onClose,
	api = backupApi,
	initial,
	now = Date.now(),
}: {
	board: Pick<BoardInfo, "id" | "title" | "visibility">;
	headingId?: string;
	onClose: () => void;
	/** Where backups are set; the gallery passes its own. */
	api?: Api;
	initial?: BackupView;
	now?: number;
}) {
	const [status, setStatus] = useState<BackupView | null>(initial ?? null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [repo, setRepo] = useState(initial?.settings ? short(initial.settings.repo) : "");
	const [branch, setBranch] = useState(initial?.settings?.branch ?? DEFAULT_BACKUP_BRANCH);
	const [every, setEvery] = useState<BackupInterval>(initial?.settings?.every ?? "day");
	const [busy, setBusy] = useState<"save" | "now" | "off" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const repoId = useId();
	const branchId = useId();

	useEffect(() => {
		if (initial) return;
		let cancelled = false;
		void api.get(board.id).then((result) => {
			if (cancelled) return;
			if (!result.ok) {
				setLoadError(describeBackupError(result.error));
				return;
			}
			setStatus(result.value);
			if (result.value.settings) {
				setRepo(short(result.value.settings.repo));
				setBranch(result.value.settings.branch);
				setEvery(result.value.settings.every);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [api, board.id, initial]);

	const settings = status?.settings ?? null;
	const repoKey = backupRepoKey(repo);
	const branchOk = validBranchName(branch.trim());
	const changed =
		!settings ||
		settings.repo !== repoKey ||
		settings.branch !== branch.trim() ||
		settings.every !== every;
	const suggestions = recentRepos()
		.map(short)
		.filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r) && r !== repo)
		.slice(0, 4);

	const apply = async (result: Promise<BackupResult>, kind: typeof busy, ask = repo) => {
		setBusy(kind);
		setError(null);
		const answer = await result;
		setBusy(null);
		if (!answer.ok) {
			setError(answer.message ?? describeBackupError(answer.error, ask));
			return;
		}
		setStatus(answer.value);
	};

	if (!status) {
		return (
			<div className="backup">
				<h2 id={headingId}>Back up to GitHub</h2>
				<div className="backup-status" data-tone={loadError ? "error" : "busy"}>
					<span className="backup-dot" aria-hidden="true" />
					<p>{loadError ?? "Checking this board’s backups…"}</p>
				</div>
				<div className="new-board-actions-end">
					<button type="button" className="new-board-cancel" onClick={onClose}>
						Close
					</button>
				</div>
			</div>
		);
	}

	const editable = status.canManage;
	return (
		<form
			className="backup"
			onSubmit={(event) => {
				event.preventDefault();
				if (!repoKey || !branchOk || !changed || busy) return;
				void apply(api.set(board.id, { repo: repoKey, branch: branch.trim(), every }), "save");
			}}
		>
			<h2 id={headingId}>Back up to GitHub</h2>
			<ul className="backup-explain">
				<li>
					<BranchIcon />
					<span>
						Tack commits this board’s JSON to a branch of its own, made just for backups, so the
						branch’s history is the board’s. It’s the same file Export makes, and imports into a new
						board.
					</span>
				</li>
				<li>
					<ClockIcon />
					<span>
						It writes when something’s changed, at most as often as you choose, as the Tack app.
					</span>
				</li>
				<li>
					<KeyIcon />
					<span>
						Only for a repository where the Tack app is installed and you can write. It checks again
						every time, and stops (and says why) if that changes.
					</span>
				</li>
				<li>
					<EyeIcon />
					<span>
						Anyone who can read the repository can read the backups: stickies, text and decisions
						included. Cards from repositories that aren’t public are left out.
					</span>
				</li>
			</ul>

			{settings && <BackupState status={status} board={board} now={now} />}

			{editable ? (
				<>
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
						<label className="new-board-field" htmlFor={branchId}>
							<span>Branch</span>
							<input
								id={branchId}
								value={branch}
								autoComplete="off"
								spellCheck={false}
								onChange={(event) => setBranch(event.target.value)}
							/>
						</label>
					</div>
					{!settings && suggestions.length > 0 && (
						<span className="new-board-hint">
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
						</span>
					)}
					<Segmented
						label="How often"
						value={every}
						options={(Object.keys(BACKUP_INTERVALS) as BackupInterval[]).map((value) => ({
							value,
							label: BACKUP_INTERVALS[value].label,
						}))}
						onChange={setEvery}
					/>
				</>
			) : (
				<p className="backup-muted">Only the board’s owner can change its backups.</p>
			)}

			{error && (
				<p className="new-board-error" role="alert">
					{error}
				</p>
			)}
			<div className="new-board-actions-end export-actions">
				{editable && settings && (
					<button
						type="button"
						className="backup-off"
						disabled={busy !== null}
						onClick={() => void apply(api.off(board.id), "off")}
					>
						{busy === "off" ? "Turning off…" : "Turn off backups"}
					</button>
				)}
				<button type="button" className="new-board-cancel" onClick={onClose}>
					{settings ? "Done" : "Cancel"}
				</button>
				{editable && settings && !changed && (
					<button
						type="button"
						className="export-copy"
						disabled={busy !== null}
						aria-busy={busy === "now"}
						onClick={() => void apply(api.now(board.id), "now")}
					>
						{busy === "now" ? "Backing up…" : "Back up now"}
					</button>
				)}
				{editable && (!settings || changed) && (
					<button
						type="submit"
						className="primary new-board-create"
						disabled={!repoKey || !branchOk || busy !== null}
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
							"Turn on backups"
						)}
					</button>
				)}
			</div>
		</form>
	);
}

/** How the last backup went, and what to know about where they go. */
function BackupState({
	status,
	board,
	now,
}: {
	status: BackupView;
	board: Pick<BoardInfo, "visibility">;
	now: number;
}) {
	const { settings } = status;
	if (!settings) return null;
	const where = (
		<>
			<strong>{short(settings.repo)}</strong>, on <code>{settings.branch}</code>
		</>
	);
	const exposed = status.repoPublic === true && board.visibility !== "public";
	return (
		<>
			{status.error ? (
				<div className="backup-status" data-tone="error" role="status">
					<span className="backup-dot" aria-hidden="true" />
					<p>
						The last backup to {where} didn’t work
						{status.errorAt ? ` (${relativeTime(Date.parse(status.errorAt), now)})` : ""}:{" "}
						{status.error}
						{status.lastAt && (
							<span className="backup-muted">
								{" "}
								The last one that did was {relativeTime(Date.parse(status.lastAt), now)}.
							</span>
						)}
					</p>
				</div>
			) : (
				<div className="backup-status" role="status">
					<span className="backup-dot" aria-hidden="true" />
					<p>
						{status.lastAt ? (
							<>
								Backed up {relativeTime(Date.parse(status.lastAt), now)} to {where}.{" "}
								{status.lastUrl && (
									<a href={safeUrl(status.lastUrl)} target="_blank" rel="noreferrer">
										See the commit
									</a>
								)}
							</>
						) : (
							<>Backups go to {where}.</>
						)}
						{status.omitted && status.omitted.cards > 0 && (
							<span className="backup-muted">
								{" "}
								{status.omitted.cards === 1
									? "1 card from a repository that isn’t public was left out."
									: `${status.omitted.cards} cards from repositories that aren’t public were left out.`}
							</span>
						)}
					</p>
				</div>
			)}
			{exposed && (
				<div className="backup-status" data-tone="warning">
					<span className="backup-dot" aria-hidden="true" />
					<p>
						{short(settings.repo)} is public, so anyone can read these backups, though the board
						itself isn’t.
					</p>
				</div>
			)}
		</>
	);
}

function BranchIcon() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<circle cx="4.5" cy="3.5" r="1.5" />
			<circle cx="4.5" cy="12.5" r="1.5" />
			<circle cx="11.5" cy="5.5" r="1.5" />
			<path d="M4.5 5v6M11.5 7c0 3-7 2-7 4" />
		</svg>
	);
}

function ClockIcon() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<circle cx="8" cy="8" r="6" />
			<path d="M8 4.5V8l2.5 1.5" />
		</svg>
	);
}

function KeyIcon() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<circle cx="5.5" cy="10.5" r="3" />
			<path d="m7.7 8.3 5.8-5.8M11.5 4.5l1.5 1.5" />
		</svg>
	);
}

function EyeIcon() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
			<circle cx="8" cy="8" r="2" />
		</svg>
	);
}
