import { type ReactNode, useMemo, useState } from "react";
import type { PendingChange, PushAs } from "../../shared/changes.ts";
import { cardStore } from "../cardStore.ts";
import { CardView } from "../CardView.tsx";
import { ChangesButton } from "../changes/ChangesButton.tsx";
import { ChangesPanel } from "../changes/ChangesPanel.tsx";
import { ChangesContext, type SheetMode } from "../changes/context.ts";
import { type HistoryState, PushSheetView } from "../changes/PushSheet.tsx";
import type { PushState } from "../changes/session.ts";
import { StagedMarksView } from "../changes/StagedMarks.tsx";
import { useChangesState } from "../changes/useChanges.ts";
import type { User } from "../presence.ts";
import { StickyView } from "../StickyNode.tsx";
import { ThemeToggle } from "../ThemeToggle.tsx";
import { LEFT_OUT, change, docWith, everyKind, midPush, someStaged } from "./changeFixtures.ts";
import { ACCESS_GALLERY, PLANNING_CARDS } from "./fixtures.ts";
import { IMAGEKIT, SimulatedPush, pastPushes, playMeta } from "./push.ts";
import "./changesGallery.css";

// Every pending-changes state: the top bar button, the panel, the marks on
// shapes and the push sheet, from review through refusals and progress to
// the history. `/play/changes`.

for (const card of [...PLANNING_CARDS, ...ACCESS_GALLERY.map((entry) => entry.card)]) {
	cardStore.set(card);
}

const ME: User = { name: "Ana Lima", color: "#7444c4", login: "ana" };
const GUEST: User = { name: "Curious Otter", color: "#2a7ab0" };
const meta = (repo: string) => playMeta(repo);
const key = (item: string) => `${IMAGEKIT}${item}`;
const card = (item: string) => PLANNING_CARDS.find((c) => c.item === item);

/** A board's worth of changes UI around some fixture changes. */
function Scope({
	changes,
	user = ME,
	readOnly = false,
	panel = false,
	sheet,
	children,
}: {
	changes: PendingChange[];
	user?: User;
	readOnly?: boolean;
	panel?: boolean;
	sheet?: SheetMode;
	children: ReactNode;
}) {
	const [doc] = useState(() => docWith(changes));
	const client = useMemo(() => {
		const push = new SimulatedPush(doc, () => ({ login: user.login ?? "guest", name: user.name }));
		push.seedHistory(pastPushes());
		return push;
	}, [doc, user]);
	const ui = useChangesState({
		doc,
		client,
		readOnly,
		user,
		toasts: null,
		undo: null,
		focusShapes: () => {},
		initial: { panel, sheet },
	});
	return <ChangesContext value={ui}>{children}</ChangesContext>;
}

function TopBar({ changes, open }: { changes: PendingChange[]; open?: boolean }) {
	return (
		<Scope changes={changes} panel={open}>
			<div className="topbar changes-gallery-bar">
				<ChangesButton />
			</div>
		</Scope>
	);
}

function PanelFrame({
	changes,
	caption,
	user,
	readOnly,
}: {
	changes: PendingChange[];
	caption: string;
	user?: User;
	readOnly?: boolean;
}) {
	return (
		<figure>
			<div className="canvas changes-gallery-canvas">
				<Scope changes={changes} panel user={user} readOnly={readOnly}>
					<ChangesPanel />
				</Scope>
			</div>
			<figcaption>{caption}</figcaption>
		</figure>
	);
}

type Sample = {
	label: string;
	shape: "sticky" | "card" | "section";
	item?: string;
	text?: string;
	color?: string;
	changes: PendingChange[];
	highlighted?: boolean;
	/** Drawn as if pointed at: its mark open, and a sticky's card-to-be out. */
	pointed?: boolean;
	/** Zoomed out, where marks are dots. */
	far?: boolean;
};

const STICKY_ID = "sample-sticky";

