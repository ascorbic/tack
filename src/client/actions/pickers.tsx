import { type KeyboardEvent, type ReactNode, useId, useMemo, useRef, useState } from "react";
import { type Presence, parseRepoInput, presenceOf, setEdits } from "../../shared/actions.ts";
import type { CloseReason } from "../../shared/changes.ts";
import type { Milestone } from "../../shared/push.ts";
import { parseRepoKey } from "../../shared/refs.ts";
import {
	CheckIcon,
	CloseIssueIcon,
	DuplicateIcon,
	MilestoneIcon,
	NotPlannedIcon,
	ReopenIcon,
	RepoIcon,
	SearchIcon,
} from "./icons.tsx";
import { SUBMIT_HINT } from "./Popover.tsx";
import { repoName } from "./selection.ts";

// Pickers for the selection actions: a repository, labels and people (with
// mixed states for multiple cards), a milestone, and closing or reopening.
// Each is keyboard-first: type to filter, arrows to move, Enter to pick.

/** Arrow keys move through a list of `length` items, wrapping around. */
function useActive(length: number) {
	const [active, setActive] = useState(0);
	const clamped = length === 0 ? -1 : Math.min(active, length - 1);
	const onKey = (event: KeyboardEvent): boolean => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			if (length === 0) return true;
			const step = event.key === "ArrowDown" ? 1 : -1;
			setActive((clamped + step + length) % length);
			return true;
		}
		return false;
	};
	return { active: clamped, setActive, onKey };
}

function SearchField({
	value,
	onChange,
	placeholder,
	onKeyDown,
	label,
	activeId,
	listId,
	icon = <SearchIcon />,
	autoFocus,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder: string;
	onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
	label: string;
	activeId?: string;
	listId: string;
	icon?: ReactNode;
	autoFocus?: boolean;
}) {
	return (
		<label className="action-search">
			{icon}
			<input
				data-autofocus
				// oxlint-disable-next-line jsx-a11y/no-autofocus -- opened on purpose, by a click or a key
				autoFocus={autoFocus}
				type="text"
				role="combobox"
				aria-label={label}
				aria-expanded="true"
				aria-controls={listId}
				aria-activedescendant={activeId}
				autoComplete="off"
				spellCheck={false}
				value={value}
				placeholder={placeholder}
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={onKeyDown}
			/>
		</label>
	);
}

// Repositories ------------------------------------------------------------------

export interface RepoOption {
	repo: string;
	/** Cards on the board from this repository. */
	cards?: number;
	recent?: boolean;
}

/** `acme/` muted, `imagekit` strong. */
export function RepoName({ repo }: { repo: string }) {
	const name = repoName(repo);
	const slash = name.lastIndexOf("/");
	return (
		<span className="repo-name">
			<span className="repo-owner">{name.slice(0, slash + 1)}</span>
			{name.slice(slash + 1)}
		</span>
	);
}

/**
 * Choose a repository: the board's own first (most cards first), then ones
 * you've used lately, or type `owner/repo` for any other.
 */
export function RepoPicker({
	value,
	onChange,
	options,
	host,
}: {
	value: string | null;
	onChange: (repo: string) => void;
	options: RepoOption[];
	/** Where a bare `owner/repo` lives. */
	host: string;
}) {
	const [query, setQuery] = useState("");
	const listId = useId();
	const typed = parseRepoInput(query, host);
	const words = query.trim().toLowerCase();
	const shown = useMemo(() => {
		// A repository typed earlier stays in the list once chosen.
		const all =
			value && !options.some((o) => o.repo === value) ? [...options, { repo: value }] : options;
		const matches = all.filter((o) => !words || repoName(o.repo).includes(words));
		if (typed && !all.some((o) => o.repo === typed)) matches.push({ repo: typed });
		return matches;
	}, [options, words, typed, value]);
	const { active, setActive, onKey } = useActive(shown.length);

	const choose = (repo: string) => {
		onChange(repo);
		setQuery("");
	};

	return (
		<div className="repo-picker">
			<SearchField
				label="Repository"
				listId={listId}
				value={query}
				onChange={(next) => {
					setQuery(next);
					setActive(0);
				}}
				placeholder={value ? repoName(value) : "owner/repo"}
				icon={<RepoIcon />}
				activeId={active >= 0 && words ? `${listId}-${active}` : undefined}
				onKeyDown={(event) => {
					if (onKey(event)) return;
					// Enter picks what you typed for; with nothing typed it stages.
					if (event.key === "Enter" && words && shown[active]) {
						event.preventDefault();
						choose(shown[active].repo);
					}
				}}
			/>
			<div className="action-list repo-list" role="listbox" id={listId} aria-label="Repositories">
				{shown.length === 0 && <p className="action-empty">Type a repository, like owner/repo</p>}
				{shown.map((option, i) => (
					<button
						key={option.repo}
						id={`${listId}-${i}`}
						type="button"
						role="option"
						aria-selected={option.repo === value}
						data-active={words !== "" && i === active}
						className="action-option"
						onPointerEnter={() => setActive(i)}
						onClick={() => choose(option.repo)}
					>
						<RepoIcon />
						<RepoName repo={option.repo} />
						<span className="action-option-meta">
							{option.cards
								? `${option.cards} card${option.cards === 1 ? "" : "s"}`
								: option.recent
									? "recent"
									: parseRepoKey(option.repo)
										? "new"
										: ""}
						</span>
						<span className="action-check" aria-hidden="true">
							{option.repo === value && <CheckIcon />}
						</span>
					</button>
				))}
			</div>
		</div>
	);
}

