import { useId, useMemo, useState } from "react";
import {
	type ActionOwner,
	addDays,
	describeDue,
	duePresets,
	isLogin,
} from "../../shared/actionItems.ts";
import type { Mentionable } from "../../shared/comments.ts";
import { itemKey, parseRef, parseRepoKey, repoKeyOf } from "../../shared/refs.ts";
import { CheckIcon, RepoIcon } from "../actions/icons.tsx";
import { type RepoOption, RepoPicker, SearchField, useActive } from "../actions/pickers.tsx";
import { Notice, PopoverHead } from "../actions/Popover.tsx";
import { repoName } from "../actions/selection.ts";
import { useCard } from "../cardStore.ts";
import type { ActionLinkView, StagedIssueView } from "./ActionItemView.tsx";
import { OwnerAvatar } from "./ActionItemView.tsx";
import { ChevronLeft, ChevronRight } from "./icons.tsx";

// The pickers an action item's chips open: who owns it (one of the board's
// people, or any GitHub login), when it's due (quick picks and a calendar),
// and the issue it follows (link one that exists, or stage a new one,
// assigned to its owner). Keyboard-first, like the selection actions'.

// --- Owner ---------------------------------------------------------------------------

export function OwnerPicker({
	current,
	me,
	people,
	onPick,
}: {
	current?: ActionOwner;
	/** You, when you're signed in: first in the list. */
	me?: ActionOwner | null;
	/** The board's people (members, then recent visitors). */
	people: readonly Mentionable[];
	onPick: (owner: ActionOwner | null) => void;
}) {
	const [query, setQuery] = useState("");
	const listId = useId();
	const words = query.trim().replace(/^@/, "").toLowerCase();
	const options = useMemo(() => {
		const all: (ActionOwner & { you?: boolean })[] = [];
		const seen = new Set<string>();
		const add = (owner: ActionOwner & { you?: boolean }) => {
			const key = owner.login.toLowerCase();
			if (seen.has(key)) return;
			seen.add(key);
			all.push(owner);
		};
		if (me) add({ ...me, you: true });
		for (const person of people) {
			add({ login: person.login, name: person.name, avatarUrl: person.avatarUrl });
		}
		if (current) add(current);
		const matches = all.filter(
			(owner) =>
				!words ||
				owner.login.toLowerCase().includes(words) ||
				(owner.name ?? "").toLowerCase().includes(words),
		);
		if (words && isLogin(words) && !seen.has(words))
			matches.push({ login: query.trim().replace(/^@/, "") });
		return matches;
	}, [me, people, current, words, query]);
	const { active, setActive, onKey } = useActive(options.length);

	return (
		<>
			<PopoverHead title="Owner" detail="Who’ll make sure it happens" />
			<SearchField
				label="Find someone"
				listId={listId}
				value={query}
				onChange={(next) => {
					setQuery(next);
					setActive(0);
				}}
				placeholder="Name or GitHub login"
				activeId={active >= 0 ? `${listId}-${active}` : undefined}
				autoFocus
				onKeyDown={(event) => {
					if (onKey(event)) return;
					if (event.key === "Enter" && options[active]) {
						event.preventDefault();
						const { you: _you, ...owner } = options[active];
						onPick(owner);
					}
				}}
			/>
			<div className="action-list" role="listbox" id={listId} aria-label="People">
				{options.length === 0 && (
					<p className="action-empty">Nobody here by that name. Type a GitHub login.</p>
				)}
				{options.map((option, i) => {
					const { you, ...owner } = option;
					const chosen = current?.login.toLowerCase() === owner.login.toLowerCase();
					return (
						<button
							key={owner.login}
							id={`${listId}-${i}`}
							type="button"
							role="option"
							aria-selected={chosen}
							data-active={i === active}
							className="action-option"
							onPointerEnter={() => setActive(i)}
							onClick={() => onPick(owner)}
						>
							<OwnerAvatar owner={owner} size={22} />
							<span className="action-option-stack">
								<span className="action-option-name">{owner.name || owner.login}</span>
								{owner.name && <span className="owner-option-login">@{owner.login}</span>}
							</span>
							{you && <span className="owner-option-you">You</span>}
							<span className="action-check" aria-hidden="true">
								{chosen && <CheckIcon />}
							</span>
						</button>
					);
				})}
			</div>
			{current && (
				<div className="picker-foot">
					<button type="button" className="picker-clear" onClick={() => onPick(null)}>
						Remove owner
					</button>
				</div>
			)}
		</>
	);
}

