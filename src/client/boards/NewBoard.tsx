import { type KeyboardEvent, useId, useMemo, useRef, useState } from "react";
import { parseRepoInput } from "../../shared/actions.ts";
import type { BoardExport } from "../../shared/boardExport.ts";
import type { BoardInfo, Visibility } from "../../shared/boards.ts";
import { DEFAULT_HOST } from "../../shared/refs.ts";
import { TEMPLATE_REPOS_MAX, type TemplateInfo } from "../../shared/templates.ts";
import { widgetDefinition } from "../../shared/widgetRegistry.ts";
import { repoName } from "../actions/selection.ts";
import { recentRepos } from "../actions/services.ts";
import { ImportDetails } from "../export/ImportBoard.tsx";
import { relativeTime } from "./api.ts";
import { BoardThumbnail } from "./BoardThumbnail.tsx";
import { PlusIcon, VisibilityIcon } from "./icons.tsx";
import { Modal } from "./Modal.tsx";
import {
	BUILT_IN_INFOS,
	type SavedTemplates,
	suggestedTitle,
	useSavedTemplates,
} from "./templates.ts";
import "./templates.css";

// The "New board" flow (#53): a gallery of templates, the built-ins first
// (Planning session biggest), then any saved on this instance, each drawn
// from its own content; and beside it what the chosen one has inside, its
// name, the repositories it should read, and last time's open action items
// to bring along. Everything's local but the saved list, which the home
// page fetched already, so it opens at once.

export interface NewBoardRequest {
	template: string | null;
	title: string;
	repos: string[];
	carryFrom: string | null;
	/** Who can open it, when there was a choice. */
	visibility?: Visibility;
	/** A board exported from Tack, to import (#59) rather than lay out a template. */
	imported?: BoardExport;
}

const BLANK = "blank";
const IMPORT = "import";
const COLUMNS = 3;

export function NewBoardDialog({
	open,
	onClose,
	...picker
}: Omit<NewBoardPickerProps, "onCancel"> & { open: boolean; onClose: () => void }) {
	const headingId = useId();
	return (
		<Modal open={open} onClose={onClose} className="new-board-dialog" labelledBy={headingId}>
			{(close) => <NewBoardPicker {...picker} headingId={headingId} onCancel={close} />}
		</Modal>
	);
}

export interface NewBoardPickerProps {
	/** Boards to carry action items over from: yours, most recent first. */
	boards: BoardInfo[];
	onCreate: (request: NewBoardRequest) => void;
	onCancel?: () => void;
	creating?: boolean;
	error?: string | null;
	/** Delete a saved template; resolves to whether it went. */
	onDelete?: (template: TemplateInfo) => Promise<boolean>;
	/** Which template to start on. */
	initial?: string;
	/**
	 * Who new boards are open to, to start with (the person's last choice),
	 * offering the choice. Absent where there's no choice: boards made
	 * signed out have no owner, so they're open to everyone.
	 */
	access?: Visibility;
	headingId?: string;
	/** The saved templates, for the gallery; the live page reads the shared library. */
	saved?: SavedTemplates;
	now?: number;
}

