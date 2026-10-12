import {
	type CSSProperties,
	type ReactNode,
	useContext,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import type * as v from "valibot";
import { boardRepos } from "../../shared/actions.ts";
import {
	type DiscussionFilters,
	answersApply,
	categoryNamed,
	isDiscussionSearch,
	readDiscussionFilters,
	toDiscussionSearch,
	toIssueSearch,
	writeDiscussionFilters,
} from "../../shared/discussionFilters.ts";
import type { Label, RepoDiscussionCategory } from "../../shared/push.ts";
import { parseSearch } from "../../shared/search.ts";
import {
	type ListConfig,
	type ListSort,
	listPresets,
	presetConfig,
} from "../../shared/widgetRegistry.ts";
import { DocContext } from "../DocContext.ts";
import {
	DISCUSSION_HOSTS,
	type Loaded,
	useDiscussionCategories,
	useRepoLabels,
} from "./categories.ts";
import { describeSearch, dropNote, queryChips, refreshNote } from "./describe.ts";
import {
	CheckIcon,
	CrossIcon,
	DiscussionsIcon,
	DropIcon,
	IssuesIcon,
	RefreshIcon,
	WarnIcon,
} from "./icons.tsx";
import { ForgeField, QueryHelp } from "./QueryHelp.tsx";

// Configuring widgets: a panel written for the list (the search, with live
// feedback on what it reads and whether cards can be dropped on it, and a
// Discussions mode whose controls write the search for you), and one
// generated from any kind's Valibot schema for kinds without their own.

const SORT_LABELS: Record<ListSort, string> = {
	updated: "Updated",
	created: "Created",
	comments: "Comments",
	reactions: "Reactions",
	top: "Top",
};
const ISSUE_SORTS: ListSort[] = ["updated", "created", "comments", "reactions"];
/** Discussions' orders, named as GitHub's discussions list names them. */
const DISCUSSION_SORTS: ListSort[] = ["created", "updated", "top", "comments"];
const DISCUSSION_SORT_LABELS: Partial<Record<ListSort, string>> = {
	created: "Newest",
	updated: "Recently active",
	top: "Top",
	comments: "Most commented",
};
const LIMITS = [10, 30, 50, 100];

/** The panel's frame: a floating sheet, like the selection actions' panels. */
export function ConfigSheet({
	label,
	onClose,
	children,
}: {
	label: string;
	onClose: () => void;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const close = useRef(onClose);
	close.current = onClose;
	useEffect(() => {
		const el = ref.current;
		(el?.querySelector<HTMLElement>("[data-autofocus]") ?? el?.querySelector("input"))?.focus({
			preventScroll: true,
		});
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Element | null;
			if (!target || el?.contains(target)) return;
			// The button that opened it toggles it itself.
			if (target.closest("[data-config-toggle]")) return;
			close.current();
		};
		window.addEventListener("pointerdown", onPointerDown, true);
		return () => window.removeEventListener("pointerdown", onPointerDown, true);
	}, []);
	return (
		<div
			ref={ref}
			role="dialog"
			aria-label={label}
			className="widget-config nodrag nopan nowheel"
			onKeyDown={(event) => {
				event.stopPropagation();
				if (event.key === "Escape") {
					event.preventDefault();
					close.current();
				}
			}}
			onPointerDown={(event) => event.stopPropagation()}
			onClick={(event) => event.stopPropagation()}
			onWheel={(event) => event.stopPropagation()}
		>
			{children}
		</div>
	);
}

type Mode = "issues" | "discussions";

export function ListConfigPanel({
	config,
	onChange,
	onClose,
	suggestedRepo,
	login = null,
	showPresets = true,
}: {
	config: ListConfig;
	onChange: (changes: Partial<ListConfig>) => void;
	onClose: () => void;
	/** For the ready-made searches: the board's busiest repository (`owner/name`). */
	suggestedRepo?: string | null;
	/** Who's editing it, signed in: offered in place of `@me`, and in ready-made lists. */
	login?: string | null;
	/** Offer ready-made searches while it's empty (not when the list itself already does). */
	showPresets?: boolean;
}) {
	const id = useId();
	// The search is committed when you press Enter or leave the field, not on
	// every keystroke: each change runs it again for everyone looking.
	const [draft, setDraft] = useState(config.q);
	useEffect(() => setDraft(config.q), [config.q]);
	const chips = useMemo(() => queryChips(parseSearch(draft)), [draft]);
	const commit = () => {
		if (draft.trim() !== config.q.trim()) onChange({ q: draft.trim() });
	};
	const drop = dropNote(draft);
	// A `sort:` in the search wins over the control: GitHub reads it first.
	const sortTerm = useMemo(
		() => parseSearch(draft).terms.find((term) => term.key === "sort" && !term.negated),
		[draft],
	);

	// Which kind of item it lists: discussions while the search says so.
	const discussionsHere = DISCUSSION_HOSTS.has(config.host);
	const [mode, setMode] = useState<Mode>(() =>
		discussionsHere && isDiscussionSearch(config.q) ? "discussions" : "issues",
	);
	useEffect(() => {
		if (isDiscussionSearch(draft)) setMode("discussions");
		else if (draft.trim()) setMode("issues");
	}, [draft]);
	const discussions = discussionsHere && mode === "discussions";

	const filters = useMemo(() => readDiscussionFilters(draft), [draft]);
	const categories = useDiscussionCategories(
		config.host,
		(discussions ? filters.repo : null) ?? suggestedRepo ?? null,
	);
	const presets = showPresets
		? listPresets(suggestedRepo ?? null, login, { categories: categories.value })
		: [];

	/** A control changed: the search, written and run at once. */
	const setSearch = (q: string, changes: Partial<ListConfig> = {}) => {
		setDraft(q);
		onChange({ q, ...changes });
	};
	const switchTo = (next: Mode) => {
		if (next === mode) return;
		setMode(next);
		if (next === "discussions") {
			const q = toDiscussionSearch(draft.trim() ? draft : "is:open", suggestedRepo ?? null);
			setSearch(q, config.sort === "reactions" ? { sort: "top" } : {});
		} else {
			setSearch(toIssueSearch(draft), config.sort === "top" ? { sort: "reactions" } : {});
		}
	};

	const sorts = discussions ? DISCUSSION_SORTS : ISSUE_SORTS;

	return (
		<ConfigSheet label="Edit list" onClose={() => (commit(), onClose())}>
			<header className="widget-config-head">
				<h3>Edit list</h3>
				<p>
					{discussions
						? `Discussions on ${config.host}, kept live for everyone looking.`
						: `Any search on ${config.host}, kept live for everyone looking.`}
				</p>
			</header>
			{discussionsHere && (
				<div className="widget-mode">
					<Segmented
						label="Show"
						stretch
						options={[
							{ value: "issues" as const, label: "Issues & PRs", icon: <IssuesIcon /> },
							{ value: "discussions" as const, label: "Discussions", icon: <DiscussionsIcon /> },
						]}
						value={mode}
						onChange={switchTo}
					/>
				</div>
			)}
			{discussions && (
				<DiscussionFields
					host={config.host}
					q={draft}
					sort={config.sort}
					filters={filters}
					categories={categories}
					suggestedRepo={suggestedRepo ?? null}
					onSearch={setSearch}
				/>
			)}
			{discussions && (
				<div className="widget-field">
					<span className="widget-field-label">Sort by</span>
					<SortControl
						sorts={DISCUSSION_SORTS}
						discussions
						sort={config.sort}
						sortTerm={sortTerm?.raw ?? null}
						onChange={(sort) => onChange({ sort })}
					/>
				</div>
			)}
			<label className="widget-field" htmlFor={`${id}-q`}>
				<span className="widget-field-label">{discussions ? "Search, as written" : "Search"}</span>
				<textarea
					id={`${id}-q`}
					className="mono"
					data-autofocus={discussions ? undefined : true}
					rows={2}
					value={draft}
					spellCheck={false}
					placeholder="repo:owner/name is:open label:bug"
					onChange={(event) => setDraft(event.target.value.replace(/\n/g, " "))}
					onBlur={commit}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							commit();
						}
					}}
				/>
			</label>
			{chips.length > 0 ? (
				<div className="widget-config-chips" aria-label="How Tack reads it">
					{chips.map((chip, i) => (
						<span
							key={`${i}:${chip.text}`}
							className="widget-chip mono"
							data-tone={chip.tone}
							data-negated={chip.negated || undefined}
						>
							{chip.text}
						</span>
					))}
				</div>
			) : (
				presets.length > 0 && (
					<div className="widget-config-presets">
						{presets.map((preset) => (
							<button
								key={preset.label}
								type="button"
								className="widget-preset"
								onClick={() => {
									setDraft(preset.q);
									onChange(presetConfig(preset, config));
								}}
							>
								{preset.label}
							</button>
						))}
					</div>
				)
			)}
			<QueryHelp
				q={draft}
				host={config.host}
				login={login}
				onUse={(q) => {
					setDraft(q);
					onChange({ q });
				}}
			/>
			{draft.trim() && (
				<ul className="widget-config-notes">
					<li>
						<RefreshIcon size={14} />
						{refreshNote(draft)}
					</li>
					<li data-tone={drop.ok ? undefined : "warn"}>
						{drop.ok ? <DropIcon size={14} /> : <WarnIcon size={14} />}
						{drop.text}
					</li>
				</ul>
			)}
			<label className="widget-field" htmlFor={`${id}-title`}>
				<span className="widget-field-label">Title</span>
				<input
					id={`${id}-title`}
					value={config.title}
					maxLength={120}
					placeholder={draft.trim() ? describeSearch(draft) : "Named after the search"}
					onChange={(event) => onChange({ title: event.target.value })}
					onKeyDown={(event) => event.key === "Enter" && onClose()}
				/>
			</label>
			{!discussions && (
				<div className="widget-field">
					<span className="widget-field-label">Sort by</span>
					<SortControl
						sorts={sorts}
						discussions={false}
						sort={config.sort}
						sortTerm={sortTerm?.raw ?? null}
						onChange={(sort) => onChange({ sort })}
					/>
				</div>
			)}
			<div className="widget-field-row">
				<div className="widget-field">
					<span className="widget-field-label">Show up to</span>
					<Segmented
						label="Show up to"
						options={LIMITS.map((limit) => ({ value: limit, label: String(limit) }))}
						value={config.limit}
						onChange={(limit) => onChange({ limit })}
					/>
				</div>
				<ForgeField value={config.host} onChange={(host) => onChange({ host })} />
			</div>
			<footer className="widget-config-foot">
				<button type="button" className="primary" onClick={() => (commit(), onClose())}>
					<CheckIcon size={14} />
					Done
				</button>
			</footer>
		</ConfigSheet>
	);
}

