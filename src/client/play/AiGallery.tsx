import { type ReactNode, useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { type AiError, type WidgetProposal, aiError } from "../../shared/ai.ts";
import "../actions/actions.css";
import type { Action } from "../actions/ActionBar.tsx";
import { IssueIcon, ParentIcon } from "../actions/icons.tsx";
import { type AskState, AskWidgetView } from "../ai/AskWidget.tsx";
import { type DraftState, DraftPanelView, draftEdit } from "../ai/DraftPanel.tsx";
import { widgetSuggestions } from "../ai/describe.ts";
import { DraftDecisionIcon, SummariseIcon } from "../ai/icons.tsx";
import { WidgetPreview } from "../ai/WidgetPreview.tsx";
import "../ai/ai.css";
import { ServicesContext } from "../actions/services.ts";
import { ThemeToggle } from "../ThemeToggle.tsx";
import { GalleryBar } from "./GalleryBar.tsx";
import { playServices } from "./writes.ts";
import { REPO, SimulatedWidgets } from "./widgets.ts";
import "./aiGallery.css";

// Every state of AI on the board (#64): asking for a widget (suggestions,
// thinking, a proposal previewed live over the fake repository, and each
// way it can fail), and summarising and drafting a decision from a
// selection (drafting, the draft to edit, what it left out, and failures).
// Whether AI is on for the instance is on `/play/auth`. `/play/ai`.

const noop = () => {};

const PROPOSALS: { label: string; prompt: string; proposal: WidgetProposal }[] = [
	{
		label: "A list, previewed live",
		prompt: `Open bugs in ${REPO}`,
		proposal: {
			kind: "widget",
			widget: "list",
			config: {
				title: "Open bugs",
				host: "fake.tack",
				q: `repo:${REPO} is:open label:bug`,
				sort: "updated",
				limit: 30,
			},
			explanation: `Open bugs in ${REPO}, most recently updated first.`,
		},
	},
	{
		label: "A stale finder, with its settings in words",
		prompt: `Issues in ${REPO} nobody’s touched for a month`,
		proposal: {
			kind: "widget",
			widget: "stale",
			config: {
				title: "Gone quiet",
				host: "fake.tack",
				q: `repo:${REPO} is:open is:issue`,
				days: 30,
				label: "stale",
				limit: 30,
			},
			explanation: "Open issues nobody’s touched for 30 days, grouped by how long.",
		},
	},
];

const ASK_ERRORS: { label: string; prompt: string; error: AiError }[] = [
	{
		label: "Nothing usable came back",
		prompt: "Something that makes the roadmap obvious",
		error: aiError("unusable"),
	},
	{
		label: "The board’s used a lot of AI just now",
		prompt: "Pull requests waiting for my review",
		error: aiError("rate_limited", { retryAt: Date.now() + 40_000 }),
	},
	{ label: "The model failed", prompt: "Open bugs", error: aiError("failed") },
];

const SUMMARY = draftEdit({
	kind: "summary",
	title: "Retro: docs and CI hurt most",
	summary:
		"Most notes are about documentation being hard to find and out of step with releases, and CI being slow enough that people stop waiting for it.",
	points: [
		"Docs: provider pages are hard to find; generate one per provider",
		"Releases: write the migration guide before breaking changes land",
		"CI: twenty minutes a run; cache the CDN detection",
	],
	read: 9,
	leftOut: { faceDown: 0, private: 1 },
});

const DECISION = draftEdit({
	kind: "decision",
	title: "Rewrite the search index, or cache results?",
	context:
		"Search is slow on big repositories, and people keep asking for filters. The discussion weighed a rewrite against caching, with filters as a way to make it matter less.",
	options: [
		{ name: "Rewrite the index", summary: "Fast for good, but weeks of work." },
		{ name: "Cache results for a minute", summary: "Quick to ship; results can be stale." },
		{ name: "Add filters first", summary: "People search less, so slowness hurts less." },
	],
	read: 5,
	leftOut: { faceDown: 0, private: 0 },
});

const DRAFTS: { label: string; mode: "summary" | "decision"; what: string; state: DraftState }[] = [
	{
		label: "Summarising",
		mode: "summary",
		what: "the “Retro” section",
		state: { status: "loading" },
	},
	{
		label: "A summary to read and place, a private card left out",
		mode: "summary",
		what: "the “Retro” section",
		state: { status: "ready", edit: SUMMARY, read: 9, leftOut: { faceDown: 0, private: 1 } },
	},
	{
		label: "A decision to edit, with its options",
		mode: "decision",
		what: "5 stickies",
		state: { status: "ready", edit: DECISION, read: 5, leftOut: { faceDown: 2, private: 0 } },
	},
	{
		label: "Face down: nothing to read until the reveal",
		mode: "summary",
		what: "4 stickies",
		state: {
			status: "error",
			error: aiError("empty", { message: "Those stickies are face down: reveal them first." }),
		},
	},
	{
		label: "Rate limited",
		mode: "decision",
		what: "6 stickies",
		state: { status: "error", error: aiError("rate_limited") },
	},
	{
		label: "The model failed",
		mode: "summary",
		what: "3 cards",
		state: { status: "error", error: aiError("failed") },
	},
];

const BAR: Action[] = [
	{
		id: "makeIssues",
		label: "Make issues from stickies",
		icon: <IssueIcon />,
		text: "Make 6 issues",
	},
	{ id: "parentIssue", label: "Make a parent issue", icon: <ParentIcon /> },
	{ id: "summarise", label: "Summarise with AI", icon: <SummariseIcon /> },
	{ id: "draftDecision", label: "Draft a decision with AI", icon: <DraftDecisionIcon /> },
];

const FACE_DOWN_BAR: Action[] = [
	{
		id: "summarise",
		label: "Summarise with AI",
		icon: <SummariseIcon />,
		unavailable: "Face down until the reveal",
	},
	{
		id: "draftDecision",
		label: "Draft a decision with AI",
		icon: <DraftDecisionIcon />,
		unavailable: "Face down until the reveal",
	},
];

/** A panel as it looks open, without needing a bar to hang from. */
function Panel({ children }: { children: ReactNode }) {
	const named = (el: HTMLDivElement | null) => {
		const title = el?.closest("figure")?.querySelector("figcaption")?.textContent;
		if (el && title) el.setAttribute("aria-label", title);
	};
	return (
		<div ref={named} className="action-popover" data-static role="dialog">
			{children}
		</div>
	);
}

/** The ask tray, as it sits above the tool dock. */
function Tray({ children }: { children: ReactNode }) {
	return <div className="ai-gallery-tray">{children}</div>;
}

export default function AiGallery() {
	const [round, setRound] = useState(0);
	const [services] = useState(playServices);
	// Previews run over the playground's fake repository, as they do on /play.
	const widgets = useMemo(() => new SimulatedWidgets(new Y.Doc()), []);
	useEffect(() => () => widgets.destroy(), [widgets]);

	return (
		<ServicesContext value={services}>
			<div className="gallery ai-gallery">
				<header className="gallery-head">
					<h1>AI</h1>
					<p>
						Asking for a widget in words, and summarising or drafting a decision from what’s
						selected. Everything the AI proposes is shown first, to edit, and placed as your own
						edit; it reads only what you may (never face-down stickies, never private cards you
						can’t see).
					</p>
					<div className="gallery-actions">
						<button type="button" onClick={() => setRound((r) => r + 1)}>
							Replay
						</button>
						<ThemeToggle labelled />
						<a className="play-link" href="/play?scenario=ai">
							← Try it in the playground
						</a>
					</div>
				</header>

				<section key={`ask${round}`}>
					<h2>Asking for a widget</h2>
					<div className="gallery-grid ai-gallery-asks">
						<figure data-state="idle">
							<Tray>
								<AskWidgetView
									state={{ status: "idle" }}
									prompt=""
									suggestions={widgetSuggestions(REPO)}
									onPrompt={noop}
									onAsk={noop}
									onPlace={noop}
									onBack={noop}
								/>
							</Tray>
							<figcaption>Ideas to start from</figcaption>
						</figure>
						<figure data-state="asking">
							<Tray>
								<AskWidgetView
									state={{ status: "asking", prompt: "Pull requests waiting for my review" }}
									prompt="Pull requests waiting for my review"
									suggestions={[]}
									onPrompt={noop}
									onAsk={noop}
									onPlace={noop}
									onBack={noop}
								/>
							</Tray>
							<figcaption>Choosing a widget</figcaption>
						</figure>
						{PROPOSALS.map(({ label, prompt, proposal }, i) => {
							const state: AskState = {
								status: "ready",
								prompt,
								proposal,
								preview: `gallery-${i}-${round}`,
							};
							return (
								<figure key={label} data-state="ready">
									<Tray>
										<AskWidgetView
											state={state}
											prompt={prompt}
											suggestions={[]}
											onPrompt={noop}
											onAsk={noop}
											onPlace={noop}
											onBack={noop}
											preview={
												<WidgetPreview
													id={state.preview}
													widget={proposal.widget}
													config={proposal.config}
													onPreview={(id) => widgets.preview(id, proposal.widget, proposal.config)}
												/>
											}
										/>
									</Tray>
									<figcaption>{label}</figcaption>
								</figure>
							);
						})}
						{ASK_ERRORS.map(({ label, prompt, error }) => (
							<figure key={label} data-state={error.reason}>
								<Tray>
									<AskWidgetView
										state={{ status: "error", prompt, error }}
										prompt={prompt}
										suggestions={[]}
										onPrompt={noop}
										onAsk={noop}
										onPlace={noop}
										onBack={noop}
									/>
								</Tray>
								<figcaption>{label}</figcaption>
							</figure>
						))}
					</div>
				</section>

				<section key={`bars${round}`}>
					<h2>In the action bar</h2>
					<div className="gallery-grid ai-gallery-bars">
						<figure>
							<GalleryBar actions={BAR} label="Stickies selected" />
							<figcaption>Stickies selected</figcaption>
						</figure>
						<figure>
							<GalleryBar actions={FACE_DOWN_BAR} label="Face-down stickies" />
							<figcaption>Face-down stickies</figcaption>
						</figure>
					</div>
				</section>

				<section key={`drafts${round}`}>
					<h2>Summaries and decisions</h2>
					<div className="gallery-grid ai-gallery-drafts">
						{DRAFTS.map(({ label, mode, what, state }) => (
							<figure
								key={label}
								data-state={state.status === "error" ? state.error.reason : state.status}
							>
								<Panel>
									<DraftPanelView
										mode={mode}
										state={state}
										what={what}
										onEdit={noop}
										onPlace={noop}
										onRetry={noop}
									/>
								</Panel>
								<figcaption>{label}</figcaption>
							</figure>
						))}
					</div>
				</section>
			</div>
		</ServicesContext>
	);
}