export function NewBoardPicker({
	boards,
	onCreate,
	onCancel,
	creating = false,
	error = null,
	onDelete,
	initial,
	access,
	headingId,
	saved: givenSaved,
	now,
}: NewBoardPickerProps) {
	// Kept while browsing templates: it's about the board, not the template.
	const [visibility, setVisibility] = useState(access);
	const library = useSavedTemplates();
	const saved = givenSaved ?? library;
	const savedList = saved.status === "ready" ? saved.templates : [];
	const all = useMemo(() => [...BUILT_IN_INFOS, ...savedList], [savedList]);
	const featured = BUILT_IN_INFOS.filter((t) => t.featured);
	const builtIns = BUILT_IN_INFOS.filter((t) => !t.featured);
	const order = useMemo(
		() => [
			...featured.map((t) => t.id),
			BLANK,
			...builtIns.map((t) => t.id),
			...savedList.map((t) => t.id),
			IMPORT,
		],
		[featured, builtIns, savedList],
	);

	const [chosenId, setChosen] = useState(initial ?? featured[0]?.id ?? BLANK);
	const chosen = all.find((t) => t.id === chosenId) ?? null;
	const grid = useRef<HTMLDivElement>(null);

	// Choosing with the keyboard: arrows through the tiles, Enter to make it.
	const onKey = (event: KeyboardEvent) => {
		const moves: Record<string, number> = {
			ArrowRight: 1,
			ArrowLeft: -1,
			ArrowDown: COLUMNS,
			ArrowUp: -COLUMNS,
		};
		const by = moves[event.key];
		if (by === undefined) return;
		event.preventDefault();
		const at = order.indexOf(chosenId);
		const next = order[Math.max(0, Math.min(order.length - 1, at + by))];
		if (!next) return;
		setChosen(next);
		grid.current?.querySelector<HTMLElement>(`[data-template="${CSS.escape(next)}"]`)?.focus();
	};

	return (
		<div className="new-board" data-creating={creating || undefined}>
			<div className="new-board-gallery" ref={grid} onKeyDown={onKey}>
				<header className="new-board-head">
					<h2 id={headingId}>New board</h2>
					<p>Start from a template made for the session you’re running, or from nothing at all.</p>
				</header>
				<div className="template-grid" role="listbox" aria-label="Templates">
					{featured.map((template, i) => (
						<TemplateTile
							key={template.id}
							template={template}
							index={i}
							chosen={chosenId === template.id}
							onChoose={() => setChosen(template.id)}
						/>
					))}
					<BlankTile index={1} chosen={chosenId === BLANK} onChoose={() => setChosen(BLANK)} />
					{builtIns.map((template, i) => (
						<TemplateTile
							key={template.id}
							template={template}
							index={i + 2}
							chosen={chosenId === template.id}
							onChoose={() => setChosen(template.id)}
						/>
					))}
				</div>
				<SavedSection saved={saved} chosenId={chosenId} onChoose={setChosen} now={now} />
				<section className="template-from-file" aria-label="From a file">
					<h3 className="template-section-title">From a file</h3>
					<div className="template-grid" role="listbox" aria-label="Import">
						<ImportTile chosen={chosenId === IMPORT} onChoose={() => setChosen(IMPORT)} />
					</div>
				</section>
			</div>
			{chosenId === IMPORT ? (
				<ImportDetails
					creating={creating}
					error={error}
					access={visibility && <AccessField value={visibility} onChange={setVisibility} />}
					onCancel={onCancel}
					onImport={(imported, title) =>
						onCreate({
							template: null,
							title,
							repos: [],
							carryFrom: null,
							imported,
							...(visibility ? { visibility } : {}),
						})
					}
				/>
			) : (
				<Details
					key={`${chosenId}:${chosen ? "ready" : "waiting"}`}
					template={chosen}
					boards={boards}
					creating={creating}
					error={error}
					visibility={visibility}
					onVisibility={setVisibility}
					onCancel={onCancel}
					onCreate={onCreate}
					onDelete={
						chosen && !chosen.builtIn && chosen.canDelete && onDelete
							? async () => {
									const gone = await onDelete(chosen);
									if (gone) setChosen(featured[0]?.id ?? BLANK);
								}
							: undefined
					}
					now={now}
				/>
			)}
		</div>
	);
}

/** Import a board exported from Tack (#59): its own tile, after the templates. */
function ImportTile({ chosen, onChoose }: { chosen: boolean; onChoose: () => void }) {
	return (
		<button
			type="button"
			role="option"
			aria-selected={chosen}
			className="template-tile import-tile"
			data-template={IMPORT}
			tabIndex={chosen ? 0 : -1}
			onClick={onChoose}
		>
			<span className="template-thumb">
				<svg width="34" height="34" viewBox="0 0 24 24" aria-hidden="true">
					<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
					<path d="M14 3v5h5M12 11v6M9.5 14.5 12 17l2.5-2.5" />
				</svg>
			</span>
			<span className="template-tile-body">
				<span className="template-tile-title">Import a board</span>
				<span className="template-tile-description">
					From a JSON export or a backup: everything on it, as a new board.
				</span>
			</span>
		</button>
	);
}