/** The order: turned off, and saying why, while the search's own `sort:` decides. */
function SortControl({
	sorts,
	discussions,
	sort,
	sortTerm,
	onChange,
}: {
	sorts: ListSort[];
	discussions: boolean;
	sort: ListSort;
	/** A `sort:` in the search, as written. */
	sortTerm: string | null;
	onChange: (sort: ListSort) => void;
}) {
	return (
		<>
			<Segmented
				label="Sort by"
				stretch={discussions}
				options={sorts.map((each) => ({
					value: each,
					label: (discussions && DISCUSSION_SORT_LABELS[each]) || SORT_LABELS[each],
				}))}
				value={sortShown(sort, discussions)}
				disabled={sortTerm !== null}
				onChange={onChange}
			/>
			{sortTerm ? (
				<span className="widget-field-note">
					The search's <span className="mono">{sortTerm}</span> decides the order.
				</span>
			) : (
				discussions &&
				sortShown(sort, true) === "top" && (
					<span className="widget-field-note">
						Most upvoted first, in order of their upvotes as they are now.
					</span>
				)
			)}
		</>
	);
}

/** The sort a mode's control shows: each mode's own name for "most popular". */
function sortShown(sort: ListSort, discussions: boolean): ListSort {
	if (discussions && sort === "reactions") return "top";
	if (!discussions && sort === "top") return "reactions";
	return sort;
}

