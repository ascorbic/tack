import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import {
	exportParts,
	describeUploadFailures,
	fromBase64,
	gatherImages,
	imageHashes,
	toBase64,
	type UploadProgress,
	uploadImages,
} from "../src/client/export/imageFiles.ts";
import { ImageError, type PreparedImage } from "../src/client/images/prepare.ts";
import {
	BOARD_EXPORT_FORMAT,
	BOARD_EXPORT_MAX_BYTES,
	BOARD_EXPORT_MAX_FILE_BYTES,
	BOARD_EXPORT_VERSION,
	type BoardExport,
	type ExportedImage,
	IMPORT_ORIGIN,
	describeImportError,
	exportBoard,
	exportFileName,
	importBoard,
	readBoardExport,
	serialiseExport,
	splitImages,
	summariseExport,
} from "../src/shared/boardExport.ts";
import type { Card, MissingCard } from "../src/shared/cards.ts";
import type { CommentThread } from "../src/shared/comments.ts";
import { addDecision, castVote } from "../src/shared/decisions.ts";
import { closeVote, placeDot, readVotes, startVote } from "../src/shared/dotvotes.ts";
import { stampsMap, toggleStamp } from "../src/shared/facilitation.ts";
import { hashImage } from "../src/shared/images.ts";
import { preparedMap, readPrepared } from "../src/shared/prepared.ts";
import { addRule, listRules, scopeRepos, setScopeRepos } from "../src/shared/rules.ts";
import { addShape, shapesMap } from "../src/shared/shapes.ts";
import { readShapes } from "../src/shared/structure.ts";
import { toggleVolunteer, volunteersMap } from "../src/shared/volunteers.ts";

const BY = { name: "Priya Shah", color: "#b4467a", login: "priya" };
const NOW = "2026-10-11T09:00:00.000Z";

function counter(prefix = "new") {
	let n = 0;
	return () => `${prefix}${++n}`;
}

/** A retro board with one of everything, and some session state that must stay out. */
function board(): Y.Doc {
	const doc = new Y.Doc();
	doc.transact(() => {
		addShape(doc, "s1", {
			type: "section",
			x: 0,
			y: 0,
			z: "a0",
			w: 800,
			h: 600,
			title: "Went well",
			color: "green",
			parent: null,
			silent: { id: "session", by: "x", at: NOW } as never,
			inbox: { query: { kind: "search", host: "github.com", q: "repo:a/b is:open" } },
			dismissed: {},
		});
		addShape(doc, "n1", {
			type: "sticky",
			x: 20,
			y: 40,
			z: "a1",
			text: "Shipped it",
			color: "yellow",
			parent: "s1",
			order: "a0",
			author: { name: "Kai", color: "#123456", login: "kai" },
		});
		addShape(doc, "n2", {
			type: "sticky",
			x: 200,
			y: 40,
			z: "a2",
			parent: "s1",
			silent: "session",
		});
		addShape(doc, "c1", {
			type: "card",
			x: 300,
			y: 300,
			z: "a3",
			ref: "github.com/acme/app#1",
			parent: "s1",
			provenance: { via: "inbox", source: "s1" },
		});
		addShape(doc, "c2", {
			type: "card",
			x: 600,
			y: 300,
			z: "a4",
			ref: "github.com/acme/secret#2",
			parent: null,
		});
		addShape(doc, "k1", {
			type: "connector",
			x: 0,
			y: 0,
			z: "a5",
			from: { x: 0, y: 0, shape: "c1" },
			to: { x: 10, y: 10, shape: "c2", anchor: { x: 0.5, y: 0 } },
			label: "blocks",
		});
		const decision = new Y.Map<unknown>();
		decision.set("type", "decision");
		decision.set("x", 900);
		decision.set("y", 0);
		decision.set("z", "a6");
		decision.set("parent", null);
		decision.set("title", "Use Valibot");
		decision.set("status", "decided");
		decision.set("writeback", "change-1");
		decision.set("votes", new Y.Map());
		shapesMap(doc).set("d1", decision);
		addShape(doc, "a1", {
			type: "action",
			x: 900,
			y: 300,
			z: "a7",
			parent: null,
			text: "Write the docs",
			owner: { login: "kai" },
			due: "2026-10-20",
			ref: "github.com/acme/secret#3",
			issue: "change-2",
			carried: { board: "b", title: "Old", shape: "x", at: NOW },
		});
	});
	castVote(doc, "d1", { name: "Kai", login: "kai" }, "agree");
	addRule(
		doc,
		{ kind: "matches", query: { kind: "search", host: "github.com", q: "repo:a/b label:bug" } },
		{ kind: "section", section: "s1" },
		BY,
		{ id: "r1" },
	);
	preparedMap(doc).set("p1", { kind: "silent", section: "s1", label: "Write", order: 0 });
	preparedMap(doc).set("p2", {
		kind: "vote",
		scope: null,
		dots: 3,
		hidden: true,
		label: "",
		order: 1,
		startedAt: NOW,
	});
	return doc;
}

const readable = (key: string) => !key.includes("/secret");