function SavedSection({
	saved,
	chosenId,
	onChoose,
	now,
}: {
	saved: SavedTemplates;
	chosenId: string;
	onChoose: (id: string) => void;
	now?: number;
}) {
	if (saved.status === "failed") return null;
	const list = saved.status === "ready" ? saved.templates : [];
	return (
		<section className="template-saved" aria-label="Saved on this Tack">
			<h3 className="template-section-title">Saved on this Tack</h3>
			{saved.status === "loading" ? (
				<div className="template-grid" aria-busy="true">
					{[0, 1, 2].map((i) => (
						<div
							key={i}
							className="template-tile template-skeleton"
							style={{ "--i": i } as React.CSSProperties}
						>
							<span className="template-thumb" />
							<span className="template-skeleton-line" />
							<span className="template-skeleton-line short" />
						</div>
					))}
				</div>
			) : list.length === 0 ? (
				<p className="template-none">
					Nothing yet. Save any board as a template from the board’s menu, and it’s here for
					everyone on this Tack.
				</p>
			) : (
				<div className="template-grid" role="listbox" aria-label="Saved templates">
					{list.map((template, i) => (
						<TemplateTile
							key={template.id}
							template={template}
							index={i}
							chosen={chosenId === template.id}
							onChoose={() => onChoose(template.id)}
							now={now}
						/>
					))}
				</div>
			)}
		</section>
	);
}

function TemplateTile({
	template,
	index,
	chosen,
	onChoose,
	now,
}: {
	template: TemplateInfo;
	index: number;
	chosen: boolean;
	onChoose: () => void;
	now?: number;
}) {
	const { summary } = template;
	return (
		<button
			type="button"
			role="option"
			aria-selected={chosen}
			className="template-tile"
			data-template={template.id}
			data-featured={template.featured || undefined}
			style={{ "--i": index } as React.CSSProperties}
			tabIndex={chosen ? 0 : -1}
			onClick={onChoose}
		>
			<span className="template-thumb">
				<BoardThumbnail thumbnail={template.thumbnail} />
				{template.featured && (
					<span className="template-badge" aria-hidden="true">
						Featured
					</span>
				)}
			</span>
			<span className="template-tile-body">
				<span className="template-tile-title">{template.title}</span>
				<span className="template-tile-description">{template.description}</span>
				<span className="template-tile-meta">
					{template.builtIn ? (
						<>
							{summary.sections > 0 && <span>{count(summary.sections, "section")}</span>}
							{summary.widgets > 0 && <span>{count(summary.widgets, "widget")}</span>}
							{summary.prepared > 0 && <span>{count(summary.prepared, "step")}</span>}
						</>
					) : (
						<span>
							{template.owner ? `By ${template.owner.name || template.owner.login}` : "Saved"}
							{template.createdAt ? ` · ${relativeTime(template.createdAt, now)}` : ""}
						</span>
					)}
				</span>
			</span>
		</button>
	);
}

function BlankTile({
	index,
	chosen,
	onChoose,
}: {
	index: number;
	chosen: boolean;
	onChoose: () => void;
}) {
	return (
		<button
			type="button"
			role="option"
			aria-selected={chosen}
			className="template-tile"
			data-template={BLANK}
			data-blank
			style={{ "--i": index } as React.CSSProperties}
			tabIndex={chosen ? 0 : -1}
			onClick={onChoose}
		>
			<span className="template-thumb">
				<BoardThumbnail thumbnail={null} />
			</span>
			<span className="template-tile-body">
				<span className="template-tile-title">Blank board</span>
				<span className="template-tile-description">
					An empty board: stickies, issues, sections and widgets as you go.
				</span>
			</span>
		</button>
	);
}

function count(n: number, one: string): string {
	return `${n} ${n === 1 ? one : `${one}s`}`;
}

/** Remembered as they're typed in, so the next board offers them. */
const REPOS_KEY = "tack:template-repos";