// Labels and people -------------------------------------------------------------

/** Someone's avatar, where the forge has them. */
export function avatarFor(repo: string, login: string): string | undefined {
	return parseRepoKey(repo)?.host === "github.com"
		? `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=40`
		: undefined;
}

export interface SetOption {
	name: string;
	/** Labels: hex colour without the #. */
	color?: string;
	description?: string;
	/** People: an avatar. */
	avatar?: string;
}

function TriBox({ presence }: { presence: Presence }) {
	return (
		<span className="tribox" data-presence={presence} aria-hidden="true">
			{presence === "all" && <CheckIcon />}
			{presence === "some" && <span className="tribox-dash" />}
		</span>
	);
}

/**
 * A filterable list of labels or people to tick: type to filter, arrows to
 * move, ↵ to tick the highlighted one, ⌘↵ to submit the form it's in. Each
 * shows whether every item has it, some do, or none.
 */
export function SetList({
	noun,
	options,
	chosen,
	initial,
	onToggle,
	placeholder,
	empty,
	render,
	autoFocus,
}: {
	/** "label" or "assignee", for names. */
	noun: string;
	options: SetOption[];
	chosen: ReadonlyMap<string, Presence>;
	/** How things were before, to mark what's changed. */
	initial?: ReadonlyMap<string, Presence>;
	onToggle: (name: string) => void;
	placeholder: string;
	empty: string;
	render: (option: SetOption) => ReactNode;
	/** Focus the filter when it appears (it's opened after its popover). */
	autoFocus?: boolean;
}) {
	const [query, setQuery] = useState("");
	const listId = useId();
	const words = query.trim().toLowerCase();
	const shown = options.filter(
		(o) =>
			!words ||
			o.name.toLowerCase().includes(words) ||
			o.description?.toLowerCase().includes(words),
	);
	const { active, setActive, onKey } = useActive(shown.length);
	return (
		<>
			<SearchField
				label={`Filter ${noun}s`}
				listId={listId}
				value={query}
				onChange={(next) => {
					setQuery(next);
					setActive(0);
				}}
				placeholder={placeholder}
				activeId={active >= 0 ? `${listId}-${active}` : undefined}
				autoFocus={autoFocus}
				onKeyDown={(event) => {
					if (onKey(event)) return;
					if (event.key !== "Enter") return;
					event.preventDefault();
					// ⌘↵ stages; ↵ ticks the highlighted option.
					if (event.metaKey || event.ctrlKey) {
						event.currentTarget.form?.requestSubmit();
						return;
					}
					const option = shown[active];
					if (option) onToggle(option.name);
				}}
			/>
			<div
				className="action-list"
				role="listbox"
				aria-multiselectable="true"
				id={listId}
				aria-label={`${noun}s`}
			>
				{options.length === 0 && <p className="action-empty">{empty}</p>}
				{options.length > 0 && shown.length === 0 && (
					<p className="action-empty">Nothing matches “{query.trim()}”</p>
				)}
				{shown.map((option, i) => {
					const presence = chosen.get(option.name) ?? "none";
					return (
						<button
							key={option.name}
							id={`${listId}-${i}`}
							type="button"
							role="option"
							aria-selected={presence === "all"}
							aria-checked={presence === "some" ? "mixed" : presence === "all"}
							data-active={i === active}
							data-changed={
								(initial && (initial.get(option.name) ?? "none") !== presence) || undefined
							}
							className="action-option"
							onPointerEnter={() => setActive(i)}
							onClick={() => onToggle(option.name)}
						>
							<TriBox presence={presence} />
							{render(option)}
						</button>
					);
				})}
			</div>
		</>
	);
}

