import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { copyShapes, pasteShapes } from "../src/client/clipboard.ts";
import { History, transactLocal } from "../src/client/undo.ts";
import { addShape, nextZ, readShape, shapesMap } from "../src/shared/shapes.ts";
import {
	addConnector,
	addSection,
	commitMoves,
	copyClosure,
	removeShapes,
	settlePasted,
} from "../src/shared/structure.ts";

// Sections and connectors with the board's undo history and clipboard.

function board() {
	const doc = new Y.Doc();
	const history = new History(doc);
	const sticky = (id: string, x: number, y: number) =>
		addShape(doc, id, { type: "sticky", text: id, x, y, z: nextZ(doc), parent: null });
	const get = (id: string) => {
		const shape = shapesMap(doc).get(id);
		return shape ? readShape(shape) : undefined;
	};
	return { doc, history, sticky, get };
}

describe("undo", () => {
	it("undoes a section move, with its contents, in one step", () => {
		const { doc, history, sticky, get } = board();
		sticky("a", 100, 100);
		sticky("b", 300, 100);
		const id = addSection(doc, { x: 0, y: 0, w: 600, h: 400 });

		transactLocal(doc, () => commitMoves(doc, new Map([[id, { x: 500, y: 200 }]])));
		expect(get("a")).toMatchObject({ x: 600, y: 300 });

		expect(history.undo()).toBe(true);
		expect(get(id)).toMatchObject({ x: 0, y: 0 });
		expect(get("a")).toMatchObject({ x: 100, y: 100, parent: id });
		expect(get("b")).toMatchObject({ x: 300, y: 100, parent: id });
		expect(history.canUndo()).toBe(false);
	});

	it("undoes deleting a section, bringing back its contents and connections", () => {
		const { doc, history, sticky, get } = board();
		sticky("in", 100, 100);
		sticky("out", 900, 100);
		const id = addSection(doc, { x: 0, y: 0, w: 600, h: 400 });
		const line = addConnector(doc, {
			from: { x: 276, y: 188, shape: "in", anchor: { x: 1, y: 0.5 } },
			to: { x: 900, y: 188, shape: "out" },
		});

		transactLocal(doc, () => removeShapes(doc, [id]));
		expect(get("in")).toBeUndefined();
		expect(get(line)?.from).toEqual({ x: 276, y: 188 });

		history.undo();
		expect(get(id)).toBeDefined();
		expect(get("in")?.parent).toBe(id);
		expect(get(line)?.from).toMatchObject({ shape: "in" });
	});
});

describe("copy and paste", () => {
	it("copies a section with its contents and the connectors between them", () => {
		const { doc, sticky } = board();
		sticky("a", 100, 100);
		sticky("b", 300, 100);
		sticky("outside", 900, 100);
		const id = addSection(doc, { x: 0, y: 0, w: 600, h: 400 });
		const inner = addConnector(doc, {
			from: { x: 0, y: 0, shape: "a" },
			to: { x: 0, y: 0, shape: "b" },
		});
		const leading = addConnector(doc, {
			from: { x: 0, y: 0, shape: "a" },
			to: { x: 0, y: 0, shape: "outside" },
		});
		const copied = new Set(copyClosure(doc, [id]));
		expect(copied).toEqual(new Set([id, "a", "b", inner]));
		expect(copied.has(leading)).toBe(false);
	});

	it("points pasted shapes at the copies, and lets go of shapes left behind", () => {
		const { doc, sticky, get } = board();
		sticky("a", 100, 100);
		sticky("outside", 900, 100);
		const id = addSection(doc, { x: 0, y: 0, w: 600, h: 400 });
		addConnector(
			doc,
			{
				from: { x: 276, y: 188, shape: "a" },
				to: { x: 900, y: 188, shape: "outside" },
			},
			"line",
		);
		addConnector(doc, { from: { x: 10, y: 10 }, to: { x: 50, y: 50 } }, "free");

		const offset = { x: 1000, y: 0 };
		const payload = copyShapes(doc, [id, "a", "line", "free"]);
		const pasted = transactLocal(doc, () => {
			const ids = pasteShapes(doc, payload, offset);
			settlePasted(doc, ids, offset);
			return ids;
		});
		const copyOf = new Map(payload.shapes.map((shape, i) => [shape.id, pasted[i] as string]));
		const sectionId = copyOf.get(id);
		const aId = copyOf.get("a");
		const [section, a, line, free] = [id, "a", "line", "free"].map((original) =>
			get(copyOf.get(original) ?? ""),
		);
		expect(section).toMatchObject({ type: "section", x: 1000, parent: null });
		expect(a).toMatchObject({ x: 1100, parent: sectionId });
		// The end on the copied sticky follows the copy; the other lets go.
		expect(line?.from).toEqual({ x: 1276, y: 188, shape: aId });
		expect(line?.to).toEqual({ x: 1900, y: 188 });
		expect(free?.from).toEqual({ x: 1010, y: 10 });
	});

	it("puts pasted shapes in whichever section they land in", () => {
		const { doc, sticky, get } = board();
		const id = addSection(doc, { x: 1000, y: 0, w: 600, h: 400 });
		sticky("a", 100, 100);
		const offset = { x: 1000, y: 0 };
		const [copy] = transactLocal(doc, () => {
			const ids = pasteShapes(doc, copyShapes(doc, ["a"]), offset);
			settlePasted(doc, ids, offset);
			return ids;
		});
		expect(get(copy ?? "")?.parent).toBe(id);
	});
});
