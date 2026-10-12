import { type ReactNode, useMemo, useState } from "react";
import {
	type ChildInput,
	type IssueExtras,
	type ParentMode,
	type Presence,
	canWrite,
	issueFromText,
} from "../../shared/actions.ts";
import type { OperationKind } from "../../shared/changes.ts";
import type { RepoMeta } from "../../shared/push.ts";
import { installUrl } from "../CardView.tsx";
import { IssueIcon, LabelIcon, MilestoneIcon, ParentIcon, PersonIcon, PullIcon } from "./icons.tsx";
import {
	LabelOption,
	MilestonePicker,
	PersonOption,
	type RepoOption,
	RepoName,
	RepoPicker,
	SetList,
	avatarFor,
} from "./pickers.tsx";
import { Notice, PopoverHead, SUBMIT_HINT } from "./Popover.tsx";
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
			<kbd>{SUBMIT_HINT}</kbd>
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

type Extra = "labels" | "milestone" | "assignees";

const ticked = (names: readonly string[]) =>
	new Map(names.map((name): [string, Presence] => [name, "all"]));

const toggled = (names: readonly string[], name: string) =>
	names.includes(name) ? names.filter((n) => n !== name) : [...names, name];

/**
 * What new issues start with: labels, a milestone and assignees, written
 * with the create itself. Each is a pill that opens its picker in place, and
 * shows what's picked once it closes. Only what the repository has is offered.
 */
export function IssueExtrasPicker({
	repo,
	meta,
	value,
	onChange,
	initialOpen = null,
}: {
	repo: string;
	meta: RepoMeta;
	value: IssueExtras;
	onChange: (value: IssueExtras) => void;
	initialOpen?: Extra | null;
}) {
	const [open, setOpen] = useState<Extra | null>(initialOpen);
	const labels = value.labels ?? [];
	const assignees = value.assignees ?? [];
	// Where the forge can set them at all, and the repository has some.
	const offered: Extra[] = [
		...(meta.labels.length > 0 && canWrite(meta, "item.labels") ? ["labels" as const] : []),
		...(meta.milestones.length > 0 && canWrite(meta, "item.milestone")
			? ["milestone" as const]
			: []),
		...(meta.assignees.length > 0 && canWrite(meta, "item.assignees")
			? ["assignees" as const]
			: []),
	];
	if (offered.length === 0) return null;
	const color = (name: string) => meta.labels.find((l) => l.name === name)?.color ?? "8a8f98";
	const pill = (extra: Extra, icon: ReactNode, label: string, chosen: ReactNode) => (
		<button
			type="button"
			className="issue-extra"
			aria-expanded={open === extra}
			aria-label={label}
			data-chosen={chosen ? true : undefined}
			onClick={() => setOpen((current) => (current === extra ? null : extra))}
		>
			{icon}
			{chosen ? chosen : <span className="issue-extra-name">{label}</span>}
			<span className="issue-extra-caret" aria-hidden="true" />
		</button>
	);
	return (
		<div className="issue-extras" role="group" aria-label="Start with">
			<div className="issue-extras-row">
				{offered.includes("labels") &&
					pill(
						"labels",
						<LabelIcon />,
						"Labels",
						labels.length > 0 && (
							<span className="issue-extra-chips">
								{labels.slice(0, 2).map((name) => (
									<span
										key={name}
										className="chip label"
										style={{ "--label": `#${color(name)}` } as React.CSSProperties}
									>
										{name}
									</span>
								))}
								{labels.length > 2 && (
									<span className="issue-extra-more">+{labels.length - 2}</span>
								)}
							</span>
						),
					)}
				{offered.includes("milestone") &&
					pill(
						"milestone",
						<MilestoneIcon />,
						"Milestone",
						value.milestone && <span className="issue-extra-name">{value.milestone}</span>,
					)}
				{offered.includes("assignees") &&
					pill(
						"assignees",
						<PersonIcon />,
						"Assignees",
						assignees.length > 0 && (
							<span className="issue-extra-name">
								{assignees.length === 1 ? `@${assignees[0]}` : `${assignees.length} people`}
							</span>
						),
					)}
			</div>
			{open && (
				<div className="issue-extra-picker" key={open}>
					{open === "labels" && (
						<SetList
							noun="label"
							options={meta.labels}
							chosen={ticked(labels)}
							onToggle={(name) => onChange({ ...value, labels: toggled(labels, name) })}
							placeholder="Filter labels"
							empty="This repository has no labels"
							render={(option) => <LabelOption option={option} />}
							autoFocus
						/>
					)}
					{open === "milestone" && (
						<MilestonePicker
							milestones={meta.milestones}
							chosen={value.milestone ?? null}
							onPick={(milestone) => {
								onChange({ ...value, milestone });
								setOpen(null);
							}}
							autoFocus
						/>
					)}
					{open === "assignees" && (
						<SetList
							noun="assignee"
							options={meta.assignees.map((login) => ({
								name: login,
								avatar: avatarFor(repo, login),
							}))}
							chosen={ticked(assignees)}
							onToggle={(name) => onChange({ ...value, assignees: toggled(assignees, name) })}
							placeholder="Filter people"
							empty="Nobody can be assigned here"
							render={(option) => <PersonOption option={option} />}
							autoFocus
						/>
					)}
				</div>
			)}
		</div>
	);
}

