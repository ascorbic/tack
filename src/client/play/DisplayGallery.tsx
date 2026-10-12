import { ReactFlowProvider } from "@xyflow/react";
import { type ReactNode, useMemo, useState } from "react";
import * as Y from "yjs";
import type { Card } from "../../shared/cards.ts";
import { LIST, MINI, type SectionDisplay, emptyWell } from "../../shared/display.ts";
import { placeDot, readVotes, startVote } from "../../shared/dotvotes.ts";
import { stampCounts, stampsMap, toggleStamp } from "../../shared/facilitation.ts";
import type { ShapeProps } from "../../shared/shapes.ts";
import { CardView } from "../CardView.tsx";
import { cardStore } from "../cardStore.ts";
import { DocContext } from "../DocContext.ts";
import {
	DisplayItemView,
	DisplayMarksContext,
	type ItemProps,
	type ZoomTier,
} from "../display/DisplayItem.tsx";
import { DisplaySwitch } from "../display/DisplaySwitch.tsx";
import { EmptyList } from "../display/EmptyList.tsx";
import { ThemeToggle } from "../ThemeToggle.tsx";
import { BACKLOG } from "./displayScenarios.ts";
import { KAI, PRIYA, TOM } from "./facilitationScenarios.ts";
import { PLANNING_CARDS, PULL_GALLERY } from "./fixtures.ts";
import "../display/display.css";
import "../sections.css";

// Every state of a row and a mini card (#72): each card state, CI, stamps
// and dots, stickies (face down and hidden in silent mode too), the other
// shapes, zoomed out, and the switch and sort in a section's header.
// `/play/lists`.

const ME = { name: "Jo Rivera", color: "#5b5fc7" };

interface Case {
	label: string;
	state: string;
	shape: ShapeProps;
	id?: string;
	selected?: boolean;
	silentAs?: ItemProps["silentAs"];
	holds?: ItemProps["holds"];
}

const at = { x: 0, y: 0, z: "a0" };
const card = (c: Card | undefined, id?: string): Pick<Case, "shape" | "id"> => ({
	shape: { type: "card", ref: c?.key ?? "", ...at },
	...(id && { id }),
});

const pulls = PULL_GALLERY.map((entry) => entry.card);

const CASES: Case[] = [
	{ label: "Issue, open", state: "open", ...card(PLANNING_CARDS[0]) },
	{ label: "Pull request, checks running", state: "pending", ...card(pulls[0]) },
	{ label: "Pull request, checks failing", state: "failing", ...card(pulls[1]) },
	{ label: "Pull request, merged", state: "merged", ...card(BACKLOG[5]) },
	{ label: "Pull request, draft", state: "draft", ...card(BACKLOG[7]) },
	{ label: "Issue, closed", state: "closed", ...card(BACKLOG[3]) },
	{ label: "Issue, not planned", state: "not-planned", ...card(BACKLOG[8]) },
	{ label: "Stamped and dotted", state: "marks", ...card(PLANNING_CARDS[1], "marked") },
	{ label: "Selected", state: "selected", selected: true, ...card(PLANNING_CARDS[2]) },
	{ label: "Loading", state: "loading", shape: { type: "card", ref: "fake.tack/acme/x#9", ...at } },
	{
		label: "Sticky",
		state: "sticky",
		shape: {
			type: "sticky",
			text: "Write the migration guide first",
			color: "pink",
			author: PRIYA,
			...at,
		},
	},
	{
		label: "Sticky, handwritten",
		state: "sticky-hand",
		shape: {
			type: "sticky",
			text: "Pair on the web component?",
			color: "green",
			font: "hand",
			author: KAI,
			...at,
		},
	},
	{
		label: "Silent: someone else’s, face down",
		state: "face-down",
		silentAs: "face-down",
		shape: { type: "sticky", color: "yellow", author: TOM, silent: "s1", ...at },
	},
	{
		label: "Silent: yours, only you can see it",
		state: "hidden",
		silentAs: "mine",
		shape: {
			type: "sticky",
			text: "Docs search finds the wrong page",
			color: "blue",
			author: ME,
			silent: "s1",
			...at,
		},
	},
	{
		label: "Empty sticky",
		state: "sticky-empty",
		shape: { type: "sticky", text: "", color: "purple", author: ME, ...at },
	},
	{ label: "Text", state: "text", shape: { type: "text", text: "Questions for Thursday", ...at } },
	{
		label: "Decision",
		state: "decision",
		shape: { type: "decision", title: "Drop Node 18 in 5.0", status: "decided", ...at },
	},
	{
		label: "Stack, named",
		state: "stack",
		shape: { type: "stack", title: "Big sites are slow", ...at },
		holds: ["sticky", "sticky", "sticky"],
	},
	{
		label: "Stack, a suggested name, issues and stickies",
		state: "stack-suggested",
		shape: { type: "stack", suggested: { title: "Release notes", hash: "x" }, ...at },
		holds: ["sticky", "card", "card", "sticky", "card"],
	},
	{
		label: "Widget",
		state: "widget",
		shape: { type: "widget", widget: "list", config: { title: "Open bugs" }, ...at },
	},
];