/**
 * Add and remove labels or people across several items. Each option shows
 * whether every item has it, some do, or none; clicking cycles it to all,
 * then none. Nothing is staged until you press Stage.
 */
export function SetPicker({
	noun,
	options,
	items,
	onStage,
	placeholder,
	empty,
	render,
}: {
	/** "label" or "assignee", for counts. */
	noun: string;
	options: SetOption[];
	items: { key: string; names: string[] }[];
	onStage: (edits: { key: string; add: string[]; remove: string[] }[]) => void;
	placeholder: string;
	empty: string;
	render: (option: SetOption) => ReactNode;
}) {
	const initial = useRef<Map<string, Presence> | null>(null);
	if (!initial.current) {
		const sets = items.map((item) => item.names);
		initial.current = new Map(options.map((o) => [o.name, presenceOf(sets, o.name)]));
	}
	const [chosen, setChosen] = useState(initial.current);
	const edits = useMemo(() => {
		// Only what you changed: untouched options keep each item as it is.
		const changed = new Map(
			[...chosen].filter(([name, presence]) => initial.current?.get(name) !== presence),
		);
		return setEdits(items, changed);
	}, [chosen, items]);
	const adds = edits.reduce((n, e) => n + e.add.length, 0);
	const removes = edits.reduce((n, e) => n + e.remove.length, 0);

	const toggle = (name: string) =>
		setChosen((current) => {
			const next = new Map(current);
			next.set(name, current.get(name) === "all" ? "none" : "all");
			return next;
		});

	return (
		<form
			className="set-picker"
			onSubmit={(event) => {
				event.preventDefault();
				if (edits.length > 0) onStage(edits);
			}}
		>
			<SetList
				noun={noun}
				options={options}
				chosen={chosen}
				initial={initial.current}
				onToggle={toggle}
				placeholder={placeholder}
				empty={empty}
				render={render}
			/>
			<footer className="action-foot">
				<span className="action-summary" aria-live="polite">
					{edits.length === 0 ? (
						"No changes yet"
					) : (
						<>
							{adds > 0 && (
								<span className="delta" data-sign="add">
									+{adds}
								</span>
							)}
							{removes > 0 && (
								<span className="delta" data-sign="remove">
									−{removes}
								</span>
							)}
							<span>
								on {edits.length} item{edits.length === 1 ? "" : "s"}
							</span>
						</>
					)}
				</span>
				<button type="submit" className="action-primary" disabled={edits.length === 0}>
					Stage
					<kbd>{SUBMIT_HINT}</kbd>
				</button>
			</footer>
		</form>
	);
}

export function LabelOption({ option }: { option: SetOption }) {
	return (
		<>
			<span
				className="chip label"
				style={{ "--label": `#${option.color ?? "8a8f98"}` } as React.CSSProperties}
			>
				{option.name}
			</span>
			{option.description && <span className="action-option-detail">{option.description}</span>}
		</>
	);
}

export function PersonOption({ option }: { option: SetOption }) {
	return (
		<>
			{option.avatar ? (
				<img className="action-avatar" src={option.avatar} alt="" width={20} height={20} />
			) : (
				<span className="action-avatar" data-initial={option.name.slice(0, 1).toUpperCase()} />
			)}
			<span className="action-option-name">{option.name}</span>
		</>
	);
}

// Milestones ---------------------------------------------------------------------

function dueLabel(dueOn: string | null | undefined): string | null {
	if (!dueOn) return null;
	const date = new Date(dueOn);
	if (Number.isNaN(date.getTime())) return null;
	const past = date.getTime() < Date.now();
	const text = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	return past ? `Was due ${text}` : `Due ${text}`;
}

