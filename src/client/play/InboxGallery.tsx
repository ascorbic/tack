import { ReactFlowProvider } from "@xyflow/react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import type { Card } from "../../shared/cards.ts";
import { dismissFromInbox, inboxQuery, setInbox } from "../../shared/inbox.ts";
import {
	type RuleLogEntry,
	addRule,
	pauseRules,
	refreshMatches,
	ruleLog,
	rulesMap,
	rulesPauseMap,
	setRuleEnabled,
} from "../../shared/rules.ts";
import { type ShapeProps, addShape, nextZ, readShape, shapesMap } from "../../shared/shapes.ts";
import { addSection } from "../../shared/structure.ts";
import { addCard } from "../board.ts";
import { CardView } from "../CardView.tsx";
import { cardStore } from "../cardStore.ts";
import { DocContext } from "../DocContext.ts";
import { InboxTray } from "../inbox/InboxTray.tsx";
import { inboxStore } from "../inbox/store.ts";
import { useCardProvenance } from "../Provenance.tsx";
import { RulesPanel } from "../rules/RulesPanel.tsx";
import { ThemeToggle } from "../ThemeToggle.tsx";
import { ToastStore } from "../Toasts.tsx";
import { SimulatedAutomation, seedForge } from "./automation.ts";
import { TRIAGE_QUERY } from "./automationScenarios.ts";
import { LABELS, PLANNING_CARDS, fixture } from "./fixtures.ts";
import "../inbox/inbox.css";
import "../rules/rules.css";

// Every state of inbox frames (#40) and rules (#44): trays loading, full,
// sorted, failing, folded and being set up; how cards say where they came
// from; and the rules panel, empty, busy, paused and composing.
// `/play/inbox`.

const HOST = "fake.tack";
const automations = new Set<SimulatedAutomation>();
const ME = { name: "Priya Shah", color: "#b4467a" };
const noop = () => {};

const NEW = [
	fixture({ item: "#611", title: "Width is ignored when `fill` is set", comments: 2 }),
	fixture({ item: "#612", title: "Contentful provider drops focal point" }),
	fixture({ item: "#613", title: "Add an example for Remix", comments: 4 }),
];
const LATER = fixture({ item: "#614", title: "srcset has duplicate entries at 3x" });
const SORTED = fixture({ item: "#601", title: "Docs: the `unpic` CLI flags" });
const RELABELLED = fixture({
	item: "#602",
	title: "Cloudflare Images: wrong default format",
	labels: [LABELS.bug, LABELS.provider],
});

interface TrayCase {
	label: string;
	state: string;
	q: string;
	/** Items on the board already. */
	onBoard?: Card[];
	dismissed?: string[];
	held?: boolean;
	collapsed?: boolean;
	editing?: boolean;
	notInbox?: boolean;
	readOnly?: boolean;
}

const TRAYS: TrayCase[] = [
	{ label: "Searching", state: "loading", q: TRIAGE_QUERY, held: true },
	{
		label: "New matches, one just arrived",
		state: "items",
		q: TRIAGE_QUERY,
		onBoard: [SORTED],
		dismissed: [RELABELLED.key],
	},
	{
		label: "All sorted",
		state: "empty",
		q: `${TRIAGE_QUERY} "CLI flags"`,
		onBoard: [SORTED],
	},
	{ label: "Couldn’t search", state: "error", q: "is:issue is:open no:label" },
	{ label: "Folded away", state: "collapsed", q: TRIAGE_QUERY, collapsed: true },
	{ label: "Making a section an inbox", state: "new", q: "", editing: true, notInbox: true },
	{ label: "Editing the query", state: "editing", q: TRIAGE_QUERY, editing: true },
	{ label: "View only", state: "read-only", q: TRIAGE_QUERY, readOnly: true },
];