/** A board for the marks: stamps and an open vote's dots on one card. */
function useMarks() {
	return useMemo(() => {
		const doc = new Y.Doc();
		toggleStamp(doc, "marked", "👍", PRIYA);
		toggleStamp(doc, "marked", "👍", KAI);
		toggleStamp(doc, "marked", "🎉", TOM);
		const vote = startVote(doc, { scope: null, by: PRIYA, dots: 5 });
		placeDot(doc, vote, PRIYA, "marked");
		placeDot(doc, vote, KAI, "marked");
		placeDot(doc, vote, ME, "marked");
		const shapes = new Map([["marked", { type: "card" as const, parent: null }]]);
		return {
			doc,
			me: ME,
			stamps: stampCounts(stampsMap(doc), ME),
			votes: readVotes(doc),
			shapes,
			now: Date.now(),
		};
	}, []);
}

function Item({ c, kind, tier }: { c: Case; kind: "row" | "mini"; tier: ItemProps["tier"] }) {
	return (
		<DisplayItemView
			id={c.id ?? c.state}
			shape={c.shape}
			kind={kind}
			selected={!!c.selected}
			tier={tier}
			enter={false}
			silentAs={c.silentAs}
			holds={c.holds}
		/>
	);
}

function Figure({ label, state, children }: { label: string; state: string; children: ReactNode }) {
	return (
		<figure data-state={state}>
			{children}
			<figcaption>{label}</figcaption>
		</figure>
	);
}

/** A section's header, selected, with its switch. */
function SwitchFigure({ mode, sorted }: { mode: SectionDisplay; sorted?: boolean }) {
	const doc = useMemo(() => new Y.Doc(), []);
	const shape: ShapeProps = {
		type: "section",
		title: "Now",
		...at,
		...(mode !== "cards" && { display: mode }),
		...(sorted && { sort: { by: "state" } }),
	};
	return (
		<DocContext value={doc}>
			<div className="display-gallery-switch">
				<DisplaySwitch id="section" shape={shape} />
			</div>
		</DocContext>
	);
}

interface EmptyCase {
	label: string;
	state: string;
	mode: "list" | "mini";
	color: string;
	width: number;
	prompt?: string;
	canDrop?: boolean;
	dropping?: number;
	tier?: ZoomTier;
}

/** Every empty state: what an editor sees, a template's prompt, held over, read-only, zoomed out. */
const EMPTIES: EmptyCase[] = [
	{ label: "List", state: "empty-list", mode: "list", color: "blue", width: 420, canDrop: true },
	{
		label: "List, with a template’s prompt",
		state: "empty-prompt",
		mode: "list",
		color: "green",
		width: 420,
		canDrop: true,
		prompt: "What’s being built now, open work first.",
	},
	{
		label: "Held over",
		state: "empty-dropping",
		mode: "list",
		color: "green",
		width: 420,
		canDrop: true,
		dropping: 1,
	},
	{ label: "Read-only", state: "empty-read-only", mode: "list", color: "purple", width: 420 },
	{
		label: "Mini cards",
		state: "empty-mini",
		mode: "mini",
		color: "blue",
		width: 600,
		canDrop: true,
		prompt: "What waits for the release after this one.",
	},
	{
		label: "Mini cards, held over by two",
		state: "empty-mini-dropping",
		mode: "mini",
		color: "yellow",
		width: 600,
		canDrop: true,
		dropping: 2,
	},
	{
		label: "Below 45%",
		state: "empty-compact",
		mode: "list",
		color: "green",
		width: 420,
		canDrop: true,
		prompt: "What’s being built now, open work first.",
		tier: "compact",
	},
	{
		label: "Below 20%",
		state: "empty-far",
		mode: "list",
		color: "green",
		width: 420,
		canDrop: true,
		tier: "far",
	},
];

