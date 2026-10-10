import { useEffect, useId, useState } from "react";
import {
	DEPENDENCY_LIMITS,
	type DependencyConfig,
	type DependencySource,
} from "../../shared/dependencyMap.ts";
import {
	DEFAULT_SECTIONS,
	DEFAULT_SKIP,
	type ReleaseConfig,
	type ReleaseSection,
} from "../../shared/releaseDraft.ts";
import {
	TIMELINE_EVENTS,
	TIMELINE_RANGES,
	type TimelineConfig,
	type TimelineEvent,
	type TimelineRange,
	eventWord,
	isoDay,
	timelineRange,
	timelineSearch,
} from "../../shared/timeline.ts";
import { ConfigSheet, Segmented } from "./ConfigPanel.tsx";
import { ForgeField, QueryHelp } from "./QueryHelp.tsx";
import { queryChips, refreshNote } from "./describe.ts";
import { CheckIcon, RefreshIcon, SearchIcon } from "./icons.tsx";
import { parseSearch } from "../../shared/search.ts";

// Config panels for the timeline, release draft and dependency map (#43).
// Searches and other text are committed on Enter or leaving the field, not
// on every keystroke: each change runs the widget's queries again for
// everyone looking.

const RANGE_LABELS: Record<TimelineRange, string> = {
	"1w": "Week",
	"2w": "2 weeks",
	"1m": "Month",
	"3m": "3 months",
	fixed: "Dates",
};

/** A text field that commits when you press Enter or leave it. */
function useDraft(value: string, commit: (value: string) => void) {
	const [draft, setDraft] = useState(value);
	useEffect(() => setDraft(value), [value]);
	const flush = () => {
		if (draft.trim() !== value.trim()) commit(draft.trim());
	};
	return {
		value: draft,
		flush,
		props: {
			value: draft,
			onChange: (event: { target: { value: string } }) =>
				setDraft(event.target.value.replace(/\n/g, " ")),
			onBlur: flush,
			onKeyDown: (event: React.KeyboardEvent) => {
				if (event.key !== "Enter") return;
				event.preventDefault();
				flush();
			},
		},
	};
}

function Done({ onClick }: { onClick: () => void }) {
	return (
		<footer className="widget-config-foot">
			<button type="button" className="primary" onClick={onClick}>
				<CheckIcon size={14} />
				Done
			</button>
		</footer>
	);
}

// --- Timeline -----------------------------------------------------------------------

export function TimelineConfigPanel({
	config,
	onChange,
	onClose,
	suggestedRepo,
	now = Date.now(),
}: {
	config: TimelineConfig;
	onChange: (changes: Partial<TimelineConfig>) => void;
	onClose: () => void;
	suggestedRepo?: string | null;
	now?: number;
}) {
	const id = useId();
	const q = useDraft(config.q, (value) => onChange({ q: value }));
	const range = timelineRange(config, now);
	const search = timelineSearch({ ...config, q: q.value || "repo:owner/name" }, now);
	return (
		<ConfigSheet label="Edit timeline" onClose={() => (q.flush(), onClose())}>
			<header className="widget-config-head">
				<h3>Edit timeline</h3>
				<p>Items along a line, by when they were opened, closed, merged or updated.</p>
			</header>
			<label className="widget-field" htmlFor={`${id}-q`}>
				<span className="widget-field-label">What to follow</span>
				<input
					id={`${id}-q`}
					className="mono"
					data-autofocus
					spellCheck={false}
					placeholder="repo:owner/name"
					{...q.props}
				/>
			</label>
			<QueryHelp q={q.value} host={config.host} onUse={(value) => onChange({ q: value })} />
			{!q.value.trim() && suggestedRepo && (
				<div className="widget-config-presets">
					<button
						type="button"
						className="widget-preset"
						onClick={() => onChange({ q: `repo:${suggestedRepo}` })}
					>
						repo:{suggestedRepo}
					</button>
				</div>
			)}
			<div className="widget-field">
				<span className="widget-field-label">Plot when they were</span>
				<Segmented<TimelineEvent>
					label="Plot when they were"
					options={TIMELINE_EVENTS.map((event) => ({ value: event, label: eventWord(event) }))}
					value={config.event}
					onChange={(event) => onChange({ event })}
				/>
			</div>
			<div className="widget-field">
				<span className="widget-field-label">Over</span>
				<Segmented<TimelineRange>
					label="Over"
					options={TIMELINE_RANGES.map((value) => ({ value, label: RANGE_LABELS[value] }))}
					value={config.range}
					onChange={(value) =>
						onChange(
							value === "fixed" && !config.from
								? { range: value, from: isoDay(range.from), to: isoDay(range.to - 86_400_000) }
								: { range: value },
						)
					}
				/>
			</div>
			{config.range === "fixed" && (
				<div className="widget-field-row">
					<label className="widget-field" htmlFor={`${id}-from`}>
						<span className="widget-field-label">From</span>
						<input
							id={`${id}-from`}
							type="date"
							value={config.from}
							onChange={(event) => onChange({ from: event.target.value })}
						/>
					</label>
					<label className="widget-field" htmlFor={`${id}-to`}>
						<span className="widget-field-label">To</span>
						<input
							id={`${id}-to`}
							type="date"
							value={config.to}
							onChange={(event) => onChange({ to: event.target.value })}
						/>
					</label>
				</div>
			)}
			{search && (
				<ul className="widget-config-notes">
					<li>
						<SearchIcon size={14} />
						<span className="widget-config-query" aria-label="The search it runs">
							{queryChips(parseSearch(search.q)).map((chip, i) => (
								<span
									key={`${i}:${chip.text}`}
									className="widget-chip mono"
									data-tone={chip.tone}
									data-negated={chip.negated || undefined}
								>
									{chip.text}
								</span>
							))}
						</span>
					</li>
					<li>
						<RefreshIcon size={14} />
						{config.range === "fixed"
							? refreshNote(q.value)
							: `${refreshNote(q.value)} The range moves on each day.`}
					</li>
				</ul>
			)}
			<div className="widget-field-row">
				<label className="widget-field" htmlFor={`${id}-title`}>
					<span className="widget-field-label">Title</span>
					<input
						id={`${id}-title`}
						value={config.title}
						maxLength={120}
						placeholder="Named after what it shows"
						onChange={(event) => onChange({ title: event.target.value })}
					/>
				</label>
				<ForgeField value={config.host} onChange={(host) => onChange({ host })} />
			</div>
			<Done onClick={() => (q.flush(), onClose())} />
		</ConfigSheet>
	);
}

