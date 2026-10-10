import { type ReactNode, useEffect, useState } from "react";
import * as Y from "yjs";
import type { Timeline } from "../../shared/history.ts";
import { HistoryController } from "../history/controller.ts";
import { HistoryDock } from "../history/HistoryDock.tsx";
import { ReplayMark, RestoreButton } from "../history/HistoryCanvas.tsx";
import { HistoryButton } from "../history/HistoryButton.tsx";
import { HistoryPanel } from "../history/HistoryPanel.tsx";
import type { HistorySource } from "../history/source.ts";
import { useHistoryMode } from "../history/useHistory.ts";
import { StickyView } from "../StickyNode.tsx";
import { ThemeToggle } from "../ThemeToggle.tsx";
import { HISTORY_PEOPLE, SimulatedHistory, retroHistory } from "./history.ts";
import "./historyGallery.css";

// Every state of history (#47): the panel loading, failing, empty, listing a
// retro's three days, showing a step in the past, filtered to a section and
// view only; the scrubber at now, in the past, playing and loading; marks of
// who changed what; and the restore button. `/play/history`.

const ME = { name: "Ana Costa", color: "#3b4cca", login: "ana" };
const noop = () => {};

/** A retro's history, recorded in memory, and the board it ended as. */
function retro(): { doc: Y.Doc; source: SimulatedHistory } {
	const doc = new Y.Doc();
	const source = new SimulatedHistory({ doc, people: [] }, () => ME);
	source.past(retroHistory());
	return { doc, source };
}

const stuck: HistorySource = {
	timeline: () => new Promise<Timeline>(() => {}),
	segment: () => new Promise(() => {}),
};

const failing: HistorySource = {
	timeline: () => Promise.reject(new Error("Couldn’t load the board’s history.")),
	segment: () => Promise.reject(new Error("Couldn’t load the board’s history.")),
};

interface Setup {
	label: string;
	state: string;
	/** Where it comes from: a recorded retro (the default), an empty board, or a broken source. */
	source?: "retro" | "empty" | "stuck" | "failing";
	/** What to do once it's open. */
	after?: (controller: HistoryController) => Promise<void> | void;
	readOnly?: boolean;
}

/** The step where Kai deleted the flaky CI sticky. */
const kaiDeleted = (controller: HistoryController) =>
	controller
		.getSnapshot()
		.steps.find((step) => step.changes.some((c) => c.id === "flaky" && c.op === "remove"));

const PANELS: Setup[] = [
	{ label: "Loading", state: "panel-loading", source: "stuck" },
	{ label: "Couldn’t load", state: "panel-error", source: "failing" },
	{ label: "Nothing yet", state: "panel-empty", source: "empty" },
	{ label: "Three days of a retro", state: "panel-ready" },
	{
		label: "Showing a step, with something to bring back",
		state: "panel-past",
		after: async (controller) => {
			const step = kaiDeleted(controller);
			if (step) await controller.seekNow(step.id);
		},
	},
	{
		label: "One section’s history",
		state: "panel-section",
		after: (controller) => controller.setSection("hurts"),
	},
	{ label: "View only", state: "panel-read-only", readOnly: true },
];

const DOCKS: Setup[] = [
	{ label: "At now, the live board", state: "dock-now" },
	{
		label: "In the past",
		state: "dock-past",
		after: async (controller) => {
			const step = kaiDeleted(controller);
			if (step) await controller.seekNow(step.id);
		},
	},
	{
		label: "Playing, at 4×",
		state: "dock-playing",
		after: async (controller) => {
			controller.setSpeed(4);
			await controller.play();
		},
	},
	{ label: "Loading", state: "dock-loading", source: "stuck" },
	{ label: "Nothing yet", state: "dock-empty", source: "empty" },
];

function useSetup(setup: Setup, round: number) {
	const [built] = useState(() => {
		if (setup.source === "stuck") return { doc: new Y.Doc(), source: stuck };
		if (setup.source === "failing") return { doc: new Y.Doc(), source: failing };
		if (setup.source === "empty") {
			const doc = new Y.Doc();
			return { doc, source: new SimulatedHistory({ doc, people: [] }, () => ME) };
		}
		return retro();
	});
	const history = useHistoryMode(built.doc, built.source);
	useEffect(() => {
		const controller = history.controller;
		if (!controller) return;
		controller.close();
		void controller.open().then(() => setup.after?.(controller));
		// Each figure sets itself up once per round.
		// oxlint-disable-next-line react-hooks/exhaustive-deps
	}, [history.controller, round]);
	useEffect(
		() => () => {
			if (built.source instanceof SimulatedHistory) built.source.destroy();
		},
		[built],
	);
	return { ...history, doc: built.doc };
}

