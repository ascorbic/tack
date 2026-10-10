// Comment commands (#58), the pure half: reading commands out of comments,
// finding boards and sections by name, placing the card and wording replies.

import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import {
	type BoardCandidate,
	commandNames,
	commandReply,
	findCommand,
	matchBoard,
	nameScore,
	placeCommandCard,
	quote,
} from "../src/shared/commands.ts";
import { addCardShape, provenanceOf } from "../src/shared/provenance.ts";
import { addShape, readShape, shapesMap } from "../src/shared/shapes.ts";
import { intersects } from "../src/shared/geometry.ts";
import { boxOf } from "../src/shared/sections.ts";
import { readShapes } from "../src/shared/structure.ts";

const NAMES = commandNames("tack-acme", "tack");

describe("finding commands in comments", () => {
	it("answers to the app's slug and its aliases", () => {
		expect(commandNames("Tack-Acme", " @tack , ,bad name")).toEqual(["tack-acme", "tack"]);
		expect(commandNames(null, "")).toEqual([]);
		expect(findCommand("@tack-acme add to roadmap", NAMES)).toMatchObject({
			kind: "add",
			name: "tack-acme",
			board: "roadmap",
		});
		expect(findCommand("@tack add to roadmap", NAMES)).toMatchObject({ name: "tack" });
		expect(findCommand("@Tack-Acme[bot] help", NAMES)).toEqual({ kind: "help", name: "tack-acme" });
		expect(findCommand("@tack help", [])).toBeNull();
	});

	it("reads add, with or without a section, and help", () => {
		expect(findCommand("@tack add to Q3 planning", NAMES)).toEqual({
			kind: "add",
			name: "tack",
			board: "Q3 planning",
			whole: "Q3 planning",
		});
		expect(findCommand("@tack add to Roadmap in Next up", NAMES)).toEqual({
			kind: "add",
			name: "tack",
			board: "Roadmap",
			section: "Next up",
			whole: "Roadmap in Next up",
		});
		// The last `in` splits; the whole is kept in case it's the board's name.
		expect(findCommand("@tack add this to Plans in 2026 into the Later section", NAMES)).toEqual({
			kind: "add",
			name: "tack",
			board: "Plans in 2026",
			section: "Later",
			whole: "Plans in 2026 into the Later section",
		});
		expect(findCommand('@tack add to "Plans in 2026" in “Next”', NAMES)).toMatchObject({
			board: "Plans in 2026",
			section: "Next",
		});
		expect(findCommand("@tack: please put it on roadmap. Thanks!", NAMES)).toMatchObject({
			kind: "add",
			board: "roadmap",
		});
		expect(findCommand("@tack add roadmap", NAMES)).toMatchObject({ board: "roadmap" });
		expect(
			findCommand("@tack add to https://tack.example.com/b/k3x9p2m7qr/roadmap", NAMES),
		).toMatchObject({ board: "https://tack.example.com/b/k3x9p2m7qr/roadmap" });
		expect(findCommand("@tack ?", NAMES)).toMatchObject({ kind: "help" });
		expect(findCommand("Hey @tack, help!", NAMES)).toMatchObject({ kind: "help" });
	});

	it("leaves mentions in passing alone", () => {
		for (const body of [
			"thanks @tack!",
			"@tack is great",
			"@tack add",
			"@tack helpful, isn't it",
			"email me at me@tack.dev add to roadmap",
			"@tack-acme-other add to roadmap",
			"@tackle add to roadmap",
			"",
		]) {
			expect(findCommand(body, NAMES)).toBeNull();
		}
	});

	it("ignores commands that are only quoted: replies, code and comments", () => {
		for (const body of [
			"> @tack add to roadmap\n\nI did this already",
			"```\n@tack add to roadmap\n```",
			"~~~md\n@tack add to roadmap\n~~~",
			"Try `@tack add to roadmap`",
			"    @tack add to roadmap",
			"<!-- @tack add to roadmap -->",
		]) {
			expect(findCommand(body, NAMES)).toBeNull();
		}
		// The first command that isn't quoted counts.
		expect(
			findCommand("> @tack add to old\n```\n@tack add to code\n```\n@tack add to new", NAMES),
		).toMatchObject({ board: "new" });
	});
});

const board = (id: string, title: string, extra: Partial<BoardCandidate> = {}) => ({
	id,
	slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
	title,
	archived: false,
	...extra,
});