function newIssueFromSticky(extra: Partial<PendingChange> = {}): PendingChange {
	return change(
		{
			kind: "issue.create",
			repo: IMAGEKIT,
			title: "Better errors when the CDN isn’t recognised",
			labels: ["enhancement"],
		},
		"priya",
		{ shapes: [STICKY_ID], effect: { kind: "replace", shapes: [STICKY_ID] }, ...extra },
	);
}

function parentFromSection(extra: Partial<PendingChange> = {}): PendingChange {
	return change({ kind: "issue.create", repo: IMAGEKIT, title: "Docs for 5.0" }, "kai", {
		shapes: [STICKY_ID],
		effect: { kind: "place", near: [STICKY_ID] },
		...extra,
	});
}

const SAMPLES: Sample[] = [
	{
		label: "Section → parent issue",
		shape: "section",
		text: "Docs for 5.0",
		changes: [parentFromSection()],
	},
	{
		label: "Parent issue, sending",
		shape: "section",
		text: "Docs for 5.0",
		changes: [parentFromSection({ status: "sending" })],
	},
	{
		label: "Sticky → new issue",
		shape: "sticky",
		text: "Better errors when the CDN isn’t recognised",
		changes: [newIssueFromSticky()],
	},
	{
		label: "Pointed at: every change, and the card it'll be",
		shape: "sticky",
		color: "blue",
		text: "Write the migration guide first",
		pointed: true,
		changes: (() => {
			const create = newIssueFromSticky();
			return [
				create,
				change(
					{ kind: "item.subIssue", parent: { key: key("#412") }, child: { pending: create.id } },
					"kai",
					{ shapes: [STICKY_ID] },
				),
			];
		})(),
	},
	{
		label: "Zoomed out: a dot",
		shape: "sticky",
		color: "green",
		text: "Codemods for 5.0",
		far: true,
		changes: [newIssueFromSticky()],
	},
	{
		label: "Sending",
		shape: "sticky",
		color: "green",
		text: "Write the migration guide first",
		changes: [newIssueFromSticky({ status: "sending" })],
	},
	{
		label: "Failed",
		shape: "sticky",
		color: "pink",
		text: "Who owns the CDN list?",
		changes: [newIssueFromSticky({ status: "failed", error: "Validation Failed" })],
	},
	{
		label: "Labels added and removed",
		shape: "card",
		item: "#412",
		changes: [
			change(
				{
					kind: "item.labels",
					target: { key: key("#412") },
					add: ["needs review", "performance"],
					remove: ["enhancement"],
				},
				"tom",
			),
		],
	},
	{
		label: "Will close, and a comment",
		shape: "card",
		item: "#377",
		changes: [
			change(
				{ kind: "item.state", target: { key: key("#377") }, state: "closed", reason: "completed" },
				"jo",
			),
			change({ kind: "item.comment", target: { key: key("#377") }, body: "Fixed in 5.0." }, "jo"),
		],
	},
	{
		label: "Will close as not planned",
		shape: "card",
		item: "#423",
		changes: [
			change(
				{
					kind: "item.state",
					target: { key: key("#423") },
					state: "closed",
					reason: "not_planned",
				},
				"kai",
			),
		],
	},
	{
		label: "Will reopen",
		shape: "card",
		item: "#398",
		changes: [change({ kind: "item.state", target: { key: key("#398") }, state: "open" }, "priya")],
	},
	{
		label: "Assigned, with a milestone",
		shape: "card",
		item: "#409",
		changes: [
			change({ kind: "item.assignees", target: { key: key("#409") }, add: ["priya"] }, "jo"),
			change({ kind: "item.milestone", target: { key: key("#409") }, milestone: "5.0" }, "kai"),
		],
	},
	{
		label: "Linked: sub-issue and blocked by",
		shape: "card",
		item: "#418",
		changes: [
			change(
				{ kind: "item.subIssue", parent: { key: key("#412") }, child: { key: key("#418") } },
				"kai",
			),
			change(
				{ kind: "item.blockedBy", target: { key: key("#418") }, blockedBy: { key: key("#377") } },
				"tom",
			),
		],
	},
	{
		label: "Sent, waiting for GitHub",
		shape: "card",
		item: "#412",
		changes: [
			change({ kind: "item.labels", target: { key: key("#412") }, add: ["docs"] }, "tom", {
				status: "sent",
			}),
		],
	},
	{
		label: "Picked out from the panel",
		shape: "card",
		item: "#377",
		highlighted: true,
		changes: [
			change({ kind: "item.milestone", target: { key: key("#377") }, milestone: "5.1" }, "kai"),
		],
	},
];

