import { useEffect, useMemo, useState } from "react";
import { addActionItem, addDays, localDate, setActionDone } from "../../shared/actionItems.ts";
import { type CommentAuthor, anchorAt } from "../../shared/comments.ts";
import { addDecision, setDecisionStatus } from "../../shared/decisions.ts";
import { boxOf } from "../../shared/sections.ts";
import { addShape, nextZ, readShape, shapesMap } from "../../shared/shapes.ts";
import { cardStore } from "../cardStore.ts";
import { commentStore } from "../comments/store.ts";
import { localTimeZone } from "../digests/api.ts";
import { DigestDialog } from "../digests/DigestDialog.tsx";
import type { User } from "../presence.ts";
import { sinceStore } from "../since/store.ts";
import { RETRO, RETRO_PULL } from "./asyncScenarios.ts";
import { checkFailed } from "./ci.ts";
import { PLAY_PEOPLE, PLAY_YOU_ID, SimulatedComments } from "./comments.ts";
import { PlayDigests } from "./digests.ts";
import type { RemotePerson, SimulatedBoard } from "./simulator.ts";
import { SimulatedSince } from "./since.ts";

// The playground's controls for comments (#51), "since you were here"
// (#46) and weekly digests (#68): simulated people comment, reply, mention
// you and resolve threads through a pretend comments server, and time can
// pass while they work, so you come back to a digest and highlights, and
// the week's digest has something to say.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const LINES = [
	"Should this be two issues?",
	"I can take this one next week",
	"Is this still blocked on the CI work?",
	"+1, this bites me every release",
	"Let’s talk about it on Thursday’s call",
	"Can we get numbers on this before deciding?",
];

const REPLIES = [
	"Agreed.",
	"I’ll look tomorrow morning (my time).",
	"Done, see the linked PR.",
	"Not sure, let’s ask in the call.",
	"Good catch!",
];