describe("finding boards", () => {
	const boards = [
		board("a1", "Roadmap"),
		board("a2", "Roadmap 2025"),
		board("a3", "Q3 planning: unpic!"),
		board("a4", "Bug triage"),
		board("a5", "Old roadmap", { archived: true }),
		board("legacy", "Legacy board"),
	];

	it("finds a board by name, slug or link, exactly first", () => {
		expect(matchBoard("roadmap", boards)).toEqual({ kind: "found", value: boards[0] });
		expect(matchBoard("q3-planning-unpic", boards)).toMatchObject({ value: { id: "a3" } });
		expect(matchBoard("Q3 planning", boards)).toMatchObject({ value: { id: "a3" } });
		expect(matchBoard("triage", boards)).toMatchObject({ value: { id: "a4" } });
		expect(matchBoard("the bug triage board", boards)).toMatchObject({ value: { id: "a4" } });
		expect(matchBoard("bug traige", boards)).toMatchObject({ value: { id: "a4" } });
		expect(matchBoard("https://tack.example/b/a2/roadmap-2025", boards)).toMatchObject({
			value: { id: "a2" },
		});
		expect(matchBoard("/b/a4", boards)).toMatchObject({ value: { id: "a4" } });
		expect(matchBoard("legacy", boards)).toMatchObject({ value: { id: "legacy" } });
	});

	it("says when a name could be more than one board, or none", () => {
		expect(matchBoard("road", boards)).toEqual({
			kind: "ambiguous",
			values: [boards[0], boards[1]],
		});
		expect(matchBoard("nothing like it", boards)).toEqual({ kind: "none" });
		// A link to a board that isn't there isn't a name to guess from.
		expect(matchBoard("https://tack.example/b/zz/roadmap", boards)).toEqual({ kind: "none" });
	});

	it("only finds archived boards by link or their exact name, so the reply can say so", () => {
		expect(matchBoard("old road", boards)).toEqual({ kind: "none" });
		expect(matchBoard("old roadmap", boards)).toMatchObject({ value: { id: "a5" } });
		expect(matchBoard("https://tack.example/b/a5/old-roadmap", boards)).toMatchObject({
			value: { id: "a5" },
		});
	});

	it("scores names", () => {
		expect(nameScore("Roadmap", "roadmap")).toBe(100);
		expect(nameScore("road", "Roadmap 2025")).toBeGreaterThan(0);
		expect(nameScore("x", "Roadmap")).toBe(0);
	});
});

const ASKED = {
	via: "comment" as const,
	source: "https://github.com/acme/widgets/issues/12#issuecomment-1",
	by: "alice",
};
const KEY = "github.com/acme/widgets#12";

function cards(doc: Y.Doc) {
	return [...shapesMap(doc)]
		.map(([id, shape]) => ({ id, ...readShape(shape) }))
		.filter((shape) => shape.type === "card");
}

function overlapsAnything(doc: Y.Doc, id: string): boolean {
	const shapes = readShapes(doc);
	const shape = shapes.get(id);
	if (!shape) throw new Error(`no ${id}`);
	const box = boxOf(id, shape);
	return [...shapes].some(
		([other, s]) => other !== id && s.type !== "section" && intersects(box, boxOf(other, s)),
	);
}