describe("exporting a board", () => {
	it("keeps the board's content and leaves out sessions and people's own state", () => {
		const { data, omitted } = exportBoard(board(), { title: "Retro", now: NOW });
		expect(data.format).toBe(BOARD_EXPORT_FORMAT);
		expect(data.version).toBe(BOARD_EXPORT_VERSION);
		expect(data.exportedAt).toBe(NOW);
		// Bottom of the stack first.
		expect(data.shapes.map((s) => s.id)).toEqual(["s1", "n1", "c1", "c2", "k1", "d1", "a1"]);
		const byId = new Map(data.shapes.map((s) => [s.id, s]));
		expect(byId.get("s1")).toEqual({
			id: "s1",
			type: "section",
			x: 0,
			y: 0,
			parent: null,
			title: "Went well",
			color: "green",
			w: 800,
			h: 600,
			inbox: { query: { kind: "search", host: "github.com", q: "repo:a/b is:open" } },
		});
		expect(byId.get("n1")).toMatchObject({ parent: "s1", order: "a0", text: "Shipped it" });
		expect(byId.get("c1")).not.toHaveProperty("provenance");
		expect(byId.get("d1")).toMatchObject({ title: "Use Valibot", status: "decided" });
		expect(byId.get("d1")).not.toHaveProperty("votes");
		expect(byId.get("d1")).not.toHaveProperty("writeback");
		expect(byId.get("a1")).not.toHaveProperty("issue");
		expect(byId.get("a1")).not.toHaveProperty("carried");
		// Face down in silent mode: its author's.
		expect(byId.has("n2")).toBe(false);
		expect(omitted).toEqual({ cards: 0, faceDown: 1 });
		const json = serialiseExport(data);
		expect(json).not.toContain("session");
		expect(json).not.toContain("change-1");
		expect(json).not.toContain("agree");
		expect(data.rules).toEqual([
			{
				id: "r1",
				trigger: {
					kind: "matches",
					query: { kind: "search", host: "github.com", q: "repo:a/b label:bug" },
				},
				action: { kind: "section", section: "s1" },
				enabled: true,
				name: "New matches into “Went well”",
			},
		]);
		expect(data.prepared.map((step) => step.kind)).toEqual(["silent", "vote"]);
		expect(json).not.toContain("startedAt");
	});

	it("leaves out cards the exporter can't read, and the links to them", () => {
		const { data, omitted } = exportBoard(board(), { title: "Retro", includeCard: readable });
		const byId = new Map(data.shapes.map((s) => [s.id, s]));
		expect(byId.has("c2")).toBe(false);
		expect(byId.get("a1")).not.toHaveProperty("ref");
		expect(omitted.cards).toBe(2);
		expect(serialiseExport(data)).not.toContain("secret");
		// The connector's end on the missing card stays where it was drawn.
		expect(byId.get("k1")?.to).toEqual({ x: 10, y: 10 });
	});

	it("names files after the board", () => {
		expect(exportFileName("Planning: Q4 ✨ Café", "json", new Date(NOW))).toBe(
			"planning-q4-cafe-2026-10-11.json",
		);
		expect(exportFileName("✨", "png", new Date(NOW))).toBe("board-2026-10-11.png");
	});
});