function Figure({ label, state, children }: { label: string; state: string; children: ReactNode }) {
	return (
		<figure data-state={state}>
			<div className="inbox-gallery-stage">{children}</div>
			<figcaption>{label}</figcaption>
		</figure>
	);
}

/** A board for one tray: its section, and whatever's on it already. */
function useTrayBoard(c: TrayCase, round: number) {
	return useMemo(() => {
		const doc = new Y.Doc();
		const id = addSection(doc, { x: 0, y: 0, w: 600, h: 400 }, { title: "Triage", color: "blue" });
		if (!c.notInbox) setInbox(doc, id, inboxQuery(c.q, HOST));
		for (const card of c.onBoard ?? []) addCard(doc, card.key, { x: 20, y: 40 });
		if (c.dismissed) dismissFromInbox(doc, id, c.dismissed, "Kai");
		return { doc, id, round };
	}, [c, round]);
}

function TrayFigure({ c, round, toasts }: { c: TrayCase; round: number; toasts: ToastStore }) {
	const { doc, id } = useTrayBoard(c, round);
	const [shape, setShape] = useState<ShapeProps | null>(null);
	useEffect(() => {
		const map = shapesMap(doc).get(id);
		if (!map) return;
		const read = () => setShape(readShape(map));
		read();
		map.observeDeep(read);
		return () => map.unobserveDeep(read);
	}, [doc, id]);
	useEffect(() => {
		const automation = new SimulatedAutomation(doc);
		automation.latency = 200;
		if (c.held) automation.held.add(id);
		automations.add(automation);
		const stop = automation.start();
		inboxStore.rewatch([id]);
		// One more match turns up a moment later, to show how arrivals land.
		const timer = c.state === "items" ? setTimeout(() => automation.deliver(LATER), 900) : 0;
		return () => {
			clearTimeout(timer);
			automations.delete(automation);
			stop();
		};
	}, [doc, id, c]);
	if (!shape) return null;
	return (
		<DocContext value={doc}>
			<InboxTray
				id={id}
				shape={shape}
				doc={doc}
				editing={Boolean(c.editing)}
				collapsed={Boolean(c.collapsed)}
				readOnly={Boolean(c.readOnly)}
				user={ME}
				toasts={toasts}
				sizeOf={() => undefined}
			/>
		</DocContext>
	);
}

/** Cards, each as it arrived. */
function useMarksDoc() {
	return useMemo(() => {
		const doc = new Y.Doc();
		const inbox = addSection(doc, { x: 0, y: 0, w: 600, h: 400 }, { title: "Triage" });
		setInbox(doc, inbox, inboxQuery(TRIAGE_QUERY, HOST));
		const rule = addRule(
			doc,
			{ kind: "matches", query: inboxQuery("repo:acme/imagekit is:issue label:bug", HOST) },
			{ kind: "section", section: inbox },
			ME,
		);
		const beside = addRule(doc, { kind: "pull-links" }, { kind: "beside-linked" }, ME);
		const add = (card: Card, provenance: ShapeProps["provenance"]) => {
			const id = crypto.randomUUID();
			addShape(doc, id, { type: "card", ref: card.key, x: 0, y: 0, z: nextZ(doc), provenance });
			return id;
		};
		const pull = PLANNING_CARDS.find((card) => card.kind === "pull") ?? NEW[0]!;
		const noLongerBug = fixture({ item: "#620", title: "Flicker on resize", labels: [] });
		for (const card of [SORTED, RELABELLED, pull, noLongerBug]) cardStore.set(card);
		const ids = {
			sorted: add(SORTED, { via: "inbox", source: inbox }),
			relabelled: add(RELABELLED, { via: "inbox", source: inbox }),
			pull: add(pull, { via: "rule", source: beside }),
			noLongerBug: add(noLongerBug, { via: "rule", source: rule }),
		};
		// Webhooks say two of them no longer match, as the server would hear.
		refreshMatches(doc, { cards: [RELABELLED, noLongerBug] });
		return {
			doc,
			marks: [
				{
					label: "Sorted from an inbox",
					card: SORTED,
					id: ids.sorted,
					fresh: false,
				},
				{
					label: "From an inbox, no longer matching",
					card: RELABELLED,
					id: ids.relabelled,
					fresh: false,
				},
				{
					label: "Just placed by a rule",
					card: pull,
					id: ids.pull,
					fresh: true,
				},
				{
					label: "Placed by a rule, no longer matching",
					card: noLongerBug,
					id: ids.noLongerBug,
					fresh: false,
				},
			],
		};
	}, []);
}