// --- Release draft -------------------------------------------------------------------

const splitLabels = (text: string) =>
	text
		.split(",")
		.map((label) => label.trim())
		.filter(Boolean);

export function ReleaseConfigPanel({
	config,
	onChange,
	onClose,
	suggestedRepo,
}: {
	config: ReleaseConfig;
	onChange: (changes: Partial<ReleaseConfig>) => void;
	onClose: () => void;
	suggestedRepo?: string | null;
}) {
	const id = useId();
	const repo = useDraft(config.repo, (value) =>
		onChange({ repo: value.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "") }),
	);
	const skip = useDraft(config.skip.join(", "), (value) => onChange({ skip: splitLabels(value) }));
	const setSection = (i: number, changes: Partial<ReleaseSection>) =>
		onChange({
			sections: config.sections.map((section, j) =>
				i === j ? { ...section, ...changes } : section,
			),
		});
	return (
		<ConfigSheet label="Edit release draft" onClose={() => (repo.flush(), skip.flush(), onClose())}>
			<header className="widget-config-head">
				<h3>Edit release draft</h3>
				<p>What's merged since the latest release, sorted into sections by label.</p>
			</header>
			<div className="widget-field-row">
				<label className="widget-field" htmlFor={`${id}-repo`}>
					<span className="widget-field-label">Repository</span>
					<input
						id={`${id}-repo`}
						className="mono"
						data-autofocus
						spellCheck={false}
						placeholder="owner/name"
						{...repo.props}
					/>
				</label>
				<ForgeField value={config.host} onChange={(host) => onChange({ host })} />
			</div>
			{!repo.value.trim() && suggestedRepo && (
				<div className="widget-config-presets">
					<button
						type="button"
						className="widget-preset"
						onClick={() => onChange({ repo: suggestedRepo })}
					>
						{suggestedRepo}
					</button>
				</div>
			)}
			<div className="widget-field">
				<span className="widget-field-label">Sections, by label</span>
				<ul className="release-config-sections">
					{config.sections.map((section, i) => (
						<li key={i} style={{ "--i": i } as React.CSSProperties}>
							<SectionTitle title={section.title} onChange={(title) => setSection(i, { title })} />
							<SectionLabels
								labels={section.labels}
								onChange={(labels) => setSection(i, { labels })}
							/>
							<button
								type="button"
								className="widget-tool"
								aria-label={`Remove ${section.title}`}
								disabled={config.sections.length <= 1}
								onClick={() => onChange({ sections: config.sections.filter((_, j) => j !== i) })}
							>
								×
							</button>
						</li>
					))}
				</ul>
				<div className="release-config-more">
					<button
						type="button"
						className="widget-preset"
						disabled={config.sections.length >= 12}
						onClick={() =>
							onChange({
								sections: [
									...config.sections.slice(0, -1),
									{ title: "New section", labels: ["label"] },
									...config.sections.slice(-1),
								],
							})
						}
					>
						Add a section
					</button>
					{JSON.stringify(config.sections) !== JSON.stringify(DEFAULT_SECTIONS) && (
						<button
							type="button"
							className="widget-preset"
							onClick={() => onChange({ sections: DEFAULT_SECTIONS })}
						>
							Reset
						</button>
					)}
				</div>
				<p className="widget-field-hint">
					A pull request goes in the first section with one of its labels. A section without labels
					takes the rest.
				</p>
			</div>
			<label className="widget-field" htmlFor={`${id}-skip`}>
				<span className="widget-field-label">Leave out pull requests labelled</span>
				<input
					id={`${id}-skip`}
					className="mono"
					placeholder={DEFAULT_SKIP.join(", ")}
					{...skip.props}
				/>
			</label>
			<div className="widget-field-row">
				<label className="widget-field" htmlFor={`${id}-title`}>
					<span className="widget-field-label">Title</span>
					<input
						id={`${id}-title`}
						value={config.title}
						maxLength={120}
						placeholder="Named after the repository"
						onChange={(event) => onChange({ title: event.target.value })}
					/>
				</label>
				<label className="widget-field widget-field-check" htmlFor={`${id}-people`}>
					<input
						id={`${id}-people`}
						type="checkbox"
						checked={config.contributors}
						onChange={(event) => onChange({ contributors: event.target.checked })}
					/>
					<span className="widget-field-label">Thank contributors</span>
				</label>
			</div>
			<Done onClick={() => (repo.flush(), skip.flush(), onClose())} />
		</ConfigSheet>
	);
}