// --- Due date ---------------------------------------------------------------------------

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function monthOf(date: string): string {
	return date.slice(0, 7);
}

function shiftMonth(month: string, by: number): string {
	const [y, m] = month.split("-").map(Number) as [number, number];
	const next = new Date(Date.UTC(y, m - 1 + by, 1));
	return next.toISOString().slice(0, 7);
}

/** The days on a month's page: whole weeks, Monday first. */
function monthDays(month: string): string[] {
	const first = `${month}-01`;
	const [y, m] = month.split("-").map(Number) as [number, number];
	const weekday = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
	const start = addDays(first, -weekday);
	const days: string[] = [];
	for (let i = 0; i < 42; i++) days.push(addDays(start, i));
	// Five weeks are enough for most months.
	return days[35]?.startsWith(month) ? days : days.slice(0, 35);
}

export function DuePicker({
	value,
	today,
	onPick,
}: {
	value?: string;
	today: string;
	onPick: (date: string | null) => void;
}) {
	const [month, setMonth] = useState(() => monthOf(value ?? today));
	const [slide, setSlide] = useState<"next" | "prev" | null>(null);
	const [cursor, setCursor] = useState(value ?? today);
	const presets = duePresets(today);
	const days = monthDays(month);
	const [y, m] = month.split("-").map(Number) as [number, number];
	const title = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	});

	const step = (by: number) => {
		setMonth((current) => shiftMonth(current, by));
		setSlide(by > 0 ? "next" : "prev");
	};
	const moveCursor = (by: number) => {
		const next = addDays(cursor, by);
		setCursor(next);
		if (monthOf(next) !== month) step(next > cursor ? 1 : -1);
	};

	return (
		<>
			<PopoverHead
				title="Due"
				detail={value ? describeDue(value, today) : "When should it be done by?"}
			/>
			<div className="due-presets" role="group" aria-label="Quick picks">
				{presets.map((preset) => (
					<button
						key={preset.date}
						type="button"
						className="due-preset"
						aria-pressed={preset.date === value}
						onClick={() => onPick(preset.date)}
					>
						{preset.label}
						{preset.label !== "Today" && preset.label !== "Tomorrow" && (
							<span className="due-preset-day">{describeDue(preset.date, today)}</span>
						)}
					</button>
				))}
			</div>
			<div className="calendar-head">
				<button
					type="button"
					className="calendar-step"
					aria-label="Previous month"
					onClick={() => step(-1)}
				>
					<ChevronLeft />
				</button>
				<span className="calendar-month" aria-live="polite">
					{title}
				</span>
				<button
					type="button"
					className="calendar-step"
					aria-label="Next month"
					onClick={() => step(1)}
				>
					<ChevronRight />
				</button>
			</div>
			<div
				key={month}
				className="calendar-grid"
				role="grid"
				aria-label={title}
				data-slide={slide ?? undefined}
				onKeyDown={(event) => {
					const moves: Record<string, number> = {
						ArrowLeft: -1,
						ArrowRight: 1,
						ArrowUp: -7,
						ArrowDown: 7,
					};
					const by = moves[event.key];
					if (by !== undefined) {
						event.preventDefault();
						moveCursor(by);
						requestAnimationFrame(() =>
							document
								.querySelector<HTMLElement>(`.calendar-day[data-date="${addDays(cursor, by)}"]`)
								?.focus(),
						);
					}
				}}
			>
				{WEEKDAYS.map((day) => (
					<span key={day} className="calendar-weekday" role="columnheader">
						{day}
					</span>
				))}
				{days.map((day, i) => (
					<button
						key={day}
						type="button"
						role="gridcell"
						className="calendar-day"
						data-date={day}
						data-outside={!day.startsWith(month) || undefined}
						data-weekend={i % 7 >= 5 || undefined}
						data-today={day === today || undefined}
						aria-pressed={day === value}
						aria-label={new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
							weekday: "long",
							day: "numeric",
							month: "long",
						})}
						tabIndex={day === cursor ? 0 : -1}
						onFocus={() => setCursor(day)}
						onClick={() => onPick(day)}
					>
						{Number(day.slice(8))}
					</button>
				))}
			</div>
			{value && (
				<div className="picker-foot">
					<button type="button" className="picker-clear" onClick={() => onPick(null)}>
						No due date
					</button>
				</div>
			)}
		</>
	);
}