/** Pick a milestone, or none: staged as soon as you pick. */
export function MilestonePicker({
	milestones,
	onPick,
	chosen,
	autoFocus,
}: {
	milestones: Milestone[];
	onPick: (milestone: string | null) => void;
	/** The milestone already picked, ticked. */
	chosen?: string | null;
	autoFocus?: boolean;
}) {
	const [query, setQuery] = useState("");
	const listId = useId();
	const words = query.trim().toLowerCase();
	const shown: (Milestone | null)[] = [
		...(words ? [] : [null]),
		...milestones.filter((m) => !words || m.title.toLowerCase().includes(words)),
	];
	const { active, setActive, onKey } = useActive(shown.length);
	return (
		<div className="milestone-picker">
			<SearchField
				label="Filter milestones"
				listId={listId}
				value={query}
				onChange={(next) => {
					setQuery(next);
					setActive(0);
				}}
				placeholder="Filter milestones"
				activeId={active >= 0 ? `${listId}-${active}` : undefined}
				autoFocus={autoFocus}
				onKeyDown={(event) => {
					if (onKey(event)) return;
					if (event.key === "Enter") {
						event.preventDefault();
						const pick = shown[active];
						if (pick !== undefined) onPick(pick?.title ?? null);
					}
				}}
			/>
			<div className="action-list" role="listbox" id={listId} aria-label="Milestones">
				{milestones.length === 0 && !words && <p className="action-empty">No open milestones</p>}
				{shown.map((milestone, i) => (
					<button
						key={milestone?.title ?? "none"}
						id={`${listId}-${i}`}
						type="button"
						role="option"
						aria-selected={chosen !== undefined && (milestone?.title ?? null) === chosen}
						data-active={i === active}
						className="action-option"
						data-none={milestone === null || undefined}
						onPointerEnter={() => setActive(i)}
						onClick={() => onPick(milestone?.title ?? null)}
					>
						<MilestoneIcon />
						<span className="action-option-name">
							{milestone ? milestone.title : "No milestone"}
						</span>
						<span className="action-option-meta">{dueLabel(milestone?.dueOn)}</span>
						{chosen !== undefined && (
							<span className="action-check" aria-hidden="true">
								{(milestone?.title ?? null) === chosen && <CheckIcon />}
							</span>
						)}
					</button>
				))}
			</div>
		</div>
	);
}

// Open and closed ----------------------------------------------------------------

export type StateChoice = { state: "open" } | { state: "closed"; reason: CloseReason };

const CLOSE_CHOICES: { reason: CloseReason; label: string; detail: string; icon: ReactNode }[] = [
	{
		reason: "completed",
		label: "Close as completed",
		detail: "Done, closed, fixed, resolved",
		icon: <CloseIssueIcon />,
	},
	{
		reason: "not_planned",
		label: "Close as not planned",
		detail: "Won’t fix, can’t repro, stale",
		icon: <NotPlannedIcon />,
	},
	{
		reason: "duplicate",
		label: "Close as duplicate",
		detail: "Duplicate of another issue",
		icon: <DuplicateIcon />,
	},
];

/** Close (with a reason) or reopen, depending on what's selected. */
export function StateMenu({
	open,
	closed,
	pulls,
	onPick,
}: {
	/** How many selected items are open, and closed. */
	open: number;
	closed: number;
	/** Whether everything open is a pull request, which close without a reason. */
	pulls: boolean;
	onPick: (choice: StateChoice) => void;
}) {
	const choices: {
		key: string;
		label: string;
		detail?: string;
		icon: ReactNode;
		pick: StateChoice;
		tone: string;
	}[] = [];
	if (open > 0) {
		for (const choice of pulls ? CLOSE_CHOICES.slice(0, 1) : CLOSE_CHOICES) {
			choices.push({
				key: choice.reason,
				label: pulls ? "Close" : choice.label,
				detail: pulls ? undefined : choice.detail,
				icon: choice.icon,
				pick: { state: "closed", reason: choice.reason },
				tone: choice.reason,
			});
		}
	}
	if (closed > 0) {
		choices.push({
			key: "open",
			label: "Reopen",
			icon: <ReopenIcon />,
			pick: { state: "open" },
			tone: "open",
		});
	}
	const [active, setActive] = useState(0);
	return (
		<div
			className="action-list state-menu"
			role="menu"
			aria-label="Close or reopen"
			onKeyDown={(event) => {
				if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
				event.preventDefault();
				const items = event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]");
				const step = event.key === "ArrowDown" ? 1 : -1;
				items[(active + step + items.length) % items.length]?.focus();
			}}
		>
			{choices.map((choice, i) => (
				<button
					key={choice.key}
					type="button"
					role="menuitem"
					className="action-option"
					data-tone={choice.tone}
					data-active={i === active}
					data-autofocus={i === 0 || undefined}
					onPointerEnter={() => setActive(i)}
					onFocus={() => setActive(i)}
					onClick={() => onPick(choice.pick)}
				>
					{choice.icon}
					<span className="action-option-stack">
						<span className="action-option-name">{choice.label}</span>
						{choice.detail && <span className="action-option-detail">{choice.detail}</span>}
					</span>
					{choice.key === "open" && closed > 0 && open > 0 && (
						<span className="action-option-meta">{closed} closed</span>
					)}
				</button>
			))}
		</div>
	);
}
