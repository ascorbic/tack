import { type ReactNode, useEffect, useState } from "react";
import * as Y from "yjs";
import { addShape } from "../../shared/shapes.ts";
import { addConnector } from "../../shared/structure.ts";
import { type Action, ActionButton } from "../actions/ActionBar.tsx";
import { BacklinkPanel } from "../actions/BacklinkPanel.tsx";
import { BlockedByAction } from "../actions/BlockedBy.tsx";
import {
	BacklinkIcon,
	CloseIssueIcon,
	IssueIcon,
	LabelIcon,
	MilestoneIcon,
	ParentIcon,
	PersonIcon,
} from "../actions/icons.tsx";
import { MakeIssuesPanel, ParentIssuePanel } from "../actions/IssuePanels.tsx";
import {
	LabelOption,
	MilestonePicker,
	PersonOption,
	SetPicker,
	StateMenu,
} from "../actions/pickers.tsx";
import { Notice, PopoverHead } from "../actions/Popover.tsx";
import { ActionRequests } from "../actions/selection.ts";
import { ServicesContext } from "../actions/services.ts";
import { cardStore } from "../cardStore.ts";
import { localUser } from "../presence.ts";
import { ThemeToggle } from "../ThemeToggle.tsx";
import "../connectors.css";
import { ToastStore } from "../Toasts.tsx";
import { History } from "../undo.ts";
import { fakeMeta, playServices, WRITES_CARDS } from "./writes.ts";

// Every state of the selection actions (#32, #33): the bars, each picker
// and panel, and the warnings. `/play/actions`.

const REPO = "fake.tack/acme/imagekit";
const UPSTREAM = "fake.tack/lovell/sharp";
const meta = fakeMeta(REPO);

const REPOS = [
	{ repo: REPO, cards: 6 },
	{ repo: "fake.tack/acme/vault", cards: 1 },
	{ repo: UPSTREAM, cards: 2 },
	{ repo: "fake.tack/acme/docs", recent: true },
];

const STICKIES = [
	{ id: "s1", text: "Benchmarks in CI\nRun them on every PR", color: "yellow" },
	{ id: "s2", text: "A provider playground", color: "pink" },
	{ id: "s3", text: "Codemods for 5.0", color: "green" },
	{ id: "s4", text: "", color: "blue" },
];

const STICKY_ACTIONS: Action[] = [
	{
		id: "makeIssues",
		label: "Make issues from stickies",
		icon: <IssueIcon />,
		text: "Make 3 issues",
	},
	{ id: "parentIssue", label: "Make a parent issue", icon: <ParentIcon /> },
];

const CARD_ACTIONS: Action[] = [
	{ id: "labels", label: "Labels", icon: <LabelIcon /> },
	{ id: "milestone", label: "Milestone", icon: <MilestoneIcon /> },
	{ id: "assign", label: "Assign", icon: <PersonIcon /> },
	{ id: "closeReopen", label: "Close", icon: <CloseIssueIcon /> },
	{ id: "backlink", label: "Comment with a link to this board", icon: <BacklinkIcon /> },
	{ id: "parentIssue", label: "Make a parent issue", icon: <ParentIcon /> },
];

const BARS: { label: string; actions: Action[]; open?: string; install?: boolean }[] = [
	{ label: "Stickies", actions: STICKY_ACTIONS },
	{
		label: "Stickies, already staged",
		actions: [
			{
				id: "makeIssues",
				label: "Make issues from stickies",
				icon: <IssueIcon />,
				text: "Staged",
				unavailable: "Already staged as issues",
			},
		],
	},
	{
		label: "A section",
		actions: [
			{
				id: "parentIssue",
				label: "Make a parent issue from this section",
				icon: <ParentIcon />,
				text: "Parent issue",
			},
		],
	},
	{ label: "Cards, labels open", actions: CARD_ACTIONS, open: "labels" },
	{
		label: "Cards without the app",
		actions: CARD_ACTIONS.slice(0, 5).map((a) => ({
			...a,
			unavailable: "Tack can’t write to these yet: install the app",
		})),
		install: true,
	},
];

function Bar({ actions, open, install }: { actions: Action[]; open?: string; install?: boolean }) {
	return (
		<div className="selection-actions" role="toolbar" aria-label="Stage changes">
			{actions.map((action) => (
				<ActionButton
					key={action.id}
					action={action}
					pressed={open === action.id}
					onClick={() => {}}
				/>
			))}
			{install && (
				<a className="selection-actions-install" href="#install">
					Install the app
				</a>
			)}
		</div>
	);
}

/** A panel as it looks open, without needing a bar to hang from. */
function Panel({ children, wide }: { children: ReactNode; wide?: boolean }) {
	return (
		<div className="action-popover" data-static data-wide={wide || undefined} role="dialog">
			{children}
		</div>
	);
}