/**
 * Discussions mode's controls: ready-made lists, repository, category,
 * answered, open or closed, labels. Each is read from the search and
 * written back into it, so the search stays the one truth.
 */
function DiscussionFields({
	host,
	q,
	sort,
	filters,
	categories,
	suggestedRepo,
	onSearch,
}: {
	host: string;
	q: string;
	sort: ListSort;
	filters: DiscussionFilters;
	categories: Loaded<RepoDiscussionCategory[]>;
	suggestedRepo: string | null;
	onSearch: (q: string, changes?: Partial<ListConfig>) => void;
}) {
	const id = useId();
	const list = categories.value;
	const set = (changes: Partial<DiscussionFilters>) => {
		const next = { ...filters, ...changes };
		// Unanswered means nothing in a category that takes no answers.
		if (!answersApply(list, next.category)) next.answered = "any";
		onSearch(writeDiscussionFilters(q, next));
	};
	const current = categoryNamed(list, filters.category);
	const answers = answersApply(list, filters.category);
	const answerable = (list ?? []).filter((category) => category.answerable);
	const labels = useRepoLabels(host, filters.repo);
	const repo = filters.repo ?? suggestedRepo;
	const presets = repo
		? listPresets(repo, null, { personal: false, categories: list }).filter((preset) =>
				isDiscussionSearch(preset.q),
			)
		: [];

	return (
		<div className="widget-discussion-fields">
			{presets.length > 0 && (
				<div className="widget-config-presets widget-mode-presets" aria-label="Ready-made">
					{presets.map((preset) => {
						const on =
							preset.q === q.trim() &&
							(preset.sort === undefined || sortShown(sort, true) === preset.sort);
						return (
							<button
								key={preset.label}
								type="button"
								className="widget-preset"
								aria-pressed={on}
								onClick={() => onSearch(preset.q, preset.sort ? { sort: preset.sort } : {})}
							>
								{preset.label}
							</button>
						);
					})}
				</div>
			)}
			<RepoField
				host={host}
				value={filters.repo}
				suggested={suggestedRepo}
				onChange={(next) =>
					set({ repo: next, category: next === filters.repo ? filters.category : null })
				}
			/>
			<div className="widget-field">
				<span className="widget-field-label" id={`${id}-category`}>
					Category
				</span>
				<div
					className="widget-categories"
					role="radiogroup"
					aria-labelledby={`${id}-category`}
					data-status={categories.status}
				>
					<CategoryOption
						checked={filters.category === null}
						onSelect={() => set({ category: null })}
					>
						All categories
					</CategoryOption>
					{(list ?? []).map((category) => (
						<CategoryOption
							key={category.name}
							checked={current?.name === category.name}
							title={category.description}
							onSelect={() => set({ category: category.name })}
						>
							{category.emoji && (
								<span className="widget-category-emoji" aria-hidden="true">
									{category.emoji}
								</span>
							)}
							{category.name}
						</CategoryOption>
					))}
					{filters.category && !current && (
						// Written in the search, but not one this repository is known to have.
						<CategoryOption checked onSelect={() => {}}>
							{filters.category}
						</CategoryOption>
					)}
					{categories.status === "loading" &&
						[0, 1, 2].map((i) => (
							<span
								key={i}
								className="widget-category-skeleton"
								style={{ "--i": i } as CSSProperties}
								aria-hidden="true"
							/>
						))}
				</div>
				{categories.status === "ready" && list?.length === 0 && (
					<span className="widget-field-note">
						{filters.repo ?? "This repository"} has no discussion categories. Are its Discussions
						turned on?
					</span>
				)}
				{categories.status === "unknown" && filters.repo && (
					<span className="widget-field-note">
						Couldn't read {filters.repo}'s categories: write one in the search, like{" "}
						<span className="mono">category:Ideas</span>.
					</span>
				)}
			</div>
			{answers ? (
				<div className="widget-field">
					<span className="widget-field-label">Answered</span>
					<Segmented
						label="Answered"
						stretch
						options={[
							{ value: "any" as const, label: "All" },
							{ value: "answered" as const, label: "Answered" },
							{ value: "unanswered" as const, label: "Unanswered" },
						]}
						value={filters.answered}
						onChange={(answered) => set({ answered })}
					/>
					{!filters.category && answerable.length > 0 && filters.answered !== "any" && (
						<span className="widget-field-note">
							Only {sentence(answerable.map(categoryName))}{" "}
							{answerable.length === 1 ? "takes" : "take"} answers.
						</span>
					)}
				</div>
			) : (
				<p className="widget-field-aside">
					<span className="widget-field-label">Answered</span>
					{current
						? `${categoryName(current)} doesn't take answers, so there's no answered or unanswered here.`
						: "No category here takes answers, so there's no answered or unanswered."}
				</p>
			)}
			<div className="widget-field">
				<span className="widget-field-label">State</span>
				<Segmented
					label="State"
					stretch
					options={[
						{ value: "open" as const, label: "Open" },
						{ value: "closed" as const, label: "Closed" },
						{ value: "all" as const, label: "All" },
					]}
					value={filters.state}
					onChange={(state) => set({ state })}
				/>
			</div>
			<LabelField
				labels={labels}
				value={filters.labels}
				onChange={(next) => set({ labels: next })}
			/>
		</div>
	);
}

