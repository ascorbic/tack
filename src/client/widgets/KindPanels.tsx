import { type CSSProperties, useEffect, useId, useMemo, useState } from "react";
import {
	STALE_DAYS,
	type MilestoneConfig,
	dueOf,
	milestoneSearch,
} from "../../shared/milestone.ts";
import {
	REVIEW_SCOPES,
	type ReviewConfig,
	type ReviewScope,
	reviewSearch,
	reviewTitle,
} from "../../shared/review.ts";
import { parseSearch } from "../../shared/search.ts";
import { type StaleConfig, STALE_THRESHOLD, spanText, staleTitle } from "../../shared/stale.ts";
import type { MetaState } from "../actions/services.ts";
import { ConfigSheet, Segmented } from "./ConfigPanel.tsx";
import { queryChips, refreshNote } from "./describe.ts";
import { CheckIcon, MilestoneIcon, RefreshIcon, WarnIcon } from "./icons.tsx";
import { ForgeField, QueryHelp } from "./QueryHelp.tsx";

// Config panels for the review queue, milestone and stale finder (#43).
// Every change is written as it's made (they're small, and each runs the
// widget's search again for everyone looking), except searches typed out
// in full, which are committed on Enter or leaving the field, as a list's.

const LIMITS = [10, 30, 50, 100];

/** A span as a segment says it, short enough not to wrap: "2w", "30d", "3mo". */
function shortSpan(days: number): string {
	if (days >= 60 && days % 30 === 0) return `${days / 30}mo`;
	if (days < 28 && days % 7 === 0) return `${days / 7}w`;
	return `${days}d`;
}

/** A text field that commits on Enter or blur, not on every keystroke. */
function useDraft(value: string, commit: (value: string) => void) {
	const [draft, setDraft] = useState(value);
	useEffect(() => setDraft(value), [value]);
	return {
		draft,
		setDraft,
		commit: () => {
			if (draft.trim() !== value.trim()) commit(draft.trim());
		},
	};
}

function Done({ onClose }: { onClose: () => void }) {
	return (
		<footer className="widget-config-foot">
			<button type="button" className="primary" onClick={onClose}>
				<CheckIcon size={14} />
				Done
			</button>
		</footer>
	);
}

/** The search a widget runs, shown as chips, so there are no surprises. */
function Runs({ q, label = "Searches" }: { q: string | null; label?: string }) {
	const chips = useMemo(() => (q ? queryChips(parseSearch(q)) : []), [q]);
	if (!q) return null;
	return (
		<div className="widget-field">
			<span className="widget-field-label">{label}</span>
			<div className="widget-config-chips kind-runs" aria-label="The search it runs">
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
		</div>
	);
}

// --- Review queue -----------------------------------------------------------------

const SCOPE_LABELS: Record<ReviewScope, string> = {
	me: "Waiting on me",
	team: "A team",
	repo: "A repository",
};

export function ReviewConfigPanel({
	config,
	suggestedRepo,
	onChange,
	onClose,
}: {
	config: ReviewConfig;
	suggestedRepo?: string | null;
	onChange: (changes: Partial<ReviewConfig>) => void;
	onClose: () => void;
}) {
	const id = useId();
	const team = useDraft(config.team, (value) => onChange({ team: value.replace(/^@/, "") }));
	const repo = useDraft(config.repo, (value) => onChange({ repo: value }));
	const q = reviewSearch(config);
	const close = () => {
		team.commit();
		repo.commit();
		onClose();
	};
	return (
		<ConfigSheet label="Edit review queue" onClose={close}>
			<header className="widget-config-head">
				<h3>Edit review queue</h3>
				<p>Open pull requests waiting for review, oldest first.</p>
			</header>
			<div className="widget-field">
				<span className="widget-field-label">Waiting on</span>
				<Segmented
					label="Waiting on"
					options={REVIEW_SCOPES.map((scope) => ({ value: scope, label: SCOPE_LABELS[scope] }))}
					value={config.scope}
					onChange={(scope) =>
						onChange(
							scope === "repo" && !config.repo && suggestedRepo
								? { scope, repo: suggestedRepo }
								: { scope },
						)
					}
				/>
			</div>
			{config.scope === "team" && (
				<label className="widget-field kind-reveal" htmlFor={`${id}-team`}>
					<span className="widget-field-label">Team</span>
					<input
						id={`${id}-team`}
						className="mono"
						data-autofocus
						value={team.draft}
						placeholder="org/team"
						spellCheck={false}
						onChange={(event) => team.setDraft(event.target.value)}
						onBlur={team.commit}
						onKeyDown={(event) => event.key === "Enter" && team.commit()}
					/>
				</label>
			)}
			{config.scope === "repo" && (
				<label className="widget-field kind-reveal" htmlFor={`${id}-repo`}>
					<span className="widget-field-label">Repository</span>
					<input
						id={`${id}-repo`}
						className="mono"
						data-autofocus
						value={repo.draft}
						placeholder="owner/name"
						spellCheck={false}
						onChange={(event) => repo.setDraft(event.target.value)}
						onBlur={repo.commit}
						onKeyDown={(event) => event.key === "Enter" && repo.commit()}
					/>
				</label>
			)}
			<Runs q={q} />
			{!q && (
				<ul className="widget-config-notes">
					<li data-tone="warn">
						<WarnIcon size={14} />
						{config.scope === "team"
							? "Name the team as org/team, as GitHub does."
							: "Name the repository as owner/name."}
					</li>
				</ul>
			)}
			<label className="widget-field widget-field-check" htmlFor={`${id}-drafts`}>
				<input
					id={`${id}-drafts`}
					type="checkbox"
					checked={config.drafts}
					onChange={(event) => onChange({ drafts: event.target.checked })}
				/>
				<span className="widget-field-label">Include drafts</span>
			</label>
			<label className="widget-field" htmlFor={`${id}-title`}>
				<span className="widget-field-label">Title</span>
				<input
					id={`${id}-title`}
					value={config.title}
					maxLength={120}
					placeholder={reviewTitle({ ...config, title: "" })}
					onChange={(event) => onChange({ title: event.target.value })}
					onKeyDown={(event) => event.key === "Enter" && close()}
				/>
			</label>
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
			<Done onClose={close} />
		</ConfigSheet>
	);
}