function MarkSample({ sample, landing }: { sample: Sample; landing: PendingChange[] | null }) {
	const changes = landing ?? sample.changes;
	const fixture = sample.item ? card(sample.item) : undefined;
	return (
		<figure>
			<div
				className="changes-mark-sample"
				data-shape={sample.shape}
				data-pointed={sample.pointed || undefined}
			>
				<div className="changes-mark-shape">
					{sample.shape === "section" ? (
						<div className="section" data-color="blue">
							<div className="section-header">
								<div className="section-title">
									<span className="section-name">{sample.text}</span>
									<span className="section-count">3</span>
								</div>
							</div>
						</div>
					) : sample.shape === "sticky" ? (
						<StickyView
							text={sample.text ?? ""}
							color={sample.color ?? "yellow"}
							author={{ name: "Priya Shah", color: "#b4467a" }}
							tilt={-1}
						/>
					) : (
						<CardView card={fixture} cardKey={fixture?.key ?? ""} />
					)}
					<StagedMarksView
						shapeId={STICKY_ID}
						cardKey={fixture?.key}
						shapeType={sample.shape}
						changes={changes}
						highlighted={sample.highlighted}
						far={sample.far}
						labelColorOf={(repo, name) => {
							const color = playMeta(repo).labels.find((label) => label.name === name)?.color;
							return color ? `#${color}` : "#8b9098";
						}}
					/>
				</div>
			</div>
			<figcaption>{sample.label}</figcaption>
		</figure>
	);
}

const LANDING: PendingChange["status"][] = ["staged", "sending", "sent", "applied"];

type SheetSample = {
	label: string;
	changes: PendingChange[];
	state: PushState;
	mode?: SheetMode;
	user?: User;
	readOnly?: boolean;
	history?: HistoryState;
	as?: PushAs;
};

function refused(reason: string, repos?: string[], message = ""): PushState {
	const ids = everyKind().map((c) => c.id);
	return {
		phase: "refused",
		ids,
		as: "user",
		refusal: { ok: false, reason, repos, message } as Extract<
			PushState,
			{ phase: "refused" }
		>["refusal"],
	};
}

function pushing(changes: PendingChange[]): PushState {
	return {
		phase: "pushing",
		ids: changes.map((c) => c.id),
		as: "user",
		pushIds: ["gallery-push"],
		startedAt: Date.now(),
	};
}

function settled(failures: number): PendingChange[] {
	return everyKind()
		.slice(0, 5)
		.map((c, i) =>
			i < 5 - failures
				? {
						...c,
						status: "applied" as const,
						result: {
							key: key(`#${540 + i}`),
							url: `https://fake.tack/acme/imagekit/issues/${540 + i}`,
						},
					}
				: {
						...c,
						status: "failed" as const,
						error: "Label “wontfix” doesn’t exist in acme/imagekit",
					},
		);
}

const IDLE: PushState = { phase: "idle" };
const HISTORY: HistoryState = { status: "ready", entries: pastPushes() };