/** A tiny PNG of the given colour, standing in for a rendered snapshot. */
function swatch(color: string): Promise<Blob> {
	const canvas = document.createElement("canvas");
	canvas.width = 320;
	canvas.height = 200;
	const ctx = canvas.getContext("2d");
	if (ctx) {
		ctx.fillStyle = color;
		ctx.fillRect(0, 0, 320, 200);
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(40, 60, 110, 70);
		ctx.fillRect(180, 60, 110, 70);
		ctx.strokeStyle = "#3f444b";
		ctx.lineWidth = 3;
		ctx.beginPath();
		ctx.moveTo(150, 95);
		ctx.lineTo(180, 95);
		ctx.stroke();
	}
	return new Promise((resolve, reject) =>
		canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no blob"))), "image/png"),
	);
}

function useBlockedDoc() {
	const [state] = useState(() => {
		const doc = new Y.Doc();
		const [a, b] = WRITES_CARDS;
		for (const card of WRITES_CARDS) cardStore.set(card);
		addShape(doc, "a", { type: "card", ref: a?.key, x: 0, y: 0, z: "a0" });
		addShape(doc, "b", { type: "card", ref: b?.key, x: 400, y: 0, z: "a1" });
		addShape(doc, "s", { type: "sticky", text: "Benchmarks in CI", x: 0, y: 300, z: "a2" });
		const ready = addConnector(doc, {
			from: { x: 0, y: 0, shape: "a" },
			to: { x: 0, y: 0, shape: "b" },
		});
		const sticky = addConnector(doc, {
			from: { x: 0, y: 0, shape: "a" },
			to: { x: 0, y: 0, shape: "s" },
			arrow: "none",
		});
		return { doc, ready, sticky, history: new History(doc) };
	});
	useEffect(() => () => state.history.destroy(), [state]);
	return state;
}