/** A category as GitHub shows it: `🙏 Q&A`. */
function categoryName(category: RepoDiscussionCategory): string {
	return category.emoji ? `${category.emoji} ${category.name}` : category.name;
}

/** "a, b and c" */
function sentence(parts: string[]): string {
	if (parts.length <= 1) return parts[0] ?? "";
	return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function CategoryOption({
	checked,
	title,
	onSelect,
	children,
}: {
	checked: boolean;
	title?: string;
	onSelect: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			role="radio"
			className="widget-category"
			aria-checked={checked}
			title={title}
			onClick={onSelect}
		>
			{children}
		</button>
	);
}

/** The repository, `owner/name`: the board's own offered, committed on Enter or leaving. */
function RepoField({
	host,
	value,
	suggested,
	onChange,
}: {
	host: string;
	value: string | null;
	suggested: string | null;
	onChange: (repo: string | null) => void;
}) {
	const id = useId();
	const doc = useContext(DocContext);
	const [draft, setDraft] = useState(value ?? "");
	useEffect(() => setDraft(value ?? ""), [value]);
	const options = useMemo(() => {
		const repos = doc
			? boardRepos(doc)
					.map((entry) => entry.repo)
					.filter((repo) => repo.startsWith(`${host}/`))
					.map((repo) => repo.slice(host.length + 1))
			: [];
		return [...new Set([...(suggested ? [suggested] : []), ...repos])];
	}, [doc, host, suggested]);
	const valid = /^[\w.-]+\/[\w.-]+$/.test(draft.trim());
	const commit = () => {
		const next = draft.trim();
		if (next === (value ?? "")) return;
		if (!next) onChange(null);
		else if (valid) onChange(next);
	};
	return (
		<label className="widget-field" htmlFor={id}>
			<span className="widget-field-label">Repository</span>
			<input
				id={id}
				className="mono"
				data-autofocus
				value={draft}
				list={options.length > 0 ? `${id}-repos` : undefined}
				placeholder="owner/name"
				spellCheck={false}
				autoComplete="off"
				aria-invalid={draft.trim() !== "" && !valid ? true : undefined}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						commit();
					}
				}}
			/>
			{options.length > 0 && (
				<datalist id={`${id}-repos`}>
					{options.map((repo) => (
						<option key={repo} value={repo} />
					))}
				</datalist>
			)}
		</label>
	);
}

