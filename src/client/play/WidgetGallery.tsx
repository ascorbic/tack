import { plainSearchError } from "../../shared/queryHelp.ts";
import { useMemo, useState } from "react";
import * as Y from "yjs";
import type { Card } from "../../shared/cards.ts";
import { addShape } from "../../shared/shapes.ts";
import { type ListConfig, listWidget } from "../../shared/widgetRegistry.ts";
import type { QueryError, SearchResult } from "../../shared/widgets.ts";
import { CardView } from "../CardView.tsx";
import { cardStore } from "../cardStore.ts";
import { ThemeToggle } from "../ThemeToggle.tsx";
import { ToastStore } from "../Toasts.tsx";
import { ListConfigPanel, SchemaConfigPanel } from "../widgets/ConfigPanel.tsx";
import { listTitle } from "../widgets/describe.ts";
import { DropConfirm } from "../widgets/DropConfirm.tsx";
import { CustomGallery } from "./CustomGallery.tsx";
import { KindGallery } from "./KindGallery.tsx";
import { type DropPreview, type ListStatus, ListView } from "../widgets/ListView.tsx";
import { planDrop } from "../widgets/match.ts";
import { WidgetPicker } from "../widgets/WidgetPicker.tsx";
import "../widgets/widgets.css";
import { LABELS } from "./fixtures.ts";
import { RoadmapGallery } from "./RoadmapGallery.tsx";
import { REPO, WIDGET_CARDS } from "./widgets.ts";

// Every widget state (#37, #38, #39), for the gallery: a list not set up,
// loading, live, refreshing, stale, empty, every kind of error, cards
// hovering to be dropped (with changes, already matching, impossible), the
// config panels, the picker, and drop-to-match's confirmation. `/play/widgets`.

const NOW = Date.UTC(2026, 9, 9, 14, 30);
const MIN = 60_000;
const BUGS = `repo:${REPO} is:open label:bug`;
const bugs = WIDGET_CARDS.filter(
	(card) => card.state === "open" && card.labels.some((l) => l.name === "bug"),
);
const result = (items: Card[], total = items.length): SearchResult => ({
	kind: "search",
	total,
	items,
});
const error = (reason: QueryError["reason"], message: string, retryAt?: number): ListStatus => ({
	kind: "error",
	error: { kind: "error", reason, message, ...(retryAt ? { retryAt } : {}) },
});

interface Sample {
	label: string;
	q?: string;
	title?: string;
	status: ListStatus;
	refreshing?: boolean;
	selected?: boolean;
	readOnly?: boolean;
	drop?: DropPreview;
	linked?: string;
	onBoard?: string[];
	lifted?: string;
	h?: number;
}

const SAMPLES: Sample[] = [
	{ label: "Not set up", q: "", status: { kind: "unconfigured" }, selected: true },
	{ label: "Loading", q: BUGS, title: "Open bugs", status: { kind: "loading" } },
	{
		label: "Live",
		q: BUGS,
		title: "Open bugs",
		status: { kind: "ready", result: result(bugs), at: NOW - 1 * MIN, stale: false },
		onBoard: [bugs[0]?.key ?? ""],
	},
	{
		label: "Pointing at a card on the board",
		q: BUGS,
		title: "Open bugs",
		status: { kind: "ready", result: result(bugs), at: NOW, stale: false },
		onBoard: [bugs[0]?.key ?? ""],
		linked: bugs[0]?.key,
	},
	{
		label: "A row being dragged out",
		q: BUGS,
		title: "Open bugs",
		status: { kind: "ready", result: result(bugs), at: NOW, stale: false },
		lifted: bugs[1]?.key,
	},
	{
		label: "Refreshing",
		q: BUGS,
		status: { kind: "ready", result: result(bugs.slice(0, 3)), at: NOW - 4 * MIN, stale: false },
		refreshing: true,
	},
	{
		label: "Stale: a refresh failed",
		q: BUGS,
		title: "Open bugs",
		status: { kind: "ready", result: result(bugs.slice(0, 4)), at: NOW - 14 * MIN, stale: true },
	},
	{
		label: "More than it shows",
		q: `repo:${REPO} is:open`,
		status: {
			kind: "ready",
			result: { ...result(WIDGET_CARDS.slice(0, 6), 212), incomplete: true },
			at: NOW,
			stale: false,
		},
	},
	{
		label: "Nothing matches",
		q: `repo:${REPO} is:open label:security`,
		status: { kind: "ready", result: result([]), at: NOW, stale: false },
		h: 320,
	},
	{
		label: "Nothing matches words, everywhere",
		q: "bugs in unpic",
		status: { kind: "ready", result: result([]), at: NOW, stale: false },
		h: 320,
	},
	{
		label: "Signed out, about @me",
		q: "is:open assignee:@me",
		status: error("signed_out", "Sign in to see what “@me” means for you."),
		h: 320,
	},
	{
		label: "Rate limited",
		q: BUGS,
		status: error("rate_limited", "API rate limit exceeded.", NOW + 4 * MIN),
		h: 320,
	},
	{
		label: "A search GitHub can't read",
		q: "repo:acme/unpic is:open label:",
		status: error(
			"invalid",
			// As the server says it: GitHub's own words, made plain.
			plainSearchError(
				"The listed users and repositories cannot be searched either because the resources do not exist or you do not have permission to view them.",
				"repo:acme/unpic is:open label:",
			),
		),
		h: 320,
	},
	{
		label: "Forge unreachable",
		q: BUGS,
		status: error("error", "GitHub answered 502."),
		h: 320,
	},
	{
		label: "Drop to match: changes",
		q: `repo:${REPO} is:open label:"good first issue"`,
		title: "Good first issues",
		status: { kind: "ready", result: result(WIDGET_CARDS.slice(2, 6)), at: NOW, stale: false },
		drop: {
			status: "changes",
			cards: 1,
			steps: [
				{ kind: "add-label", label: "good first issue" },
				{ kind: "assign", label: "@kai" },
				{ kind: "open", label: "Reopen" },
			],
		},
	},
	{
		label: "Drop to match: already matches",
		q: BUGS,
		status: { kind: "ready", result: result(bugs.slice(0, 4)), at: NOW, stale: false },
		drop: { status: "matches", cards: 1 },
	},
	{
		label: "Drop to match: can't",
		q: `repo:${REPO} flaky`,
		status: { kind: "ready", result: result([]), at: NOW, stale: false },
		drop: {
			status: "impossible",
			reason: "This list searches for the words “flaky”, and Tack doesn't edit what an item says.",
		},
	},
	{
		label: "View only",
		q: BUGS,
		title: "Open bugs",
		status: { kind: "ready", result: result(bugs.slice(0, 4)), at: NOW, stale: false },
		readOnly: true,
	},
];

