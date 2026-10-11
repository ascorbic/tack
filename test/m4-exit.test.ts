// The M4 exit (#54), end to end: a retro run fully async over three days by
// three people in three time zones, on a board made from the Retro
// template, with the clock moved (`setClock`) to each person's working
// hours. Lena (Berlin, UTC+2) facilitates; Priya (Bengaluru, UTC+5:30) and
// Sam (San Francisco, UTC−7) take part. Nobody is ever on the board at the
// same time as anyone else.
//
// Day 1: everyone writes in silent mode, and nobody sees anyone else's
// text. Day 2: the reveal, a dot vote open until day 3 that each person
// votes in at their own local time, comments and mentions, and digests of
// what changed while each was away. Day 3: the vote's closed, the winners
// become action items with owners and due dates, staged as issues and
// pushed through the real GitHub adapter (fake GitHub), and the open ones
// are carried into the next retro. History has all of it.

import { afterEach, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import {
	actionState,
	addActionItem,
	addDays,
	dueState,
	setActionDone,
	stageActionIssue,
	stickiesToActions,
	updateActionItem,
} from "../src/shared/actionItems.ts";
import type { CardMessage } from "../src/shared/cards.ts";
import { listChanges, type Stager } from "../src/shared/changes.ts";
import type {
	CommentEvent,
	CommentThread,
	CommentsYou,
	NotificationList,
} from "../src/shared/comments.ts";
import {
	closedAt,
	isOpen,
	placeDot,
	readVotes,
	startVote,
	tallyVote,
	voteFor,
} from "../src/shared/dotvotes.ts";
import { type Timeline, decodeSegment } from "../src/shared/history.ts";
import { markStarted, readPrepared } from "../src/shared/prepared.ts";
import type { PushResponse } from "../src/shared/push.ts";
import { addShape, readShape, type ShapeProps, shapesMap } from "../src/shared/shapes.ts";
import { commentDigest, type Digest, type SinceEvent } from "../src/shared/since.ts";
import { joinSilentSession, parseSession, type SilentMessage } from "../src/shared/silent.ts";
import { type BoardClient, eventually } from "./board-client.ts";
import type { FakeUser } from "./fake-github.ts";
import { boardStub, signInWithGitHub } from "./harness.ts";
import { DAY, HOUR, MINUTE, ORIGIN, World } from "./world.ts";

const WIDGETS = 1;
const REPO = "github.com/acme/widgets";

let world: World;
afterEach(() => world?.dispose());

/** Someone taking part, from their own time zone. */
class Person {
	cookie = "";
	client: BoardClient | null = null;
	/** Everything any of their connections received, to search for others' hidden text. */
	readonly heard: BoardClient["raw"] = [];

	constructor(
		readonly user: FakeUser,
		/** Their UTC offset, in minutes. */
		readonly utcOffset: number,
		readonly color: string,
	) {}

	get login(): string {
		return this.user.login;
	}

	get author() {
		return { name: this.user.name ?? this.login, color: this.color };
	}

	get voter() {
		return { ...this.author, login: this.login };
	}

	get stager(): Stager {
		return { id: this.user.id, login: this.login, name: this.author.name, color: this.color };
	}

	get doc(): Y.Doc {
		if (!this.client) throw new Error(`${this.login} isn't on the board`);
		return this.client.doc;
	}

	/** Their wall clock now: "2026-10-13 08:40". */
	localTime(at = world.now()): string {
		return new Date(at + this.utcOffset * MINUTE).toISOString().slice(0, 16).replace("T", " ");
	}

	/** Their calendar day now, as action items' due dates are written. */
	today(at = world.now()): string {
		return this.localTime(at).slice(0, 10);
	}

	async signIn(): Promise<void> {
		this.cookie = await signInWithGitHub(world.mf, world.github, this.user);
	}

	/** Open the board, at `local` on their own clock ("08:40", on day `day` of the retro, 1–3). */
	async arrive(board: string, day: number, local: string): Promise<BoardClient> {
		const [h = 0, m = 0] = local.split(":").map(Number);
		await world.at(world.monday + (day - 1) * DAY + (h * 60 + m - this.utcOffset) * MINUTE);
		expect(this.localTime().slice(11)).toBe(local);
		this.client = await world.connect(board, this.cookie);
		await eventually(() => this.events().some((e) => e.type === "comments"));
		return this.client;
	}

	/** Close the board, and give the server a moment to note when they left. */
	async leave(): Promise<void> {
		if (!this.client) return;
		await this.client.roundTrip();
		this.heard.push(...this.client.raw);
		this.client.close();
		this.client = null;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}

	events(): (CommentEvent | SinceEvent | SilentMessage)[] {
		return (this.client?.messages ?? []) as (CommentEvent | SinceEvent | SilentMessage)[];
	}

	/** Whether they've ever received `text`, in any form. */
	received(text: string): boolean {
		const bytes = new TextEncoder().encode(text);
		return [...this.heard, ...(this.client?.raw ?? [])].some((data) =>
			typeof data === "string" ? data.includes(text) : includesBytes(data, bytes),
		);
	}

	/** Since you were here, as the top bar's button asks for it on arrival. */
	async digest(): Promise<Digest> {
		const count = () => this.events().filter((e) => e.type === "since").length;
		const before = count();
		this.client!.send({ type: "since-request" });
		await eventually(() => count() > before);
		return (
			this.events()
				.filter((e) => e.type === "since")
				.at(-1) as SinceEvent
		).digest;
	}

	/** The comment threads they know about. */
	threads(): CommentThread[] {
		const threads = new Map<string, CommentThread>();
		for (const event of this.events()) {
			if (event.type === "comments") {
				if (event.first) threads.clear();
				for (const thread of event.threads) threads.set(thread.id, thread);
			}
			if (event.type === "comment-thread") threads.set(event.thread.id, event.thread);
			if (event.type === "comment-removed") threads.delete(event.thread);
		}
		return [...threads.values()];
	}

	you(): CommentsYou {
		const latest = this.events()
			.filter((e) => e.type === "comments" || e.type === "comments-you")
			.at(-1) as { you: CommentsYou };
		return latest.you;
	}

	/** Write a sticky in a silent section: on the board face down, its text only theirs. */
	async writeSilently(id: string, section: string, at: { x: number; y: number }, text: string) {
		this.doc.transact(() => {
			addShape(this.doc, id, {
				type: "sticky",
				...at,
				z: `s-${id}`,
				parent: section,
				author: this.author,
			});
			joinSilentSession(this.doc, id);
		});
		await this.client!.roundTrip();
		this.client!.send({ type: "silent-text", shape: id, text });
		await this.client!.roundTrip();
	}

	comment(thread: string, body: string, shape?: string) {
		const message = `m-${crypto.randomUUID().slice(0, 8)}`;
		if (shape) {
			const props = readShape(shapesMap(this.doc).get(shape)!);
			this.client!.send({
				type: "comment-start",
				thread,
				message,
				anchor: { x: props.x + 180, y: props.y + 10, shape, dx: 180, dy: 10 },
				body,
			});
		} else {
			this.client!.send({ type: "comment-reply", thread, message, body });
		}
	}

	async notifications(): Promise<NotificationList> {
		return world.json<NotificationList>("/api/notifications", this.cookie);
	}
}

function includesBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
	outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
		for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
		return true;
	}
	return false;
}

