import {
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { Card } from "../../shared/cards.ts";
import {
	type ReleaseConfig,
	type ReleaseDraft,
	draftRelease,
	releaseMarkdown,
	sentence,
} from "../../shared/releaseDraft.ts";
import type { ReleaseResult } from "../../shared/widgets.ts";
import { StateIcon } from "../CardView.tsx";
import { scaledDuration } from "../motion.ts";
import {
	QueryErrorEmpty,
	WidgetEmpty,
	WidgetFoot,
	WidgetShell,
	type WidgetState,
	copyText,
	useNow,
} from "./chrome.tsx";
import { ago } from "./describe.ts";
import { CheckIcon, PinIcon } from "./icons.tsx";
import { CopyIcon, MarkdownIcon, ReleaseIcon } from "./kindIcons.tsx";
import "./release.css";

// The release draft widget (#43), drawn without the board around it so the
// gallery can show every state: what's merged since the latest release in
// sections by label, the version it suggests and why, who to thank, and
// notes in Markdown, previewed in place and copied with one click.

export interface ReleaseViewProps {
	title: string;
	config: ReleaseConfig;
	state: WidgetState<ReleaseResult>;
	now?: number;
	selected?: boolean;
	readOnly?: boolean;
	enter?: boolean;
	refreshing?: boolean;
	/** Show the Markdown instead (the gallery). */
	preview?: boolean;
	linked?: string | null;
	lifted?: string | null;
	onBoard?: (key: string) => boolean;
	onRefresh?: () => void;
	onConfigure?: () => void;
	onItemPointerDown?: (event: ReactPointerEvent<HTMLElement>, card: Card) => void;
	onItemHover?: (key: string | null) => void;
	onReveal?: (key: string) => void;
	/** Notes were copied (for a toast). */
	onCopied?: (draft: ReleaseDraft) => void;
	suggestions?: { label: string; repo: string }[];
	onSuggest?: (repo: string) => void;
}

/** Each section's colour, by what its title says it holds. */
function tone(title: string): string {
	const t = title.toLowerCase();
	if (/break/.test(t)) return "break";
	if (/feat|new|enhance/.test(t)) return "feature";
	if (/fix|bug/.test(t)) return "fix";
	if (/doc/.test(t)) return "docs";
	return "other";
}

export function ReleaseView(props: ReleaseViewProps) {
	const { state, config } = props;
	const now = useNow(props.now);
	const result = state.kind === "ready" ? state.value : null;
	const draft = useMemo(() => (result ? draftRelease(result, config) : null), [result, config]);
	const notes = useMemo(
		() =>
			draft && result ? releaseMarkdown(draft, result, { contributors: config.contributors }) : "",
		[draft, result, config.contributors],
	);
	const [preview, setPreview] = useState(props.preview ?? false);
	const latest = result?.latest ?? null;
	const subtitle = result ? (
		latest ? (
			<>
				<span>since</span>
				<a
					className="release-tag mono nodrag nopan"
					href={latest.url}
					target="_blank"
					rel="noreferrer"
					draggable={false}
				>
					{latest.tag}
				</a>
				<span>· {ago(Date.parse(latest.publishedAt), now)}</span>
			</>
		) : (
			<span>No releases yet: everything merged so far</span>
		)
	) : config.repo ? (
		<span className="mono">{config.repo}</span>
	) : undefined;

	return (
		<WidgetShell
			kind="release"
			icon={<ReleaseIcon />}
			title={props.title}
			subtitle={subtitle}
			count={draft?.count ?? null}
			status={state.kind}
			stale={state.kind === "ready" && state.stale}
			selected={props.selected}
			enter={props.enter}
			readOnly={props.readOnly}
			refreshing={props.refreshing}
			onRefresh={props.onRefresh}
			onConfigure={props.onConfigure}
			configureLabel="Edit release draft"
			tools={
				draft && draft.count > 0 ? (
					<button
						type="button"
						className="widget-tool"
						aria-label={preview ? "Show pull requests" : "Preview notes"}
						aria-pressed={preview}
						data-tooltip={preview ? "Show pull requests" : "Preview notes"}
						onClick={() => setPreview((on) => !on)}
					>
						<MarkdownIcon />
					</button>
				) : undefined
			}
			far={
				draft
					? {
							value: draft.next ?? String(draft.count),
							label: draft.next
								? `${draft.count} merged since ${latest?.tag ?? "the start"}`
								: `merged since ${latest?.tag ?? "the start"}`,
						}
					: undefined
			}
			footer={
				state.kind === "ready" && draft ? (
					<WidgetFoot
						at={state.at}
						stale={state.stale}
						refreshing={props.refreshing}
						now={props.now}
						onRefresh={props.onRefresh}
					>
						{draft.count > 0 && (
							<CopyButton text={notes} onCopied={() => props.onCopied?.(draft)} />
						)}
					</WidgetFoot>
				) : undefined
			}
		>
			<Body {...props} now={now} draft={draft} notes={notes} preview={preview} />
		</WidgetShell>
	);
}

function Body(
	props: ReleaseViewProps & {
		now: number;
		draft: ReleaseDraft | null;
		notes: string;
		preview: boolean;
	},
) {
	const { state, draft } = props;
	switch (state.kind) {
		case "unconfigured":
			return (
				<WidgetEmpty
					icon={<ReleaseIcon size={20} />}
					title="Which repository is releasing?"
					detail="Tack gathers what's merged since its latest release into notes, sorted by label."
				>
					{props.suggestions && props.suggestions.length > 0 && (
						<div className="widget-presets nodrag nopan">
							{props.suggestions.map((suggestion) => (
								<button
									key={suggestion.repo}
									type="button"
									className="widget-preset"
									disabled={props.readOnly}
									onClick={() => props.onSuggest?.(suggestion.repo)}
								>
									{suggestion.label}
								</button>
							))}
						</div>
					)}
					{!props.readOnly && props.onConfigure && (
						<button type="button" className="widget-action" onClick={props.onConfigure}>
							Choose a repository
						</button>
					)}
				</WidgetEmpty>
			);
		case "loading":
			return <Skeleton />;
		case "error":
			return (
				<QueryErrorEmpty
					error={state.error}
					noun="this release"
					now={props.now}
					readOnly={props.readOnly}
					onRefresh={props.onRefresh}
					onConfigure={props.onConfigure}
				/>
			);
		case "ready":
			if (!draft || draft.count === 0) {
				return (
					<WidgetEmpty
						icon={<CheckIcon size={20} />}
						tone="good"
						title="All caught up"
						detail={
							state.value.latest
								? `Nothing's been merged since ${state.value.latest.tag}. Merged pull requests show up here as they land.`
								: "Nothing's been merged yet. Merged pull requests show up here as they land."
						}
					/>
				);
			}
			return props.preview ? (
				<Markdown text={props.notes} />
			) : (
				<Draft {...props} draft={draft} result={state.value} />
			);
	}
}

const BUMP_WORDS = { major: "Breaking", minor: "New features", patch: "Fixes only" } as const;

function Draft(
	props: ReleaseViewProps & { draft: ReleaseDraft; result: ReleaseResult; now: number },
) {
	const { draft, result } = props;
	let order = 0;
	return (
		<div className="release">
			{draft.next && result.latest && (
				<div className="release-next" data-bump={draft.bump}>
					<span className="release-version mono">{result.latest.tag}</span>
					<span className="release-arrow" aria-hidden="true" />
					<span className="release-version release-version-next mono">{draft.next}</span>
					<span className="release-bump" title={`A ${draft.bump} release`}>
						{BUMP_WORDS[draft.bump]}
					</span>
				</div>
			)}
			{draft.sections.map((section) => (
				<section key={section.title} className="release-section" data-tone={tone(section.title)}>
					<h4 className="release-section-title">
						<span className="release-section-dot" aria-hidden="true" />
						{section.title}
						<span className="release-section-count">{section.items.length}</span>
					</h4>
					<ul className="release-rows">
						{section.items.map((card) => (
							<Row key={card.key} card={card} order={order++} {...props} />
						))}
					</ul>
				</section>
			))}
			{props.config.contributors && draft.contributors.length > 0 && (
				<div className="release-people">
					<span className="release-avatars">
						{draft.contributors.slice(0, 6).map((person, i) => (
							<img
								key={person.login}
								src={person.avatarUrl}
								alt={person.login}
								title={`@${person.login}: ${person.count} pull request${person.count === 1 ? "" : "s"}`}
								draggable={false}
								style={{ "--i": i } as React.CSSProperties}
							/>
						))}
					</span>
					<span className="release-thanks">
						Thanks to{" "}
						{sentence(
							draft.contributors.length > 4
								? [
										...draft.contributors.slice(0, 3).map((c) => `@${c.login}`),
										`${draft.contributors.length - 3} others`,
									]
								: draft.contributors.map((c) => `@${c.login}`),
						)}
					</span>
				</div>
			)}
			{draft.skipped.length > 0 && (
				<p className="release-skipped">
					{draft.skipped.length} left out by label ({props.config.skip.slice(0, 2).join(", ")}
					{props.config.skip.length > 2 ? "…" : ""})
				</p>
			)}
		</div>
	);
}

function Row({
	card,
	order,
	readOnly,
	linked,
	lifted,
	onBoard,
	onItemPointerDown,
	onItemHover,
	onReveal,
}: ReleaseViewProps & { card: Card; order: number }) {
	const on = onBoard?.(card.key) ?? false;
	return (
		<li
			className="release-row nodrag nopan"
			data-state={card.state}
			data-linked={linked === card.key || undefined}
			data-lifted={lifted === card.key || undefined}
			data-on-board={on || undefined}
			data-draggable={!readOnly || undefined}
			style={{ "--i": Math.min(order, 12) } as React.CSSProperties}
			title={readOnly ? undefined : "Drag onto the board to add a card"}
			onPointerEnter={() => onItemHover?.(card.key)}
			onPointerLeave={() => onItemHover?.(null)}
			onPointerDown={(event) => onItemPointerDown?.(event, card)}
		>
			<span className="state-icon" aria-hidden="true">
				<StateIcon card={card} size={13} />
			</span>
			<span className="release-row-title">{card.title}</span>
			<span className="release-row-ref mono">{card.item}</span>
			{on ? (
				<button
					type="button"
					className="widget-row-marker"
					aria-label={`${card.item} is on the board: show it`}
					onPointerDown={(event) => event.stopPropagation()}
					onClick={() => onReveal?.(card.key)}
				>
					<PinIcon />
				</button>
			) : card.author ? (
				<img
					className="release-row-author"
					src={card.author.avatarUrl}
					alt={card.author.login}
					title={`@${card.author.login}`}
					draggable={false}
				/>
			) : (
				<span />
			)}
		</li>
	);
}

/** The notes as they'll read, lightly tinted: headings, mentions and references. */
function Markdown({ text }: { text: string }) {
	const lines = text.split("\n");
	return (
		<pre className="release-markdown" aria-label="Release notes">
			{lines.map((line, i) => (
				<span key={i} className="release-md-line" data-kind={lineKind(line)}>
					{tint(line)}
					{"\n"}
				</span>
			))}
		</pre>
	);
}

function lineKind(line: string): string | undefined {
	if (line.startsWith("## ")) return "h2";
	if (line.startsWith("### ")) return "h3";
	if (line.startsWith("- ")) return "item";
	if (line.startsWith("**")) return "link";
	return undefined;
}

function tint(line: string) {
	const parts = line.split(/(@[\w-]+(?:\[bot\])?|\(#\d+\)|\([\w.-]+\/[\w.-]+#\d+\))/g);
	return parts.map((part, i) =>
		part.startsWith("@") ? (
			<span key={i} className="release-md-mention">
				{part}
			</span>
		) : /^\(.*#\d+\)$/.test(part) ? (
			<span key={i} className="release-md-ref">
				{part}
			</span>
		) : (
			part
		),
	);
}

/** Copy the notes: the button says it did, then settles back. */
function CopyButton({ text, onCopied }: { text: string; onCopied?: () => void }) {
	const [copied, setCopied] = useState(0);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	return (
		<button
			type="button"
			className="release-copy nodrag nopan"
			data-copied={copied > 0 || undefined}
			onClick={async () => {
				if (!(await copyText(text))) return;
				setCopied((n) => n + 1);
				onCopied?.();
				clearTimeout(timer.current);
				timer.current = setTimeout(() => setCopied(0), scaledDuration(1800));
			}}
		>
			<span className="release-copy-icon" key={copied} aria-hidden="true">
				{copied > 0 ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
			</span>
			{copied > 0 ? "Copied" : "Copy notes"}
		</button>
	);
}

function Skeleton() {
	return (
		<div className="release" aria-busy="true" aria-label="Loading">
			<div className="release-next release-next-skeleton">
				<span className="skeleton" style={{ width: 56 }} />
				<span className="skeleton" style={{ width: 56 }} />
			</div>
			{[3, 2, 2].map((rows, s) => (
				<section key={s} className="release-section">
					<span className="skeleton release-skeleton-title" />
					<ul className="release-rows">
						{Array.from({ length: rows }, (_, i) => (
							<li
								key={i}
								className="release-row widget-row-skeleton"
								style={{ "--i": s * 3 + i } as React.CSSProperties}
							>
								<span className="skeleton widget-skeleton-dot" />
								<span className="skeleton" style={{ width: `${70 - i * 12}%` }} />
							</li>
						))}
					</ul>
				</section>
			))}
		</div>
	);
}