function pick<T>(list: readonly T[]): T {
	return list[Math.floor(Math.random() * list.length)] as T;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function AsyncPlay({
	sim,
	scenario,
	board,
	user,
	signedIn,
	viewOnly,
	someone,
}: {
	sim: SimulatedBoard;
	scenario: string;
	/** The board's name, as the board knows it. */
	board: string;
	user: User;
	signedIn: boolean;
	viewOnly: boolean;
	someone: () => RemotePerson;
}) {
	const me: CommentAuthor = useMemo(
		() => ({
			id: PLAY_YOU_ID,
			login: user.login ?? "you",
			name: user.name,
			avatarUrl: user.avatarUrl ?? "",
		}),
		[user.login, user.name, user.avatarUrl],
	);
	const since = useMemo(
		() =>
			new SimulatedSince(sim.doc, () =>
				sim.people.map((person) => ({ origin: person.origin, user: person.user })),
			),
		[sim],
	);
	const comments = useMemo(
		() => new SimulatedComments(sim.doc, me, commentStore, () => since.now(), undefined, board),
		// A new board, a new server; who you are is kept in step below.
		[sim, since, board],
	);
	const digests = useMemo(
		() =>
			new PlayDigests(
				{ since: () => since.digest(), doc: sim.doc, now: () => since.now() },
				{ id: `play-${scenario}`, title: board },
				localTimeZone(),
			),
		[since, sim, scenario, board],
	);
	const [note, setNote] = useState<string | null>(null);
	const [digesting, setDigesting] = useState(false);

	useEffect(() => {
		comments.me = me;
	}, [comments, me]);

	useEffect(() => {
		digests.access = { canManage: signedIn && !viewOnly, canEdit: !viewOnly };
	}, [digests, signedIn, viewOnly]);

	useEffect(() => {
		commentStore.reset();
		sinceStore.reset();
		sinceStore.board = `play:${scenario}`;
		const disconnect = comments.connect();
		const stop = since.start();
		Object.assign(window, { tackComments: comments, tackSince: since });
		if (scenario === "comments") seedThreads(sim, comments, comments.me);
		if (scenario === "since")
			void awayForDays(sim, since, comments, comments.me, 3).then(() => since.comeBack());
		else if (scenario === "digest") {
			// A week of work, a digest already set up, and its dialog open on the preview.
			digests.settings = {
				discussion: { repo: "github.com/acme/unpic", category: "Announcements" },
				email: true,
				weekday: 1,
				hour: 9,
				timeZone: localTimeZone(),
			};
			digests.repoPublic = true;
			digests.subscription = { email: "you@example.com", confirmed: true, at: 0 };
			void awayForDays(sim, since, comments, comments.me, 6)
				.then(() => aWeekOfDecisions(sim, since))
				.then(() => {
					since.comeBack();
					setDigesting(true);
				});
		} else since.comeBack();
		setNote(null);
		return () => {
			disconnect();
			stop();
		};
	}, [comments, since, sim, scenario, digests]);

	useEffect(() => {
		comments.setAccess({ signedIn, role: viewOnly ? "viewer" : "owner" });
	}, [comments, signedIn, viewOnly]);

	const anywhere = () => {
		const ids = sim
			.shapeIds()
			.filter((id) => shapesMap(sim.doc).get(id)?.get("type") !== "connector");
		const id = pick(ids);
		const shape = id ? shapesMap(sim.doc).get(id) : undefined;
		if (!id || !shape)
			return anchorAt({ x: 200 + Math.random() * 600, y: 100 + Math.random() * 400 });
		const box = boxOf(id, readShape(shape));
		return anchorAt(
			{ x: box.x + box.w * (0.6 + Math.random() * 0.3), y: box.y + 10 + Math.random() * 30 },
			{ id, box },
		);
	};
	const somebody = () => pick(PLAY_PEOPLE);
	const openThreads = () => [...comments.threads.values()].filter((t) => !t.resolved);

	return (
		<div className="play-section">
			<h2 className="play-label">Comments and catching up</h2>
			<div className="play-buttons">
				<button
					type="button"
					onClick={() => {
						const by = somebody();
						comments.start(by, anywhere(), pick(LINES));
						setNote(`${by.name} commented.`);
					}}
				>
					Someone comments
				</button>
				<button
					type="button"
					onClick={() => {
						const thread = pick(openThreads());
						if (!thread) return setNote("No open threads to reply to.");
						comments.reply(somebody(), thread.id, pick(REPLIES));
					}}
				>
					Someone replies
				</button>
				<button
					type="button"
					onClick={() => {
						const by = somebody();
						comments.start(by, anywhere(), `@${me.login} what do you think?`);
						setNote(`${by.name} mentioned you: see the bell.`);
					}}
				>
					Someone mentions you
				</button>
				<button
					type="button"
					onClick={() => {
						const thread = pick(openThreads());
						if (!thread) return setNote("Nothing open to resolve.");
						comments.resolve(somebody(), thread.id);
					}}
				>
					Someone resolves one
				</button>
				<button
					type="button"
					onClick={async () => {
						since.leave();
						setNote("You left. Three days pass while people work…");
						await awayForDays(sim, since, comments, me, 3, someone);
						since.comeBack();
						sinceStore.setPanel(true);
						setNote("You’re back: see what changed.");
					}}
				>
					Away for 3 days
				</button>
				<button
					type="button"
					onClick={() => {
						since.leave();
						since.pass(HOUR * 20);
						since.comeBack();
						setNote("Away overnight, and nothing happened.");
					}}
				>
					Quiet night
				</button>
			</div>
			<p className="play-hint">
				{note ??
					"Press B to comment. Toggle view-only or sign out above to see what viewers and guests can do."}
			</p>
			<h2 className="play-label">Weekly digest</h2>
			<div className="play-buttons">
				<button type="button" onClick={() => setDigesting(true)}>
					Weekly digest…
				</button>
				<button
					type="button"
					onClick={async () => {
						since.leave();
						setNote("A week passes: people decide things, tick off actions and push…");
						await awayForDays(sim, since, comments, me, 6, someone);
						await aWeekOfDecisions(sim, since);
						since.comeBack();
						setNote("A week of work: open the Weekly digest to see what it’d say.");
					}}
				>
					A busy week
				</button>
				<button type="button" onClick={() => setNote(digests.send())}>
					The digest goes out
				</button>
				<button
					type="button"
					onClick={() =>
						setNote(
							digests.confirm()
								? "You followed the link: the digest comes to you now."
								: "No email to confirm: ask for it in the dialog first.",
						)
					}
				>
					Follow the email’s link
				</button>
			</div>
			<DigestDialog
				board={{ id: `play-${scenario}`, title: board, visibility: "private" }}
				open={digesting}
				onClose={() => setDigesting(false)}
				api={digests}
			/>
		</div>
	);
}

/**
 * Over the week: a decision's made, action items come and go (one done,
 * one new, one late), by simulated people so they count as theirs.
 */
async function aWeekOfDecisions(sim: SimulatedBoard, since: SimulatedSince): Promise<void> {
	const person = sim.join();
	await sleep(30);
	const today = localDate(since.now());
	const doc = person.doc;
	const decision = "digest-decision";
	if (!shapesMap(doc).has(decision)) {
		addDecision(doc, decision, {
			x: 1340,
			y: 600,
			title: "Move image tests off the shared runners",
			author: { name: person.user.name, color: person.user.color },
		});
	}
	setDecisionStatus(doc, decision, "decided", {
		by: { name: person.user.name, color: person.user.color },
	});
	const action = (id: string, y: number, text: string, due: string, done?: boolean) => {
		if (shapesMap(doc).has(id)) return;
		doc.transact(() =>
			addActionItem(doc, id, {
				x: 980,
				y,
				text,
				due,
				owner: { login: "kai", name: "Kai Andersen" },
				parent: shapesMap(doc).has(RETRO.actions) ? RETRO.actions : null,
			}),
		);
		if (done) setActionDone(doc, id, true, new Date(since.now() - DAY).toISOString());
	};
	action(
		"digest-action-done",
		620,
		"Turn on retries for image downloads",
		addDays(today, -1),
		true,
	);
	action("digest-action-new", 720, "Write up the runner costs", addDays(today, 4));
	action("digest-action-late", 820, "Rotate the CI cache keys", addDays(today, -2));
	await sleep(30);
	sim.leave(person);
}

/** Threads on the retro board, a few days old, one unread and mentioning you. */
function seedThreads(sim: SimulatedBoard, comments: SimulatedComments, me: CommentAuthor): void {
	const [priya, kai, tom, jo] = PLAY_PEOPLE as [
		CommentAuthor,
		CommentAuthor,
		CommentAuthor,
		CommentAuthor,
	];
	const at = (shape: string, dx: number, dy: number) => {
		const map = shapesMap(sim.doc).get(shape);
		if (!map) return anchorAt({ x: dx, y: dy });
		const box = boxOf(shape, readShape(map));
		return anchorAt({ x: box.x + dx, y: box.y + dy }, { id: shape, box });
	};
	const now = comments.now();
	const node = comments.start(
		priya,
		at(RETRO.node, 230, 14),
		"Is this still blocked on the CI matrix change?",
		now - 2 * DAY,
	);
	comments.reply(kai, node, "#418 is ready for review, so not for long.", now - 2 * DAY + 2 * HOUR);
	comments.reply(priya, node, `Great. @${me.login} can you review it?`, now - 3 * HOUR);
	const docs = comments.start(
		tom,
		at(RETRO.docs, 150, 20),
		"We said this last retro too. Let’s make it an action.",
		now - 26 * HOUR,
	);
	comments.reply(jo, docs, "+1, I’ll write it up as an issue.", now - 20 * HOUR);
	comments.start(
		jo,
		at(RETRO.actions, 160, 14),
		"Let’s vote on these on Thursday’s call.",
		now - 5 * HOUR,
	);
	comments.start(
		kai,
		anchorAt({ x: 1380, y: 260 }),
		"Room here for next quarter’s ideas?",
		now - 40 * HOUR,
	);
	const done = comments.start(
		priya,
		at(RETRO.release, 150, 16),
		"Who set this up? It was lovely.",
		now - 3 * DAY,
	);
	comments.reply(tom, done, "Jo did!", now - 3 * DAY + HOUR);
	comments.resolve(priya, done);
	// Read up to a day ago: newer messages are unread.
	for (const thread of comments.threads.values()) comments.reads.set(thread.id, now - DAY);
	comments.setAccess(comments.access);
}

/**
 * Time passes while you're away: people add and move things, edit, comment
 * and push, and GitHub closes, merges and fails things. Edits are made by
 * simulated people, so they count as theirs.
 */
async function awayForDays(
	sim: SimulatedBoard,
	since: SimulatedSince,
	comments: SimulatedComments,
	me: CommentAuthor,
	days: number,
	someone?: () => RemotePerson,
): Promise<void> {
	if (since.baseline === null) since.leave();
	since.pass(days * DAY);
	const people = [sim.join(), sim.join(), ...(someone ? [someone()] : [])];
	// Let their documents catch up with the board's.
	await sleep(30);
	const [first, second] = people as [RemotePerson, RemotePerson];
	const shapes = shapesMap(sim.doc);
	first.doc.transact(() => {
		const doc = first.doc;
		for (const [i, text] of ["Ship the provider docs page", "Office hours, monthly"].entries()) {
			addShape(doc, crypto.randomUUID(), {
				type: "sticky",
				text,
				color: "blue",
				author: { name: first.user.name, color: first.user.color },
				x: 240 + i * 200,
				y: 340,
				z: nextZ(doc),
				parent: shapes.has(RETRO.well) ? RETRO.well : null,
			});
		}
		shapesMap(doc)
			.get(RETRO.docs)
			?.set("text", "Provider docs are still hard to find (issue #440)");
	});
	second.doc.transact(() => {
		const card =
			shapesMap(second.doc).get(RETRO.cdn) ??
			[...shapesMap(second.doc).values()].find((s) => s.get("type") === "card");
		if (card) {
			card.set("x", Number(card.get("x")) + 40);
			card.set("y", Number(card.get("y")) + 60);
		}
		shapesMap(second.doc).get(RETRO.ci)?.set("color", "yellow");
	});
	// GitHub, meanwhile.
	for (const key of sim.cardKeys()) {
		const card = cardStore.get(key);
		if (!card || "missing" in card) continue;
		if (card.kind === "issue" && card.state === "open" && key.endsWith("#412")) {
			sim.updateCard(key, () => ({
				state: "closed",
				stateReason: "completed",
				comments: card.comments + 2,
			}));
		} else if (card.kind === "pull" && card.state === "open" && !key.endsWith(RETRO_PULL.item)) {
			sim.updateCard(key, () => ({ state: "merged" }));
		} else if (key === RETRO_PULL.key && card.pull) {
			sim.updateCard(key, (c) => (c.pull ? { pull: checkFailed(c.pull) } : {}));
		}
	}
	since.pushed({
		pushId: `away-${Date.now()}`,
		by: { login: "kai", name: "Kai Andersen" },
		applied: 3,
		failed: 0,
		summaries: ["Create issue “Ship the provider docs page”", "Add docs to #440", "Close #398"],
	});
	const [priya, kai] = PLAY_PEOPLE as [CommentAuthor, CommentAuthor];
	const target = shapes.get(RETRO.flaky) ? RETRO.flaky : sim.shapeIds("sticky")[0];
	const box = target ? boxOf(target, readShape(shapes.get(target)!)) : null;
	const thread = comments.start(
		kai,
		box && target
			? anchorAt({ x: box.x + 150, y: box.y + 20 }, { id: target, box })
			: anchorAt({ x: 900, y: 200 }),
		`@${me.login} the retry PR is up, but CI is red. Can you take a look?`,
		since.now() - 5 * HOUR,
	);
	comments.reply(
		priya,
		thread,
		"I think it’s the new check, not the change.",
		since.now() - 2 * HOUR,
	);
	for (const person of people) {
		if (!someone || person !== people.at(-1)) sim.leave(person);
	}
}
