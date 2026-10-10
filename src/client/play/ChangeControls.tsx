import { issueFromText } from "../../shared/issueText.ts";
import { useState } from "react";
import { type Operation, listChanges, stageChange, unstageChanges } from "../../shared/changes.ts";
import { repoKeyOf } from "../../shared/refs.ts";
import { shapesMap } from "../../shared/shapes.ts";
import { cardStore } from "../cardStore.ts";
import { stagerFor, useChangesUI } from "../changes/context.ts";
import { isPending } from "../changes/describe.ts";
import type { User } from "../presence.ts";
import { type PushMode, PUSH_MODES, IMAGEKIT, failChange, type SimulatedPush } from "./push.ts";
import type { RemotePerson, SimulatedBoard } from "./simulator.ts";

const LABEL_SETS = [["bug"], ["needs review"], ["performance", "question"], ["good first issue"]];

function pick<T>(list: readonly T[]): T | undefined {
	return list[Math.floor(Math.random() * list.length)];
}

/**
 * The playground's controls for pending changes: stage as yourself or as
 * someone else, unstage, fail, and choose how the pretend push server
 * answers. Signing out and view-only show the panel as others see it.
 */
export function ChangeControls({
	sim,
	push,
	user,
	someone,
	signedIn,
	onSignedIn,
	viewOnly,
	onViewOnly,
}: {
	sim: SimulatedBoard;
	push: SimulatedPush;
	user: User;
	someone: () => RemotePerson;
	signedIn: boolean;
	onSignedIn: (signedIn: boolean) => void;
	viewOnly: boolean;
	onViewOnly: (viewOnly: boolean) => void;
}) {
	const ui = useChangesUI();
	const [mode, setMode] = useState<PushMode>(push.mode);

	/** Stickies nobody's turning into an issue yet. */
	const freeStickies = () => {
		const taken = new Set(
			listChanges(sim.doc)
				.filter((change) => change.op.kind === "issue.create")
				.flatMap((change) => change.shapes ?? []),
		);
		return sim.shapeIds("sticky").filter((id) => !taken.has(id));
	};

	/** A random card shape, with its item key. */
	const randomCard = (): { id: string; key: string } | undefined => {
		const cards = sim.shapeIds("card").flatMap((id) => {
			const key = shapesMap(sim.doc).get(id)?.get("ref");
			const card = typeof key === "string" ? cardStore.get(key) : undefined;
			return typeof key === "string" && card && !("missing" in card) && card.live !== false
				? [{ id, key }]
				: [];
		});
		return pick(cards);
	};

	const stickyToIssue = (op: (text: string) => Operation, by: "me" | "someone") => {
		const id = pick(freeStickies());
		if (!id) return;
		const value = shapesMap(sim.doc).get(id)?.get("text");
		const text = (typeof value === "string" && value) || "Untitled idea";
		const options = { shapes: [id], effect: { kind: "replace" as const, shapes: [id] } };
		if (by === "me") stageChange(sim.doc, op(text), stagerFor(user), options);
		else {
			const person = someone();
			stageChange(person.doc, op(text), stagerFor(person.user), options);
		}
	};

	// As the Make issues action reads a sticky, so the issue follows it.
	const newIssue = (text: string): Operation => ({
		kind: "issue.create",
		repo: IMAGEKIT,
		...(issueFromText(text) ?? { title: text }),
		labels: pick(LABEL_SETS),
	});

	const actions = {
		mineToIssue: () => stickyToIssue(newIssue, "me"),
		theirsToIssue: () => stickyToIssue(newIssue, "someone"),
		labels: () => {
			const card = randomCard();
			if (!card) return;
			const person = someone();
			stageChange(
				person.doc,
				{ kind: "item.labels", target: { key: card.key }, add: pick(LABEL_SETS) },
				stagerFor(person.user),
				{ shapes: [card.id] },
			);
		},
		close: () => {
			const card = randomCard();
			if (!card) return;
			const person = someone();
			stageChange(
				person.doc,
				{
					kind: "item.state",
					target: { key: card.key },
					state: "closed",
					reason: Math.random() < 0.5 ? "completed" : "not_planned",
				},
				stagerFor(person.user),
				{ shapes: [card.id] },
			);
		},
		comment: () => {
			const card = randomCard();
			if (!card) return;
			stageChange(
				sim.doc,
				{
					kind: "item.comment",
					target: { key: card.key },
					body: "Discussed on the planning board: let’s pick this up **next**.",
				},
				stagerFor(user),
				{ shapes: [card.id] },
			);
		},
		unstage: () => {
			const change = pick(listChanges(sim.doc).filter(isPending));
			if (change) unstageChanges(someone().doc, [change.id]);
		},
		fail: () => {
			const change = pick(listChanges(sim.doc).filter((c) => c.status === "staged"));
			if (change) {
				const repo = change.op.kind === "issue.create" ? change.op.repo : IMAGEKIT;
				failChange(
					sim.doc,
					change.id,
					`Resource not accessible by integration (${repoKeyOf(repo).replace(/^[^/]+\//, "")})`,
				);
			}
		},
	};

	return (
		<div className="play-section">
			<h2 className="play-label">Pending changes</h2>
			<div className="play-buttons">
				<button type="button" onClick={actions.mineToIssue}>
					My sticky → issue
				</button>
				<button type="button" onClick={actions.theirsToIssue}>
					Their sticky → issue
				</button>
				<button type="button" onClick={actions.labels}>
					Someone adds labels
				</button>
				<button type="button" onClick={actions.close}>
					Someone stages a close
				</button>
				<button type="button" onClick={actions.comment}>
					I stage a comment
				</button>
				<button type="button" onClick={actions.unstage}>
					Someone unstages one
				</button>
				<button type="button" onClick={actions.fail}>
					A change fails
				</button>
				<button type="button" onClick={() => ui?.openSheet("review")}>
					Open the push sheet
				</button>
			</div>
			<label className="play-label play-label-spaced" htmlFor="push-mode">
				Push server
			</label>
			<select
				id="push-mode"
				value={mode}
				onChange={(event) => {
					const next = event.target.value as PushMode;
					push.mode = next;
					setMode(next);
				}}
			>
				{PUSH_MODES.map((option) => (
					<option key={option.mode} value={option.mode}>
						{option.label}
					</option>
				))}
			</select>
			<label className="play-toggle">
				<input type="checkbox" checked={signedIn} onChange={(e) => onSignedIn(e.target.checked)} />
				Signed in{user.login ? ` as @${user.login}` : ""}
			</label>
			<label className="play-toggle">
				<input type="checkbox" checked={viewOnly} onChange={(e) => onViewOnly(e.target.checked)} />
				View only
			</label>
			<p className="play-hint">
				Stage, then push from Changes in the top bar. Undo unstages your own. Try the “Pushing to
				GitHub” scenario for every kind.
			</p>
		</div>
	);
}