function rememberedRepos(): string[] {
	try {
		const value = JSON.parse(localStorage.getItem(REPOS_KEY) ?? "[]") as unknown;
		return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
}

export function rememberRepos(repos: string[]): void {
	try {
		const next = [...new Set([...repos, ...rememberedRepos()])].slice(0, 8);
		localStorage.setItem(REPOS_KEY, JSON.stringify(next));
	} catch {
		// Private browsing: nothing to remember with.
	}
}

function Details({
	template,
	boards,
	creating,
	error,
	visibility,
	onVisibility,
	onCancel,
	onCreate,
	onDelete,
	now,
}: {
	template: TemplateInfo | null;
	boards: BoardInfo[];
	creating: boolean;
	error: string | null;
	visibility?: Visibility;
	onVisibility: (visibility: Visibility) => void;
	onCancel?: () => void;
	onCreate: (request: NewBoardRequest) => void;
	onDelete?: () => Promise<void>;
	now?: number;
}) {
	const [title, setTitle] = useState(() => suggestedTitle(template, now));
	const spec = template?.repos ?? null;
	const [repos, setRepos] = useState<string[]>(() => spec?.defaults ?? []);
	const carryable = template?.collectsActions
		? boards.filter((board) => board.archivedAt === null)
		: [];
	const [carryFrom, setCarryFrom] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const titleId = useId();
	const missing = spec ? Math.max(0, spec.min - repos.length) : 0;
	const summary = template?.summary;
	const widgets = (summary?.widgetKinds ?? []).map((kind) => widgetDefinition(kind)?.title ?? kind);
	// Sections by name, repeats counted ("Theme: rename me ×3").
	const sections = [
		...(summary?.sectionTitles ?? []).reduce(
			(counts, name) => counts.set(name, (counts.get(name) ?? 0) + 1),
			new Map<string, number>(),
		),
	];

	const submit = () => {
		if (creating || missing > 0) return;
		if (repos.length > 0) rememberRepos(repos);
		onCreate({
			template: template?.id ?? null,
			title: title.trim(),
			repos,
			carryFrom,
			...(visibility ? { visibility } : {}),
		});
	};

	return (
		<aside className="new-board-details" aria-label={template ? template.title : "Blank board"}>
			<div className="template-preview">
				<BoardThumbnail thumbnail={template?.thumbnail ?? null} animate />
			</div>
			<h3 className="template-details-title">{template?.title ?? "Blank board"}</h3>
			<p className="template-details-description">
				{template?.description ??
					"Nothing on it yet. Add stickies, issues and pull requests, sections and widgets as you go."}
			</p>
			{summary && (
				<ul className="template-inside" aria-label="What’s inside">
					{sections.slice(0, 6).map(([name, n], i) => (
						<li key={`s${i}`} data-kind="section" style={{ "--i": i } as React.CSSProperties}>
							{name}
							{n > 1 && <span className="template-inside-times">×{n}</span>}
						</li>
					))}
					{sections.length > 6 && <li data-kind="more">+{sections.length - 6} more</li>}
					{widgets.map((name, i) => (
						<li key={`w${i}`} data-kind="widget" style={{ "--i": i + 6 } as React.CSSProperties}>
							{name}
						</li>
					))}
					{summary.rules > 0 && (
						<li data-kind="rule">{summary.rules === 1 ? "A rule" : `${summary.rules} rules`}</li>
					)}
					{summary.prepared > 0 && (
						<li data-kind="steps">
							{summary.prepared === 1 ? "A step" : `${summary.prepared} steps`} ready to start
						</li>
					)}
				</ul>
			)}

			<form
				className="new-board-form"
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
			>
				<label className="new-board-field" htmlFor={titleId}>
					<span>Name</span>
					<input
						id={titleId}
						value={title}
						placeholder="Untitled board"
						maxLength={120}
						onChange={(event) => setTitle(event.target.value)}
					/>
				</label>
				{spec && <RepoField spec={spec} repos={repos} onChange={setRepos} />}
				{visibility && <AccessField value={visibility} onChange={onVisibility} />}
				{carryable.length > 0 && (
					<label className="new-board-field">
						<span>Bring open action items from</span>
						<select
							value={carryFrom ?? ""}
							onChange={(event) => setCarryFrom(event.target.value || null)}
						>
							<option value="">Nowhere: start fresh</option>
							{carryable.slice(0, 20).map((board) => (
								<option key={board.id} value={board.id}>
									{board.title}
								</option>
							))}
						</select>
					</label>
				)}
				{error && (
					<p className="new-board-error" role="alert">
						{error}
					</p>
				)}
				<div className="new-board-actions">
					{onDelete &&
						(confirmDelete ? (
							<span className="template-delete-confirm">
								Delete for everyone?
								<button
									type="button"
									className="template-delete-yes"
									onClick={() => void onDelete()}
								>
									Delete
								</button>
								<button type="button" onClick={() => setConfirmDelete(false)}>
									Keep
								</button>
							</span>
						) : (
							<button
								type="button"
								className="template-delete"
								onClick={() => setConfirmDelete(true)}
							>
								Delete template
							</button>
						))}
					<span className="new-board-actions-end">
						{onCancel && (
							<button type="button" className="new-board-cancel" onClick={onCancel}>
								Cancel
							</button>
						)}
						<button
							type="submit"
							className="primary new-board-create"
							disabled={creating || missing > 0}
							aria-busy={creating}
							title={
								missing > 0
									? `Add ${missing === 1 ? "a repository" : `${missing} repositories`} first`
									: undefined
							}
						>
							{creating ? (
								<>
									<span className="new-board-spinner" aria-hidden="true" />
									Laying it out…
								</>
							) : (
								<>
									<PlusIcon />
									Create board
								</>
							)}
						</button>
					</span>
				</div>
			</form>
		</aside>
	);
}

const ACCESS_CHOICES: { value: Visibility; label: string; hint: string }[] = [
	{ value: "instance", label: "Everyone on this Tack", hint: "can open and edit it" },
	{ value: "private", label: "Only people I invite", hint: "until you share it" },
];

/** Who can open the new board: a choice, remembered for next time. */
function AccessField({
	value,
	onChange,
}: {
	value: Visibility;
	onChange: (value: Visibility) => void;
}) {
	const name = useId();
	return (
		<fieldset className="new-board-field new-board-access">
			<legend>Who can open it</legend>
			<div className="new-board-access-choices">
				{ACCESS_CHOICES.map((choice) => (
					<label key={choice.value} data-checked={value === choice.value || undefined}>
						<input
							type="radio"
							name={name}
							value={choice.value}
							checked={value === choice.value}
							onChange={() => onChange(choice.value)}
						/>
						<VisibilityIcon visibility={choice.value} size={15} />
						<span>
							<strong>{choice.label}</strong>
							<small>{choice.hint}</small>
						</span>
					</label>
				))}
			</div>
		</fieldset>
	);
}

/** Repositories for a template: chips, typed in as `owner/name`, with recent ones offered. */
function RepoField({
	spec,
	repos,
	onChange,
}: {
	spec: NonNullable<TemplateInfo["repos"]>;
	repos: string[];
	onChange: (repos: string[]) => void;
}) {
	const [text, setText] = useState("");
	const [invalid, setInvalid] = useState(false);
	const id = useId();
	const max = Math.min(spec.max, TEMPLATE_REPOS_MAX);
	const full = repos.length >= max;
	const suggestions = useMemo(
		() =>
			[...new Set([...(spec.defaults ?? []), ...rememberedRepos(), ...recentRepos()])]
				.filter((repo) => !repos.includes(repo))
				.slice(0, 4),
		[spec.defaults, repos],
	);
	const add = (repo: string) => {
		if (full || repos.includes(repo)) return;
		onChange([...repos, repo]);
	};
	const commit = () => {
		const repo = parseRepoInput(text, DEFAULT_HOST);
		if (!repo) {
			if (text.trim()) setInvalid(true);
			return false;
		}
		add(repo);
		setText("");
		return true;
	};

	return (
		<div className="new-board-field" data-invalid={invalid || undefined}>
			<label htmlFor={id}>
				{max === 1 ? "Repository" : "Repositories"}
				{spec.min === 0 && <span className="new-board-optional"> · optional</span>}
			</label>
			<div className="repo-chips">
				{repos.map((repo, i) => (
					<span key={repo} className="repo-chip" data-first={i === 0 || undefined}>
						{repoName(repo)}
						<button
							type="button"
							aria-label={`Remove ${repoName(repo)}`}
							onClick={() => onChange(repos.filter((r) => r !== repo))}
						>
							×
						</button>
					</span>
				))}
				{!full && (
					<input
						id={id}
						value={text}
						placeholder={repos.length ? "Add another" : "owner/repo"}
						autoComplete="off"
						spellCheck={false}
						onChange={(event) => {
							setText(event.target.value);
							setInvalid(false);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter" || event.key === "," || event.key === " ") {
								if (!text.trim()) return;
								event.preventDefault();
								commit();
							} else if (event.key === "Backspace" && !text && repos.length > 0) {
								onChange(repos.slice(0, -1));
							}
						}}
						onBlur={() => {
							if (text.trim()) commit();
						}}
					/>
				)}
			</div>
			<span className="new-board-hint">
				{invalid
					? "That doesn’t look like owner/repo"
					: (spec.hint ?? "Its widgets, inboxes and rules read these")}
			</span>
			{suggestions.length > 0 && !full && (
				<span className="repo-suggestions">
					{suggestions.map((repo) => (
						<button key={repo} type="button" className="repo-suggestion" onClick={() => add(repo)}>
							+ {repoName(repo)}
						</button>
					))}
				</span>
			)}
		</div>
	);
}