// --- Issue ---------------------------------------------------------------------------------

/** An issue someone typed or pasted: a link, `owner/repo#12`, or `#12` in the usual repository. */
export function parseIssueInput(text: string, repo: string | null): string | null {
	const trimmed = text.trim();
	const ref = parseRef(trimmed);
	if (ref) return itemKey(ref);
	const number = /^#?(\d+)$/.exec(trimmed)?.[1];
	if (number && repo && parseRepoKey(repo)) return `${repo}#${number}`;
	return null;
}

/** `#12` in the usual repository, `owner/repo#12` in any other. */
export function linkLabel(key: string, usual: string | null): string {
	const repo = repoKeyOf(key);
	const item = key.slice(repo.length);
	return usual && repo.toLowerCase() === usual.toLowerCase() ? item : `${repoName(repo)}${item}`;
}

export function LinkPicker({
	current,
	staged,
	repos,
	host,
	usualRepo,
	owner,
	canCreate,
	onLink,
	onCreate,
	onUnlink,
}: {
	current: ActionLinkView | null;
	staged: StagedIssueView | null;
	repos: RepoOption[];
	host: string;
	/** The repository `#12` means: the board's busiest. */
	usualRepo: string | null;
	owner?: ActionOwner;
	/** Whether a new issue can be staged (there's something written, and it isn't staged already). */
	canCreate: boolean;
	onLink: (key: string) => void;
	onCreate: (repo: string) => void;
	onUnlink: () => void;
}) {
	const [query, setQuery] = useState("");
	const [repo, setRepo] = useState<string | null>(usualRepo ?? repos[0]?.repo ?? null);
	const key = parseIssueInput(query, usualRepo ?? repo);
	const card = useCard(key ?? "");
	const known = card && !("missing" in card) ? card : null;
	const listId = useId();

	return (
		<>
			<PopoverHead title="Issue" detail="Once linked, the item is done when its issue is closed" />
			{current && (
				<div className="link-section">
					<div className="link-preview">
						<span className="action-chip-state" data-state={current.state} aria-hidden="true" />
						<span className="mono">{current.label}</span>
						<span className="link-preview-title">{current.title ?? ""}</span>
						<button type="button" className="action-secondary" onClick={onUnlink}>
							Unlink
						</button>
					</div>
				</div>
			)}
			{staged && !current && (
				<div className="link-section">
					<Notice tone={staged.status === "failed" ? "error" : undefined}>
						{staged.status === "failed"
							? `Making it in ${staged.repo} failed: ${staged.error ?? "try again from Changes"}`
							: `A new issue in ${staged.repo} is staged, assigned to its owner. Push to make it.`}
					</Notice>
					<div className="picker-foot">
						<button type="button" className="picker-clear" onClick={onUnlink}>
							Unstage it
						</button>
					</div>
				</div>
			)}
			<form
				className="link-section"
				onSubmit={(event) => {
					event.preventDefault();
					if (key) onLink(key);
				}}
			>
				<p className="link-section-title">{current ? "Link another issue" : "Link an issue"}</p>
				<SearchField
					label="Issue"
					listId={listId}
					value={query}
					onChange={setQuery}
					placeholder={usualRepo ? `#123, or paste a link` : "owner/repo#123, or paste a link"}
					autoFocus={!current}
				/>
				{key && (
					<div className="link-preview" id={listId}>
						<span
							className="action-chip-state"
							data-state={known?.state ?? "unknown"}
							aria-hidden="true"
						/>
						<span className="mono">{linkLabel(key, usualRepo)}</span>
						<span className="link-preview-title">{known?.title ?? ""}</span>
						<button type="submit" className="action-primary">
							Link
						</button>
					</div>
				)}
			</form>
			{!current && !staged && (
				<div className="link-section">
					<p className="link-section-title">Or make a new issue</p>
					<RepoPicker value={repo} onChange={setRepo} options={repos} host={host} />
					<div className="picker-foot">
						<span className="action-summary">
							{owner ? `Assigned to @${owner.login}` : "Pick an owner to assign it"}
						</span>
						<button
							type="button"
							className="action-primary"
							disabled={!repo || !canCreate}
							onClick={() => repo && onCreate(repo)}
						>
							<RepoIcon />
							Stage issue
						</button>
					</div>
				</div>
			)}
		</>
	);
}