// --- Milestone -------------------------------------------------------------------

const STALE_CHOICES = [7, 14, 30];

export function MilestoneConfigPanel({
	config,
	meta,
	suggestedRepo,
	now = Date.now(),
	onChange,
	onClose,
}: {
	config: MilestoneConfig;
	/** The repository's milestones, as the pickers load them. */
	meta: MetaState;
	suggestedRepo?: string | null;
	now?: number;
	onChange: (changes: Partial<MilestoneConfig>) => void;
	onClose: () => void;
}) {
	const id = useId();
	// Until it has its own, the board's busiest repository, as the widget itself offers.
	const current = config.repo || suggestedRepo || "";
	const repo = useDraft(current, (value) =>
		onChange({ repo: value, ...(value !== config.repo ? { milestone: "" } : {}) }),
	);
	const milestones = meta.status === "ready" ? meta.meta.milestones : [];
	const picked = config.milestone;
	const close = () => {
		repo.commit();
		onClose();
	};
	return (
		<ConfigSheet label="Edit milestone" onClose={close}>
			<header className="widget-config-head">
				<h3>Edit milestone</h3>
				<p>Its progress, pace and due date, and the open items most at risk.</p>
			</header>
			<label className="widget-field" htmlFor={`${id}-repo`}>
				<span className="widget-field-label">Repository</span>
				<input
					id={`${id}-repo`}
					className="mono"
					data-autofocus={!config.repo || undefined}
					value={repo.draft}
					placeholder={suggestedRepo ?? "owner/name"}
					spellCheck={false}
					onChange={(event) => repo.setDraft(event.target.value)}
					onBlur={repo.commit}
					onKeyDown={(event) => event.key === "Enter" && repo.commit()}
				/>
			</label>
			<div className="widget-field">
				<span className="widget-field-label">Milestone</span>
				{!current ? (
					<p className="kind-hint">Name a repository to see its milestones.</p>
				) : meta.status === "loading" || meta.status === "idle" ? (
					<div className="milestone-picks" aria-busy="true">
						<span className="skeleton" />
						<span className="skeleton" />
					</div>
				) : milestones.length === 0 ? (
					<p className="kind-hint">
						{meta.status === "unknown"
							? "Couldn't load its milestones. Type one's title below."
							: "It has no open milestones."}
					</p>
				) : (
					<div className="milestone-picks" role="radiogroup" aria-label="Milestone">
						{milestones.map((milestone, i) => {
							const due = dueOf(milestone.dueOn, now);
							return (
								<button
									key={milestone.title}
									type="button"
									role="radio"
									aria-checked={picked === milestone.title}
									className="milestone-pick"
									style={{ "--i": i } as CSSProperties}
									onClick={() =>
										onChange({
											milestone: milestone.title,
											...(config.repo ? {} : { repo: current }),
										})
									}
								>
									<MilestoneIcon size={14} />
									<strong>{milestone.title}</strong>
									<span data-due={due.tone}>{due.text}</span>
								</button>
							);
						})}
					</div>
				)}
				{current && meta.status === "unknown" && (
					<input
						aria-label="Milestone title"
						value={config.milestone}
						placeholder="v1.0"
						onChange={(event) => onChange({ milestone: event.target.value })}
					/>
				)}
			</div>
			<Runs q={milestoneSearch(config, "open")?.replace(/ is:open$/, "") ?? null} />
			<div className="widget-field">
				<span className="widget-field-label">At risk when quiet for</span>
				<Segmented
					label="At risk when quiet for"
					options={[...new Set([...STALE_CHOICES, config.staleDays])]
						.filter((d) => d >= STALE_DAYS.min && d <= STALE_DAYS.max)
						.sort((a, b) => a - b)
						.map((days) => ({ value: days, label: shortSpan(days), title: spanText(days) }))}
					value={config.staleDays}
					onChange={(staleDays) => onChange({ staleDays })}
				/>
			</div>
			<div className="widget-field-row">
				<label className="widget-field" htmlFor={`${id}-title`}>
					<span className="widget-field-label">Title</span>
					<input
						id={`${id}-title`}
						value={config.title}
						maxLength={120}
						placeholder={config.milestone || "Named after the milestone"}
						onChange={(event) => onChange({ title: event.target.value })}
						onKeyDown={(event) => event.key === "Enter" && close()}
					/>
				</label>
				<ForgeField value={config.host} onChange={(host) => onChange({ host })} />
			</div>
			<Done onClose={close} />
		</ConfigSheet>
	);
}