export default function ActionsGallery() {
	const [services] = useState(playServices);
	const [toasts] = useState(() => new ToastStore());
	const [requests] = useState(() => new ActionRequests());
	const blocked = useBlockedDoc();
	const [user] = useState(localUser);
	const [round, setRound] = useState(0);
	const items = [
		{ key: `${REPO}#412`, names: ["breaking", "enhancement"] },
		{ key: `${REPO}#377`, names: ["bug", "provider"] },
		{ key: `${REPO}#431`, names: ["docs", "enhancement"] },
	];
	const staged = new Set(["s3"]);

	return (
		<ServicesContext value={services}>
			<div className="gallery actions-gallery">
				<header className="gallery-head">
					<h1>Selection actions</h1>
					<p>
						What a selection can become on the forge: issues from stickies, parent issues,
						blocked-by, triage and backlinks. Every action stages changes; nothing is written until
						someone pushes.
					</p>
					<div className="gallery-actions">
						<button type="button" onClick={() => setRound((r) => r + 1)}>
							Replay
						</button>
						<ThemeToggle labelled />
						<a className="play-link" href="/play?scenario=writes">
							← Try them in the playground
						</a>
					</div>
				</header>

				<section key={`bars${round}`}>
					<h2>Action bars</h2>
					<div className="gallery-grid actions-bars">
						{BARS.map((bar) => (
							<figure key={bar.label}>
								<Bar actions={bar.actions} open={bar.open} install={bar.install} />
								<figcaption>{bar.label}</figcaption>
							</figure>
						))}
					</div>
				</section>

				<section key={`issues${round}`}>
					<h2>Making issues</h2>
					<div className="gallery-grid actions-panels">
						<figure>
							<Panel>
								<MakeIssuesPanel
									stickies={STICKIES}
									staged={staged}
									repos={REPOS}
									host="fake.tack"
									initialRepo={REPO}
									onStage={() => {}}
								/>
							</Panel>
							<figcaption>Stickies to issues</figcaption>
						</figure>
						<figure>
							<Panel>
								<MakeIssuesPanel
									stickies={STICKIES.slice(0, 1)}
									staged={new Set()}
									repos={REPOS}
									host="fake.tack"
									initialRepo={UPSTREAM}
									onStage={() => {}}
								/>
							</Panel>
							<figcaption>A repository without the app</figcaption>
						</figure>
						<figure>
							<Panel wide>
								<ParentIssuePanel
									title="Docs for 5.0"
									from="this section"
									repos={REPOS}
									host="fake.tack"
									initialRepo={REPO}
									items={[
										{
											input: { shape: "c1", card: { key: `${REPO}#431`, kind: "issue" } },
											label: "Document every provider’s options",
											ref: "#431",
										},
										{
											input: { shape: "s1", sticky: "Write the migration guide first" },
											label: "Write the migration guide first",
											color: "blue",
										},
										{
											input: { shape: "c2", card: { key: `${REPO}#418`, kind: "pull" } },
											label: "Remove Node 18 from CI",
											ref: "#418",
										},
									]}
									onStage={() => {}}
								/>
							</Panel>
							<figcaption>A section to a parent issue, with a pull request left out</figcaption>
						</figure>
					</div>
				</section>

				<section key={`triage${round}`}>
					<h2>Triage</h2>
					<div className="gallery-grid actions-panels">
						<figure>
							<Panel>
								<PopoverHead title="Labels" detail="On 3 items" />
								<SetPicker
									noun="label"
									options={meta?.labels ?? []}
									items={items}
									onStage={() => {}}
									placeholder="Filter labels"
									empty="This repository has no labels"
									render={(option) => <LabelOption option={option} />}
								/>
							</Panel>
							<figcaption>Labels, some on every card, some on a few</figcaption>
						</figure>
						<figure>
							<Panel>
								<PopoverHead title="Assignees" />
								<SetPicker
									noun="assignee"
									options={(meta?.assignees ?? []).map((name) => ({ name }))}
									items={[{ key: `${REPO}#412`, names: ["kai"] }]}
									onStage={() => {}}
									placeholder="Filter people"
									empty="Nobody can be assigned here"
									render={(option) => <PersonOption option={option} />}
								/>
							</Panel>
							<figcaption>Assignees</figcaption>
						</figure>
						<figure>
							<Panel>
								<PopoverHead title="Milestone" detail="For 3 items" />
								<MilestonePicker milestones={meta?.milestones ?? []} onPick={() => {}} />
							</Panel>
							<figcaption>Milestone</figcaption>
						</figure>
						<figure>
							<Panel>
								<StateMenu open={2} closed={1} pulls={false} onPick={() => {}} />
							</Panel>
							<figcaption>Close (with a reason) or reopen</figcaption>
						</figure>
						<figure>
							<Panel>
								<PopoverHead title="Labels" detail="On 2 items" />
								<div className="action-loading" aria-busy="true">
									<span className="action-skeleton" />
									<span className="action-skeleton" />
									<span className="action-skeleton short" />
								</div>
							</Panel>
							<figcaption>Loading a repository’s labels</figcaption>
						</figure>
						<figure>
							<Panel>
								<PopoverHead title="Labels" />
								<Notice tone="warn">
									Couldn’t load labels for acme/vault. Try again in a moment.
								</Notice>
							</Panel>
							<figcaption>Couldn’t load</figcaption>
						</figure>
					</div>
				</section>

				<section key={`backlinks${round}`}>
					<h2>Backlinks</h2>
					<div className="gallery-grid actions-panels">
						{(
							[
								["One snapshot", [WRITES_CARDS[0]], (_a: string) => swatch("#e5eefb")],
								[
									"Two audiences, a private card hidden",
									[WRITES_CARDS[0], WRITES_CARDS[4]],
									(a: string) => swatch(a === "public" ? "#e5eefb" : "#f0e9fd"),
								],
								["Drawing", [WRITES_CARDS[1]], () => new Promise<Blob>(() => {})],
								[
									"Couldn’t draw",
									[WRITES_CARDS[2]],
									() => Promise.reject(new Error("The snapshot came out too big to upload.")),
								],
							] as const
						).map(([label, cards, draw]) => (
							<figure key={label}>
								<Panel wide>
									<BacklinkPanel
										cards={cards.flatMap((card) =>
											card ? [{ shape: card.key, key: card.key, card }] : [],
										)}
										boardCards={WRITES_CARDS.map((card, i) => ({
											shape: card.key,
											key: card.key,
											public: card.visibility === "public",
											box: { x: i * 260, y: 0, width: 240, height: 120 },
										}))}
										region={{ x: 0, y: 0, width: 1400, height: 400 }}
										flow={() => null}
										sizeOf={() => undefined}
										isPublicItem={() => true}
										draw={draw}
										onStage={async () => {}}
									/>
								</Panel>
								<figcaption>{label}</figcaption>
							</figure>
						))}
					</div>
				</section>

				<section key={`blocked${round}`}>
					<h2>Blocked by</h2>
					<div className="gallery-grid actions-panels">
						<figure className="gallery-blocked">
							<div className="connector-toolbar-inner">
								<BlockedByAction
									doc={blocked.doc}
									connector={blocked.ready}
									user={user}
									toasts={toasts}
									history={blocked.history}
									requests={requests}
									defaultOpen
								/>
							</div>
							<figcaption>Two issues</figcaption>
						</figure>
						<figure className="gallery-blocked">
							<div className="connector-toolbar-inner">
								<BlockedByAction
									doc={blocked.doc}
									connector={blocked.sticky}
									user={user}
									toasts={toasts}
									history={blocked.history}
									requests={requests}
									defaultOpen
								/>
							</div>
							<figcaption>A sticky that isn’t an issue yet, no direction</figcaption>
						</figure>
					</div>
				</section>
			</div>
		</ServicesContext>
	);
}