const PRESETS = [
	{ label: "Open bugs", title: "Open bugs", q: BUGS },
	{ label: "Needs triage", title: "Needs triage", q: `repo:${REPO} is:issue is:open no:label` },
	{ label: "Assigned to me", title: "Assigned to me", q: "is:open assignee:@me" },
];

/** Cards to drop, and a board for drop-to-match's confirmation. */
function useDropDoc() {
	return useMemo(() => {
		const doc = new Y.Doc();
		const add = (id: string, card: Card) => {
			cardStore.set(card);
			addShape(doc, id, { type: "card", ref: card.key, x: 0, y: 0, z: "a0" });
		};
		const target = WIDGET_CARDS.find((card) => card.item === "#425") as Card;
		add("c1", target);
		add("c2", { ...(WIDGET_CARDS.find((card) => card.item === "#415") as Card) });
		return doc;
	}, []);
}

export default function WidgetGallery() {
	const [rows, setRows] = useState(bugs);
	const [config, setConfig] = useState<ListConfig>({
		...listWidget.defaults,
		host: "fake.tack",
		q: BUGS,
		title: "Open bugs",
	});
	const doc = useDropDoc();
	const [toasts] = useState(() => new ToastStore());
	useState(() => {
		for (const card of WIDGET_CARDS) cardStore.set(card);
		return null;
	});
	const plans = (q: string, shapes: string[]) =>
		planDrop(doc, shapes, { q, host: "fake.tack" }, "kai", (key) => cardStore.get(key));

	/** A live update: one row arrives, one leaves, one changes. */
	const update = () => {
		setRows((current) => {
			const next = current.slice(1).map((card, i) =>
				i === 0
					? {
							...card,
							title: `${card.title.replace(/ \(again\)$/, "")} (again)`,
							labels: [...card.labels, LABELS.needsReview],
						}
					: card,
			);
			const extra = WIDGET_CARDS.find(
				(card) => !current.some((c) => c.key === card.key) && card.state === "open",
			);
			return extra ? [{ ...extra, labels: [LABELS.bug] }, ...next] : next;
		});
	};

	return (
		<div className="gallery widget-gallery">
			<header className="gallery-head">
				<h1>Widgets</h1>
				<p>
					Live views of the forge on the board. Every list state, what dropping cards on a list
					looks like, and the panels that set lists up and stage what makes cards match; the review
					queue, milestone and stale finder in every state, zoomed out too.
				</p>
				<div className="gallery-actions">
					<button type="button" className="primary" onClick={update}>
						Simulate an update
					</button>
					<ThemeToggle labelled />
					<a className="play-link" href="/play?scenario=widgets">
						← Try them in the playground
					</a>
				</div>
			</header>

			<section>
				<h2>Lists</h2>
				<div className="gallery-grid widget-samples">
					<figure data-state="live-update">
						<div className="widget-sample" style={{ height: 440 }}>
							<ListView
								title="Open bugs"
								q={BUGS}
								status={{ kind: "ready", result: result(rows), at: NOW, stale: false }}
								now={NOW}
								onRefresh={() => {}}
								onConfigure={() => {}}
							/>
						</div>
						<figcaption>Live updates (press “Simulate an update”)</figcaption>
					</figure>
					{SAMPLES.map((sample) => {
						const q = sample.q ?? BUGS;
						return (
							<figure key={sample.label} data-state={sample.label}>
								<div className="widget-sample" style={{ height: sample.h ?? 440 }}>
									<ListView
										title={sample.title ?? listTitle({ title: "", q })}
										q={q}
										status={sample.status}
										refreshing={sample.refreshing}
										selected={sample.selected}
										readOnly={sample.readOnly}
										drop={sample.drop}
										linked={sample.linked}
										lifted={sample.lifted}
										onBoard={(key) => sample.onBoard?.includes(key) ?? false}
										now={NOW}
										presets={PRESETS}
										onPreset={() => {}}
										onRefresh={() => {}}
										onConfigure={sample.readOnly ? undefined : () => {}}
									/>
								</div>
								<figcaption>{sample.label}</figcaption>
							</figure>
						);
					})}
				</div>
			</section>

			<KindGallery />

			<CustomGallery />

			<section>
				<h2>A card whose row is pointed at</h2>
				<div className="gallery-grid">
					<figure data-state="linked-card">
						<div className="card-link" data-linked>
							<CardView card={bugs[0]} cardKey={bugs[0]?.key ?? ""} />
						</div>
						<figcaption>Lit up from its row</figcaption>
					</figure>
				</div>
			</section>

			<section>
				<h2>Setting up</h2>
				<div className="gallery-grid widget-panels">
					<figure data-state="config">
						<ListConfigPanel
							config={config}
							suggestedRepo={REPO}
							onChange={(changes) => setConfig((c) => ({ ...c, ...changes }))}
							onClose={() => {}}
						/>
						<figcaption>The list's panel</figcaption>
					</figure>
					<figure data-state="config-words">
						<ListConfigPanel
							config={{ ...config, q: `repo:${REPO} flaky test`, title: "" }}
							suggestedRepo={REPO}
							onChange={() => {}}
							onClose={() => {}}
						/>
						<figcaption>Words in the search: drop to match can't work</figcaption>
					</figure>
					<figure data-state="config-empty">
						<ListConfigPanel
							config={{ ...listWidget.defaults, host: "fake.tack" }}
							suggestedRepo={REPO}
							onChange={() => {}}
							onClose={() => {}}
						/>
						<figcaption>A new list: ready-made searches</figcaption>
					</figure>
					<figure data-state="config-schema">
						<SchemaConfigPanel
							title="List"
							schema={listWidget.schema}
							config={config as unknown as Record<string, unknown>}
							onChange={() => {}}
							onClose={() => {}}
						/>
						<figcaption>Generated from a kind's schema</figcaption>
					</figure>
				</div>
			</section>

			<section>
				<h2>Drop to match</h2>
				<div className="gallery-grid widget-panels">
					<figure data-state="confirm-changes">
						<DropConfirm
							doc={doc}
							title="Good first issues"
							plans={plans(`repo:${REPO} is:open label:"good first issue" assignee:@me`, ["c1"])}
							stager={{ name: "Kai", login: "kai" }}
							toasts={toasts}
							history={null}
							onClose={() => {}}
						/>
						<figcaption>Changes to stage</figcaption>
					</figure>
					<figure data-state="confirm-several">
						<DropConfirm
							doc={doc}
							title="Open bugs"
							plans={plans(BUGS, ["c1", "c2"])}
							stager={{ name: "Kai", login: "kai" }}
							toasts={toasts}
							history={null}
							onClose={() => {}}
						/>
						<figcaption>Several cards, one reopened</figcaption>
					</figure>
					<figure data-state="confirm-impossible">
						<DropConfirm
							doc={doc}
							title="Mentions flaky"
							plans={plans(`repo:${REPO} is:pr flaky`, ["c1"])}
							stager={{ name: "Kai", login: "kai" }}
							toasts={toasts}
							history={null}
							onClose={() => {}}
						/>
						<figcaption>Can't be done, and why</figcaption>
					</figure>
				</div>
			</section>

			<RoadmapGallery />

			<section>
				<h2>Picker</h2>
				<div className="gallery-grid">
					<figure data-state="picker">
						<WidgetPicker suggestedRepo={REPO} onAdd={() => {}} />
						<figcaption>The widget tool's tray</figcaption>
					</figure>
				</div>
			</section>
		</div>
	);
}