// --- Stale finder ------------------------------------------------------------------

const THRESHOLDS = [14, 30, 60, 90, 180];

export function StaleConfigPanel({
	config,
	presets,
	labels,
	login = null,
	onChange,
	onClose,
}: {
	config: StaleConfig;
	/** Ready-made searches. */
	presets: { label: string; q: string }[];
	/** Labels the repository has, to suggest. */
	labels?: string[];
	/** Who's editing it, signed in: offered in place of `@me`. */
	login?: string | null;
	onChange: (changes: Partial<StaleConfig>) => void;
	onClose: () => void;
}) {
	const id = useId();
	const search = useDraft(config.q, (q) => onChange({ q }));
	const chips = useMemo(() => queryChips(parseSearch(search.draft)), [search.draft]);
	const close = () => {
		search.commit();
		onClose();
	};
	return (
		<ConfigSheet label="Edit stale finder" onClose={close}>
			<header className="widget-config-head">
				<h3>Edit stale finder</h3>
				<p>
					Items with no activity for a while, with quick ways to tidy them up. Nothing changes until
					it's pushed.
				</p>
			</header>
			<label className="widget-field" htmlFor={`${id}-q`}>
				<span className="widget-field-label">Look through</span>
				<textarea
					id={`${id}-q`}
					className="mono"
					data-autofocus
					rows={2}
					value={search.draft}
					spellCheck={false}
					placeholder="repo:owner/name is:open"
					onChange={(event) => search.setDraft(event.target.value.replace(/\n/g, " "))}
					onBlur={search.commit}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							search.commit();
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
				<div className="widget-config-presets">
					{presets.map((preset) => (
						<button
							key={preset.label}
							type="button"
							className="widget-preset"
							onClick={() => {
								search.setDraft(preset.q);
								onChange({ q: preset.q });
							}}
						>
							{preset.label}
						</button>
					))}
				</div>
			)}
			<QueryHelp
				q={search.draft}
				host={config.host}
				login={login}
				onUse={(q) => {
					search.setDraft(q);
					onChange({ q });
				}}
			/>
			<div className="widget-field">
				<span className="widget-field-label">Quiet for at least</span>
				<Segmented
					label="Quiet for at least"
					options={[...new Set([...THRESHOLDS, config.days])]
						.filter((d) => d >= STALE_THRESHOLD.min && d <= STALE_THRESHOLD.max)
						.sort((a, b) => a - b)
						.map((days) => ({ value: days, label: shortSpan(days), title: spanText(days) }))}
					value={config.days}
					onChange={(days) => onChange({ days })}
				/>
			</div>
			{search.draft.trim() && (
				<ul className="widget-config-notes">
					<li>
						<RefreshIcon size={14} />
						{refreshNote(search.draft)}
					</li>
				</ul>
			)}
			<div className="widget-field-row">
				<label className="widget-field" htmlFor={`${id}-label`}>
					<span className="widget-field-label">Label to add</span>
					<input
						id={`${id}-label`}
						value={config.label}
						maxLength={50}
						list={`${id}-labels`}
						placeholder="stale"
						onChange={(event) => onChange({ label: event.target.value })}
					/>
					<datalist id={`${id}-labels`}>
						{labels?.map((label) => (
							<option key={label} value={label} />
						))}
					</datalist>
				</label>
				<ForgeField value={config.host} onChange={(host) => onChange({ host })} />
			</div>
			<label className="widget-field" htmlFor={`${id}-title`}>
				<span className="widget-field-label">Title</span>
				<input
					id={`${id}-title`}
					value={config.title}
					maxLength={120}
					placeholder={staleTitle({ ...config, title: "" })}
					onChange={(event) => onChange({ title: event.target.value })}
					onKeyDown={(event) => event.key === "Enter" && close()}
				/>
			</label>
			<Done onClose={close} />
		</ConfigSheet>
	);
}
