import { useMemo, useState } from "react";
import type { Card } from "../../shared/cards.ts";
import {
	type DependencyConfig,
	dependencyWidget,
	relatedName,
} from "../../shared/dependencyMap.ts";
import { type ReleaseConfig, releaseTitle, releaseWidget } from "../../shared/releaseDraft.ts";
import { type TimelineConfig, timelineTitle, timelineWidget } from "../../shared/timeline.ts";
import { readConfig } from "../../shared/widgetRegistry.ts";
import type { QueryError, QueryResult, ReleaseResult, SearchResult } from "../../shared/widgets.ts";
import { cardStore } from "../cardStore.ts";
import type { WidgetState } from "../widgets/chrome.tsx";
import { DependencyView } from "../widgets/DependencyView.tsx";
import { dependencyState } from "../widgets/kinds.tsx";
import {
	DependencyConfigPanel,
	ReleaseConfigPanel,
	TimelineConfigPanel,
} from "../widgets/panels.tsx";
import { ReleaseView } from "../widgets/ReleaseView.tsx";
import { TimelineView } from "../widgets/TimelineView.tsx";
import { LOADED, LATEST_RELEASE, RELEASE_PULLS, relatedOf } from "./roadmap.ts";
import { REPO, WIDGET_CARDS } from "./widgets.ts";

// The timeline, release draft and dependency map in every state (#43), for
// the widget gallery: not set up, loading, live, stale, empty, failing,
// view-only and zoomed far out, and their config panels.

const NOW = Date.UTC(2026, 9, 9, 14, 30);
const MIN = 60_000;
const DAY = 86_400_000;
const HOST = "fake.tack";

/** The playground's fixtures are dated from when it loaded: move them to the gallery's “now”. */
const shift = NOW - LOADED;
const move = (at: string | null | undefined) =>
	at ? new Date(Date.parse(at) + shift).toISOString() : at;
const retime = (card: Card): Card => ({
	...card,
	createdAt: move(card.createdAt) ?? undefined,
	closedAt: move(card.closedAt),
	mergedAt: move(card.mergedAt),
});
const ITEMS = [...WIDGET_CARDS, ...RELEASE_PULLS].map(retime);
const PULLS = RELEASE_PULLS.map(retime);

const search = (items: Card[], total = items.length): SearchResult => ({
	kind: "search",
	total,
	items,
});
const ready = <T,>(value: T, at = NOW - 2 * MIN, stale = false): WidgetState<T> => ({
	kind: "ready",
	value,
	at,
	stale,
});
const failed = (
	reason: QueryError["reason"],
	message: string,
	retryAt?: number,
): WidgetState<never> => ({
	kind: "error",
	error: { kind: "error", reason, message, ...(retryAt ? { retryAt } : {}) },
});

/** A busy quarter: lots of issues opened around two launches, to show clusters. */
const BUSY: Card[] = Array.from({ length: 64 }, (_, i) => {
	const burst = i < 26 ? 62 : i < 48 ? 20 : 4 + (i % 9) * 6;
	const created = NOW - (burst + ((i * 7) % 11) / 10) * DAY;
	const base = ITEMS[i % ITEMS.length] as Card;
	return {
		...base,
		key: `fake.tack/${REPO}#${300 + i}`,
		item: `#${300 + i}`,
		title: `${base.title.split(":")[0]} (${i + 1})`,
		createdAt: new Date(created).toISOString(),
		state: i % 4 === 0 ? "closed" : "open",
		kind: i % 5 === 0 ? "pull" : "issue",
	};
});

const timelineConfig = (overrides: Partial<TimelineConfig> = {}): TimelineConfig =>
	readConfig(timelineWidget, { host: HOST, q: `repo:${REPO}`, range: "1m", ...overrides });

const releaseConfig = (overrides: Partial<ReleaseConfig> = {}): ReleaseConfig =>
	readConfig(releaseWidget, { host: HOST, repo: REPO, ...overrides });

const release = (
	mergedSince: Card[],
	latest: ReleaseResult["latest"] = LATEST_RELEASE,
): ReleaseResult => ({
	kind: "release",
	repo: `${HOST}/${REPO}`,
	latest: latest && { ...latest, publishedAt: new Date(NOW - 23 * DAY).toISOString() },
	mergedSince,
});

const LAUNCH = [425, 413, 426, 408, 431, 427, 419, 415, 410, 414, 429, 420].map(
	(n) => `fake.tack/${REPO}#${n}`,
);

