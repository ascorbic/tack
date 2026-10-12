import { useMemo, useState } from "react";
import * as Y from "yjs";
import type { Card, MissingCard } from "../../shared/cards.ts";
import type { ShapeProps } from "../../shared/shapes.ts";
import { STICKY, membersHash, openLayout } from "../../shared/stacks.ts";
import { cardStore } from "../cardStore.ts";
import { StickyView } from "../StickyNode.tsx";
import { GroupThese } from "../stacks/GroupThese.tsx";
import { StackPapers } from "../stacks/StackNode.tsx";
import type { GroupAnswer } from "../stacks/store.ts";
import type { StackView } from "../stacks/view.ts";
import { STACK_CARDS } from "./stacks.ts";

// Stacks (#73) for the galleries: every state of the stack's theme card on
// the board, issues and pull requests in it too, close up and zoomed out
// (/play/cards), and Group these' panel (/play/actions).

const PRIYA = { name: "Priya Shah", color: "#b4467a" };
const KAI = { name: "Kai Andersen", color: "#1f7a6b" };
const TOM = { name: "Tom Okafor", color: "#a35a12" };

const note = (id: string, text: string, color: string, author = PRIYA) => ({
	id,
	shape: { type: "sticky", x: 0, y: 0, z: "a0", text, color, author } as ShapeProps,
});

const CI = [
	note("ci1", "CI takes 25 minutes on a good day", "pink", KAI),
	note("ci2", "Flaky e2e on Windows", "pink", TOM),
	note("ci3", "Can't rerun one job in the build", "yellow"),
];

/** An item that can't be shown: from a repository this person can't read. */
const HIDDEN_CARD: MissingCard = {
	key: "fake.tack/ascorbic/tack-internal#3",
	missing: true,
	reason: "private",
};

const [notesCard, loaderCard, versionsCard, , srcsetCard, embargoCard] = STACK_CARDS;

const item = (id: string, entry: Card | MissingCard | undefined) => ({
	id,
	shape: { type: "card", ref: entry?.key ?? "", x: 0, y: 0, z: "a0" } as ShapeProps,
});

const RELEASE = [
	note("r1", "Release notes are thin", "green"),
	item("r2", notesCard),
	item("r3", loaderCard),
	note("r4", "Breaking changes buried in commits, not the release notes", "green", KAI),
	item("r5", versionsCard),
	note("r6", "Changelog doesn't credit contributors", "green", TOM),
];

const stack = (props: Partial<ShapeProps> = {}): ShapeProps => ({
	type: "stack",
	x: 0,
	y: 0,
	z: "a0",
	...props,
});

const view = (members: StackView["members"], extra: Partial<StackView> = {}): StackView => ({
	members,
	open: false,
	receiving: false,
	fed: 0,
	...extra,
});

interface Sample {
	label: string;
	shape: ShapeProps;
	view: StackView;
	selected?: boolean;
	naming?: boolean;
	patience?: number | null;
	far?: boolean;
}

/** Only private cards: the server can't name it from anything everyone could read. */
const PRIVATE_ONLY = [item("u1", embargoCard), item("u2", HIDDEN_CARD)];

const SAMPLES: Sample[] = [
	{
		label: "Named by a person",
		shape: stack({ title: "Unreliable CI" }),
		view: view(CI),
	},
	{
		label: "A suggested name, selected (✓ keeps it)",
		shape: stack({ suggested: { title: "Unreliable CI", hash: "x" } }),
		view: view(CI),
		selected: true,
		naming: true,
	},
	{
		label: "Issues, a pull request and stickies, +N more",
		shape: stack({ suggested: { title: "Release notes", hash: "x" } }),
		view: view(RELEASE),
		naming: true,
	},
	{
		label: "Only cards, one of them private",
		shape: stack({ title: "Big sites are slow" }),
		view: view([item("p1", srcsetCard), item("p2", HIDDEN_CARD), item("p3", notesCard)]),
	},
	{
		label: "Being named",
		shape: stack(),
		view: view(CI.slice(0, 2)),
		naming: true,
		patience: null,
	},
	{
		label: "Only private cards: not named automatically",
		shape: stack({
			unnameable: { hash: membersHash(PRIVATE_ONLY.map((member) => member.id)) },
		}),
		view: view(PRIVATE_ONLY),
		naming: true,
	},
	{
		label: "No name came in time",
		shape: stack(),
		view: view(CI.slice(0, 2)),
		naming: true,
		patience: 0,
	},
	{
		label: "AI suggestions off",
		shape: stack(),
		view: view(CI.slice(1)),
		selected: true,
	},
	{
		label: "Something held over it",
		shape: stack({ title: "Unreliable CI" }),
		view: view(CI, { receiving: true }),
	},
	{
		label: "Silent mode: face down on top",
		shape: stack({ title: "What hurts" }),
		view: view([
			{
				id: "s1",
				shape: { ...note("s1", "", "blue").shape, silent: "session" },
			},
			note("s2", "Reviews take a week", "blue", KAI),
		]),
	},
	{
		label: "A long name",
		shape: stack({
			suggested: { title: "Contributors never hear back on their first pull request", hash: "x" },
		}),
		view: view([note("l1", "No reply for weeks", "green"), note("l2", "Bots only", "green", TOM)]),
	},
	{
		label: "Zoomed out: its name and count",
		shape: stack({ suggested: { title: "Release notes", hash: "x" } }),
		view: view(RELEASE),
		far: true,
	},
	{
		label: "Zoomed out, untitled",
		shape: stack(),
		view: view(CI),
		far: true,
	},
];