function sheetSamples(): SheetSample[] {
	const all = everyKind();
	const mid = midPush();
	const someFailed = settled(2);
	const landed = settled(0);
	return [
		{ label: "Review: one of every kind", changes: all, state: IDLE },
		{ label: "Review: pushing as the app", changes: someStaged(), state: IDLE, as: "app" },
		{ label: "Review: signed out", changes: someStaged(), state: IDLE, user: GUEST },
		{ label: "Review: view only", changes: someStaged(), state: IDLE, readOnly: true },
		{
			label: "Starting",
			changes: someStaged(),
			state: { phase: "requesting", ids: [], as: "user" },
		},
		{ label: "Refused: signed out", changes: someStaged(), state: refused("signed_out") },
		{
			label: "Refused: no write access",
			changes: someStaged(),
			state: refused("no_write_access", [IMAGEKIT]),
		},
		{
			label: "Refused: app not installed",
			changes: someStaged(),
			state: refused("not_installed", [`fake.tack/lovell/sharp`]),
		},
		{
			label: "Refused: missing dependency",
			changes: someStaged(),
			state: refused(
				"missing_dependency",
				undefined,
				"“Make “Write the migration guide” a sub-issue of new issue “Docs for 5.0”” needs “Create issue “Docs for 5.0” in acme/imagekit”, which isn’t in this push.",
			),
		},
		{ label: "Refused: someone else is pushing", changes: someStaged(), state: refused("busy") },
		{ label: "Refused: offline", changes: someStaged(), state: refused("offline") },
		{ label: "Progress: under way", changes: mid, state: pushing(mid) },
		{ label: "Progress: some failed", changes: someFailed, state: pushing(someFailed) },
		{ label: "Progress: everything landed", changes: landed, state: pushing(landed) },
		{ label: "History", changes: [], state: IDLE, mode: "history", history: HISTORY },
		{
			label: "History: none yet",
			changes: [],
			state: IDLE,
			mode: "history",
			history: { status: "ready", entries: [] },
		},
		{
			label: "History: loading",
			changes: [],
			state: IDLE,
			mode: "history",
			history: { status: "loading" },
		},
		{
			label: "History: couldn’t load",
			changes: [],
			state: IDLE,
			mode: "history",
			history: { status: "error", error: "offline" },
		},
		{ label: "Nothing to push", changes: [], state: IDLE },
	];
}

function SheetFrame({ sample }: { sample: SheetSample }) {
	const [changes, setChanges] = useState(sample.changes);
	const [leftOut, setLeftOut] = useState<ReadonlySet<string>>(
		() => new Set(sample.changes.filter((c) => LEFT_OUT.has(c.id)).map((c) => c.id)),
	);
	const [as, setAs] = useState<PushAs>(sample.as ?? "user");
	const [mode, setMode] = useState<SheetMode>(sample.mode ?? "review");
	return (
		<figure>
			<div className="changes-sheet-frame">
				<PushSheetView
					mode={mode}
					onMode={setMode}
					changes={changes}
					meta={meta}
					state={sample.state}
					readOnly={sample.readOnly ?? false}
					user={sample.user ?? ME}
					as={as}
					onAs={setAs}
					signInHref="#sign-in"
					installHref="#install"
					canPush
					leftOut={leftOut}
					onToggle={(ids, included) =>
						setLeftOut((current) => {
							const next = new Set(current);
							for (const id of ids) {
								if (included) next.delete(id);
								else next.add(id);
							}
							return next;
						})
					}
					onEdit={(id, edit) => {
						setChanges((current) =>
							current.map((c) =>
								c.id === id && c.op.kind === "issue.create"
									? {
											...c,
											op: {
												...c.op,
												...edit,
												labels: edit.labels ? [...edit.labels] : c.op.labels,
												assignees: edit.assignees ? [...edit.assignees] : c.op.assignees,
												milestone:
													edit.milestone === undefined
														? c.op.milestone
														: (edit.milestone ?? undefined),
											},
										}
									: c,
							),
						);
						return true;
					}}
					onPush={() => {}}
					onRetry={() => {}}
					onResolve={() => {}}
					onClose={() => {}}
					onDone={() => {}}
					history={sample.history ?? HISTORY}
					onReloadHistory={() => {}}
				/>
			</div>
			<figcaption>{sample.label}</figcaption>
		</figure>
	);
}