/** A dependency map's results, as the server would send them for these items. */
function relatedResults(
	keys: string[],
	drop: string[] = [],
): Record<string, QueryResult | QueryError> {
	const lookup = (key: string) => ITEMS.find((card) => card.key === key);
	return Object.fromEntries(
		keys
			.filter((key) => !drop.includes(key))
			.map((key) => [relatedName(key), relatedOf(key, lookup)]),
	);
}

const sectionConfig: DependencyConfig = readConfig(dependencyWidget, {
	source: "section",
	section: "launch",
});
const searchConfig: DependencyConfig = readConfig(dependencyWidget, {
	host: HOST,
	q: `repo:${REPO} is:issue is:open`,
});

function mapState(
	config: DependencyConfig,
	results: Record<string, QueryResult | QueryError>,
	inSection: string[] = [],
	stale = false,
) {
	return dependencyState(
		config,
		{ results, at: NOW - (stale ? 30 * MIN : 3 * MIN) },
		inSection,
		NOW,
	);
}

interface Sample {
	label: string;
	width: number;
	height: number;
	far?: boolean;
	render: () => React.ReactNode;
}

/** How far out the zoomed-out samples are, as on a board at about 30%. */
const FAR = 3.4;

function Samples({ samples }: { samples: Sample[] }) {
	return (
		<div className="roadmap-samples">
			{samples.map((sample) => {
				const widget = (
					<div
						className="widget-sample roadmap-sample"
						data-far-zoom={sample.far || undefined}
						style={
							{
								width: sample.width,
								height: sample.height,
								...(sample.far ? { "--unzoom": FAR, scale: 1 / FAR, transformOrigin: "0 0" } : {}),
							} as React.CSSProperties
						}
					>
						{sample.render()}
					</div>
				);
				return (
					<figure key={sample.label} data-state={sample.label}>
						{sample.far ? (
							<div
								className="roadmap-far"
								style={{ width: sample.width / FAR, height: sample.height / FAR }}
							>
								{widget}
							</div>
						) : (
							widget
						)}
						<figcaption>{sample.label}</figcaption>
					</figure>
				);
			})}
		</div>
	);
}