function SectionTitle({ title, onChange }: { title: string; onChange: (title: string) => void }) {
	// An empty title would make the sections invalid: keep the old one.
	const draft = useDraft(title, (value) => value && onChange(value));
	return <input aria-label="Section" maxLength={60} {...draft.props} />;
}

function SectionLabels({
	labels,
	onChange,
}: {
	labels: string[];
	onChange: (labels: string[]) => void;
}) {
	const draft = useDraft(labels.join(", "), (value) => onChange(splitLabels(value)));
	return (
		<input aria-label="Labels" className="mono" placeholder="Everything else" {...draft.props} />
	);
}

// --- Dependency map --------------------------------------------------------------------

export function DependencyConfigPanel({
	config,
	sections,
	onChange,
	onClose,
	suggestedRepo,
}: {
	config: DependencyConfig;
	/** The board's sections, to map one's cards. */
	sections: { id: string; title: string; cards: number }[];
	onChange: (changes: Partial<DependencyConfig>) => void;
	onClose: () => void;
	suggestedRepo?: string | null;
}) {
	const id = useId();
	const q = useDraft(config.q, (value) => onChange({ q: value }));
	return (
		<ConfigSheet label="Edit dependency map" onClose={() => (q.flush(), onClose())}>
			<header className="widget-config-head">
				<h3>Edit dependency map</h3>
				<p>Tack asks each item what blocks it, and draws the graph.</p>
			</header>
			<div className="widget-field">
				<span className="widget-field-label">Map</span>
				<Segmented<DependencySource>
					label="Map"
					options={[
						{ value: "search", label: "A search" },
						{ value: "section", label: "A section's cards" },
					]}
					value={config.source}
					onChange={(source) => onChange({ source })}
				/>
			</div>
			{config.source === "search" ? (
				<>
					<label className="widget-field" htmlFor={`${id}-q`}>
						<span className="widget-field-label">Search</span>
						<textarea
							id={`${id}-q`}
							className="mono"
							data-autofocus
							rows={2}
							spellCheck={false}
							placeholder="repo:owner/name is:issue is:open"
							{...q.props}
						/>
					</label>
					<QueryHelp q={q.value} host={config.host} onUse={(value) => onChange({ q: value })} />
					{!q.value.trim() && suggestedRepo && (
						<div className="widget-config-presets">
							<button
								type="button"
								className="widget-preset"
								onClick={() => onChange({ q: `repo:${suggestedRepo} is:issue is:open` })}
							>
								Open issues in {suggestedRepo.split("/").at(-1)}
							</button>
						</div>
					)}
				</>
			) : (
				<label className="widget-field" htmlFor={`${id}-section`}>
					<span className="widget-field-label">Section</span>
					<select
						id={`${id}-section`}
						value={config.section}
						onChange={(event) => onChange({ section: event.target.value })}
					>
						<option value="">Choose a section…</option>
						{sections.map((section) => (
							<option key={section.id} value={section.id}>
								{section.title || "Untitled section"} ({section.cards}{" "}
								{section.cards === 1 ? "card" : "cards"})
							</option>
						))}
					</select>
				</label>
			)}
			<div className="widget-field-row">
				<div className="widget-field">
					<span className="widget-field-label">Ask about up to</span>
					<Segmented
						label="Ask about up to"
						options={[10, 20, DEPENDENCY_LIMITS.max].map((limit) => ({
							value: limit,
							label: String(limit),
						}))}
						value={config.limit}
						onChange={(limit) => onChange({ limit })}
					/>
				</div>
				{config.source === "search" && (
					<ForgeField value={config.host} onChange={(host) => onChange({ host })} />
				)}
			</div>
			<label className="widget-field" htmlFor={`${id}-title`}>
				<span className="widget-field-label">Title</span>
				<input
					id={`${id}-title`}
					value={config.title}
					maxLength={120}
					placeholder="Named after what it maps"
					onChange={(event) => onChange({ title: event.target.value })}
				/>
			</label>
			<Done onClick={() => (q.flush(), onClose())} />
		</ConfigSheet>
	);
}
