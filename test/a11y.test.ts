import { describe, expect, it } from "vite-plus/test";
import {
	type Placed,
	boardOrder,
	countWords,
	describeBoard,
	describeShape,
	itemFromKey,
	nearestInDirection,
} from "../src/shared/a11y.ts";

// The board for keyboards and screen readers (#61): reading order, moving
// with the arrow keys, and shapes and boards in words.

const shape = (id: string, x: number, y: number, extra: Partial<Placed> = {}): Placed => ({
	id,
	type: "sticky",
	parent: null,
	x,
	y,
	w: 100,
	h: 100,
	...extra,
});

describe("reading order", () => {
	it("reads the top level in rows, top to bottom, each left to right", () => {
		const shapes = [
			shape("c", 0, 300),
			shape("b", 220, 10),
			shape("a", 0, 0),
			shape("d", 220, 300),
		];
		expect(boardOrder(shapes)).toEqual(["a", "b", "c", "d"]);
	});

	it("follows a section with what's in it, nested sections too", () => {
		const shapes = [
			shape("loose", 900, 0),
			shape("s", 0, 0, { type: "section", w: 800, h: 600 }),
			shape("in-2", 300, 100, { parent: "s" }),
			shape("in-1", 50, 100, { parent: "s" }),
			shape("inner", 50, 300, { type: "section", parent: "s", w: 400, h: 200 }),
			shape("deep", 80, 350, { parent: "inner" }),
		];
		expect(boardOrder(shapes)).toEqual(["s", "in-1", "in-2", "inner", "deep", "loose"]);
	});

	it("takes a list's own order for a section showing one", () => {
		const shapes = [
			shape("s", 0, 0, { type: "section", w: 400, h: 400 }),
			shape("a", 10, 10, { parent: "s" }),
			shape("b", 10, 200, { parent: "s" }),
		];
		expect(boardOrder(shapes, (section) => (section === "s" ? ["b", "a"] : undefined))).toEqual([
			"s",
			"b",
			"a",
		]);
	});

	it("treats shapes whose section has gone as top level, and never loses one", () => {
		const shapes = [
			shape("orphan", 0, 0, { parent: "gone" }),
			shape("x", 0, 500, { type: "section", parent: "y" }),
			shape("y", 300, 500, { type: "section", parent: "x" }),
		];
		expect(boardOrder(shapes).sort()).toEqual(["orphan", "x", "y"]);
		expect(boardOrder(shapes)[0]).toBe("orphan");
	});
});

describe("the arrow keys", () => {
	const row = [shape("a", 0, 0), shape("b", 200, 0), shape("c", 400, 0), shape("below", 0, 200)];

	it("moves to the nearest shape that way, preferring ones in line", () => {
		expect(nearestInDirection(row[0]!, row, "right")).toBe("b");
		expect(nearestInDirection(row[1]!, row, "left")).toBe("a");
		expect(nearestInDirection(row[0]!, row, "down")).toBe("below");
		expect(nearestInDirection(row[0]!, row, "up")).toBeNull();
		// A shape far along but in line beats one close by but well off to the side.
		const shapes = [shape("from", 0, 0), shape("off", 150, 260), shape("inline", 500, 20)];
		expect(nearestInDirection(shapes[0]!, shapes, "right")).toBe("inline");
		// Right means right: not the one just below, a little to the right.
		const grid = [shape("from", 0, 0), shape("under", 12, 130), shape("beside", 220, 8)];
		expect(nearestInDirection(grid[0]!, grid, "right")).toBe("beside");
		expect(nearestInDirection(grid[0]!, grid, "down")).toBe("under");
	});

	it("stays in the section first, then leaves it for the nearest thing that way", () => {
		const shapes = [
			shape("s", 0, 0, { type: "section", w: 700, h: 300 }),
			shape("one", 20, 50, { parent: "s" }),
			shape("two", 300, 50, { parent: "s" }),
			shape("outside", 800, 50),
		];
		const [, one, two] = shapes;
		expect(nearestInDirection(one!, shapes, "right")).toBe("two");
		// Never to the section it's in, nor into a section from it.
		expect(nearestInDirection(two!, shapes, "right")).toBe("outside");
		expect(nearestInDirection(two!, shapes, "left")).toBe("one");
		expect(nearestInDirection(shapes[0]!, shapes, "right")).toBe("outside");
	});
});