describe("what people did on a board", () => {
	const KAI = { name: "Kai", color: "#123456", login: "kai" };
	const PRIYA = { name: "Priya Shah", color: "#b4467a", login: "priya" };
	const at = (minute: number) => `2026-10-11T09:${String(minute).padStart(2, "0")}:00.000Z`;

	function item(key: string, extra: Partial<Card> = {}): Card {
		return {
			key,
			forge: "github",
			host: "github.com",
			repo: key.slice("github.com/".length).split("#")[0] ?? "",
			item: `#${key.split("#")[1]}`,
			kind: "issue",
			title: "Uploads fail on Safari",
			state: "open",
			stateReason: null,
			labels: [{ name: "bug", color: "d73a4a" }],
			assignees: [{ login: "kai", avatarUrl: "https://avatars.example/kai" }],
			author: { login: "priya", avatarUrl: "https://avatars.example/priya" },
			comments: 4,
			reactions: 3,
			thumbsUp: { count: 2, logins: ["kai", "zed"] },
			url: `https://github.com/${key.slice("github.com/".length).replace("#", "/issues/")}`,
			updatedAt: at(1),
			...extra,
		};
	}

	const cards = (key: string): Card | MissingCard | undefined =>
		key.includes("/secret") ? { key, missing: true, reason: "private" } : item(key);

	function author(login: string, name: string | null): CommentThread["messages"][number]["author"] {
		return { id: login.length, login, name, avatarUrl: `https://avatars.example/${login}` };
	}

	const THREADS: CommentThread[] = [
		{
			id: "t1",
			anchor: { x: 30, y: 50, shape: "n1", dx: 10, dy: 10 },
			createdAt: Date.parse(at(10)),
			updatedAt: Date.parse(at(12)),
			resolved: null,
			messages: [
				{
					id: "m1",
					author: author("priya", "Priya Shah"),
					body: "Can we ship this @kai?",
					at: Date.parse(at(10)),
					mentions: ["kai"],
				},
				{
					id: "m2",
					author: author("kai", null),
					body: "",
					at: Date.parse(at(11)),
					deleted: true,
				},
				{
					id: "m3",
					author: author("kai", null),
					body: "Yes, Friday",
					at: Date.parse(at(12)),
					editedAt: Date.parse(at(13)),
				},
			],
		},
		// On a card from a repository the exporter can't read: stays out.
		{
			id: "t2",
			anchor: { x: 600, y: 300, shape: "c2", dx: 0, dy: 0 },
			createdAt: Date.parse(at(14)),
			updatedAt: Date.parse(at(14)),
			resolved: null,
			messages: [
				{
					id: "m4",
					author: author("kai", "Kai"),
					body: "About the secret",
					at: Date.parse(at(14)),
				},
			],
		},
		// A free pin, resolved.
		{
			id: "t3",
			anchor: { x: -40, y: 900 },
			createdAt: Date.parse(at(15)),
			updatedAt: Date.parse(at(16)),
			resolved: { by: author("priya", "Priya Shah"), at: Date.parse(at(16)) },
			messages: [
				{ id: "m5", author: author("kai", "Kai"), body: "Parking this", at: Date.parse(at(15)) },
			],
		},
		// Everything in it deleted: gone.
		{
			id: "t4",
			anchor: { x: 0, y: 0 },
			createdAt: Date.parse(at(17)),
			updatedAt: Date.parse(at(17)),
			resolved: null,
			messages: [
				{ id: "m6", author: author("kai", "Kai"), body: "", at: Date.parse(at(17)), deleted: true },
			],
		},
	];

	/** The retro board after a session: three dot votes, stamps, hands up. */
	function session(): { doc: Y.Doc; votes: string[] } {
		const doc = board();
		const open = startVote(doc, { scope: "s1", dots: 3, reactions: true, by: BY, at: at(2) });
		placeDot(doc, open, KAI, "n1", at(3));
		placeDot(doc, open, KAI, "n1", at(3));
		placeDot(doc, open, KAI, "c1", at(3));
		placeDot(doc, open, PRIYA, "c1", at(4));
		// Face down, so it isn't in the file, and nor are its dots.
		placeDot(doc, open, PRIYA, "n2", at(4));
		closeVote(doc, open, BY, at(5));
		const secret = startVote(doc, { scope: null, hidden: true, by: BY, at: at(7) });
		placeDot(doc, secret, KAI, "n1", at(7));
		const sealed = startVote(doc, {
			scope: null,
			title: "Next",
			hidden: true,
			endsAt: at(8),
			by: BY,
			at: at(6),
		});
		placeDot(doc, sealed, PRIYA, "c1", at(7));
		toggleStamp(doc, "n1", "👍", KAI, at(20));
		toggleStamp(doc, "n1", "👍", PRIYA, at(21));
		toggleStamp(doc, "n1", "🎉", PRIYA, at(22));
		toggleStamp(doc, "c2", "👀", KAI, at(23));
		toggleVolunteer(doc, "c1", { ...KAI, avatarUrl: "https://avatars.example/kai" }, at(24));
		toggleVolunteer(doc, "c1", PRIYA, at(25));
		toggleVolunteer(doc, "c2", PRIYA, at(25));
		addDecision(doc, "d2", { x: 900, y: 400, title: "Weekly releases" });
		castVote(doc, "d2", KAI, "agree");
		castVote(doc, "d2", PRIYA, "disagree");
		return { doc, votes: [open, sealed, secret] };
	}

	it("stays out unless asked for", () => {
		const { doc } = session();
		const { data } = exportBoard(doc, { title: "Retro", now: NOW });
		expect(data).not.toHaveProperty("activity");
		const json = serialiseExport(data);
		expect(json).not.toContain("Friday");
		expect(json).not.toContain("👍");
	});

	it("holds votes' results, stamps, hands up, comments and items, for the shapes in the file", () => {
		const { doc, votes } = session();
		const [open, sealed, secret] = votes;
		const { data } = exportBoard(doc, {
			title: "Retro",
			now: at(30),
			includeCard: readable,
			activity: { cards, threads: THREADS },
		});
		const activity = data.activity;
		expect(activity?.votes).toEqual([
			{
				id: open,
				scope: "s1",
				dots: 3,
				hidden: false,
				reactions: true,
				startedAt: at(2),
				closedAt: at(5),
				voters: 2,
				// zed's 👍 counts; kai's doesn't, as kai voted here.
				results: [
					{
						shape: "c1",
						rank: 1,
						dots: 2,
						reactions: 1,
						total: 3,
						by: [
							{ name: "Kai", login: "kai", dots: 1 },
							{ name: "Priya Shah", login: "priya", dots: 1 },
						],
						reactors: ["zed"],
					},
					{
						shape: "n1",
						rank: 2,
						dots: 2,
						reactions: 0,
						total: 2,
						by: [{ name: "Kai", login: "kai", dots: 2 }],
						reactors: [],
					},
				],
			},
			// Hidden, and closed when its time ran out: totals, never who.
			{
				id: sealed,
				title: "Next",
				scope: null,
				dots: 3,
				hidden: true,
				reactions: false,
				startedAt: at(6),
				endsAt: at(8),
				closedAt: at(8),
				voters: 1,
				results: [{ shape: "c1", rank: 1, dots: 1, reactions: 0, total: 1 }],
			},
			// Hidden and still open: only how many have voted.
			{
				id: secret,
				scope: null,
				dots: 3,
				hidden: true,
				reactions: false,
				startedAt: at(7),
				voters: 1,
			},
		]);
		// d1 was decided before anyone voted: decided decisions don't take votes.
		expect(activity?.decisions).toEqual([
			{
				shape: "d2",
				agree: [{ name: "Kai", login: "kai" }],
				disagree: [{ name: "Priya Shah", login: "priya" }],
			},
		]);
		expect(activity?.stamps).toEqual([
			{
				shape: "n1",
				emoji: "👍",
				people: [
					{ name: "Kai", login: "kai" },
					{ name: "Priya Shah", login: "priya" },
				],
			},
			{ shape: "n1", emoji: "🎉", people: [{ name: "Priya Shah", login: "priya" }] },
		]);
		expect(activity?.volunteers).toEqual([
			{
				shape: "c1",
				people: [
					{ name: "Kai", login: "kai" },
					{ name: "Priya Shah", login: "priya" },
				],
			},
		]);
		expect(activity?.comments).toEqual([
			{
				id: "t1",
				shape: "n1",
				x: 30,
				y: 50,
				messages: [
					{
						author: { name: "Priya Shah", login: "priya" },
						body: "Can we ship this @kai?",
						at: at(10),
					},
					{
						author: { name: "kai", login: "kai" },
						body: "Yes, Friday",
						at: at(12),
						editedAt: at(13),
					},
				],
			},
			{
				id: "t3",
				x: -40,
				y: 900,
				resolved: { by: { name: "Priya Shah", login: "priya" }, at: at(16) },
				messages: [{ author: { name: "Kai", login: "kai" }, body: "Parking this", at: at(15) }],
			},
		]);
		expect(activity?.items).toEqual([
			{
				key: "github.com/acme/app#1",
				kind: "issue",
				title: "Uploads fail on Safari",
				state: "open",
				url: "https://github.com/acme/app/issues/1",
				labels: ["bug"],
				assignees: ["kai"],
				author: "priya",
				comments: 4,
				reactions: 3,
				thumbsUp: 2,
				updatedAt: at(1),
			},
		]);
		const json = serialiseExport(data);
		expect(json).not.toContain("secret");
		expect(json).not.toContain("👀");
	});

	it("says what a discussion has, and leaves out items it has no data for", () => {
		const doc = new Y.Doc();
		addShape(doc, "c", {
			type: "card",
			x: 0,
			y: 0,
			z: "a0",
			parent: null,
			ref: "github.com/acme/app#9",
		});
		addShape(doc, "u", {
			type: "card",
			x: 0,
			y: 0,
			z: "a1",
			parent: null,
			ref: "github.com/acme/app#10",
		});
		const discussion = item("github.com/acme/app#9", {
			kind: "discussion",
			title: "Multi-tenancy",
			state: "closed",
			stateReason: "resolved",
			milestone: { title: "1.0", dueOn: null },
			discussion: {
				category: { name: "Ideas", emoji: "💡", answerable: false },
				answered: false,
				upvotes: 13,
				locked: false,
			},
		});
		const { data } = exportBoard(doc, {
			title: "Ideas",
			activity: { cards: (key) => (key === discussion.key ? discussion : undefined), threads: [] },
		});
		expect(data.activity?.items).toEqual([
			{
				key: "github.com/acme/app#9",
				kind: "discussion",
				title: "Multi-tenancy",
				state: "closed",
				stateReason: "resolved",
				url: "https://github.com/acme/app/issues/9",
				labels: ["bug"],
				assignees: ["kai"],
				author: "priya",
				comments: 4,
				reactions: 3,
				thumbsUp: 2,
				milestone: "1.0",
				category: "Ideas",
				upvotes: 13,
				answered: false,
				updatedAt: at(1),
			},
		]);
		expect(data.activity).toMatchObject({ votes: [], stamps: [], volunteers: [], comments: [] });
	});

	it("is counted for the dialog, and left behind by an import", () => {
		const { doc } = session();
		const { data } = exportBoard(doc, {
			title: "Retro",
			includeCard: readable,
			activity: { cards, threads: THREADS },
		});
		expect(summariseExport(data).activity).toEqual({
			votes: 3,
			stamps: 3,
			volunteers: 2,
			comments: 2,
			items: 1,
		});
		expect(summariseExport(exportBoard(doc, { title: "Retro" }).data)).not.toHaveProperty(
			"activity",
		);
		const read = readBoardExport(serialiseExport(data));
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.data).not.toHaveProperty("activity");
		const copy = new Y.Doc();
		importBoard(copy, read.data, { by: BY, newId: counter() });
		expect(readVotes(copy)).toEqual([]);
		expect(stampsMap(copy).size).toBe(0);
		expect(volunteersMap(copy).size).toBe(0);
	});

	it("doesn't count towards what an import may weigh", () => {
		const { doc } = session();
		const long = "x".repeat(BOARD_EXPORT_MAX_BYTES);
		const { data } = exportBoard(doc, {
			title: "Retro",
			activity: {
				cards,
				threads: [
					{
						id: "long",
						anchor: { x: 0, y: 0 },
						createdAt: 0,
						updatedAt: 0,
						resolved: null,
						messages: [{ id: "m", author: author("kai", "Kai"), body: long, at: 0 }],
					},
				],
			},
		});
		expect(readBoardExport(serialiseExport(data)).ok).toBe(true);
	});
});