/** Labels it must have: chips to take away, and the repository's others to add. */
function LabelField({
	labels,
	value,
	onChange,
}: {
	labels: Loaded<Label[]>;
	value: string[];
	onChange: (labels: string[]) => void;
}) {
	const id = useId();
	const known = labels.value ?? [];
	const colour = (name: string) =>
		known.find((label) => label.name.toLowerCase() === name.toLowerCase())?.color;
	const others = known.filter(
		(label) => !value.some((name) => name.toLowerCase() === label.name.toLowerCase()),
	);
	return (
		<div className="widget-field">
			<span className="widget-field-label" id={`${id}-label`}>
				Labels
			</span>
			<div className="widget-labels" role="group" aria-labelledby={`${id}-label`}>
				{value.map((name) => {
					const color = colour(name);
					return (
						<span
							key={name}
							className="chip label widget-label-chip"
							style={color ? ({ "--label": `#${color}` } as CSSProperties) : undefined}
						>
							{name}
							<button
								type="button"
								aria-label={`Remove ${name}`}
								onClick={() => onChange(value.filter((each) => each !== name))}
							>
								<CrossIcon />
							</button>
						</span>
					);
				})}
				{others.length > 0 ? (
					<span className="widget-label-add">
						<select
							aria-label="Add a label"
							value=""
							onChange={(event) => {
								if (event.target.value) onChange([...value, event.target.value]);
							}}
						>
							<option value="">{value.length > 0 ? "+ Label" : "Any label  +"}</option>
							{others.map((label) => (
								<option key={label.name} value={label.name}>
									{label.name}
								</option>
							))}
						</select>
					</span>
				) : (
					value.length === 0 && (
						<span className="widget-labels-none">
							{labels.status === "loading" ? "Reading labels…" : "Any label"}
						</span>
					)
				)}
			</div>
		</div>
	);
}