export function RoadmapGallery() {
	useState(() => {
		for (const card of ITEMS) cardStore.set(card);
		return null;
	});
	const [timeline, setTimeline] = useState(
		timelineConfig({ range: "fixed", from: "2026-09-14", to: "2026-10-09" }),
	);
	const [releaseDraft, setReleaseDraft] = useState(releaseConfig());
	const [map, setMap] = useState<DependencyConfig>(sectionConfig);
	const states = useMemo(() => {
		const all = relatedResults(LAUNCH);
		return {
			launch: mapState(sectionConfig, all, LAUNCH),
			pending: mapState(sectionConfig, relatedResults(LAUNCH, LAUNCH.slice(6)), LAUNCH),
			search: mapState(
				searchConfig,
				{
					items: search(
						ITEMS.filter((card) => card.state === "open" && card.kind === "issue").slice(0, 14),
					),
					...relatedResults(
						ITEMS.filter((card) => card.state === "open" && card.kind === "issue")
							.slice(0, 14)
							.map((card) => card.key),
					),
				},
				[],
				true,
			),
			loose: mapState(searchConfig, {
				items: search(ITEMS.filter((card) => ["#416", "#417", "#422", "#424"].includes(card.item))),
				...relatedResults(
					ITEMS.filter((card) => ["#416", "#417", "#422", "#424"].includes(card.item)).map(
						(card) => card.key,
					),
				),
			}),
		};
	}, []);
	const view = { now: NOW, onRefresh: () => {}, onConfigure: () => {} };
	const created = timelineConfig();

	const timelines: Sample[] = [
		{
			label: "Timeline: not set up",
			width: 720,
			height: 300,
			render: () => (
				<TimelineView
					{...view}
					title="New timeline"
					config={timelineConfig({ q: "" })}
					state={{ kind: "unconfigured" }}
					suggestions={[{ label: "Opened in unpic", q: `repo:${REPO}` }]}
					selected
				/>
			),
		},
		{
			label: "Timeline: loading",
			width: 720,
			height: 300,
			render: () => (
				<TimelineView
					{...view}
					title={timelineTitle(created, NOW)}
					config={created}
					state={{ kind: "loading" }}
				/>
			),
		},
		{
			label: "Timeline: opened in the last month",
			width: 720,
			height: 320,
			render: () => (
				<TimelineView
					{...view}
					title={timelineTitle(created, NOW)}
					config={created}
					state={ready(search(ITEMS.filter((card) => card.createdAt)))}
					onBoard={(key) => key.endsWith("#425") || key.endsWith("#413")}
				/>
			),
		},
		{
			label: "Timeline: a busy quarter, clustered",
			width: 720,
			height: 280,
			render: () => {
				const config = timelineConfig({ range: "3m", title: "Opened this quarter" });
				return (
					<TimelineView
						{...view}
						title={timelineTitle(config, NOW)}
						config={config}
						state={ready(search(BUSY, 212))}
					/>
				);
			},
		},
		{
			label: "Timeline: merged, stale",
			width: 520,
			height: 280,
			render: () => {
				const config = timelineConfig({ event: "merged", range: "2w" });
				return (
					<TimelineView
						{...view}
						title={timelineTitle(config, NOW)}
						config={config}
						state={ready(search(PULLS), NOW - 26 * MIN, true)}
					/>
				);
			},
		},
		{
			label: "Timeline: nothing in range",
			width: 520,
			height: 240,
			render: () => {
				const config = timelineConfig({ event: "closed", range: "1w" });
				return (
					<TimelineView
						{...view}
						title={timelineTitle(config, NOW)}
						config={config}
						state={ready(search([]))}
					/>
				);
			},
		},
		{
			label: "Timeline: rate limited",
			width: 520,
			height: 260,
			render: () => (
				<TimelineView
					{...view}
					title={timelineTitle(created, NOW)}
					config={created}
					state={failed("rate_limited", "API rate limit exceeded.", NOW + 4 * MIN)}
				/>
			),
		},
		{
			label: "Timeline: zoomed far out",
			width: 720,
			height: 320,
			far: true,
			render: () => (
				<TimelineView
					{...view}
					title={timelineTitle(created, NOW)}
					config={created}
					state={ready(search(ITEMS.filter((card) => card.createdAt)))}
				/>
			),
		},
	];

	const draft = releaseConfig();
	const releases: Sample[] = [
		{
			label: "Release: not set up",
			width: 400,
			height: 360,
			render: () => (
				<ReleaseView
					{...view}
					title="Release draft"
					config={releaseConfig({ repo: "" })}
					state={{ kind: "unconfigured" }}
					suggestions={[{ label: REPO, repo: REPO }]}
				/>
			),
		},
		{
			label: "Release: loading",
			width: 400,
			height: 520,
			render: () => (
				<ReleaseView
					{...view}
					title={releaseTitle(draft)}
					config={draft}
					state={{ kind: "loading" }}
				/>
			),
		},
		{
			label: "Release: the next release's draft",
			width: 400,
			height: 620,
			render: () => (
				<ReleaseView
					{...view}
					title={releaseTitle(draft)}
					config={draft}
					state={ready(release(PULLS))}
					onBoard={(key) => key.endsWith("#443")}
				/>
			),
		},
		{
			label: "Release: the notes, previewed",
			width: 400,
			height: 620,
			render: () => (
				<ReleaseView
					{...view}
					title={releaseTitle(draft)}
					config={draft}
					state={ready(release(PULLS))}
					preview
				/>
			),
		},
		{
			label: "Release: a breaking change, stale",
			width: 400,
			height: 420,
			render: () => (
				<ReleaseView
					{...view}
					title="Next major"
					config={draft}
					state={ready(
						release([
							{
								...(PULLS[3] as Card),
								title: "Drop Node 18 support",
								labels: [{ name: "breaking", color: "b60205" }],
							},
							...PULLS.slice(4, 6),
						]),
						NOW - 40 * MIN,
						true,
					)}
				/>
			),
		},
		{
			label: "Release: all caught up",
			width: 400,
			height: 320,
			render: () => (
				<ReleaseView
					{...view}
					title={releaseTitle(draft)}
					config={draft}
					state={ready(release([]))}
				/>
			),
		},
		{
			label: "Release: the first release",
			width: 400,
			height: 420,
			render: () => (
				<ReleaseView
					{...view}
					title="First release"
					config={releaseConfig({ contributors: false })}
					state={ready(release(PULLS.slice(0, 5), null))}
					readOnly
				/>
			),
		},
		{
			label: "Release: can't read the repository",
			width: 400,
			height: 320,
			render: () => (
				<ReleaseView
					{...view}
					title={releaseTitle(draft)}
					config={draft}
					state={failed("no_access", "It doesn't exist, or you can't see it.")}
				/>
			),
		},
		{
			label: "Release: zoomed far out",
			width: 400,
			height: 520,
			far: true,
			render: () => (
				<ReleaseView
					{...view}
					title={releaseTitle(draft)}
					config={draft}
					state={ready(release(PULLS))}
				/>
			),
		},
	];

	const launchTitle = "Dependencies in 5.0 launch";
	const maps: Sample[] = [
		{
			label: "Map: not set up",
			width: 600,
			height: 320,
			render: () => (
				<DependencyView
					{...view}
					title="New dependency map"
					source="A search"
					state={{ kind: "unconfigured" }}
					suggestions={[
						{ label: "Open issues in unpic", run: () => {} },
						{ label: "Cards in 5.0 launch", run: () => {} },
					]}
				/>
			),
		},
		{
			label: "Map: loading",
			width: 600,
			height: 320,
			render: () => (
				<DependencyView
					{...view}
					title={launchTitle}
					source="Cards in “5.0 launch”"
					state={{ kind: "loading" }}
				/>
			),
		},
		{
			label: "Map: a section's cards, with a cycle and the critical path",
			width: 780,
			height: 440,
			render: () => (
				<DependencyView
					{...view}
					title={launchTitle}
					source="Cards in “5.0 launch”"
					state={states.launch}
					onBoard={(key) => key.endsWith("#408")}
					onExpand={() => {}}
				/>
			),
		},
		{
			label: "Map: an item clicked",
			width: 780,
			height: 440,
			render: () => (
				<DependencyView
					{...view}
					title={launchTitle}
					source="Cards in “5.0 launch”"
					state={states.launch}
					picked={`fake.tack/${REPO}#413`}
					onExpand={() => {}}
				/>
			),
		},
		{
			label: "Map: still asking about some",
			width: 600,
			height: 380,
			render: () => (
				<DependencyView
					{...view}
					title={launchTitle}
					source="Cards in “5.0 launch”"
					state={states.pending}
				/>
			),
		},
		{
			label: "Map: a search, stale, with items that block nothing",
			width: 780,
			height: 460,
			render: () => (
				<DependencyView
					{...view}
					title="Open issues"
					source={searchConfig.q}
					state={states.search}
					readOnly
				/>
			),
		},
		{
			label: "Map: nothing blocks anything",
			width: 600,
			height: 320,
			render: () => (
				<DependencyView {...view} title="Providers" source={searchConfig.q} state={states.loose} />
			),
		},
		{
			label: "Map: signed out",
			width: 600,
			height: 300,
			render: () => (
				<DependencyView
					{...view}
					title={launchTitle}
					source="Cards in “5.0 launch”"
					state={failed("signed_out", "Sign in with GitHub to see what’s related.")}
				/>
			),
		},
		{
			label: "Map: zoomed far out",
			width: 780,
			height: 440,
			far: true,
			render: () => (
				<DependencyView
					{...view}
					title={launchTitle}
					source="Cards in “5.0 launch”"
					state={states.launch}
				/>
			),
		},
	];

	return (
		<>
			<section data-kind="timeline">
				<h2>Timelines</h2>
				<Samples samples={timelines} />
			</section>
			<section data-kind="release">
				<h2>Release drafts</h2>
				<Samples samples={releases} />
			</section>
			<section data-kind="dependencies">
				<h2>Dependency maps</h2>
				<Samples samples={maps} />
			</section>
			<section data-kind="roadmap-config">
				<h2>Setting them up</h2>
				<div className="gallery-grid widget-panels">
					<figure data-state="timeline-config">
						<TimelineConfigPanel
							config={timeline}
							suggestedRepo={REPO}
							now={NOW}
							onChange={(changes) => setTimeline((c) => ({ ...c, ...changes }))}
							onClose={() => {}}
						/>
						<figcaption>The timeline's panel, with fixed dates</figcaption>
					</figure>
					<figure data-state="release-config">
						<ReleaseConfigPanel
							config={releaseDraft}
							suggestedRepo={REPO}
							onChange={(changes) => setReleaseDraft((c) => ({ ...c, ...changes }))}
							onClose={() => {}}
						/>
						<figcaption>The release draft's panel: sections by label</figcaption>
					</figure>
					<figure data-state="dependency-config">
						<DependencyConfigPanel
							config={map}
							sections={[
								{ id: "launch", title: "5.0 launch", cards: 12 },
								{ id: "later", title: "Later", cards: 4 },
							]}
							suggestedRepo={REPO}
							onChange={(changes) => setMap((c) => ({ ...c, ...changes }))}
							onClose={() => {}}
						/>
						<figcaption>The dependency map's panel</figcaption>
					</figure>
				</div>
			</section>
		</>
	);
}
