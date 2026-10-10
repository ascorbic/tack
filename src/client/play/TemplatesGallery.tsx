import { type ReactNode, useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { type ActionState, addDays } from "../../shared/actionItems.ts";
import { BUILT_IN_TEMPLATES, builtInInfo } from "../../shared/builtInTemplates.ts";
import type { Mentionable } from "../../shared/comments.ts";
import { markStarted, readPrepared } from "../../shared/prepared.ts";
import type { TemplateInfo } from "../../shared/templates.ts";
import { instantiateTemplate } from "../../shared/templates.ts";
import "../actions/actions.css";
import {
	type ActionItemViewProps,
	type ActionLinkView,
	ActionItemView,
} from "../actionItems/ActionItemView.tsx";
import { CarryPanel } from "../actionItems/CarryPanel.tsx";
import { DuePicker, LinkPicker, OwnerPicker } from "../actionItems/pickers.tsx";
import { BoardThumbnail } from "../boards/BoardThumbnail.tsx";
import { NewBoardPicker } from "../boards/NewBoard.tsx";
import { SaveTemplatePanel } from "../boards/SaveTemplate.tsx";
import type { SavedTemplates } from "../boards/templates.ts";
import { PreparedSteps } from "../facilitation/Prepared.tsx";
import "../facilitation/facilitation.css";
import { ThemeToggle } from "../ThemeToggle.tsx";
import { board, OCTOCAT, PRIYA as PRIYA_PERSON } from "./boardFixtures.ts";
import { playServices } from "./writes.ts";
import "./templatesGallery.css";

// Every state of action items (#52) and templates (#53): items due later,
// soon, today and late, done, linked and staged; their pickers; carrying
// over; a template's steps ready to start; the New board picker with saved
// templates loading, missing and there; and saving a board as a template.
// `/play/templates`.

const TODAY = "2026-10-10";
const PRIYA = { login: "priya", name: "Priya Shah" };
const KAI = { login: "kai", name: "Kai Andersen" };
const OPEN: ActionState = { status: "open", from: "board" };
const DONE: ActionState = { status: "done", from: "board" };
const noop = () => {};

const LINK_OPEN: ActionLinkView = {
	key: "github.com/emdash-cms/emdash#412",
	label: "#412",
	state: "open",
	title: "Document the plugin API",
	url: "https://github.com/emdash-cms/emdash/issues/412",
};

const ITEMS: { label: string; state: string; props: Omit<ActionItemViewProps, "today"> }[] = [
	{
		label: "Due later",
		state: "later",
		props: { text: "Write up the caching plan", owner: PRIYA, due: addDays(TODAY, 9), state: OPEN },
	},
	{
		label: "Due soon",
		state: "soon",
		props: {
			text: "Pair on the flaky upload test",
			owner: KAI,
			due: addDays(TODAY, 2),
			state: OPEN,
		},
	},
	{
		label: "Due today",
		state: "today",
		props: { text: "Send the release notes", owner: PRIYA, due: TODAY, state: OPEN },
	},
	{
		label: "Late",
		state: "overdue",
		props: { text: "Rotate the CDN keys", owner: KAI, due: addDays(TODAY, -3), state: OPEN },
	},
	{
		label: "Done",
		state: "done",
		props: { text: "Book the venue", owner: PRIYA, due: addDays(TODAY, -1), state: DONE },
	},
	{
		label: "Just ticked",
		state: "celebrate",
		props: { text: "Thank the translators", owner: KAI, state: DONE, celebrate: true },
	},
	{
		label: "Linked: open issue",
		state: "linked-open",
		props: {
			text: "Document the plugin API",
			owner: KAI,
			due: addDays(TODAY, 5),
			state: { status: "open", from: "issue" },
			link: LINK_OPEN,
		},
	},
	{
		label: "Linked: issue closed",
		state: "linked-closed",
		props: {
			text: "Cache provider lookups",
			owner: PRIYA,
			state: { status: "done", from: "issue", reason: "completed" },
			link: { ...LINK_OPEN, label: "#377", state: "closed" },
		},
	},
	{
		label: "Closing staged",
		state: "pending-close",
		props: {
			text: "Document the plugin API",
			owner: KAI,
			state: { status: "open", from: "issue" },
			link: { ...LINK_OPEN, staged: "close" },
		},
	},
	{
		label: "New issue staged",
		state: "staged",
		props: {
			text: "Add a size budget to CI",
			owner: PRIYA,
			due: addDays(TODAY, 12),
			state: OPEN,
			stagedIssue: { repo: "emdash-cms/emdash", status: "staged" },
		},
	},
	{
		label: "Issue being made",
		state: "sending",
		props: {
			text: "Add a size budget to CI",
			owner: PRIYA,
			state: OPEN,
			stagedIssue: { repo: "emdash-cms/emdash", status: "sending" },
		},
	},
	{
		label: "Making the issue failed",
		state: "failed",
		props: {
			text: "Add a size budget to CI",
			state: OPEN,
			stagedIssue: { repo: "emdash-cms/emdash", status: "failed", error: "Not allowed" },
		},
	},
	{
		label: "Carried over",
		state: "carried",
		props: {
			text: "Ask upstream about AVIF support",
			owner: KAI,
			due: addDays(TODAY, -8),
			state: OPEN,
			carried: { board: "b", title: "Retro, September", shape: "x", at: "2026-09-12T10:00:00Z" },
		},
	},
	{
		label: "New, selected",
		state: "empty",
		props: { text: "", state: OPEN, selected: true },
	},
	{
		label: "Linked, issue unreadable",
		state: "unknown",
		props: {
			text: "Fix the private deploy script",
			state: { status: "open", from: "unknown" },
			link: { key: "github.com/acme/vault#7", label: "acme/vault#7", state: "unknown" },
			tick: { can: false, why: "Its status comes from acme/vault#7, once it loads" },
		},
	},
	{
		label: "View only",
		state: "read-only",
		props: {
			text: "Write up the caching plan",
			owner: PRIYA,
			due: addDays(TODAY, 2),
			state: OPEN,
			readOnly: true,
		},
	},
	{
		label: "Zoomed out",
		state: "compact",
		props: {
			text: "Rotate the CDN keys",
			owner: KAI,
			due: addDays(TODAY, -3),
			state: OPEN,
			compact: true,
		},
	},
];

const PEOPLE: Mentionable[] = [
	{ id: 1, login: "priya", name: "Priya Shah", avatarUrl: "", role: "owner" },
	{ id: 2, login: "kai", name: "Kai Andersen", avatarUrl: "", role: "editor" },
	{ id: 3, login: "tom", name: "Tom Okafor", avatarUrl: "", role: null },
];

const SAVED: TemplateInfo[] = [
	{
		...builtInInfo(BUILT_IN_TEMPLATES[1] as never),
		id: "savedretro1",
		title: "Our fortnightly retro",
		description: "What went well, what to fix, who’s doing what, with kudos at the end.",
		builtIn: false,
		owner: PRIYA_PERSON,
		createdAt: Date.parse("2026-10-07T10:00:00Z"),
		canDelete: true,
	},
	{
		...builtInInfo(BUILT_IN_TEMPLATES[2] as never),
		id: "savedtriage",
		title: "emdash triage",
		description: "Unlabelled issues across the emdash repositories.",
		builtIn: false,
		owner: OCTOCAT,
		createdAt: Date.parse("2026-09-30T10:00:00Z"),
		canDelete: false,
		repos: {
			min: 0,
			max: 2,
			defaults: ["github.com/emdash-cms/emdash", "github.com/emdash-cms/docs"],
		},
	},
];

const BOARDS = [
	board("Retro, September", { layout: "retro" }),
	board("Sprint 42 retro", { layout: "retro" }),
];

function Figure({
	label,
	state,
	wide,
	children,
}: {
	label: string;
	state: string;
	wide?: boolean;
	children: ReactNode;
}) {
	return (
		<figure data-state={state} data-wide={wide || undefined}>
			<div className="templates-gallery-stage">{children}</div>
			<figcaption>{label}</figcaption>
		</figure>
	);
}

/** A picker as it sits in its popover, without the board around it. */
function Panel({ children, wide }: { children: ReactNode; wide?: boolean }) {
	return (
		<div className="action-popover templates-gallery-popover" data-wide={wide || undefined}>
			{children}
		</div>
	);
}

function useRunSheet() {
	return useMemo(() => {
		const doc = new Y.Doc();
		const template = BUILT_IN_TEMPLATES.find((t) => t.id === "tack:retro");
		if (template) instantiateTemplate(doc, template.content, { by: { name: "Priya Shah" } });
		const fresh = readPrepared(doc);
		const done = new Y.Doc();
		Y.applyUpdate(done, Y.encodeStateAsUpdate(doc));
		const [first, second] = readPrepared(done);
		const by = { name: "Priya Shah", color: "#b4467a" };
		if (first) markStarted(done, first.id, by, "2026-10-10T14:40:00Z");
		if (second) markStarted(done, second.id, by, "2026-10-10T14:46:00Z");
		return { doc, fresh, done, started: readPrepared(done) };
	}, []);
}

export default function TemplatesGallery() {
	const [round, setRound] = useState(0);
	const services = useMemo(playServices, []);
	const sheet = useRunSheet();
	// The pickers take focus as they would in their popovers: stay at the top.
	useEffect(() => {
		const frame = requestAnimationFrame(() => window.scrollTo(0, 0));
		return () => cancelAnimationFrame(frame);
	}, [round]);
	const savedStates: { label: string; state: string; saved: SavedTemplates }[] = [
		{ label: "Saved templates loading", state: "picker-loading", saved: { status: "loading" } },
		{ label: "None saved yet", state: "picker-empty", saved: { status: "ready", templates: [] } },
		{
			label: "Saved on this Tack",
			state: "picker-saved",
			saved: { status: "ready", templates: SAVED },
		},
	];

	return (
		<div className="gallery templates-gallery" key={round}>
			<header className="gallery-head">
				<h1>Action items and templates</h1>
				<p>
					Action items with owners and due dates whose status follows their issues, carried into the
					next session; and boards made from templates, with steps ready to start.
				</p>
				<div className="gallery-actions">
					<button type="button" onClick={() => setRound((r) => r + 1)}>
						Replay
					</button>
					<ThemeToggle labelled />
					<a className="play-link" href="/play?scenario=actions">
						Action items →
					</a>
					<a className="play-link" href="/play?scenario=template-planning">
						Planning session →
					</a>
				</div>
			</header>

			<section>
				<h2>Action items</h2>
				<div className="gallery-grid templates-gallery-items">
					{ITEMS.map((item) => (
						<Figure key={item.state} label={item.label} state={item.state}>
							<ActionItemView today={TODAY} onToggle={noop} onPicker={noop} {...item.props} />
						</Figure>
					))}
				</div>
			</section>

			<section>
				<h2>Pickers</h2>
				<div className="gallery-grid templates-gallery-panels">
					<Figure label="Owner: the board’s people, you first" state="owner-picker">
						<Panel>
							<OwnerPicker
								current={KAI}
								me={{ login: "ana", name: "Ana Costa" }}
								people={PEOPLE}
								onPick={noop}
							/>
						</Panel>
					</Figure>
					<Figure label="Due date: quick picks and a calendar" state="due-picker">
						<Panel>
							<DuePicker value={addDays(TODAY, 6)} today={TODAY} onPick={noop} />
						</Panel>
					</Figure>
					<Figure label="Issue: link one, or stage a new one" state="link-picker">
						<Panel wide>
							<LinkPicker
								current={null}
								staged={null}
								repos={[{ repo: "github.com/emdash-cms/emdash", cards: 12 }]}
								host="github.com"
								usualRepo="github.com/emdash-cms/emdash"
								owner={PRIYA}
								canCreate
								onLink={noop}
								onCreate={noop}
								onUnlink={noop}
							/>
						</Panel>
					</Figure>
					<Figure label="Issue: linked" state="link-picker-linked">
						<Panel wide>
							<LinkPicker
								current={LINK_OPEN}
								staged={null}
								repos={[]}
								host="github.com"
								usualRepo="github.com/emdash-cms/emdash"
								canCreate={false}
								onLink={noop}
								onCreate={noop}
								onUnlink={noop}
							/>
						</Panel>
					</Figure>
					<Figure label="Carry over to another board" state="carry">
						<Panel wide>
							<CarryPanel
								items={[
									{ id: "a", text: "Rotate the CDN keys" },
									{ id: "b", text: "Ask upstream about AVIF support" },
									{ id: "c", text: "Write up the caching plan" },
								]}
								services={services}
								onCarried={noop}
							/>
						</Panel>
					</Figure>
				</div>
			</section>

			<section>
				<h2>Steps ready to start</h2>
				<div className="gallery-grid templates-gallery-panels">
					<Figure label="A retro’s run sheet" state="prepared">
						<div className="facilitate-menu templates-gallery-menu">
							<PreparedSteps
								doc={sheet.doc}
								steps={sheet.fresh}
								user={{ name: "Ana Costa", color: "#3b4cca" }}
								readOnly={false}
								onStarted={noop}
							/>
						</div>
					</Figure>
					<Figure label="Halfway through" state="prepared-started">
						<div className="facilitate-menu templates-gallery-menu">
							<PreparedSteps
								doc={sheet.done}
								steps={sheet.started}
								user={{ name: "Ana Costa", color: "#3b4cca" }}
								readOnly={false}
								onStarted={noop}
							/>
						</div>
					</Figure>
				</div>
			</section>

			<section>
				<h2>Built-in templates</h2>
				<div className="gallery-grid templates-gallery-previews">
					{BUILT_IN_TEMPLATES.map((template) => (
						<Figure
							key={template.id}
							label={template.title}
							state={`preview-${template.id.slice(5)}`}
						>
							<div className="template-preview">
								<BoardThumbnail thumbnail={builtInInfo(template).thumbnail} animate />
							</div>
						</Figure>
					))}
				</div>
			</section>

			<section>
				<h2>New board</h2>
				{savedStates.map((s) => (
					<Figure key={s.state} label={s.label} state={s.state} wide>
						<div className="templates-gallery-dialog">
							<NewBoardPicker boards={BOARDS} saved={s.saved} onCreate={noop} onCancel={noop} />
						</div>
					</Figure>
				))}
				<Figure label="A saved template, with its repositories" state="picker-saved-chosen" wide>
					<div className="templates-gallery-dialog">
						<NewBoardPicker
							boards={BOARDS}
							saved={{ status: "ready", templates: SAVED }}
							initial="savedtriage"
							onCreate={noop}
							onDelete={async () => false}
						/>
					</div>
				</Figure>
				<Figure label="Laying it out" state="picker-creating" wide>
					<div className="templates-gallery-dialog">
						<NewBoardPicker
							boards={BOARDS}
							saved={{ status: "ready", templates: [] }}
							initial="tack:retro"
							creating
							onCreate={noop}
						/>
					</div>
				</Figure>
				<Figure label="Couldn’t make it" state="picker-error" wide>
					<div className="templates-gallery-dialog">
						<NewBoardPicker
							boards={BOARDS}
							saved={{ status: "ready", templates: [] }}
							initial="tack:triage"
							error="Couldn’t reach Tack just now. Try again?"
							onCreate={noop}
						/>
					</div>
				</Figure>
			</section>

			<section>
				<h2>Saving a board as a template</h2>
				<div className="gallery-grid templates-gallery-panels">
					<Figure label="Save as template" state="save">
						<div className="save-template-dialog templates-gallery-save">
							<SaveTemplatePanel
								board={{ id: "b", title: "Retro, October" }}
								onClose={noop}
								save={async () => ({ ok: false, error: "offline" })}
							/>
						</div>
					</Figure>
					<Figure label="Saved" state="saved">
						<div className="save-template-dialog templates-gallery-save">
							<SaveTemplatePanel
								board={{ id: "b", title: "Retro, October" }}
								onClose={noop}
								initialSaved={SAVED[0] ?? null}
							/>
						</div>
					</Figure>
				</div>
			</section>
		</div>
	);
}