describe("shapes in words", () => {
	const context = {
		sectionTitle: (id: string) => (id === "s" ? "Went well" : undefined),
		card: (key: string) =>
			key === "github.com/acme/imagekit#412"
				? {
						item: "#412",
						repo: "imagekit",
						title: "Netlify ignores quality",
						state: "open" as const,
						kind: "issue" as const,
					}
				: key === "github.com/acme/imagekit#9"
					? { missing: true }
					: undefined,
		contents: () => ["sticky", "sticky", "card"] as const,
		widgetName: (kind: string) => (kind === "list" ? "List" : undefined),
	};

	it("says a sticky's words, who wrote it and where it is", () => {
		expect(
			describeShape(
				"1",
				{
					type: "sticky",
					text: "Ship\nthe docs",
					author: { name: "Kai", color: "#000" },
					parent: "s",
				},
				context,
			),
		).toBe("Ship the docs, by Kai, in Went well");
		expect(describeShape("1", { type: "sticky" })).toBe("empty");
	});

	it("never says a face-down sticky's words, unless they're yours", () => {
		const faceDown = {
			type: "sticky" as const,
			silent: "session",
			author: { name: "Kai", color: "" },
		};
		expect(describeShape("1", faceDown)).toBe("face down, by Kai");
		expect(describeShape("1", faceDown, { hiddenText: () => "my idea" })).toBe(
			"my idea, hidden until it’s revealed, by Kai",
		);
	});

	it("says a card's item, title and state, or what it knows", () => {
		expect(describeShape("1", { type: "card", ref: "github.com/acme/imagekit#412" }, context)).toBe(
			"imagekit #412: Netlify ignores quality, open issue",
		);
		expect(describeShape("1", { type: "card", ref: "github.com/acme/imagekit#7" }, context)).toBe(
			"imagekit #7",
		);
		expect(describeShape("1", { type: "card", ref: "github.com/acme/imagekit#9" }, context)).toBe(
			"imagekit #9, couldn’t be loaded",
		);
		expect(itemFromKey("gitlab.com/group/sub/project!12")).toEqual({
			repo: "project",
			item: "!12",
		});
	});

	it("says what's in a section, and names widgets, decisions and action items", () => {
		expect(describeShape("s", { type: "section", title: "Went well" }, context)).toBe(
			"Went well, 2 sticky notes and 1 card",
		);
		expect(describeShape("s", { type: "section" }, { contents: () => [] })).toBe("untitled, empty");
		expect(
			describeShape(
				"w",
				{ type: "widget", widget: "list", config: { title: "Open bugs" } },
				context,
			),
		).toBe("Open bugs, list");
		expect(describeShape("d", { type: "decision", title: "Use AVIF" })).toBe("Use AVIF, proposed");
		expect(
			describeShape("a", {
				type: "action",
				text: "Write notes",
				done: "2026-10-01",
				owner: { login: "kai" },
				due: "2026-10-09",
			}),
		).toBe("Write notes, done, for @kai, due 2026-10-09");
	});
});

describe("a board in words", () => {
	it("counts what's there, then says each section and what's outside them", () => {
		const board = [
			{ id: "s1", type: "section" as const, parent: null, title: "Went well", x: 0, y: 0 },
			{ id: "s2", type: "section" as const, parent: null, title: "", x: 900, y: 0 },
			{ id: "a", type: "sticky" as const, parent: "s1", x: 10, y: 10 },
			{ id: "b", type: "sticky" as const, parent: "s1", x: 10, y: 10 },
			{ id: "c", type: "card" as const, parent: null, x: 10, y: 900 },
		];
		expect(describeBoard(board)).toBe(
			"2 sections, 2 sticky notes and 1 card. Went well: 2 sticky notes. Untitled section: empty. Outside any section: 1 card.",
		);
		expect(describeBoard([])).toBe("The board is empty.");
	});

	it("names a dozen sections at most", () => {
		const sections = Array.from({ length: 15 }, (_, i) => ({
			id: `s${i}`,
			type: "section" as const,
			parent: null,
			title: `S${i}`,
			x: i * 500,
			y: 0,
		}));
		expect(describeBoard(sections)).toMatch(/S11: empty\. And 3 more sections\.$/);
	});

	it("counts in words", () => {
		expect(countWords(["sticky", "card", "sticky", "action"])).toBe(
			"2 sticky notes, 1 card and 1 action item",
		);
		expect(countWords([])).toBe("nothing");
	});
});