describe("reading an export", () => {
	const valid = () => exportBoard(board(), { title: "Retro", now: NOW }).data;

	it("reads what it exported, from text or JSON", () => {
		const data = valid();
		const read = readBoardExport(serialiseExport(data));
		expect(read).toEqual({ ok: true, data });
		expect(readBoardExport(JSON.parse(JSON.stringify(data)))).toEqual({ ok: true, data });
		expect(summariseExport(data)).toMatchObject({
			shapes: 7,
			counts: { card: 2, sticky: 1, section: 1, connector: 1, decision: 1, action: 1 },
			rules: 1,
			prepared: 2,
		});
	});

	it("says why it can't read something", () => {
		const errors = [
			readBoardExport("{nope"),
			readBoardExport("[]"),
			readBoardExport(JSON.stringify({ format: "other" })),
			readBoardExport(JSON.stringify({ ...valid(), version: 99 })),
			readBoardExport(
				JSON.stringify({
					...valid(),
					shapes: [{ id: "x", type: "card", x: 0, y: 0, ref: "nope" }],
				}),
			),
			readBoardExport(
				JSON.stringify({ ...valid(), shapes: [{ id: "x", type: "sticky", x: "far", y: 0 }] }),
			),
			readBoardExport(
				JSON.stringify({
					...valid(),
					shapes: [
						{ id: "x", type: "text", x: 0, y: 0 },
						{ id: "x", type: "text", x: 0, y: 0 },
					],
				}),
			),
			readBoardExport(JSON.stringify({ ...valid(), shapes: [{ id: "x", type: "goblin" }] })),
		].map((result) => (result.ok ? null : result.error.reason));
		expect(errors).toEqual([
			"not_json",
			"not_tack",
			"not_tack",
			"newer",
			"invalid",
			"invalid",
			"invalid",
			"invalid",
		]);
		const newer = readBoardExport(JSON.stringify({ ...valid(), version: 2 }));
		expect(!newer.ok && describeImportError(newer.error)).toMatch(/newer version of Tack/);
	});

	it("drops properties it doesn't know", () => {
		const data = valid();
		const sneaky = {
			...data,
			shapes: [{ id: "n", type: "sticky", x: 0, y: 0, text: "hi", silent: "s", __proto__x: 1 }],
			secret: "token",
		};
		const read = readBoardExport(JSON.stringify(sneaky));
		expect(read.ok && read.data.shapes[0]).toEqual({
			id: "n",
			type: "sticky",
			x: 0,
			y: 0,
			text: "hi",
		});
		expect(read.ok && "secret" in read.data).toBe(false);
	});
});