function MarkFigure({
	doc,
	id,
	card,
	fresh,
	round,
}: {
	doc: Y.Doc;
	id: string;
	card: Card;
	fresh: boolean;
	round: number;
}) {
	const shape = readShape(shapesMap(doc).get(id)!);
	const { origin, unmatched } = useCardProvenance(doc, id, shape, false);
	return (
		<div className="inbox-gallery-card" key={round}>
			<CardView
				card={card}
				cardKey={card.key}
				enter={fresh}
				origin={origin}
				unmatched={unmatched}
			/>
		</div>
	);
}

/** A board with rules, some activity, and one paused. */
function useRulesDoc(kind: "empty" | "busy" | "paused") {
	return useMemo(() => {
		const doc = new Y.Doc();
		const bugs = addSection(doc, { x: 0, y: 0, w: 600, h: 400 }, { title: "New bugs" });
		const [issue] = PLANNING_CARDS;
		if (issue) addCard(doc, issue.key, { x: 700, y: 0 });
		if (kind === "empty") return doc;
		const beside = addRule(doc, { kind: "pull-links" }, { kind: "beside-linked" }, ME);
		const matching = addRule(
			doc,
			{ kind: "matches", query: inboxQuery("repo:acme/imagekit is:issue is:open label:bug", HOST) },
			{ kind: "section", section: bugs },
			ME,
		);
		const docs = addRule(
			doc,
			{ kind: "pull-links", closesOnly: true },
			{ kind: "beside-linked" },
			{ name: "Kai Andersen" },
		);
		setRuleEnabled(doc, docs, false);
		if (kind === "paused") {
			pauseRules(doc, { name: "Kai Andersen" });
			rulesPauseMap(doc).set("held", 3);
		}
		const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
		rulesMap(doc).get(beside)?.set("fired", 3);
		rulesMap(doc).get(beside)?.set("lastAt", ago(2));
		rulesMap(doc).get(matching)?.set("fired", 1);
		rulesMap(doc).get(matching)?.set("lastAt", ago(65));
		const entries: RuleLogEntry[] = [
			{
				id: "e1",
				rule: matching,
				at: ago(65),
				outcome: "placed",
				key: "fake.tack/acme/imagekit#377",
				section: bugs,
				shape: "x",
			},
			{
				id: "e2",
				rule: beside,
				at: ago(30),
				outcome: "placed",
				key: "fake.tack/acme/imagekit#418",
				near: "fake.tack/acme/imagekit#412",
				shape: "y",
			},
			{
				id: "e3",
				rule: matching,
				at: ago(9),
				outcome: "skipped",
				key: "fake.tack/acme/imagekit#440",
				section: "gone",
				reason: "no_section",
			},
			{
				id: "e4",
				rule: beside,
				at: ago(2),
				outcome: "placed",
				key: "fake.tack/acme/imagekit#431",
				near: "fake.tack/acme/imagekit#412",
				shape: "z",
			},
		];
		ruleLog(doc).push(entries);
		return doc;
	}, [kind]);
}

function RulesFigure({
	doc,
	readOnly = false,
	composing = false,
	toasts,
}: {
	doc: Y.Doc;
	readOnly?: boolean;
	composing?: boolean;
	toasts: ToastStore;
}) {
	return (
		<div className="inbox-gallery-panel">
			<RulesPanel
				doc={doc}
				user={ME}
				readOnly={readOnly}
				onClose={noop}
				onReveal={noop}
				onUndo={noop}
				toasts={toasts}
				initiallyComposing={composing}
			/>
		</div>
	);
}