/** Stickies into issues: pick a repository, check the titles, maybe labels, stage. */
export function MakeIssuesPanel({
	stickies,
	staged,
	repos,
	host,
	initialRepo,
	initialExtras = {},
	initialExtra = null,
	onStage,
	onTitle,
}: {
	stickies: StickyPreview[];
	/** Stickies already staged as issues, left out. */
	staged: ReadonlySet<string>;
	repos: RepoOption[];
	host: string;
	initialRepo: string | null;
	/** For the gallery: what's picked, and which picker is open. */
	initialExtras?: IssueExtras;
	initialExtra?: Extra | null;
	onStage: (repo: string, extras: IssueExtras) => void;
	/** Reword a sticky's title, writing it back to the sticky. */
	onTitle?: (sticky: string, title: string) => void;
}) {
	const [repo, setRepoState] = useState(initialRepo);
	const [all, setAll] = useState(false);
	const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
	const [extras, setExtras] = useState<IssueExtras>(initialExtras);
	// Labels and people are the repository's own: a new one starts afresh.
	const setRepo = (next: string) => {
		if (next !== repo) setExtras({});
		setRepoState(next);
	};
	const access = useRepoAccess(repo, "issue.create");
	const meta = access.meta?.writable ? access.meta : null;
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
	const shown = all ? issues : issues.slice(0, 4);

	return (
		<form
			className="issue-panel"
			onSubmit={(event) => {
				event.preventDefault();
				if (repo && n > 0 && !access.blocked) onStage(repo, extras);
			}}
		>
			<PopoverHead
				title={n === 1 ? "Make an issue" : `Make ${n} issues`}
				detail="The first line is the title. Each sticky becomes its issue’s card once it’s made."
			/>
			<RepoPicker value={repo} onChange={setRepo} options={repos} host={host} />
			{access.notice}
			{repo && meta && !access.blocked && (
				<IssueExtrasPicker
					key={repo}
					repo={repo}
					meta={meta}
					value={extras}
					onChange={setExtras}
					initialOpen={initialExtra}
				/>
			)}
			{n > 0 && (
				<ol className="issue-preview" aria-label="Issues to make" data-all={all || undefined}>
					{shown.map((issue) => (
						<li key={issue.id} data-open={opened.has(issue.id) || undefined}>
							<span className="issue-preview-dot" data-color={issue.color ?? "yellow"} />
							{onTitle ? (
								<input
									className="issue-preview-title issue-preview-edit"
									aria-label={`Title, from its sticky: ${issue.title}`}
									value={issue.title}
									spellCheck
									onChange={(event) => {
										if (event.target.value.trim()) onTitle(issue.id, event.target.value);
									}}
								/>
							) : (
								<span className="issue-preview-title">{issue.title}</span>
							)}
							{issue.body && (
								<button
									type="button"
									className="issue-preview-body"
									aria-expanded={opened.has(issue.id)}
									onClick={() =>
										setOpened((was) => {
											const next = new Set(was);
											if (next.has(issue.id)) next.delete(issue.id);
											else next.add(issue.id);
											return next;
										})
									}
								>
									{opened.has(issue.id) ? "− description" : "+ description"}
								</button>
							)}
							{issue.body && opened.has(issue.id) && (
								<p className="issue-preview-text">{issue.body}</p>
							)}
						</li>
					))}
					{n > shown.length && (
						<li className="issue-preview-more">
							<button type="button" onClick={() => setAll(true)}>
								Show all {n}
							</button>
						</li>
					)}
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
	/**
	 * The parent issue it already has (`#4`), and whether that's the one
	 * the section or selection already has (`same`).
	 */
	parent?: { label: string; same: boolean };
}

/** The parent issue a section or selection already has, for the panel. */
export interface ExistingParentPreview {
	/** `#4`, or a staged issue's title in quotes. */
	label: string;
	title?: string;
}

/** `#5`, `#5 and #6`, `#5, #6 and 2 more`. */
function refList(labels: string[]): string {
	const unique = [...new Set(labels)];
	if (unique.length <= 1) return unique.join("");
	if (unique.length <= 3) return `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`;
	return `${unique.slice(0, 2).join(", ")} and ${unique.length - 2} more`;
}

/** What happens to one child, in each mode. */
function fateOf(item: ChildPreview, mode: ParentMode): "add" | "already" | "move" | "out" {
	if (!item.parent) return "add";
	if (mode === "add") return item.parent.same ? "already" : "out";
	return mode === "move" ? "move" : "out";
}

/**
 * A parent issue with sub-issues: a title, a repository, and what goes
 * under it. When some of it already has a parent (the section was made a
 * parent issue before, say), it says so and offers what to do: add the new
 * ones to the parent that's there (the default), make a new parent and
 * move them to it, or make a new parent without them.
 */
export function ParentIssuePanel({
	title: initialTitle,
	from,
	items,
	repos,
	host,
	initialRepo,
	existing = null,
	checking = false,
	initialMode,
	onStage,
}: {
	title: string;
	/** Where it comes from: "this section" or "the selection". */
	from: string;
	items: ChildPreview[];
	repos: RepoOption[];
	host: string;
	initialRepo: string | null;
	existing?: ExistingParentPreview | null;
	/** Still finding out which already have a parent. */
	checking?: boolean;
	initialMode?: ParentMode;
	onStage: (repo: string, title: string, mode: ParentMode) => void;
}) {
	const [title, setTitle] = useState(initialTitle);
	const [repo, setRepo] = useState(initialRepo);
	const [chosen, setMode] = useState<ParentMode | null>(initialMode ?? null);
	const mode: ParentMode = chosen ?? (existing ? "add" : "skip");
	const access = useRepoAccess(repo, "item.subIssue");
	const children = items.filter(
		(item) => !("card" in item.input) || item.input.card.kind === "issue",
	);
	const pulls = items.length - children.length;
	const discussions = items.filter(
		(item) => "card" in item.input && item.input.card.kind === "discussion",
	).length;
	const parented = children.filter((item) => item.parent);
	const under = parented.filter((item) => item.parent?.same);
	const elsewhere = parented.filter((item) => !item.parent?.same);
	const fates = children.map((item) => fateOf(item, mode));
	const going = fates.filter((fate) => fate === "add" || fate === "move").length;
	const moving = fates.filter((fate) => fate === "move").length;
	const adding = mode === "add";
	const choosing = !checking && (existing !== null || parented.length > 0);
	const ready =
		!!repo && !checking && !access.blocked && (adding ? going > 0 : title.trim() !== "");
	const shown = children.slice(0, 5);

	const name = existing ? `${existing.label}${existing.title ? ` ${existing.title}` : ""}` : "";
	const already = (() => {
		if (checking) return null;
		if (existing && under.length > 0 && elsewhere.length === 0) {
			return under.length === children.length
				? `${children.length === 1 ? "This is" : "These are"} already ${children.length === 1 ? "a sub-issue" : "sub-issues"} of ${name}.`
				: `${refList(under.map((item) => item.ref ?? item.label))} ${under.length === 1 ? "is" : "are"} already ${under.length === 1 ? "a sub-issue" : "sub-issues"} of ${name}.`;
		}
		if (existing)
			return `${from === "this section" ? "This section" : "The selection"} is already ${name}.`;
		if (parented.length > 0) {
			const refs = refList(parented.map((item) => item.ref ?? item.label));
			const theirs = refList(parented.map((item) => item.parent?.label ?? ""));
			return `${refs} already ${parented.length === 1 ? "has a parent issue" : "have parent issues"} (${theirs}), and an issue can only have one.`;
		}
		return null;
	})();

	return (
		<form
			className="issue-panel parent-panel"
			data-mode={mode}
			onSubmit={(event) => {
				event.preventDefault();
				if (ready && repo) onStage(repo, title, mode);
			}}
		>
			<PopoverHead
				title={adding && existing ? `Add to ${existing.label}` : "Parent issue with sub-issues"}
				detail={
					adding && existing
						? `What’s new in ${from} goes under the parent issue it already has.`
						: `Everything in ${from} goes under one new issue.`
				}
			/>
			{checking && (
				<p className="parent-checking" role="status">
					<span className="parent-checking-dot" aria-hidden="true" />
					Checking which already have a parent…
				</p>
			)}
			{already && (
				<Notice tone="warn" icon={<ParentIcon />}>
					{already}
				</Notice>
			)}
			{choosing && (
				<fieldset className="parent-choice">
					<legend className="visually-hidden">What to do</legend>
					{existing && (
						<ParentChoice
							value="add"
							mode={mode}
							onChange={setMode}
							label={`Add to ${existing.label}${existing.title ? ` ${existing.title}` : ""}`}
							detail={
								children.length - parented.length > 0
									? `${count(children.length - parented.length, "new sub-issue")}${under.length ? `; ${under.length} already there` : ""}`
									: "Nothing new to add"
							}
						/>
					)}
					{parented.length > 0 && (
						<ParentChoice
							value="move"
							mode={mode}
							onChange={setMode}
							label="Make a new parent and move them"
							detail={`Takes ${refList(parented.map((item) => item.ref ?? item.label))} off ${refList(parented.map((item) => item.parent?.label ?? ""))}`}
						/>
					)}
					<ParentChoice
						value="skip"
						mode={mode}
						onChange={setMode}
						label={
							parented.length > 0
								? "Make a new parent without them"
								: "Make a new parent issue anyway"
						}
						detail={
							parented.length > 0
								? `${refList(parented.map((item) => item.ref ?? item.label))} ${parented.length === 1 ? "stays" : "stay"} where ${parented.length === 1 ? "it is" : "they are"}`
								: `A second parent issue for ${from}`
						}
					/>
				</fieldset>
			)}
			{!adding && (
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
			)}
			<RepoPicker
				value={repo}
				onChange={setRepo}
				options={repos}
				host={host}
				label={adding ? "New issues in" : undefined}
			/>
			{access.notice}
			<ol
				className="issue-preview tree"
				aria-label="Sub-issues"
				data-checking={checking || undefined}
			>
				{shown.map((item, i) => {
					const fate = checking ? "add" : (fates[i] ?? "add");
					return (
						<li key={item.input.shape} data-fate={fate}>
							{"card" in item.input ? (
								<IssueIcon />
							) : (
								<span className="issue-preview-dot" data-color={item.color ?? "yellow"} />
							)}
							{item.ref && <span className="mono issue-preview-ref">{item.ref}</span>}
							<span className="issue-preview-title">{item.label}</span>
							{fate === "already" && (
								<span className="issue-preview-body">already under {item.parent?.label}</span>
							)}
							{fate === "move" && (
								<span className="issue-preview-body parent-fate-move">
									moves from {item.parent?.label}
								</span>
							)}
							{fate === "out" && (
								<span className="issue-preview-body">stays under {item.parent?.label}</span>
							)}
							{fate === "add" && !("card" in item.input) && (
								<span className="issue-preview-body">new</span>
							)}
						</li>
					);
				})}
				{children.length > 5 && (
					<li className="issue-preview-more">and {children.length - 5} more</li>
				)}
				{children.length === 0 && <li className="issue-preview-more">No sub-issues yet</li>}
			</ol>
			{pulls > 0 && (
				<Notice icon={<PullIcon />}>
					{leftOutWords(items.length - children.length - discussions, discussions)} left out: only
					issues can be sub-issues.
				</Notice>
			)}
			<footer className="action-foot">
				<Footnote />
				<StageButton disabled={!ready}>
					{checking
						? "Checking…"
						: adding && existing
							? going > 0
								? `Add ${count(going, "sub-issue")} to ${existing.label}`
								: "Nothing new to add"
							: going > 0
								? moving === 0
									? `Stage with ${count(going, "sub-issue")}`
									: moving === going
										? `Stage, moving ${going === 1 ? "it" : `all ${going}`}`
										: `Stage ${going}, moving ${moving}`
								: "Stage"}
				</StageButton>
			</footer>
		</form>
	);
}

function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** One way to go, as a card you pick. */
function ParentChoice({
	value,
	mode,
	onChange,
	label,
	detail,
}: {
	value: ParentMode;
	mode: ParentMode;
	onChange: (mode: ParentMode) => void;
	label: string;
	detail: string;
}) {
	return (
		<label className="parent-choice-option" data-checked={mode === value}>
			<input
				type="radio"
				name="parent-mode"
				value={value}
				checked={mode === value}
				onChange={() => onChange(value)}
			/>
			<span className="parent-choice-mark" aria-hidden="true" />
			<span className="parent-choice-text">
				<strong>{label}</strong>
				<small>{detail}</small>
			</span>
		</label>
	);
}

/** "A pull request is", "2 discussions are", "A pull request and a discussion are". */
function leftOutWords(pulls: number, discussions: number): string {
	const many = pulls + discussions > 1;
	const count = (n: number, one: string, several: string) =>
		n === 1 ? `a ${one}` : `${n} ${several}`;
	const words = [
		...(pulls > 0 ? [count(pulls, "pull request", "pull requests")] : []),
		...(discussions > 0 ? [count(discussions, "discussion", "discussions")] : []),
	].join(" and ");
	return `${words.charAt(0).toUpperCase()}${words.slice(1)} ${many ? "are" : "is"}`;
}