describe("importing a board", () => {
	it("writes everything with fresh ids, references remapped, in one transaction", () => {
		const data = exportBoard(board(), { title: "Retro", now: NOW }).data;
		const doc = new Y.Doc();
		const origins: unknown[] = [];
		doc.on("afterTransaction", (transaction: Y.Transaction) => origins.push(transaction.origin));
		const result = importBoard(doc, data, { by: BY, now: NOW, newId: counter() });
		expect(origins).toEqual([IMPORT_ORIGIN]);
		expect(result).toEqual({ shapes: 7, rules: 1, prepared: 2 });

		const shapes = readShapes(doc);
		const ids = data.shapes.map((s) => s.id);
		for (const id of ids) expect(shapes.has(id)).toBe(false);
		const find = (title: string) =>
			[...shapes].find(([, s]) => s.title === title || s.text === title)?.[0];
		const section = find("Went well");
		expect(section).toBeDefined();
		expect(shapes.get(find("Shipped it") ?? "")?.parent).toBe(section);
		expect(shapes.get(section ?? "")?.dismissed).toEqual({});
		const connector = [...shapes.values()].find((s) => s.type === "connector");
		const cards = [...shapes].filter(([, s]) => s.type === "card").map(([id]) => id);
		expect(cards).toContain(connector?.from?.shape);
		expect(cards).toContain(connector?.to?.shape);
		const decision = [...shapes.values()].find((s) => s.type === "decision");
		expect(decision).toMatchObject({ status: "decided", votes: {} });
		expect(
			shapesMap(doc)
				.get(find("Use Valibot") ?? "")
				?.get("votes"),
		).toBeInstanceOf(Y.Map);

		const [rule] = listRules(doc);
		expect(rule?.action).toEqual({ kind: "section", section });
		expect(rule?.createdBy).toEqual(BY);
		const steps = readPrepared(doc);
		expect(steps.map((s) => s.kind)).toEqual(["silent", "vote"]);
		expect(steps[0]?.kind === "silent" && steps[0].section).toBe(section);
	});

	it("drops references to shapes that aren't there", () => {
		const read = readBoardExport({
			format: BOARD_EXPORT_FORMAT,
			version: BOARD_EXPORT_VERSION,
			title: "Loose ends",
			shapes: [
				{ id: "n", type: "sticky", x: 0, y: 0, parent: "gone", order: "!!" },
				{
					id: "k",
					type: "connector",
					x: 5,
					y: 5,
					from: { x: 1, y: 2, shape: "n" },
					to: { x: 3, y: 4, shape: "gone", anchor: { x: 0, y: 0 } },
				},
				{ id: "d", type: "decision", x: 0, y: 0, supersededBy: "n" },
			],
			rules: [
				{
					id: "r",
					trigger: { kind: "matches", query: { kind: "search", host: "github.com", q: "x" } },
					action: { kind: "section", section: "gone" },
				},
			],
			prepared: [{ id: "p", kind: "silent", section: "gone" }],
		} satisfies Omit<BoardExport, "exportedAt" | "shapes" | "rules" | "prepared"> & {
			shapes: unknown[];
			rules: unknown[];
			prepared: unknown[];
		});
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		const doc = new Y.Doc();
		const result = importBoard(doc, read.data, { by: BY, newId: counter() });
		expect(result).toEqual({ shapes: 3, rules: 0, prepared: 0 });
		const shapes = readShapes(doc);
		const sticky = [...shapes.values()].find((s) => s.type === "sticky");
		expect(sticky?.parent).toBeNull();
		expect(sticky).not.toHaveProperty("order");
		const connector = [...shapes.values()].find((s) => s.type === "connector");
		expect(connector?.from).toEqual({ x: 1, y: 2, shape: "new1" });
		expect(connector?.to).toEqual({ x: 3, y: 4 });
		expect(connector).toMatchObject({ x: 0, y: 0 });
		expect([...shapes.values()].find((s) => s.type === "decision")).not.toHaveProperty(
			"supersededBy",
		);
	});

	it("keeps the repositories a board was made for, so its rules place the same items", () => {
		const doc = board();
		setScopeRepos(doc, ["github.com/acme/app"], "template");
		const { data } = exportBoard(doc, { title: "Retro" });
		expect(data.repos).toEqual(["github.com/acme/app"]);
		const read = readBoardExport(
			serialiseExport({ ...data, repos: ["github.com/acme/app", "not a repo"] }),
		);
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		const copy = new Y.Doc();
		importBoard(copy, read.data, { by: BY, newId: counter() });
		expect(scopeRepos(copy)).toEqual(["github.com/acme/app"]);
		expect(exportBoard(new Y.Doc(), { title: "Empty" }).data).not.toHaveProperty("repos");
	});
});