export default function InboxGallery() {
	const [round, setRound] = useState(0);
	const [toasts] = useState(() => new ToastStore());
	// Every tray's board answers for its own inboxes.
	useEffect(() => {
		inboxStore.reset();
		const previous = inboxStore.channel;
		inboxStore.channel = {
			send: (request) => {
				for (const automation of automations) automation.receive(request);
			},
		};
		inboxStore.rewatch();
		return () => {
			inboxStore.channel = previous;
		};
	}, []);
	useMemo(() => {
		seedForge([...NEW, SORTED, RELABELLED, ...PLANNING_CARDS]);
		for (const card of [LATER]) cardStore.set(card);
	}, []);
	const marks = useMarksDoc();
	const emptyRules = useRulesDoc("empty");
	const busyRules = useRulesDoc("busy");
	const composingRules = useRulesDoc("empty");
	const pausedRules = useRulesDoc("paused");

	return (
		<ReactFlowProvider>
			<div className="gallery inbox-gallery">
				<header className="gallery-head">
					<h1>Inboxes and rules</h1>
					<p>
						Boards that fill themselves. An inbox section collects new matches for a search in a
						tray, for people to sort; rules place cards as webhooks arrive. Neither ever moves what
						people placed.
					</p>
					<div className="gallery-actions">
						<button type="button" onClick={() => setRound((r) => r + 1)}>
							Replay
						</button>
						<ThemeToggle labelled />
						<a className="play-link" href="/play?scenario=inbox">
							← Try an inbox
						</a>
						<a className="play-link" href="/play?scenario=rules">
							Try rules →
						</a>
					</div>
				</header>

				<section>
					<h2>Inbox trays</h2>
					<div className="gallery-grid inbox-gallery-trays">
						{TRAYS.map((c) => (
							<Figure key={`${c.label}${round}`} label={c.label} state={c.state}>
								<TrayFigure c={c} round={round} toasts={toasts} />
							</Figure>
						))}
					</div>
				</section>

				<section>
					<h2>How cards arrived</h2>
					<div className="gallery-grid inbox-gallery-cards">
						<DocContext value={marks.doc}>
							{marks.marks.map((mark) => (
								<Figure
									key={`${mark.label}${round}`}
									label={mark.label}
									state={mark.label.includes("no longer") ? "stale" : "fresh"}
								>
									<MarkFigure doc={marks.doc} {...mark} round={round} />
								</Figure>
							))}
						</DocContext>
					</div>
				</section>

				<section>
					<h2>The rules panel</h2>
					<div className="gallery-grid inbox-gallery-panels">
						<Figure label="No rules yet" state="rules-empty">
							<RulesFigure key={`e${round}`} doc={emptyRules} toasts={toasts} />
						</Figure>
						<Figure label="Rules at work, one paused" state="rules-busy">
							<RulesFigure key={`b${round}`} doc={busyRules} toasts={toasts} />
						</Figure>
						<Figure label="A new rule" state="rules-composing">
							<RulesFigure key={`c${round}`} doc={composingRules} composing toasts={toasts} />
						</Figure>
						<Figure label="Paused for a session" state="rules-paused">
							<RulesFigure key={`p${round}`} doc={pausedRules} toasts={toasts} />
						</Figure>
						<Figure label="View only" state="rules-read-only">
							<RulesFigure key={`r${round}`} doc={busyRules} readOnly toasts={toasts} />
						</Figure>
						<Figure label="View only, no rules" state="rules-read-only-empty">
							<RulesFigure key={`v${round}`} doc={emptyRules} readOnly toasts={toasts} />
						</Figure>
					</div>
				</section>
			</div>
		</ReactFlowProvider>
	);
}
