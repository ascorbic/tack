import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { stageChange } from "../src/shared/changes.ts";
import { creditLine, isBoardUrl, withCredit } from "../src/shared/credit.ts";
import { listChanges } from "../src/shared/changes.ts";
import { addShape } from "../src/shared/shapes.ts";

// Credit lines on new issues: where they came from on the board, and whose
// sticky they were.

const REPO = "github.com/emdash-cms/emdash";
const BOARD = { url: "https://tack.example.com/b/abc123/planning", title: "EmDash planning" };
const by = { login: "matt", name: "Matt" };

function board() {
	const doc = new Y.Doc();
	addShape(doc, "sec", {
		type: "section",
		title: "Plugin API",
		x: 0,
		y: 0,
		w: 600,
		h: 400,
		z: "a0",
	});
	addShape(doc, "s1", {
		type: "sticky",
		text: "Typed hooks",
		x: 20,
		y: 20,
		z: "a1",
		parent: "sec",
		author: { name: "Priya", color: "pink", login: "priya" },
	});
	addShape(doc, "s2", {
		type: "sticky",
		text: "Loose idea",
		x: 900,
		y: 0,
		z: "a2",
		author: { name: "Guest *Bee*", color: "blue" },
	});
	return doc;
}

describe("credit lines", () => {
	it("credits a sticky's author and names its section", () => {
		const doc = board();
		stageChange(doc, { kind: "issue.create", repo: REPO, title: "Typed hooks" }, by, {
			shapes: ["s1"],
			effect: { kind: "replace", shapes: ["s1"] },
		});
		const [change] = listChanges(doc);
		const line = creditLine(doc, change!, BOARD);
		expect(line).toBe(
			"<sub>From [EmDash planning](https://tack.example.com/b/abc123/planning) › Plugin API, an idea by @priya</sub>",
		);
		expect(withCredit(change!.op, line)).toMatchObject({ body: line });
		expect(withCredit({ ...change!.op, body: "More" } as never, line)).toMatchObject({
			body: `More\n\n${line}`,
		});
	});

	it("names signed-out authors without letting their name be markup", () => {
		const doc = board();
		stageChange(doc, { kind: "issue.create", repo: REPO, title: "Loose idea" }, by, {
			shapes: ["s2"],
			effect: { kind: "replace", shapes: ["s2"] },
		});
		expect(creditLine(doc, listChanges(doc)[0]!, BOARD)).toBe(
			"<sub>From [EmDash planning](https://tack.example.com/b/abc123/planning), an idea by Guest \\*Bee\\*</sub>",
		);
	});

	it("names the section a parent issue was made from, and nothing for other changes", () => {
		const doc = board();
		stageChange(doc, { kind: "issue.create", repo: REPO, title: "Plugin API" }, by, {
			shapes: ["sec"],
			effect: { kind: "place", near: ["sec"] },
		});
		stageChange(doc, { kind: "item.comment", target: { key: `${REPO}#1` }, body: "Hi" }, by);
		const [parent, comment] = listChanges(doc);
		expect(creditLine(doc, parent!, BOARD)).toBe(
			"<sub>From [EmDash planning](https://tack.example.com/b/abc123/planning) › Plugin API</sub>",
		);
		expect(creditLine(doc, comment!, BOARD)).toBeNull();
	});

	it("only links to this board on this instance", () => {
		const origin = "https://tack.example.com";
		expect(isBoardUrl(BOARD.url, origin, "abc123")).toBe(true);
		expect(isBoardUrl("https://tack.example.com/b/abc123", origin, "abc123")).toBe(true);
		expect(isBoardUrl("https://evil.example/b/abc123/x", origin, "abc123")).toBe(false);
		expect(isBoardUrl("https://tack.example.com/b/other/x", origin, "abc123")).toBe(false);
		expect(isBoardUrl("https://tack.example.com/b/abc123/x?y=1", origin, "abc123")).toBe(false);
		expect(isBoardUrl("https://tack.example.com/b/abc123/x)](javascript:1", origin, "abc123")).toBe(
			false,
		);
		expect(isBoardUrl("not a url", origin, "abc123")).toBe(false);
	});
});