describe("link cards", () => {
	const PREVIEW = {
		status: "ok",
		title: "Unpic",
		description: "Responsive images",
		image: "https://unpic.pics/og.png",
		fetchedAt: NOW,
	} as const;

	it("go out and come back with their address, preview and stack", () => {
		const doc = new Y.Doc();
		doc.transact(() => {
			addShape(doc, "stack", { type: "stack", x: 0, y: 0, z: "a0", title: "Images" });
			addShape(doc, "l1", {
				type: "link",
				x: 10,
				y: 20,
				z: "a1",
				url: "https://unpic.pics/",
				preview: PREVIEW,
				stack: "stack",
			});
			addShape(doc, "l2", { type: "link", x: 300, y: 20, z: "a2", url: "https://tack.social/" });
		});
		const { data } = exportBoard(doc, { title: "Links" });
		expect(data.shapes.filter((shape) => shape.type === "link")).toEqual([
			{
				id: "l1",
				type: "link",
				x: 10,
				y: 20,
				parent: null,
				url: "https://unpic.pics/",
				preview: PREVIEW,
				stack: "stack",
			},
			{ id: "l2", type: "link", x: 300, y: 20, parent: null, url: "https://tack.social/" },
		]);
		const read = readBoardExport(serialiseExport(data));
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		const copy = new Y.Doc();
		importBoard(copy, read.data, { by: BY, newId: counter() });
		const links = [...readShapes(copy).values()].filter((shape) => shape.type === "link");
		expect(links).toHaveLength(2);
		expect(links[0]).toMatchObject({ url: "https://unpic.pics/", preview: PREVIEW, stack: "new1" });
	});

	it("refuse addresses that aren't the web's, and drop what a preview shouldn't hold", () => {
		const base = { format: BOARD_EXPORT_FORMAT, version: BOARD_EXPORT_VERSION, title: "x" };
		const bad = readBoardExport({
			...base,
			shapes: [{ id: "l", type: "link", x: 0, y: 0, url: "javascript:alert(1)" }],
		});
		expect(bad.ok).toBe(false);
		const odd = readBoardExport({
			...base,
			shapes: [
				{
					id: "l",
					type: "link",
					x: 0,
					y: 0,
					url: "https://tack.social/",
					preview: { status: "ok", fetchedAt: NOW, image: "javascript:x", title: "Tack", extra: 1 },
				},
			],
		});
		expect(odd.ok).toBe(true);
		if (!odd.ok) return;
		const preview = (odd.data.shapes[0] as { preview?: object }).preview;
		expect(preview).toEqual({ status: "ok", fetchedAt: NOW, title: "Tack" });
	});
});

// --- Images ------------------------------------------------------------------------------

/** The start of a PNG, as much as is read to know it's one and how big: enough to hash and size. */
function png(width: number, height: number, seed = 0): Uint8Array {
	const bytes = new Uint8Array(40);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	new DataView(bytes.buffer).setUint32(16, width);
	new DataView(bytes.buffer).setUint32(20, height);
	bytes[39] = seed;
	return bytes;
}