function PanelFigure({ setup, round }: { setup: Setup; round: number }) {
	const { controller, state, doc } = useSetup(setup, round);
	return (
		<Figure label={setup.label} state={setup.state}>
			<div className="history-gallery-panel">
				{controller && state.open && (
					<HistoryPanel
						controller={controller}
						state={state}
						live={doc}
						readOnly={setup.readOnly ?? false}
						onClose={noop}
						onFocus={noop}
					/>
				)}
			</div>
		</Figure>
	);
}

function DockFigure({ setup, round }: { setup: Setup; round: number }) {
	const { controller, state } = useSetup(setup, round);
	return (
		<Figure label={setup.label} state={setup.state}>
			<div className="history-gallery-dock">
				{controller && state.open && (
					<HistoryDock controller={controller} state={state} onClose={noop} />
				)}
			</div>
		</Figure>
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

const { kai, priya, jo } = HISTORY_PEOPLE;

export default function HistoryGallery() {
	const [round, setRound] = useState(0);
	return (
		<div className="gallery history-gallery">
			<header className="gallery-head">
				<h1>History</h1>
				<p>
					The board over time: scrub or play it back, see who changed what, look at one section’s
					history, and bring back what was removed, as an edit you can undo.
				</p>
				<div className="gallery-actions">
					<button type="button" onClick={() => setRound((r) => r + 1)}>
						Replay
					</button>
					<ThemeToggle labelled />
					<a className="play-link" href="/play?scenario=history">
						Scrub through a retro →
					</a>
				</div>
			</header>

			<section>
				<h2>The button</h2>
				<div className="gallery-grid history-gallery-buttons">
					<Figure label="Closed" state="button-closed">
						<div className="topbar history-gallery-topbar">
							<HistoryButton open={false} onToggle={noop} />
						</div>
					</Figure>
					<Figure label="Open" state="button-open">
						<div className="topbar history-gallery-topbar">
							<HistoryButton open onToggle={noop} />
						</div>
					</Figure>
				</div>
			</section>

			<section>
				<h2>The panel</h2>
				<div className="gallery-grid history-gallery-panels">
					{PANELS.map((setup) => (
						<PanelFigure key={`${setup.state}`} setup={setup} round={round} />
					))}
				</div>
			</section>

			<section>
				<h2>The scrubber</h2>
				<div className="gallery-grid history-gallery-docks">
					{DOCKS.map((setup) => (
						<DockFigure key={`${setup.state}`} setup={setup} round={round} />
					))}
				</div>
			</section>

			<section>
				<h2>On the board</h2>
				<div className="gallery-grid history-gallery-marks" key={round}>
					<Figure label="Added" state="mark-add">
						<MarkStage>
							<StickyView text="A bot that drafts release notes" color="blue" author={jo} />
							<ReplayMark
								change={{ id: "a", op: "add", type: "sticky", box: [0, 0, 176, 176] }}
								actor={jo}
								named
							/>
						</MarkStage>
					</Figure>
					<Figure label="Edited" state="mark-edit">
						<MarkStage>
							<StickyView text="Release notes by hand take hours" color="yellow" author={priya} />
							<ReplayMark
								change={{ id: "a", op: "edit", keys: ["text"], box: [0, 0, 176, 176] }}
								actor={priya}
								named
							/>
						</MarkStage>
					</Figure>
					<Figure label="Removed" state="mark-remove">
						<MarkStage>
							<ReplayMark
								change={{ id: "a", op: "remove", type: "sticky", box: [0, 0, 176, 176] }}
								actor={kai}
								named
							/>
						</MarkStage>
					</Figure>
					<Figure label="Bring back" state="restore">
						<div className="history-gallery-restore">
							<RestoreButton count={1} copy={false} onRestore={noop} />
						</div>
					</Figure>
					<Figure label="Restore a copy of three" state="restore-copy">
						<div className="history-gallery-restore">
							<RestoreButton count={3} copy onRestore={noop} />
						</div>
					</Figure>
				</div>
			</section>
		</div>
	);
}

function MarkStage({ children }: { children: ReactNode }) {
	return <div className="history-gallery-mark">{children}</div>;
}
