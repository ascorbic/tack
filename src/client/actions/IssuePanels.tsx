import { type ReactNode, useMemo, useState } from "react";
import { type ChildInput, canWrite, issueFromText } from "../../shared/actions.ts";
import type { OperationKind } from "../../shared/changes.ts";
import { installUrl } from "../CardView.tsx";
import { IssueIcon, PullIcon } from "./icons.tsx";
import { type RepoOption, RepoName, RepoPicker } from "./pickers.tsx";
import { Notice, PopoverHead } from "./Popover.tsx";
import { useRepoMeta } from "./services.ts";

// Panels for making issues: stickies into issues, and a parent issue with
// sub-issues from a section or a selection.

/** Whether Tack can write `kind` to a repository, and what to say if it can't. */
export function useRepoAccess(repo: string | null, kind: OperationKind) {
	const state = useRepoMeta(repo);
	let notice: ReactNode = null;
	let blocked = false;
	if (repo && state.status === "loading") {
		notice = (
			<Notice>
				Checking <RepoName repo={repo} />…
			</Notice>
		);
	} else if (repo && state.status === "ready" && !state.meta.writable) {
		blocked = true;
		notice = (
			<Notice tone="warn">
				Tack can’t write to <RepoName repo={repo} /> yet.{" "}
				<a href={installUrl()} className="action-link">
					Install the app
				</a>
			</Notice>
		);
	} else if (repo && state.status === "ready" && !canWrite(state.meta, kind)) {
		blocked = true;
		notice = <Notice tone="warn">This forge doesn’t support that from Tack.</Notice>;
	}
	return { blocked, notice, meta: state.meta };
}

function StageButton({ disabled, children }: { disabled?: boolean; children: ReactNode }) {
	return (
		<button type="submit" className="action-primary" disabled={disabled}>
			{children}
			<kbd>↵</kbd>
		</button>
	);
}

function Footnote() {
	return <span className="action-summary">Not written until pushed.</span>;
}

export interface StickyPreview {
	id: string;
	text: string;
	color?: string;
}

/** Stickies into issues: pick a repository, check the titles, stage. */
export function MakeIssuesPanel({
	stickies,
	staged,
	repos,
	host,
	initialRepo,
	onStage,
}: {
	stickies: StickyPreview[];
	/** Stickies already staged as issues, left out. */
	staged: ReadonlySet<string>;
	repos: RepoOption[];
	host: string;
	initialRepo: string | null;
	onStage: (repo: string) => void;
}) {
	const [repo, setRepo] = useState(initialRepo);
	const access = useRepoAccess(repo, "issue.create");
	const issues = useMemo(
		() =>
			stickies.flatMap((sticky) => {
				if (staged.has(sticky.id)) return [];
				const issue = issueFromText(sticky.text);
				return issue ? [{ ...issue, id: sticky.id, color: sticky.color }] : [];
			}),
		[stickies, staged],
	);
	const empty = stickies.filter((s) => !staged.has(s.id) && !issueFromText(s.text)).length;
	const already = stickies.filter((s) => staged.has(s.id)).length;
	const n = issues.length;
	const shown = issues.slice(0, 4);

	return (
		<form
			className="issue-panel"
			onSubmit={(event) => {
				event.preventDefault();
				if (repo && n > 0 && !access.blocked) onStage(repo);
			}}
		>
			<PopoverHead
				title={n === 1 ? "Make an issue" : `Make ${n} issues`}
				detail="The first line is the title. Each sticky becomes its issue’s card once it’s made."
			/>
			<RepoPicker value={repo} onChange={setRepo} options={repos} host={host} />
			{access.notice}
			{n > 0 && (
				<ol className="issue-preview" aria-label="Issues to make">
					{shown.map((issue) => (
						<li key={issue.id}>
							<span className="issue-preview-dot" data-color={issue.color ?? "yellow"} />
							<span className="issue-preview-title">{issue.title}</span>
							{issue.body && <span className="issue-preview-body">+ description</span>}
						</li>
					))}
					{n > shown.length && <li className="issue-preview-more">and {n - shown.length} more</li>}
				</ol>
			)}
			{(empty > 0 || already > 0) && (
				<Notice>
					{[
						already > 0 && `${already} already staged`,
						empty > 0 && `${empty} empty ${empty === 1 ? "sticky" : "stickies"}`,
					]
						.filter(Boolean)
						.join(", ")}{" "}
					left out.
				</Notice>
			)}
			<footer className="action-foot">
				<Footnote />
				<StageButton disabled={!repo || n === 0 || access.blocked}>
					{n === 1 ? "Stage issue" : `Stage ${n} issues`}
				</StageButton>
			</footer>
		</form>
	);
}

export interface ChildPreview {
	input: ChildInput;
	/** `#412 Drop Node 18`, or a sticky's first line. */
	label: string;
	ref?: string;
	color?: string;
}

/** A parent issue with sub-issues: a title, a repository, and what goes under it. */
export function ParentIssuePanel({
	title: initialTitle,
	from,
	items,
	repos,
	host,
	initialRepo,
	onStage,
}: {
	title: string;
	/** Where it comes from: "this section" or "the selection". */
	from: string;
	items: ChildPreview[];
	repos: RepoOption[];
	host: string;
	initialRepo: string | null;
	onStage: (repo: string, title: string) => void;
}) {
	const [title, setTitle] = useState(initialTitle);
	const [repo, setRepo] = useState(initialRepo);
	const access = useRepoAccess(repo, "item.subIssue");
	const children = items.filter(
		(item) => !("card" in item.input) || item.input.card.kind === "issue",
	);
	const pulls = items.length - children.length;
	const ready = !!repo && title.trim() !== "" && !access.blocked;

	return (
		<form
			className="issue-panel"
			onSubmit={(event) => {
				event.preventDefault();
				if (ready && repo) onStage(repo, title);
			}}
		>
			<PopoverHead
				title="Parent issue with sub-issues"
				detail={`Everything in ${from} goes under one new issue.`}
			/>
			<label className="action-field">
				<span>Title</span>
				<input
					data-autofocus
					type="text"
					value={title}
					maxLength={256}
					placeholder="What ties these together?"
					onChange={(event) => setTitle(event.target.value)}
				/>
			</label>
			<RepoPicker value={repo} onChange={setRepo} options={repos} host={host} />
			{access.notice}
			<ol className="issue-preview tree" aria-label="Sub-issues">
				{children.slice(0, 5).map((item) => (
					<li key={item.input.shape}>
						{"card" in item.input ? (
							<IssueIcon />
						) : (
							<span className="issue-preview-dot" data-color={item.color ?? "yellow"} />
						)}
						{item.ref && <span className="mono issue-preview-ref">{item.ref}</span>}
						<span className="issue-preview-title">{item.label}</span>
						{!("card" in item.input) && <span className="issue-preview-body">new</span>}
					</li>
				))}
				{children.length > 5 && (
					<li className="issue-preview-more">and {children.length - 5} more</li>
				)}
				{children.length === 0 && <li className="issue-preview-more">No sub-issues yet</li>}
			</ol>
			{pulls > 0 && (
				<Notice icon={<PullIcon />}>
					{pulls === 1 ? "A pull request is" : `${pulls} pull requests are`} left out: only issues
					can be sub-issues.
				</Notice>
			)}
			<footer className="action-foot">
				<Footnote />
				<StageButton disabled={!ready}>
					{children.length > 0
						? `Stage with ${children.length} sub-issue${children.length === 1 ? "" : "s"}`
						: "Stage"}
				</StageButton>
			</footer>
		</form>
	);
}