export function Segmented<T extends string | number>({
	label,
	options,
	value,
	disabled = false,
	stretch = false,
	onChange,
}: {
	label: string;
	options: { value: T; label: string; title?: string; icon?: ReactNode }[];
	value: T;
	disabled?: boolean;
	/** As wide as the panel, its options sharing it. */
	stretch?: boolean;
	onChange: (value: T) => void;
}) {
	return (
		<div
			className="widget-segmented"
			role="radiogroup"
			aria-label={label}
			aria-disabled={disabled || undefined}
			data-stretch={stretch || undefined}
		>
			{options.map((option) => (
				<button
					key={String(option.value)}
					type="button"
					role="radio"
					title={option.title}
					aria-label={option.title}
					disabled={disabled}
					aria-checked={option.value === value}
					onClick={() => onChange(option.value)}
				>
					{option.icon}
					{option.label}
				</button>
			))}
		</div>
	);
}

// --- Generated from a schema -----------------------------------------------------

interface SchemaNode {
	type: string;
	entries?: Record<string, SchemaNode>;
	wrapped?: SchemaNode;
	options?: unknown[];
	pipe?: SchemaNode[];
	requirement?: unknown;
}

/** A field of an object schema, as a form control: strings, numbers, booleans and picklists. */
interface Field {
	key: string;
	kind: "string" | "number" | "boolean" | "picklist";
	options?: string[];
	min?: number;
	max?: number;
}

function unwrap(schema: SchemaNode): SchemaNode {
	let node = schema;
	while (node.wrapped) node = node.wrapped;
	return node;
}

/** The fields a config schema has that a form can edit. Anything else is left alone. */
export function schemaFields(schema: v.GenericSchema<unknown>): Field[] {
	const root = unwrap(schema as unknown as SchemaNode);
	if (root.type !== "object" || !root.entries) return [];
	return Object.entries(root.entries).flatMap(([key, entry]): Field[] => {
		const node = unwrap(entry);
		const actions = node.pipe ?? [];
		const bound = (type: string) =>
			actions.find((action) => action.type === type)?.requirement as number | undefined;
		switch (node.type) {
			case "string":
				return [{ key, kind: "string" }];
			case "number":
				return [{ key, kind: "number", min: bound("min_value"), max: bound("max_value") }];
			case "boolean":
				return [{ key, kind: "boolean" }];
			case "picklist":
				return [{ key, kind: "picklist", options: (node.options ?? []).map(String) }];
			default:
				return [];
		}
	});
}

function labelFor(key: string): string {
	const words = key.replace(/([A-Z])/g, " $1").toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A config form for any kind, generated from its schema. */
export function SchemaConfigPanel({
	title,
	schema,
	config,
	onChange,
	onClose,
}: {
	title: string;
	schema: v.GenericSchema<unknown>;
	config: Record<string, unknown>;
	onChange: (changes: Record<string, unknown>) => void;
	onClose: () => void;
}) {
	const id = useId();
	const fields = schemaFields(schema);
	return (
		<ConfigSheet label={`Edit ${title}`} onClose={onClose}>
			<header className="widget-config-head">
				<h3>Edit {title.toLowerCase()}</h3>
			</header>
			{fields.length === 0 && <p className="widget-config-empty">Nothing to set up.</p>}
			{fields.map((field) => {
				const value = config[field.key];
				const control = `${id}-${field.key}`;
				if (field.kind === "boolean") {
					return (
						<label key={field.key} className="widget-field widget-field-check" htmlFor={control}>
							<input
								id={control}
								type="checkbox"
								checked={value === true}
								onChange={(event) => onChange({ [field.key]: event.target.checked })}
							/>
							<span className="widget-field-label">{labelFor(field.key)}</span>
						</label>
					);
				}
				return (
					<label key={field.key} className="widget-field" htmlFor={control}>
						<span className="widget-field-label">{labelFor(field.key)}</span>
						{field.kind === "picklist" ? (
							<select
								id={control}
								value={typeof value === "string" ? value : ""}
								onChange={(event) => onChange({ [field.key]: event.target.value })}
							>
								{field.options?.map((option) => (
									<option key={option} value={option}>
										{option}
									</option>
								))}
							</select>
						) : (
							<input
								id={control}
								type={field.kind === "number" ? "number" : "text"}
								min={field.min}
								max={field.max}
								value={typeof value === "string" || typeof value === "number" ? value : ""}
								onChange={(event) =>
									onChange({
										[field.key]:
											field.kind === "number" ? Number(event.target.value) : event.target.value,
									})
								}
							/>
						)}
					</label>
				);
			})}
			<footer className="widget-config-foot">
				<button type="button" className="primary" onClick={onClose}>
					<CheckIcon size={14} />
					Done
				</button>
			</footer>
		</ConfigSheet>
	);
}