function Sections({ landing, round }: { landing: PendingChange[] | null; round: number }) {
	const sheets = useMemo(sheetSamples, []);
	const staged = useMemo(someStaged, []);
	const clean = staged.filter((c) => c.status !== "failed");
	const mid = useMemo(midPush, []);
	return (
		<>
			<section>
				<h2>Top bar</h2>
				<div className="changes-gallery-bars">
					<figure>
						<TopBar changes={[]} />
						<figcaption>Nothing staged</figcaption>
					</figure>
					<figure>
						<TopBar changes={clean} />
						<figcaption>Staged</figcaption>
					</figure>
					<figure>
						<TopBar changes={staged} />
						<figcaption>One failed</figcaption>
					</figure>
					<figure>
						<TopBar changes={mid} />
						<figcaption>Pushing</figcaption>
					</figure>
					<figure>
						<TopBar changes={clean} open />
						<figcaption>Panel open</figcaption>
					</figure>
				</div>
			</section>

			<section>
				<h2>Changes panel</h2>
				<div className="changes-gallery-panels">
					<PanelFrame changes={staged} caption="Staged, with a failure" />
					<PanelFrame changes={everyKind()} caption="Every kind, two repositories" />
					<PanelFrame changes={mid} caption="Pushing" />
					<PanelFrame changes={staged} caption="View only" readOnly />
					<PanelFrame changes={staged} caption="Signed out" user={GUEST} />
					<PanelFrame changes={[]} caption="Empty" />
				</div>
			</section>

			<section>
				<h2>Marks on shapes</h2>
				<div className="changes-gallery-marks">
					{SAMPLES.map((sample) => (
						<MarkSample key={sample.label} sample={sample} landing={null} />
					))}
					<MarkSample
						key="landing"
						sample={{
							label: `Landing: ${LANDING[round % LANDING.length]}`,
							shape: "card",
							item: "#418",
							changes: [],
						}}
						landing={landing}
					/>
				</div>
			</section>

			<section>
				<h2>Push sheet</h2>
				<div className="changes-gallery-sheets">
					{sheets.map((sample) => (
						<SheetFrame key={sample.label} sample={sample} />
					))}
				</div>
			</section>
		</>
	);
}

type Layout = "page" | "both";

const LANDING_CHANGE = change(
	{ kind: "item.labels", target: { key: key("#418") }, add: ["needs review"] },
	"tom",
);

export default function ChangesGallery() {
	const [layout, setLayout] = useState<Layout>("page");
	const [motion, setMotion] = useState(false);
	// One change walking through its statuses, for the landing animation.
	const [round, setRound] = useState(0);
	const [landing, setLanding] = useState<PendingChange[]>([LANDING_CHANGE]);
	const step = () => {
		const next = round + 1;
		setRound(next);
		setLanding([{ ...LANDING_CHANGE, status: LANDING[next % LANDING.length] ?? "staged" }]);
	};
	return (
		<div className="gallery" data-motion={motion ? "slow" : undefined}>
			<header className="gallery-head">
				<h1>Changes</h1>
				<p>
					Every pending-changes state: the top bar, the panel, marks on shapes, and the push sheet
					from review through refusals, progress and history. The live flow is on{" "}
					<a href="/play?scenario=push">the pushing scenario</a>.
				</p>
				<div className="gallery-actions">
					<button type="button" className="primary" onClick={step}>
						Next status: {LANDING[(round + 1) % LANDING.length]}
					</button>
					<ThemeToggle labelled />
					<label className="play-toggle">
						<input
							type="checkbox"
							checked={layout === "both"}
							onChange={(e) => setLayout(e.target.checked ? "both" : "page")}
						/>
						Both themes side by side
					</label>
					<label className="play-toggle">
						<input type="checkbox" checked={motion} onChange={(e) => setMotion(e.target.checked)} />
						Slow motion
					</label>
					<a className="play-link" href="/play/cards">
						Cards gallery →
					</a>
				</div>
			</header>
			{layout === "both" ? (
				<div className="gallery-split">
					<div className="gallery-pane" data-theme="light">
						<Sections landing={landing} round={round} />
					</div>
					<div className="gallery-pane" data-theme="dark">
						<Sections landing={landing} round={round} />
					</div>
				</div>
			) : (
				<Sections landing={landing} round={round} />
			)}
		</div>
	);
}