async function file(width: number, height: number, seed = 0): Promise<ExportedImage> {
	const bytes = png(width, height, seed);
	return { hash: await hashImage(bytes), type: "image/png", data: toBase64(bytes) };
}

/** A board with an image whose file's stored, and one still uploading. */
function pictures(hash: string): Y.Doc {
	const doc = new Y.Doc();
	doc.transact(() => {
		addShape(doc, "s", { type: "section", x: 0, y: 0, z: "a0", w: 900, h: 600, parent: null });
		addShape(doc, "i1", {
			type: "image",
			x: 40,
			y: 60,
			z: "a1",
			parent: "s",
			order: "a0",
			image: hash,
			mime: "image/png",
			iw: 1200,
			ih: 800,
			w: 300,
			h: 200,
			alt: "The whiteboard after the retro",
			caption: true,
		});
		addShape(doc, "i2", {
			type: "image",
			x: 400,
			y: 60,
			z: "a2",
			parent: null,
			mime: "image/jpeg",
			w: 100,
			h: 100,
			upload: { by: "Kai", client: 7, at: NOW },
			blur: "data:image/webp;base64,AAAA",
		});
	});
	return doc;
}

describe("images in an export", () => {
	it("keep their shapes, naming files by hash, and come back on a new board", async () => {
		const image = await file(1200, 800);
		const { data } = exportBoard(pictures(image.hash), { title: "Retro", now: NOW });
		// One still uploading has no file to name: it's left out.
		expect(data.shapes.map((shape) => shape.id)).toEqual(["s", "i1"]);
		expect(data.shapes[1]).toEqual({
			id: "i1",
			type: "image",
			x: 40,
			y: 60,
			parent: "s",
			order: "a0",
			image: image.hash,
			mime: "image/png",
			iw: 1200,
			ih: 800,
			w: 300,
			h: 200,
			alt: "The whiteboard after the retro",
			caption: true,
		});
		expect(serialiseExport(data)).not.toContain("Kai");
		expect(summariseExport(data).counts).toEqual({ section: 1, image: 1 });

		const withFiles = { ...data, images: [image] };
		const read = readBoardExport(serialiseExport(withFiles));
		expect(read).toEqual({ ok: true, data: withFiles });
		if (!read.ok) return;
		const doc = new Y.Doc();
		const result = importBoard(doc, splitImages(read.data).board, { by: BY, newId: counter() });
		expect(result).toEqual({ shapes: 2, rules: 0, prepared: 0 });
		const shapes = readShapes(doc);
		expect(shapes.get("new2")).toMatchObject({
			type: "image",
			image: image.hash,
			mime: "image/png",
			iw: 1200,
			ih: 800,
			w: 300,
			h: 200,
			alt: "The whiteboard after the retro",
			caption: true,
			parent: "new1",
		});
		expect(shapes.get("new2")).not.toHaveProperty("upload");
	});

	it("checks the files it carries", async () => {
		const image = await file(10, 10);
		const { data } = exportBoard(pictures(image.hash), { title: "Retro", now: NOW });
		const reason = (images: unknown) => {
			const result = readBoardExport(JSON.stringify({ ...data, images }));
			return result.ok ? "ok" : result.error.reason;
		};
		expect(reason([image])).toBe("ok");
		expect(reason([])).toBe("ok");
		expect(reason([{ ...image, hash: "nope" }])).toBe("invalid");
		expect(reason([{ ...image, type: "image/svg+xml" }])).toBe("invalid");
		expect(reason([{ ...image, data: "<script>" }])).toBe("invalid");
		expect(reason({ [image.hash]: image.data })).toBe("invalid");
		// An image shape names its file by hash, never by anything else.
		const named = { ...data, shapes: [{ ...data.shapes[1], image: "cat.png", parent: null }] };
		expect(readBoardExport(JSON.stringify(named)).ok).toBe(false);
	});

	it("go apart from the board, which is all the server's sent", async () => {
		const image = await file(10, 10);
		const { data } = exportBoard(pictures(image.hash), { title: "Retro", now: NOW });
		const { board: alone, images } = splitImages({ ...data, images: [image] });
		expect(images).toEqual([image]);
		expect(alone).toEqual(data);
		expect(alone).not.toHaveProperty("images");
		expect(splitImages(data)).toEqual({ board: data, images: [] });
	});

	it("may take a file past 4 MB, but not a board past it without them", async () => {
		const image = await file(10, 10);
		const { data } = exportBoard(pictures(image.hash), { title: "Retro", now: NOW });
		// A few big files (reading checks their base64, not that it's the file named).
		const big = "A".repeat(3 * 1024 * 1024);
		const heavy = { ...data, images: [image, { ...image, data: big }, { ...image, data: big }] };
		const text = serialiseExport(heavy);
		expect(text.length).toBeGreaterThan(BOARD_EXPORT_MAX_BYTES);
		expect(readBoardExport(text).ok).toBe(true);

		const wordy = {
			...data,
			shapes: [
				...data.shapes,
				...Array.from({ length: 450 }, (_, i) => ({
					id: `n${i}`,
					type: "sticky" as const,
					x: i,
					y: 0,
					text: "x".repeat(10_000),
				})),
			],
		};
		const tooWordy = readBoardExport(serialiseExport({ ...wordy, images: [image] }));
		expect(!tooWordy.ok && tooWordy.error.reason).toBe("too_large");
		expect(!tooWordy.ok && describeImportError(tooWordy.error)).toMatch(/up to 4 MB/);
		const plain = readBoardExport(serialiseExport(wordy));
		expect(!plain.ok && plain.error.reason).toBe("too_large");
		// And never past what a board could hold, images and all.
		expect(readBoardExport(" ".repeat(BOARD_EXPORT_MAX_FILE_BYTES + 1))).toEqual({
			ok: false,
			error: { reason: "too_large" },
		});
	});
});