/** An empty section showing a list or grid, at the height the layout gives it. */
function EmptyFigure({ mode, color, width, prompt, canDrop, dropping = 0, tier }: EmptyCase) {
	const height = (mode === "mini" ? MINI.pad : LIST.pad) * 2 + emptyWell(mode);
	return (
		<div className="display-gallery-empty" data-tier={tier}>
			<div
				className="section"
				data-color={color}
				data-display={mode === "mini" ? "grid" : "list"}
				data-drop-target={dropping > 0}
				style={{ width, height }}
			>
				<EmptyList
					mode={mode}
					width={width}
					height={height}
					prompt={prompt}
					canDrop={!!canDrop}
					dropping={dropping}
					tier={tier ?? "full"}
				/>
			</div>
		</div>
	);
}

export default function DisplayGallery() {
	const [round, setRound] = useState(0);
	useMemo(() => {
		for (const c of [...PLANNING_CARDS, ...BACKLOG, ...pulls]) cardStore.set(c);
	}, []);
	const marks = useMarks();
	const doc = useMemo(() => new Y.Doc(), []);

	return (
		<ReactFlowProvider>
			<DocContext value={doc}>
				<DisplayMarksContext value={marks}>
					<div className="gallery display-gallery" key={round}>
						<header className="gallery-head">
							<h1>Lists and mini cards</h1>
							<p>
								A section can show what’s in it as a list of rows, or a grid of mini cards. Every
								shape keeps its place on the board for when it’s cards again.
							</p>
							<div className="gallery-actions">
								<button type="button" onClick={() => setRound((r) => r + 1)}>
									Replay
								</button>
								<ThemeToggle labelled />
								<a className="play-link" href="/play?scenario=lists">
									Try it on a board →
								</a>
							</div>
						</header>

						<section>
							<h2>Rows</h2>
							<div className="display-gallery-rows">
								{CASES.map((c) => (
									<Figure key={c.state} label={c.label} state={c.state}>
										<div className="display-gallery-row">
											<Item c={c} kind="row" tier="full" />
										</div>
									</Figure>
								))}
							</div>
						</section>

						<section>
							<h2>Mini cards</h2>
							<div className="display-gallery-minis">
								{CASES.map((c) => (
									<Figure key={c.state} label={c.label} state={c.state}>
										<div className="display-gallery-mini">
											<Item c={c} kind="mini" tier="full" />
										</div>
									</Figure>
								))}
							</div>
						</section>

						<section>
							<h2>Zoomed out</h2>
							<p className="gallery-note">
								Further out, just the state and a bigger title; further still, bars of colour.
							</p>
							<div className="display-gallery-zoom">
								{(["compact", "far"] as const).map((tier) => (
									<Figure
										key={tier}
										label={tier === "compact" ? "Below 45%" : "Below 20%"}
										state={tier}
									>
										<div className="display-gallery-zoomed" data-tier={tier}>
											{CASES.slice(0, 6).map((c) => (
												<div className="display-gallery-row" key={c.state}>
													<Item c={c} kind="row" tier={tier} />
												</div>
											))}
											<div className="display-gallery-minis-small">
												{CASES.slice(0, 4).map((c) => (
													<div className="display-gallery-mini" key={c.state}>
														<Item c={c} kind="mini" tier={tier} />
													</div>
												))}
											</div>
										</div>
									</Figure>
								))}
							</div>
						</section>

						<section>
							<h2>Empty</h2>
							<p className="gallery-note">
								An empty list or grid: placeholders where its first rows go, and what goes in it.
								Held over, the placeholders it’ll take make room.
							</p>
							<div className="display-gallery-empties">
								{EMPTIES.map((e) => (
									<Figure key={e.state} label={e.label} state={e.state}>
										<EmptyFigure {...e} />
									</Figure>
								))}
							</div>
						</section>

						<section>
							<h2>Switching and sorting</h2>
							<div className="gallery-grid display-gallery-switches">
								<Figure label="Cards" state="switch-cards">
									<SwitchFigure mode="cards" />
								</Figure>
								<Figure label="List, by hand" state="switch-list">
									<SwitchFigure mode="list" />
								</Figure>
								<Figure label="Mini cards, by state" state="switch-mini">
									<SwitchFigure mode="mini" sorted />
								</Figure>
							</div>
						</section>

						<section>
							<h2>Popped out</h2>
							<div className="gallery-grid">
								<Figure label="A row’s card, on hover" state="preview">
									<div className="display-preview display-gallery-preview">
										<CardView card={pulls[0]} cardKey={pulls[0]?.key ?? ""} />
									</div>
								</Figure>
							</div>
						</section>
					</div>
				</DisplayMarksContext>
			</DocContext>
		</ReactFlowProvider>
	);
}