function shapes(doc: Y.Doc): Map<string, ShapeProps> {
	return new Map([...shapesMap(doc)].map(([id, shape]) => [id, readShape(shape)]));
}

function sectionId(doc: Y.Doc, title: string): string {
	const found = [...shapes(doc)].find(([, s]) => s.type === "section" && s.title === title);
	if (!found) throw new Error(`no section “${title}”`);
	return found[0];
}

function cardState(client: BoardClient, key: string): string | undefined {
	for (const message of [...(client.messages as CardMessage[])].reverse()) {
		if (message.type !== "cards") continue;
		const card = message.cards.find((entry) => entry.key === key);
		if (card && !("missing" in card)) return card.state;
	}
	return undefined;
}

const LENA: FakeUser = { id: 601, login: "lena", name: "Lena", avatar_url: "https://a/lena" };
const PRIYA: FakeUser = { id: 602, login: "priya", name: "Priya", avatar_url: "https://a/priya" };
const SAM: FakeUser = { id: 603, login: "sam", name: "Sam", avatar_url: "https://a/sam" };

// What each of them writes on day 1, face down.
const WRITES = {
	lena: { well: "Release notes went out on time", improve: "Too many meetings on Thursdays" },
	priya: {
		well: "Pairing on the parser was great",
		improve: "Reviews wait days for a second look",
	},
	sam: { well: "The new docs site landed", improve: "Flaky CI ate a day every week" },
};

