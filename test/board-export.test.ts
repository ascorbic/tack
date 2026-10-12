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
import { castVote } from "../src/shared/decisions.ts";
import { hashImage } from "../src/shared/images.ts";
import { preparedMap, readPrepared } from "../src/shared/prepared.ts";
import { addRule, listRules, scopeRepos, setScopeRepos } from "../src/shared/rules.ts";
import { addShape, shapesMap } from "../src/shared/shapes.ts";
import { readShapes } from "../src/shared/structure.ts";

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
