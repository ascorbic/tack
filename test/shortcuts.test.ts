import { describe, expect, it } from "vite-plus/test";
import {
	type KeyInput,
	SHORTCUTS,
	formatCombo,
	matchShortcut,
	sheetShortcuts,
	shortcutHint,
	shortcutKeys,
	toolShortcuts,
} from "../src/client/shortcuts.ts";

const press = (key: string, extra: Partial<KeyInput> = {}): KeyInput => ({
	key,
	code: extra.code ?? (key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key),
	metaKey: false,
	ctrlKey: false,
	altKey: false,
	shiftKey: false,
	...extra,
});

const id = (input: KeyInput, apple = true) => matchShortcut(input, apple)?.id;

describe("matchShortcut", () => {
	it("uses ⌘ on Apple platforms and Ctrl elsewhere", () => {
		expect(id(press("z", { metaKey: true }), true)).toBe("undo");
		expect(id(press("z", { ctrlKey: true }), true)).toBeUndefined();
		expect(id(press("z", { ctrlKey: true }), false)).toBe("undo");
		expect(id(press("z", { metaKey: true }), false)).toBeUndefined();
	});

	it("tells undo from redo by Shift", () => {
		expect(id(press("Z", { metaKey: true, shiftKey: true }))).toBe("redo");
		expect(id(press("y", { ctrlKey: true }), false)).toBe("redo");
	});

	it("doesn't fire plain-key shortcuts with a modifier held", () => {
		expect(id(press("Escape"))).toBe("deselect");
		expect(id(press("Escape", { metaKey: true }))).toBeUndefined();
		expect(id(press("ArrowLeft", { altKey: true }))).toBeUndefined();
	});

	it("nudges by 1, or 10 with Shift", () => {
		expect(id(press("ArrowLeft"))).toBe("nudgeLeft");
		expect(id(press("ArrowDown", { shiftKey: true }))).toBe("nudgeDownFar");
	});

	it("matches ⌥ shortcuts by physical key, since ⌥ changes the character", () => {
		expect(id(press("å", { code: "KeyA", altKey: true }))).toBe("alignLeft");
		expect(id(press("˙", { code: "KeyH", altKey: true, shiftKey: true }))).toBe(
			"distributeHorizontal",
		);
		expect(id(press("†", { code: "KeyT", altKey: true, ctrlKey: true }))).toBe("tidy");
		expect(id(press("t", { code: "KeyT", altKey: true, ctrlKey: true }), false)).toBe("tidy");
	});

	it("handles shifted characters on any layout", () => {
		expect(id(press("?", { code: "Slash", shiftKey: true }))).toBe("shortcuts");
		expect(id(press("!", { code: "Digit1", shiftKey: true }))).toBe("zoomToFit");
		expect(id(press("+", { code: "Equal", shiftKey: true, metaKey: true }))).toBe("zoomIn");
		expect(id(press("=", { code: "Equal", metaKey: true }))).toBe("zoomIn");
		expect(id(press("-", { code: "Minus" }))).toBe("zoomOut");
	});

	it("leaves letters without modifiers to the tools and stickies", () => {
		for (const key of "vhscdxat") expect(id(press(key))).toBeUndefined();
	});
});

describe("formatting", () => {
	it("formats keycaps for each platform", () => {
		expect(formatCombo({ key: "z", mod: true, shift: true }, true)).toEqual(["⇧", "⌘", "Z"]);
		expect(formatCombo({ key: "z", mod: true, shift: true }, false)).toEqual([
			"Shift",
			"Ctrl",
			"Z",
		]);
		expect(formatCombo({ code: "KeyT", ctrl: true, alt: true }, true)).toEqual(["⌃", "⌥", "T"]);
		expect(formatCombo({ code: "Digit1", shift: true }, false)).toEqual(["Shift", "1"]);
		expect(formatCombo({ key: "ArrowLeft" }, true)).toEqual(["←"]);
	});

	it("gives compact hints", () => {
		expect(shortcutHint("undo", true)).toBe("⌘Z");
		expect(shortcutHint("undo", false)).toBe("Ctrl+Z");
		expect(shortcutHint("nothing", true)).toBe("");
	});

	it("lists only the combos that apply on this platform", () => {
		const redo = SHORTCUTS.find((s) => s.id === "redo");
		expect(redo && shortcutKeys(redo, true)).toEqual([["⇧", "⌘", "Z"]]);
		expect(redo && shortcutKeys(redo, false)).toEqual([
			["Shift", "Ctrl", "Z"],
			["Ctrl", "Y"],
		]);
		const zoomIn = SHORTCUTS.find((s) => s.id === "zoomIn");
		expect(zoomIn && shortcutKeys(zoomIn, true)).toEqual([["⌘", "+"]]);
	});
});

describe("the sheet", () => {
	const all = [...toolShortcuts({ v: "select", s: "sticky", f: "frame" }), ...SHORTCUTS];

	it("lists tools from the toolbar, including ones it doesn't know", () => {
		const tools = sheetShortcuts(all, "", true).find((s) => s.group === "Tools");
		expect(tools?.shortcuts.map((s) => s.label)).toEqual(["Select", "Sticky note", "Frame"]);
	});

	it("shows one nudge entry, not one per arrow", () => {
		const labels = sheetShortcuts(all, "nudge", true).flatMap((s) =>
			s.shortcuts.map((x) => x.label),
		);
		expect(labels).toEqual(["Nudge", "Nudge 10px"]);
	});

	it("searches labels, keys and the words for symbols", () => {
		const labels = (query: string, apple = true) =>
			sheetShortcuts(all, query, apple).flatMap((s) => s.shortcuts.map((x) => x.label));
		expect(labels("undo")).toEqual(["Undo"]);
		expect(labels("zoom fit")).toEqual(["Zoom to fit"]);
		expect(labels("cmd d")).toContain("Duplicate");
		expect(labels("⌘D")).toEqual([]);
		expect(labels("option a")).toContain("Align left");
		expect(labels("arrange")).toContain("Tidy up");
		expect(labels("xyzzy")).toEqual([]);
	});

	it("keeps the groups in order", () => {
		expect(sheetShortcuts(all, "", true).map((s) => s.group)).toEqual([
			"Tools",
			"Edit",
			"Selection",
			"Arrange",
			"View",
			"Help",
		]);
	});
});