it("a retro runs fully async over three days, across three time zones", async () => {
	world = new World(WIDGETS);
	const { github } = world;
	github.addRepo(WIDGETS, "acme/widgets", {
		writers: ["lena"],
		assignable: ["lena", "priya", "sam"],
	});
	github.install(7, "acme", ["acme/widgets"]);
	// Monday, 07:00 in Berlin.
	await world.boot(world.monday + 5 * HOUR);
	const lena = new Person(LENA, 120, "#f97316");
	const priya = new Person(PRIYA, 330, "#8b5cf6");
	const sam = new Person(SAM, -420, "#0ea5e9");
	for (const person of [lena, priya, sam]) await person.signIn();
	// Known to the index, so invites resolve to them at once.
	for (const person of [priya, sam]) await world.json("/api/boards", person.cookie);

	// --- Day 1, Monday ------------------------------------------------------------
	// Lena, just before 08:00 in Berlin: a retro from the template, Priya
	// and Sam invited.
	await world.at(world.monday + 5 * HOUR + 50 * MINUTE);
	const made = await world.json<{ id: string; slug: string }>("/api/boards", lena.cookie, {
		method: "POST",
		body: JSON.stringify({
			title: "Retro, week 42",
			template: "tack:retro",
			visibility: "private",
		}),
	});
	const board = made.id;
	const boardUrl = `${ORIGIN}/b/${board}/${made.slug}`;
	await world.json(`/api/boards/${board}/members`, lena.cookie, {
		method: "POST",
		body: JSON.stringify({ logins: ["priya", "sam"], role: "editor" }),
	});
	const stub = await boardStub(world.mf, board);
	await stub.pushTiming({ spacingMs: 10, confirmMs: 60_000, backoffMs: 50 });

	await lena.arrive(board, 1, "08:00");
	expect((await lena.digest()).since).toBeNull();
	const well = sectionId(lena.doc, "Went well");
	const improve = sectionId(lena.doc, "To improve");
	const actions = sectionId(lena.doc, "Actions");
	const steps = readPrepared(lena.doc);
	expect(steps.map((step) => step.kind)).toEqual(["silent", "silent", "vote", "timer"]);

	// She starts silent writing in both sections from the Facilitate menu
	// (without the timers: there's a whole day for it), and writes her own.
	for (const section of [well, improve]) {
		lena.client!.send({ type: "silent-start", section, by: lena.author });
		const step = steps.find((s) => s.kind === "silent" && s.section === section)!;
		markStarted(lena.doc, step.id, lena.author, world.iso());
	}
	await eventually(() =>
		[well, improve].every((id) => parseSession(shapes(lena.doc).get(id)?.silent) !== null),
	);
	const layout = shapes(lena.doc);
	const box = (id: string) => layout.get(id)!;
	const spot = (section: string, n: number) => ({
		x: box(section).x + 40 + (n % 2) * 260,
		y: box(section).y + 120 + Math.floor(n / 2) * 220,
	});
	await lena.writeSilently("lena-well", well, spot(well, 0), WRITES.lena.well);
	await lena.writeSilently("lena-improve", improve, spot(improve, 0), WRITES.lena.improve);
	await lena.leave();

	// Priya, 17:30 in Bengaluru, the same day.
	await priya.arrive(board, 1, "17:30");
	expect((await priya.digest()).since).toBeNull();
	// Lena's stickies are there, face down: her name and colour, no text.
	expect(shapes(priya.doc).get("lena-well")).toMatchObject({
		silent: expect.any(String),
		author: lena.author,
	});
	expect(shapes(priya.doc).get("lena-well")?.text).toBeUndefined();
	await priya.writeSilently("priya-well", well, spot(well, 1), WRITES.priya.well);
	await priya.writeSilently("priya-improve", improve, spot(improve, 1), WRITES.priya.improve);
	await priya.leave();

	// Sam, 09:00 in San Francisco: half past nine at night in Bengaluru,
	// and Lena's long gone home.
	await sam.arrive(board, 1, "09:00");
	expect(priya.localTime().slice(11)).toBe("21:30");
	expect(lena.localTime().slice(11)).toBe("18:00");
	await sam.writeSilently("sam-well", well, spot(well, 2), WRITES.sam.well);
	await sam.writeSilently("sam-improve", improve, spot(improve, 2), WRITES.sam.improve);
	// Sam comes back to his own text on another tab: it's his alone.
	const samTab = await world.connect(board, sam.cookie);
	samTab.send({ type: "silent-hello" });
	await eventually(() => samTab.messages.some((m) => (m as SilentMessage).type === "silent-texts"));
	expect(samTab.messages.find((m) => (m as SilentMessage).type === "silent-texts")).toMatchObject({
		texts: { "sam-well": WRITES.sam.well, "sam-improve": WRITES.sam.improve },
	});
	samTab.close();
	await sam.leave();

	// Nobody has seen anyone else's text, in any form, and it isn't in the
	// board's history either.
	const people = { lena, priya, sam } as const;
	for (const [login, person] of Object.entries(people)) {
		for (const [author, texts] of Object.entries(WRITES)) {
			if (author === login) continue;
			for (const text of Object.values(texts))
				expect(person.received(text), `${login}: ${text}`).toBe(false);
		}
	}
	const dayOne = await world.json<Timeline>(`/api/boards/${board}/history`, lena.cookie);
	for (const step of dayOne.steps) {
		const bytes = new Uint8Array(
			await (
				await world.api(`/api/boards/${board}/history/segment?step=${step.id}`, lena.cookie)
			).arrayBuffer(),
		);
		for (const texts of Object.values(WRITES))
			for (const text of Object.values(texts))
				expect(includesBytes(bytes, new TextEncoder().encode(text))).toBe(false);
	}

	// --- Day 2, Tuesday -----------------------------------------------------------
	// Lena, 08:00 in Berlin: what happened while she was away is Priya's and
	// Sam's stickies, still face down.
	await lena.arrive(board, 2, "08:00");
	const lenaTuesday = await lena.digest();
	expect(lenaTuesday.since).toBeGreaterThanOrEqual(world.monday + 6 * HOUR);
	expect(lenaTuesday.since).toBeLessThan(world.monday + 7 * HOUR);
	expect(
		lenaTuesday.edits.map((edit) => `${edit.by.login}:${edit.shape}:${edit.kind}`).sort(),
	).toEqual([
		"priya:priya-improve:added",
		"priya:priya-well:added",
		"sam:sam-improve:added",
		"sam:sam-well:added",
	]);

	// The reveal: every sticky turns over at once.
	for (const section of [well, improve]) {
		const session = parseSession(shapes(lena.doc).get(section)?.silent)!;
		lena.client!.send({ type: "silent-reveal", session: session.id });
	}
	await eventually(
		() => [...shapes(lena.doc).values()].filter((s) => s.type === "sticky" && s.text).length === 6,
	);
	expect(shapes(lena.doc).get("sam-improve")).toMatchObject({ text: WRITES.sam.improve });
	expect(shapes(lena.doc).get("sam-improve")?.silent).toBeUndefined();

	// A dot vote on what to improve, three dots each, open until Wednesday
	// noon (UTC): so there's a working day for everyone, wherever they are.
	const voteStep = steps.find((step) => step.kind === "vote")!;
	const endsAt = world.monday + 2 * DAY + 12 * HOUR;
	let voteId = "";
	lena.doc.transact(() => {
		voteId = startVote(lena.doc, {
			scope: improve,
			dots: voteStep.kind === "vote" ? voteStep.dots : 3,
			hidden: true,
			title: voteStep.kind === "vote" ? voteStep.title : undefined,
			endsAt: world.iso(endsAt),
			by: lena.author,
			// Who started it, as the board's client says (the server's key for her).
			starter: `u:${lena.user.id}`,
			at: world.iso(),
		});
		markStarted(lena.doc, voteStep.id, lena.author, world.iso());
	});
	/** Place dots as the board would let them: only into the open vote over that sticky. */
	const vote = (person: Person, dots: [string, number][]) => {
		person.doc.transact(() => {
			for (const [shape, n] of dots) {
				const open = voteFor(readVotes(person.doc), shapes(person.doc), shape, world.now());
				expect(open?.id, `${person.login} voting on ${shape}`).toBe(voteId);
				for (let i = 0; i < n; i++) placeDot(person.doc, voteId, person.voter, shape, world.iso());
			}
		});
	};
	vote(lena, [
		["sam-improve", 2],
		["priya-improve", 1],
	]);

	// And she asks Priya about Sam's sticky.
	lena.comment(
		"thread-ci",
		"@priya you fixed this on the old runners, could you take it on?",
		"sam-improve",
	);
	await eventually(() => lena.threads().some((thread) => thread.id === "thread-ci"));
	await lena.leave();

	// Priya, 19:00 in Bengaluru: the reveal, Sam's stickies and Lena's
	// comment are what's new; the mention is in her inbox.
	await priya.arrive(board, 2, "19:00");
	const priyaTuesday = await priya.digest();
	const edited = priyaTuesday.edits.map((edit) => `${edit.by.login ?? edit.by.kind}:${edit.shape}`);
	expect(edited).toEqual(expect.arrayContaining(["sam:sam-well", "sam:sam-improve"]));
	expect(edited.some((edit) => edit.startsWith("priya:"))).toBe(false);
	const priyaComments = commentDigest(priya.threads(), priyaTuesday.since, {
		id: priya.you().id,
		login: "priya",
	});
	expect(priyaComments.mentioned.map((thread) => thread.id)).toEqual(["thread-ci"]);
	const mentions = await priya.notifications();
	expect(mentions.notifications).toEqual([
		expect.objectContaining({ kind: "mention", by: expect.objectContaining({ login: "lena" }) }),
	]);
	expect(mentions.unread).toBe(1);
	priya.comment("thread-ci", "Happy to. @sam, shall we pair on it?");
	vote(priya, [
		["sam-improve", 2],
		["priya-improve", 1],
	]);
	await eventually(
		() => priya.threads().find((thread) => thread.id === "thread-ci")?.messages.length === 2,
	);
	await priya.leave();

	// Sam, 08:30 in San Francisco (still Tuesday there): the reply mentions
	// him, and he votes before his standup.
	await sam.arrive(board, 2, "08:30");
	const samTuesday = await sam.digest();
	expect(samTuesday.edits.some((edit) => edit.by.login === "lena")).toBe(false);
	const samComments = commentDigest(sam.threads(), samTuesday.since, {
		id: sam.you().id,
		login: "sam",
	});
	expect(samComments.mentioned.map((thread) => thread.id)).toEqual(["thread-ci"]);
	expect((await sam.notifications()).notifications[0]).toMatchObject({
		kind: "mention",
		by: { login: "priya" },
	});
	vote(sam, [
		["sam-improve", 1],
		["priya-improve", 2],
	]);
	await sam.leave();

	// --- Day 3, Wednesday -----------------------------------------------------------
	// Sam, 06:00 in San Francisco (13:00 UTC): the vote has closed, and the
	// board won't take another dot. The results are out.
	await sam.arrive(board, 3, "06:00");
	const [closed] = readVotes(sam.doc);
	expect(isOpen(closed!, world.now())).toBe(false);
	expect(closedAt(closed!, world.now())).toBe(world.iso(endsAt));
	expect(voteFor(readVotes(sam.doc), shapes(sam.doc), "lena-improve", world.now())).toBeNull();
	const ballotTimes = Object.fromEntries(
		Object.entries(closed!.ballots).map(([key, ballot]) => [key, ballot.at]),
	);
	expect(Object.keys(ballotTimes).sort()).toEqual(["@lena", "@priya", "@sam"]);
	expect(lena.localTime(Date.parse(ballotTimes["@lena"]!))).toMatch(/ 08:0\d$/);
	expect(priya.localTime(Date.parse(ballotTimes["@priya"]!))).toMatch(/ 19:0\d$/);
	expect(sam.localTime(Date.parse(ballotTimes["@sam"]!))).toMatch(/ 08:3\d$/);
	const tally = tallyVote(closed!, sam.doc);
	expect(tally.map((row) => [row.shape, row.total])).toEqual([
		["sam-improve", 5],
		["priya-improve", 4],
	]);
	await sam.leave();

	// Lena, 16:00 in Berlin: the winners become action items in Actions,
	// owned by whoever's taking them, due by their own calendars.
	await lena.arrive(board, 3, "16:00");
	const [ciAction] = stickiesToActions(lena.doc, ["sam-improve"]);
	const actionsBox = box(actions);
	const priyaDue = addDays(priya.today(), 2); // Friday, in Bengaluru
	updateActionItem(lena.doc, ciAction!, {
		text: "Quarantine the flaky CI tests",
		owner: { login: "priya", name: "Priya" },
		due: priyaDue,
	});
	lena.doc.transact(() => {
		const shape = shapesMap(lena.doc).get(ciAction!)!;
		shape.set("x", actionsBox.x + 40);
		shape.set("y", actionsBox.y + 140);
		shape.set("parent", actions);
	});
	addActionItem(lena.doc, "reviews", {
		x: actionsBox.x + 40,
		y: actionsBox.y + 280,
		parent: actions,
		text: "A review rota, two reviewers a day",
		owner: { login: "sam", name: "Sam" },
		due: addDays(sam.today(), 5), // next Monday, in San Francisco
		author: lena.author,
	});
	addActionItem(lena.doc, "room", {
		x: actionsBox.x + 40,
		y: actionsBox.y + 420,
		parent: actions,
		text: "Book the room for the next retro",
		owner: { login: "lena", name: "Lena" },
		author: lena.author,
	});
	setActionDone(lena.doc, "room", true, world.iso());

	// The two that need work are staged as issues, and pushed.
	const staged = [ciAction!, "reviews"].map((id) =>
		stageActionIssue(lena.doc, id, REPO, lena.stager, {
			boardUrl,
			boardTitle: "Retro, week 42",
		}),
	);
	expect(staged.every(Boolean)).toBe(true);
	await lena.client!.roundTrip();
	const pushed = await world.api(`/api/boards/${board}/push`, lena.cookie, {
		method: "POST",
		body: JSON.stringify({ ids: staged, as: "user" }),
	});
	expect(pushed.status).toBe(202);
	expect(((await pushed.json()) as PushResponse).ok).toBe(true);
	await eventually(
		() =>
			staged.every(
				(id) => listChanges(lena.doc).find((change) => change.id === id)?.status === "applied",
			),
		15_000,
	);
	const issues = github.itemsIn(WIDGETS);
	const ciIssue = issues.find((issue) => issue.title === "Quarantine the flaky CI tests")!;
	const rotaIssue = issues.find((issue) => issue.title === "A review rota, two reviewers a day")!;
	expect(ciIssue).toMatchObject({ assignees: ["priya"] });
	expect(rotaIssue).toMatchObject({ assignees: ["sam"] });
	expect(ciIssue.body).toContain(`**Due** ${priyaDue}`);
	expect(ciIssue.body).toContain(`[Retro, week 42](${boardUrl})`);
	// The items follow their issues now.
	const ciKey = `${REPO}#${ciIssue.number}`;
	const rotaKey = `${REPO}#${rotaIssue.number}`;
	await eventually(() => shapes(lena.doc).get(ciAction!)?.ref === ciKey);
	await eventually(() => shapes(lena.doc).get("reviews")?.ref === rotaKey);
	await eventually(() => cardState(lena.client!, ciKey) === "open", 8000);
	await lena.leave();

	// Priya has already quarantined the tests: she closes the issue on
	// GitHub, then looks in at 22:00 in Bengaluru. The action item is done.
	await world.at(world.monday + 2 * DAY + 16 * HOUR + 25 * MINUTE);
	await world.change(ciIssue.number, { state: "closed", stateReason: "completed" }, "closed");
	await priya.arrive(board, 3, "22:00");
	await eventually(() => cardState(priya.client!, ciKey) === "closed", 8000);
	const ciShape = shapes(priya.doc).get(ciAction!)!;
	expect(actionState(ciShape, cardOf(priya.client!, ciKey))).toMatchObject({
		status: "done",
		from: "issue",
	});
	// A due date is a day on the calendar, read in each person's own: by
	// Thursday 20:00 UTC, Friday has come in Bengaluru, not in San Francisco.
	const thursdayEvening = world.monday + 3 * DAY + 20 * HOUR;
	expect(ciShape.due).toBe(priyaDue);
	expect(dueState(ciShape.due, priya.today(thursdayEvening))).toBe("today");
	expect(dueState(ciShape.due, sam.today(thursdayEvening))).toBe("soon");
	await priya.leave();

	// Sam, 10:00 in San Francisco (Wednesday, 17:00 UTC): his digest says
	// what Lena did while he was away, and her push.
	await sam.arrive(board, 3, "10:00");
	const samWednesday = await sam.digest();
	expect(samWednesday.pushes).toEqual([
		expect.objectContaining({ by: expect.objectContaining({ login: "lena" }), applied: 2 }),
	]);
	expect(
		samWednesday.edits.filter((edit) => edit.by.login === "lena").map((edit) => edit.shape),
	).toEqual(expect.arrayContaining(["reviews", "room", ciAction]));
	await sam.leave();

	// Lena, 20:00 in Berlin: Priya's issue was closed while she was away.
	// She starts next week's retro, from the template, with this one's open
	// action items: only the review rota (the CI issue's closed, and the
	// room's booked).
	await lena.arrive(board, 3, "20:00");
	const lenaWednesday = await lena.digest();
	expect(lenaWednesday.cards).toEqual([expect.objectContaining({ key: ciKey, kind: "closed" })]);
	await lena.leave();
	const next = await world.json<{ id: string; carried?: number }>("/api/boards", lena.cookie, {
		method: "POST",
		body: JSON.stringify({
			title: "Retro, week 43",
			template: "tack:retro",
			visibility: "private",
			carryFrom: board,
		}),
	});
	expect(next.carried).toBe(1);
	const nextClient = await world.connect(next.id, lena.cookie);
	const carried = [...shapes(nextClient.doc).values()].filter((shape) => shape.type === "action");
	expect(carried).toEqual([
		expect.objectContaining({
			text: "A review rota, two reviewers a day",
			ref: rotaKey,
			owner: expect.objectContaining({ login: "sam" }),
			parent: sectionId(nextClient.doc, "Actions"),
			carried: expect.objectContaining({ board, title: "Retro, week 42" }),
		}),
	]);

	// --- History ------------------------------------------------------------------
	// Three days of it, each person's part attributed to them, and the
	// server's own: the reveal, and the push linking items to their issues.
	const history = await world.json<Timeline>(`/api/boards/${board}/history`, lena.cookie);
	const actors = (step: Timeline["steps"][number]) =>
		step.actors.map((key) => history.actors[key]?.login ?? history.actors[key]?.system);
	const byDay = (day: number) =>
		history.steps.filter(
			(step) => step.at >= world.monday + (day - 1) * DAY && step.at < world.monday + day * DAY,
		);
	// Day 1: the template laid out (the server), silent mode started, and
	// everyone's stickies, each in their own step.
	expect(new Set(byDay(1).flatMap(actors))).toEqual(
		new Set(["server", "reveal", "lena", "priya", "sam"]),
	);
	const stickiesBy = (login: string, day: number) =>
		byDay(day)
			.filter((step) => actors(step).join() === login)
			.flatMap((step) => step.changes.filter((c) => c.op === "add").map((c) => c.id));
	expect(stickiesBy("priya", 1).sort()).toEqual(["priya-improve", "priya-well"]);
	expect(stickiesBy("sam", 1).sort()).toEqual(["sam-improve", "sam-well"]);
	// Day 2: the reveal, and each person's dots, at their own times.
	expect(new Set(byDay(2).flatMap(actors))).toEqual(new Set(["reveal", "lena", "priya", "sam"]));
	for (const person of [priya, sam]) {
		const voted = byDay(2).find((step) => actors(step).join() === person.login);
		expect(voted?.other).toContain("dotVotes");
		expect(person.localTime(voted!.at).slice(11)).toBe(person === priya ? "19:00" : "08:30");
	}
	// Day 3: Lena's action items, and the push linking them to their issues.
	expect(new Set(byDay(3).flatMap(actors))).toEqual(new Set(["lena", "push"]));
	expect(
		byDay(3)
			.filter((step) => actors(step).join() === "push")
			.flatMap((step) => step.changes.map((c) => `${c.id}:${c.keys?.join()}`)),
	).toEqual(expect.arrayContaining([`${ciAction}:ref`, "reviews:ref"]));
	// The board after the reveal, replayed from history, has everyone's text.
	const revealStep = byDay(2).find((step) => actors(step).includes("reveal"))!;
	const segment = decodeSegment(
		new Uint8Array(
			await (
				await world.api(`/api/boards/${board}/history/segment?step=${revealStep.id}`, lena.cookie)
			).arrayBuffer(),
		),
	);
	const replay = new Y.Doc();
	Y.applyUpdate(replay, segment.base.state);
	for (const step of segment.steps) {
		if (step.id <= revealStep.id && step.update) Y.applyUpdate(replay, step.update);
	}
	expect(shapes(replay).get("priya-improve")?.text).toBe(WRITES.priya.improve);
}, 90_000);

function cardOf(client: BoardClient, key: string) {
	for (const message of [...(client.messages as CardMessage[])].reverse()) {
		if (message.type !== "cards") continue;
		const card = message.cards.find((entry) => entry.key === key);
		if (card) return card;
	}
	return undefined;
}