/** The stack shape's states, for the cards gallery. */
export function StackGallery() {
	useMemo(() => {
		for (const entry of [...STACK_CARDS, HIDDEN_CARD]) cardStore.set(entry);
	}, []);
	const layout = openLayout({ x: 0, y: 0 }, ["a", "b", "c"]);
	const left = Math.min(...[...layout.slots.values()].map((slot) => slot.x), layout.tray.x);
	const top = layout.tray.y;
	return (
		<section>
			<h2>Stacks</h2>
			<div className="gallery-grid stacks">
				{SAMPLES.map((sample) => (
					<figure key={sample.label}>
						<StackPapers
							id={sample.label}
							shape={sample.shape}
							view={sample.view}
							selected={sample.selected}
							naming={sample.naming}
							patience={sample.patience}
							far={sample.far}
							editable
						/>
						<figcaption>{sample.label}</figcaption>
					</figure>
				))}
				<figure className="gallery-stack-open">
					<div
						className="gallery-stack-tray"
						style={{ width: layout.tray.w, height: layout.tray.h }}
					>
						<StackPapers
							id="open"
							shape={stack({ suggested: { title: "Unreliable CI", hash: "x" } })}
							view={view(CI, { open: true })}
							selected
							naming
							editable
						/>
						{CI.map((member, i) => {
							const slot = layout.slots.get(["a", "b", "c"][i] as string);
							return slot ? (
								<div
									key={member.id}
									className="gallery-stack-member"
									style={{ left: slot.x - left, top: slot.y - top, width: STICKY }}
								>
									<StickyView
										text={member.shape.text ?? ""}
										color={member.shape.color ?? "yellow"}
										author={member.shape.author}
									/>
								</div>
							) : null;
						})}
					</div>
					<figcaption>Spread open (Esc gathers it back)</figcaption>
				</figure>
			</div>
		</section>
	);
}

const NOTES = [
	{ id: "a", text: "Provider docs are hard to find, I end up reading source", color: "yellow" },
	{ id: "b", text: "No example for a custom image loader", color: "yellow" },
	{ id: "c", text: "Which CDN options exist? Couldn't tell from the docs", color: "yellow" },
	{ id: "d", text: "CI takes 25 minutes on a good day", color: "pink" },
	{ id: "e", text: "Flaky e2e on Windows", color: "pink" },
	{ id: "f", text: "A logo?", color: "blue" },
];

const CARDS = [notesCard, loaderCard].flatMap((card) =>
	card && "title" in card
		? [{ id: card.item, text: card.title, ref: card.item, state: card.state }]
		: [],
);

const PANELS: {
	label: string;
	preview: GroupAnswer | "thinking";
	cards?: boolean;
}[] = [
	{ label: "Reading the stickies", preview: "thinking" },
	{
		label: "Proposed stacks",
		preview: {
			ok: true,
			stacks: [
				{ name: "Hard-to-find docs", ids: ["a", "b", "c"] },
				{ name: "Unreliable CI", ids: ["d", "e"] },
			],
		},
	},
	{
		label: "Cards included",
		cards: true,
		preview: {
			ok: true,
			stacks: [
				{ name: "Release notes", ids: ["#701", "#712"] },
				{ name: "Unreliable CI", ids: ["d", "e"] },
			],
		},
	},
	{
		label: "Too few, once private cards are left out",
		cards: true,
		preview: { ok: false, reason: "too_few", withheld: 2 },
	},
	{ label: "The model failed", preview: { ok: false, reason: "failed" } },
	{ label: "Rate limited", preview: { ok: false, reason: "limited" } },
];

/** Group these' panel, for the actions gallery. */
export function GroupTheseGallery() {
	const [doc] = useState(() => new Y.Doc());
	return (
		<section>
			<h2>Group these</h2>
			<div className="gallery-grid actions-panels">
				{PANELS.map(({ label, preview, cards }) => (
					<figure key={label}>
						<div
							className="action-popover"
							data-static
							data-wide
							role="dialog"
							aria-label={`Group these: ${label}`}
						>
							<GroupThese
								doc={doc}
								stickies={NOTES}
								cards={CARDS}
								initialCards={cards}
								preview={preview}
								onMade={() => {}}
								onClose={() => {}}
							/>
						</div>
						<figcaption>{label}</figcaption>
					</figure>
				))}
			</div>
		</section>
	);
}