describe("image files, in the browser", () => {
	it("writes a file in pieces that are exactly the export's text", async () => {
		const a = await file(10, 10, 1);
		const b = await file(20, 10, 2);
		const { data } = exportBoard(pictures(a.hash), { title: "Retro", now: NOW });
		for (const images of [[a], [a, b]]) {
			const withFiles = { ...data, images };
			expect(exportParts(withFiles).join("")).toBe(serialiseExport(withFiles));
		}
		expect(exportParts(data)).toEqual([serialiseExport(data)]);
		expect(readBoardExport(exportParts({ ...data, images: [a, b] }).join("")).ok).toBe(true);
	});

	it("gathers the files image shapes show, once each, saying what's missing", async () => {
		const a = await file(10, 10, 1);
		const doc = pictures(a.hash);
		const gone = "f".repeat(64);
		addShape(doc, "i3", { type: "image", x: 0, y: 0, z: "a3", parent: null, image: a.hash });
		addShape(doc, "i4", { type: "image", x: 0, y: 0, z: "a4", parent: null, image: gone });
		const { data } = exportBoard(doc, { title: "Retro", now: NOW });
		expect(imageHashes(data)).toEqual([a.hash, gone]);
		const asked: string[] = [];
		const progress: string[] = [];
		const gathered = await gatherImages(
			data,
			{
				blob: async (hash) => {
					asked.push(hash);
					return hash === a.hash ? new Blob([fromBase64(a.data)]) : null;
				},
			},
			{ onProgress: (done, total) => progress.push(`${done}/${total}`) },
		);
		expect(asked).toEqual([a.hash, gone]);
		expect(gathered).toEqual({ images: [a], missing: [gone] });
		expect(progress).toEqual(["0/2", "1/2", "2/2"]);
	});

	it("uploads an import's files as they are, checked against their hashes", async () => {
		const a = await file(1200, 800, 1);
		const b = await file(10, 10, 2);
		const stray = await file(5, 5, 3);
		const doc = pictures(a.hash);
		addShape(doc, "i3", { type: "image", x: 0, y: 0, z: "a3", parent: null, image: b.hash });
		const { data } = exportBoard(doc, { title: "Retro", now: NOW });
		const uploaded: PreparedImage[] = [];
		const progress: UploadProgress[] = [];
		const result = await uploadImages(
			data,
			// The same file twice, one nothing shows, and one whose bytes aren't what it's called.
			[a, a, stray, { ...b, data: toBase64(png(10, 10, 9)) }],
			{
				upload: async (prepared, onProgress) => {
					onProgress?.(0.5);
					uploaded.push(prepared);
				},
			},
			{ onProgress: (step) => progress.push(step), thumbnail: async () => new Blob(["thumb"]) },
		);
		expect(uploaded.map((image) => [image.hash, image.type, image.width, image.height])).toEqual([
			[a.hash, "image/png", 1200, 800],
		]);
		expect(uploaded[0]?.thumb).toBeInstanceOf(Blob);
		// The very bytes in the file, so the shapes' hash still names them.
		expect(new Uint8Array(await (uploaded[0] as PreparedImage).blob.arrayBuffer())).toEqual(
			fromBase64(a.data),
		);
		expect(result).toEqual({
			total: 2,
			failures: [{ hash: b.hash, message: "Its file in the export is damaged." }],
		});
		expect(progress.at(0)).toEqual({ fraction: 0, done: 0, total: 2 });
		expect(progress.at(-1)).toEqual({ fraction: 1, done: 2, total: 2 });
		expect(describeUploadFailures(result.failures, result.total)).toBe(
			"1 of its 2 images couldn’t be added, so it shows as unavailable. Its file in the export is damaged.",
		);
	});

	it("says in words when uploads fail", async () => {
		const a = await file(10, 10, 1);
		const { data } = exportBoard(pictures(a.hash), { title: "Retro", now: NOW });
		const refused = await uploadImages(data, [a], {
			upload: async () => {
				throw new ImageError(
					"This board has no room for more images. Remove some, then try again.",
				);
			},
		});
		expect(describeUploadFailures(refused.failures, refused.total)).toBe(
			"Its image couldn’t be added, so it shows as unavailable. This board has no room for more images. Remove some, then try again.",
		);
		expect(
			describeUploadFailures(
				[
					{ hash: "a", message: "One thing." },
					{ hash: "b", message: "Another." },
				],
				2,
			),
		).toBe("None of its 2 images could be added, so they show as unavailable.");
	});
});