describe("placing the card", () => {
	it("puts it beside everything on the board, then gathers the next below it", () => {
		const doc = new Y.Doc();
		addShape(doc, "sticky", { type: "sticky", text: "hi", x: 0, y: 0, z: "a0", color: "pink" });
		const origins: unknown[] = [];
		doc.on("afterTransaction", (t: Y.Transaction) => origins.push(t.origin));
		const first = placeCommandCard(doc, { key: KEY, provenance: ASKED }, "command");
		expect(first).toMatchObject({ status: "added", section: null, full: false });
		expect(origins).toEqual(["command"]);
		const [placed] = cards(doc);
		expect(placed).toMatchObject({ ref: KEY });
		expect(provenanceOf(placed)).toEqual(ASKED);
		expect(placed!.x).toBeGreaterThan(200);
		expect(overlapsAnything(doc, placed!.id)).toBe(false);

		const second = placeCommandCard(
			doc,
			{ key: "github.com/acme/widgets#13", provenance: ASKED },
			"command",
		);
		const next = cards(doc).find((c) => c.ref?.endsWith("#13"));
		expect(second.status).toBe("added");
		expect(next!.x).toBe(placed!.x);
		expect(next!.y).toBeGreaterThan(placed!.y);
		expect(overlapsAnything(doc, next!.id)).toBe(false);
	});

	it("puts it on an empty board at the origin", () => {
		const doc = new Y.Doc();
		placeCommandCard(doc, { key: KEY, provenance: ASKED }, null);
		expect(cards(doc)[0]).toMatchObject({ x: 0, y: 0 });
	});

	it("puts it in the section it names, or just below if it's full", () => {
		const doc = new Y.Doc();
		addShape(doc, "next", {
			type: "section",
			title: "Next up",
			x: 0,
			y: 0,
			w: 320,
			h: 220,
			z: "a0",
		});
		addShape(doc, "later", {
			type: "section",
			title: "Later",
			x: 400,
			y: 0,
			w: 300,
			h: 200,
			z: "a1",
		});
		expect(
			placeCommandCard(doc, { key: KEY, section: "next", provenance: ASKED }, null),
		).toMatchObject({
			status: "added",
			section: { id: "next", title: "Next up" },
			full: false,
		});
		expect(cards(doc)[0]).toMatchObject({ parent: "next" });

		const full = placeCommandCard(
			doc,
			{ key: "github.com/acme/widgets#13", section: "Next up", provenance: ASKED },
			null,
		);
		expect(full).toMatchObject({ status: "added", full: true });
		const below = cards(doc).find((c) => c.ref?.endsWith("#13"));
		expect(below!.y).toBeGreaterThanOrEqual(220);
	});

	it("never adds what's already there, and says when a section isn't", () => {
		const doc = new Y.Doc();
		addCardShape(doc, "mine", { ref: KEY, x: 0, y: 0 });
		addShape(doc, "s1", { type: "section", title: "Next up", x: 400, y: 0, z: "a1" });
		addShape(doc, "s2", { type: "section", title: "Next week", x: 900, y: 0, z: "a2" });
		expect(placeCommandCard(doc, { key: KEY, provenance: ASKED }, null)).toEqual({
			status: "already",
			shape: "mine",
		});
		const other = "github.com/acme/widgets#2";
		expect(placeCommandCard(doc, { key: other, section: "Done", provenance: ASKED }, null)).toEqual(
			{
				status: "no_section",
				sections: ["Next up", "Next week"],
			},
		);
		expect(placeCommandCard(doc, { key: other, section: "next", provenance: ASKED }, null)).toEqual(
			{
				status: "ambiguous_section",
				sections: ["Next up", "Next week"],
			},
		);
		expect(cards(doc)).toHaveLength(1);
	});
});

const PUBLIC = { title: "Roadmap", url: "https://tack.example/b/a1/roadmap", public: true };
const PRIVATE = { title: "Acquisition plans", url: "https://tack.example/b/a9/x", public: false };

describe("replies", () => {
	it("links to the board it added to", () => {
		expect(commandReply({ kind: "added", board: PUBLIC, item: "issue" })).toBe(
			"📌 Added this issue to [**Roadmap**](https://tack.example/b/a1/roadmap).",
		);
		expect(
			commandReply({ kind: "added", board: PUBLIC, item: "pull", section: "Next up", full: true }),
		).toBe(
			"📌 Added this pull request to [**Roadmap**](https://tack.example/b/a1/roadmap) in “Next up”. It was full, so this is just below it.",
		);
		expect(commandReply({ kind: "help", name: "tack-acme", item: "issue" })).toContain(
			"`@tack-acme add to <board> in <section>`",
		);
	});

	it("never names a board that isn't public unless the person asking did", () => {
		const ambiguous = commandReply({
			kind: "ambiguous",
			query: "plans",
			boards: [PUBLIC, PRIVATE],
		});
		expect(ambiguous).toContain("[**Roadmap**]");
		expect(ambiguous).not.toContain("Acquisition");
		expect(ambiguous).toContain("1 more that isn't public");
		const none = commandReply({ kind: "ambiguous", query: "plans", boards: [PRIVATE, PRIVATE] });
		expect(none).not.toContain("Acquisition");
		expect(none).toContain("2 of them, none public");
		const section = commandReply({
			kind: "no_section",
			board: PRIVATE,
			query: "acq",
			section: "Secret",
			sections: ["Targets"],
		});
		expect(section).toContain("“acq”");
		expect(section).not.toMatch(/Acquisition|Targets/);
		expect(
			commandReply({
				kind: "no_section",
				board: PUBLIC,
				query: "road",
				section: "Done",
				sections: ["Next up"],
			}),
		).toContain("Its sections: “Next up”.");
	});

	it("can't be made to mention people or make links", () => {
		const text = quote("@octocat [click](https://evil.example) *bold*");
		expect(text).not.toContain("@octocat");
		expect(text).not.toMatch(/\]\(|https:\/\//);
		expect(commandReply({ kind: "not_found", query: "@everyone" })).not.toContain("@everyone");
	});
});
