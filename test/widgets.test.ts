import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { repairBoard } from "../src/shared/repair.ts";
import { boxOf } from "../src/shared/sections.ts";
import { addShape, readShape, shapesMap } from "../src/shared/shapes.ts";
import { addSection, commitMoves, resizeWidget } from "../src/shared/structure.ts";
import {
	addWidget,
	listConfig,
	listWidget,
	queryScope,
	readConfig,
	updateWidgetConfig,
	widgetDefinition,
	widgetQueries,
} from "../src/shared/widgetRegistry.ts";

describe("the widget registry", () => {
	it("knows its kinds, and nothing else", () => {
		expect(widgetDefinition("list")).toBe(listWidget);
		for (const kind of ["timeline", "release", "dependencies"]) {
			expect(widgetDefinition(kind)?.kind).toBe(kind);
		}
		expect(widgetDefinition("toString")).toBeNull();
		expect(widgetDefinition(undefined)).toBeNull();
	});

	it("reads configs with defaults for anything missing or malformed", () => {
		expect(readConfig(listWidget, undefined)).toEqual(listWidget.defaults);
		expect(readConfig(listWidget, "nonsense")).toEqual(listWidget.defaults);
		expect(
			readConfig(listWidget, { q: "is:open", limit: 1000, sort: "sideways", extra: true }),
		).toEqual({ ...listWidget.defaults, q: "is:open" });
		expect(listConfig({ config: { title: "Bugs", q: "label:bug", limit: 10 } })).toMatchObject({
			title: "Bugs",
			limit: 10,
		});
	});

	it("works out a list's search, and none until it has one", () => {
		expect(widgetQueries({ widget: "list", config: { q: "  " } })).toEqual({});
		expect(
			widgetQueries({ widget: "list", config: { q: "repo:acme/widgets is:open ", limit: 20 } }),
		).toEqual({
			items: {
				kind: "search",
				host: "github.com",
				q: "repo:acme/widgets is:open",
				sort: "updated",
				order: "desc",
				limit: 20,
			},
		});
		expect(widgetQueries({ widget: "mystery", config: {} })).toEqual({});
	});

	it("scopes queries to the repositories and owners they read", () => {
		expect(
			queryScope({ kind: "search", host: "github.com", q: "repo:Acme/Widgets org:emdash" }),
		).toEqual({ repos: ["github.com/acme/widgets"], owners: ["github.com/emdash"] });
		expect(queryScope({ kind: "related", key: "github.com/acme/widgets#4" })).toEqual({
			repos: ["github.com/acme/widgets"],
			owners: [],
		});
	});
});

describe("widget shapes", () => {
	it("are added at their kind's size, and sized by w and h", () => {
		const doc = new Y.Doc();
		const id = addWidget(doc, "list", { x: 10.4, y: 20 }, { q: "is:open" });
		const shape = readShape(shapesMap(doc).get(id) as Y.Map<unknown>);
		expect(shape).toMatchObject({ type: "widget", widget: "list", x: 10, w: 360, h: 440 });
		expect(boxOf(id, shape)).toEqual({ x: 10, y: 20, w: 360, h: 440 });
	});

	it("resize to at least their minimum, and join the section they land in", () => {
		const doc = new Y.Doc();
		const section = addSection(doc, { x: 0, y: 0, w: 2000, h: 2000 });
		const id = addWidget(doc, "list", { x: 3000, y: 3000 });
		resizeWidget(doc, id, { x: 100, y: 100, w: 10, h: 900 });
		const shape = readShape(shapesMap(doc).get(id) as Y.Map<unknown>);
		expect(shape).toMatchObject({ x: 100, y: 100, w: 260, h: 900, parent: section });
	});

	it("move like any other shape", () => {
		const doc = new Y.Doc();
		const id = addWidget(doc, "list", { x: 0, y: 0 });
		commitMoves(doc, new Map([[id, { x: 50, y: 60 }]]));
		expect(readShape(shapesMap(doc).get(id) as Y.Map<unknown>)).toMatchObject({ x: 50, y: 60 });
	});

	it("update only the config fields that change", () => {
		const doc = new Y.Doc();
		const id = addWidget(doc, "list", { x: 0, y: 0 }, { q: "is:open", title: "" });
		let writes = 0;
		shapesMap(doc).observeDeep(() => writes++);
		updateWidgetConfig(doc, id, { q: "is:open" });
		expect(writes).toBe(0);
		updateWidgetConfig(doc, id, { title: "Open" });
		expect(readShape(shapesMap(doc).get(id) as Y.Map<unknown>).config).toEqual({
			q: "is:open",
			title: "Open",
		});
	});

	it("are repaired when their size or config is unusable", () => {
		const doc = new Y.Doc();
		addShape(doc, "w", { type: "widget", widget: "list", x: 0, y: 0, z: "a0", config: "x" });
		shapesMap(doc).get("w")?.set("w", "wide");
		expect(repairBoard(doc).widgets).toBe(1);
		const shape = readShape(shapesMap(doc).get("w") as Y.Map<unknown>);
		expect(shape).toMatchObject({ w: 360, h: 440, config: listWidget.defaults });
		expect(repairBoard(doc).widgets).toBe(0);
	});

	it("of unknown kinds keep their config for the Tack that knows them", () => {
		const doc = new Y.Doc();
		addShape(doc, "w", { type: "widget", widget: "future", x: 0, y: 0, z: "a0", w: 300, h: 300 });
		expect(repairBoard(doc).widgets).toBe(0);
	});
});
