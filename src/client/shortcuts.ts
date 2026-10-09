// Keyboard shortcuts: one list that drives both the key handling and the
// shortcut sheet, so the sheet can never drift from what the keys do.

/**
 * A key combination. `mod` is ⌘ on Apple platforms and Ctrl elsewhere;
 * `ctrl` is the Control key itself. `mod`, `ctrl` and `alt` must match
 * exactly. `shift` is ignored when unset, since characters like `?` and `+`
 * need it on some layouts.
 */
export interface KeyCombo {
	/** `KeyboardEvent.key`, compared case-insensitively. */
	key?: string;
	/** `KeyboardEvent.code`, for combinations where the key varies (⌥ and digits). */
	code?: string;
	mod?: boolean;
	ctrl?: boolean;
	alt?: boolean;
	shift?: boolean;
}

export type ShortcutGroup = "Tools" | "Edit" | "Selection" | "Arrange" | "View" | "People" | "Help";

export const GROUPS: ShortcutGroup[] = [
	"Tools",
	"Edit",
	"Selection",
	"Arrange",
	"View",
	"People",
	"Help",
];

export interface Shortcut {
	id: string;
	label: string;
	group: ShortcutGroup;
	combos: KeyCombo[];
	/** Shown in the sheet instead of `combos`, for gestures like Shift-click. */
	display?: string[][];
	/** Extra words to match when searching. */
	keywords?: string;
}

/** The subset of a KeyboardEvent that shortcuts look at. */
export interface KeyInput {
	key: string;
	code: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
}

export type CommandId =
	| "undo"
	| "redo"
	| "copy"
	| "cut"
	| "paste"
	| "duplicate"
	| "delete"
	| "selectAll"
	| "deselect"
	| "nudgeLeft"
	| "nudgeRight"
	| "nudgeUp"
	| "nudgeDown"
	| "nudgeLeftFar"
	| "nudgeRightFar"
	| "nudgeUpFar"
	| "nudgeDownFar"
	| "alignLeft"
	| "alignCenter"
	| "alignRight"
	| "alignTop"
	| "alignMiddle"
	| "alignBottom"
	| "distributeHorizontal"
	| "distributeVertical"
	| "tidy"
	| "zoomIn"
	| "zoomOut"
	| "zoomToFit"
	| "zoomTo100"
	| "zoomToSelection"
	| "shortcuts";

const arrow = (key: string, shift: boolean): KeyCombo[] => [{ key, shift }];

/** Every shortcut except tools, which come from the toolbar (see toolShortcuts). */
export const SHORTCUTS: Shortcut[] = [
	{ id: "undo", label: "Undo", group: "Edit", combos: [{ key: "z", mod: true, shift: false }] },
	{
		id: "redo",
		label: "Redo",
		group: "Edit",
		combos: [
			{ key: "z", mod: true, shift: true },
			{ key: "y", ctrl: true, shift: false },
		],
	},
	{ id: "copy", label: "Copy", group: "Edit", combos: [{ key: "c", mod: true, shift: false }] },
	{ id: "cut", label: "Cut", group: "Edit", combos: [{ key: "x", mod: true, shift: false }] },
	{
		id: "paste",
		label: "Paste",
		group: "Edit",
		combos: [{ key: "v", mod: true, shift: false }],
		keywords: "link url text sticky card",
	},
	{
		id: "duplicate",
		label: "Duplicate",
		group: "Edit",
		combos: [{ key: "d", mod: true, shift: false }],
		keywords: "copy clone",
	},
	{
		id: "delete",
		label: "Delete",
		group: "Edit",
		combos: [{ key: "Backspace" }, { key: "Delete" }],
		keywords: "remove",
	},
	{ id: "selectAll", label: "Select all", group: "Selection", combos: [{ key: "a", mod: true }] },
	{
		id: "addToSelection",
		label: "Add to selection",
		group: "Selection",
		combos: [],
		display: [["Shift", "Click"]],
		keywords: "multi select shift",
	},
	{
		id: "marquee",
		label: "Select an area",
		group: "Selection",
		combos: [],
		display: [["Drag"], ["Shift", "Drag"]],
		keywords: "marquee lasso box",
	},
	{
		id: "rename",
		label: "Rename a section or label a connector",
		group: "Edit",
		combos: [],
		display: [["Enter"]],
		keywords: "title label section connector arrow",
	},
	{
		id: "connectFromShape",
		label: "Connect from a dot beside a shape",
		group: "Edit",
		combos: [],
		display: [["Drag"]],
		keywords: "connector arrow line link",
	},
	{
		id: "deselect",
		label: "Deselect, or stop editing",
		group: "Selection",
		combos: [{ key: "Escape" }],
		keywords: "escape clear",
	},
	{
		id: "edit",
		label: "Edit sticky",
		group: "Selection",
		combos: [],
		display: [["Enter"], ["Type"]],
		keywords: "text write",
	},
	{
		id: "nudge",
		label: "Nudge",
		group: "Arrange",
		combos: [],
		display: [["←", "↑", "→", "↓"]],
		keywords: "move arrow",
	},
	{
		id: "nudgeFar",
		label: "Nudge 10px",
		group: "Arrange",
		combos: [],
		display: [["Shift", "←", "↑", "→", "↓"]],
		keywords: "move arrow",
	},
	{ id: "nudgeLeft", label: "Nudge left", group: "Arrange", combos: arrow("ArrowLeft", false) },
	{ id: "nudgeRight", label: "Nudge right", group: "Arrange", combos: arrow("ArrowRight", false) },
	{ id: "nudgeUp", label: "Nudge up", group: "Arrange", combos: arrow("ArrowUp", false) },
	{ id: "nudgeDown", label: "Nudge down", group: "Arrange", combos: arrow("ArrowDown", false) },
	{ id: "nudgeLeftFar", label: "Nudge left", group: "Arrange", combos: arrow("ArrowLeft", true) },
	{
		id: "nudgeRightFar",
		label: "Nudge right",
		group: "Arrange",
		combos: arrow("ArrowRight", true),
	},
	{ id: "nudgeUpFar", label: "Nudge up", group: "Arrange", combos: arrow("ArrowUp", true) },
	{ id: "nudgeDownFar", label: "Nudge down", group: "Arrange", combos: arrow("ArrowDown", true) },
	{
		id: "noSnap",
		label: "Move without snapping",
		group: "Arrange",
		combos: [],
		display: [["Mod", "Drag"]],
		keywords: "snap guides",
	},
	{
		id: "alignLeft",
		label: "Align left",
		group: "Arrange",
		combos: [{ code: "KeyA", alt: true, shift: false }],
	},
	{
		id: "alignCenter",
		label: "Align centres horizontally",
		group: "Arrange",
		combos: [{ code: "KeyH", alt: true, shift: false }],
	},
	{
		id: "alignRight",
		label: "Align right",
		group: "Arrange",
		combos: [{ code: "KeyD", alt: true, shift: false }],
	},
	{
		id: "alignTop",
		label: "Align top",
		group: "Arrange",
		combos: [{ code: "KeyW", alt: true, shift: false }],
	},
	{
		id: "alignMiddle",
		label: "Align centres vertically",
		group: "Arrange",
		combos: [{ code: "KeyV", alt: true, shift: false }],
	},
	{
		id: "alignBottom",
		label: "Align bottom",
		group: "Arrange",
		combos: [{ code: "KeyS", alt: true, shift: false }],
	},
	{
		id: "distributeHorizontal",
		label: "Distribute horizontally",
		group: "Arrange",
		combos: [{ code: "KeyH", alt: true, shift: true }],
		keywords: "space evenly",
	},
	{
		id: "distributeVertical",
		label: "Distribute vertically",
		group: "Arrange",
		combos: [{ code: "KeyV", alt: true, shift: true }],
		keywords: "space evenly",
	},
	{
		id: "tidy",
		label: "Tidy up",
		group: "Arrange",
		combos: [{ code: "KeyT", alt: true, ctrl: true }],
		keywords: "grid arrange",
	},
	{
		id: "zoomIn",
		label: "Zoom in",
		group: "View",
		combos: [{ key: "=", mod: true }, { key: "+", mod: true }, { key: "+" }, { key: "=" }],
	},
	{
		id: "zoomOut",
		label: "Zoom out",
		group: "View",
		combos: [{ key: "-", mod: true }, { key: "-" }],
	},
	{
		id: "zoomToFit",
		label: "Zoom to fit",
		group: "View",
		combos: [{ code: "Digit1", shift: true }],
		keywords: "everything all",
	},
	{
		id: "zoomToSelection",
		label: "Zoom to selection",
		group: "View",
		combos: [{ code: "Digit2", shift: true }],
	},
	{
		id: "zoomTo100",
		label: "Zoom to 100%",
		group: "View",
		combos: [{ code: "Digit0", shift: true }],
	},
	{
		id: "pan",
		label: "Pan",
		group: "View",
		combos: [],
		display: [["Space", "Drag"], ["Scroll"]],
		keywords: "move hand",
	},
	// People: handled by CursorChat.tsx and Follow.tsx, listed here so the
	// sheet shows them.
	{
		id: "chat",
		label: "Cursor chat",
		group: "People",
		combos: [],
		display: [["/"]],
		keywords: "message say talk",
	},
	{
		id: "follow",
		label: "Follow someone",
		group: "People",
		combos: [],
		display: [["Click", "avatar"]],
		keywords: "presentation watch",
	},
	{
		id: "stopFollowing",
		label: "Stop following",
		group: "People",
		combos: [],
		display: [["Esc"]],
		keywords: "escape unfollow",
	},
	{
		id: "shortcuts",
		label: "Keyboard shortcuts",
		group: "Help",
		combos: [{ key: "?" }],
		keywords: "help keys",
	},
];

/** Shortcuts that exist only to be listed: they have one entry per direction. */
const HIDDEN = new Set([
	"nudgeLeft",
	"nudgeRight",
	"nudgeUp",
	"nudgeDown",
	"nudgeLeftFar",
	"nudgeRightFar",
	"nudgeUpFar",
	"nudgeDownFar",
]);

const TOOL_LABELS: Record<string, string> = {
	select: "Select",
	hand: "Hand",
	sticky: "Sticky note",
	card: "Issue or pull request",
	text: "Text",
	section: "Section",
	connector: "Connector",
};

/** Sheet entries for the toolbar's single-key tool shortcuts. */
export function toolShortcuts(toolKeys: Record<string, string>): Shortcut[] {
	return Object.entries(toolKeys).map(([key, tool]) => ({
		id: `tool:${tool}`,
		label: TOOL_LABELS[tool] ?? tool.charAt(0).toUpperCase() + tool.slice(1),
		group: "Tools",
		combos: [{ key }],
		keywords: "tool",
	}));
}

export function isApplePlatform(): boolean {
	if (typeof navigator === "undefined") return false;
	return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

export function matchesCombo(event: KeyInput, combo: KeyCombo, apple: boolean): boolean {
	const meta = apple ? !!combo.mod : false;
	const ctrl = apple ? !!combo.ctrl : !!(combo.mod || combo.ctrl);
	if (event.metaKey !== meta || event.ctrlKey !== ctrl || event.altKey !== !!combo.alt)
		return false;
	if (combo.shift !== undefined && event.shiftKey !== combo.shift) return false;
	if (combo.code !== undefined && event.code !== combo.code) return false;
	if (combo.key !== undefined && event.key.toLowerCase() !== combo.key.toLowerCase()) return false;
	return combo.key !== undefined || combo.code !== undefined;
}

/** The shortcut a key press triggers, if any. */
export function matchShortcut(
	event: KeyInput,
	apple: boolean,
	shortcuts: Shortcut[] = SHORTCUTS,
): Shortcut | undefined {
	return shortcuts.find((shortcut) =>
		shortcut.combos.some((combo) => matchesCombo(event, combo, apple)),
	);
}

const KEY_NAMES: Record<string, [apple: string, other: string]> = {
	ArrowLeft: ["←", "←"],
	ArrowRight: ["→", "→"],
	ArrowUp: ["↑", "↑"],
	ArrowDown: ["↓", "↓"],
	Backspace: ["⌫", "Backspace"],
	Delete: ["⌦", "Delete"],
	Escape: ["Esc", "Esc"],
	Enter: ["↵", "Enter"],
	Mod: ["⌘", "Ctrl"],
	Shift: ["⇧", "Shift"],
	"=": ["+", "+"],
};

function keyName(name: string, apple: boolean): string {
	const named = KEY_NAMES[name];
	if (named) return apple ? named[0] : named[1];
	if (/^Key[A-Z]$/.test(name)) return name.slice(3);
	if (/^Digit\d$/.test(name)) return name.slice(5);
	return name.length === 1 ? name.toUpperCase() : name;
}

/** The keys of a combo as keycap labels, e.g. ["⌘", "⇧", "Z"]. */
export function formatCombo(combo: KeyCombo, apple: boolean): string[] {
	const keys: string[] = [];
	if (combo.ctrl && (apple || !combo.mod)) keys.push(apple ? "⌃" : "Ctrl");
	if (combo.alt) keys.push(apple ? "⌥" : "Alt");
	if (combo.shift) keys.push(apple ? "⇧" : "Shift");
	if (combo.mod) keys.push(apple ? "⌘" : "Ctrl");
	const key = combo.key ?? combo.code;
	if (key) keys.push(keyName(key, apple));
	return keys;
}

/** A compact hint for a command's main shortcut, e.g. "⌘Z" or "Ctrl+Z". */
export function shortcutHint(id: string, apple: boolean): string {
	const combo = SHORTCUTS.find((shortcut) => shortcut.id === id)?.combos[0];
	return combo ? formatCombo(combo, apple).join(apple ? "" : "+") : "";
}

/**
 * Keycaps for each way to trigger a shortcut, for the sheet. Combos only
 * available on other platforms, and duplicates, are left out.
 */
export function shortcutKeys(shortcut: Shortcut, apple: boolean): string[][] {
	if (shortcut.display) {
		return shortcut.display.map((keys) => keys.map((key) => keyName(key, apple)));
	}
	const seen = new Set<string>();
	const out: string[][] = [];
	for (const combo of shortcut.combos) {
		// Ctrl+Y is the Windows and Linux redo; ⌃Y means nothing on a Mac.
		if (apple && combo.ctrl && !combo.alt) continue;
		// Bare zoom keys are a convenience, not worth listing beside ⌘+ and ⌘-.
		if (!combo.mod && (combo.key === "+" || combo.key === "=" || combo.key === "-")) continue;
		const keys = formatCombo(combo, apple);
		const id = keys.join(" ");
		if (!seen.has(id)) {
			seen.add(id);
			out.push(keys);
		}
	}
	return out;
}

/** Shortcuts to list in the sheet, in groups, filtered by a search query. */
export function sheetShortcuts(
	shortcuts: Shortcut[],
	query: string,
	apple: boolean,
): { group: ShortcutGroup; shortcuts: Shortcut[] }[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const listed = shortcuts.filter((s) => !HIDDEN.has(s.id));
	const matches = listed.filter((shortcut) => {
		if (words.length === 0) return true;
		const haystack = [
			shortcut.label,
			shortcut.group,
			shortcut.keywords ?? "",
			...shortcutKeys(shortcut, apple).flat(),
			...shortcutKeys(shortcut, apple)
				.flat()
				.map((key) => KEY_WORDS[key] ?? ""),
		]
			.join(" ")
			.toLowerCase();
		return words.every((word) => haystack.includes(word));
	});
	return GROUPS.map((group) => ({
		group,
		shortcuts: matches.filter((s) => s.group === group),
	})).filter((section) => section.shortcuts.length > 0);
}

/** Words people type for symbol keycaps. */
const KEY_WORDS: Record<string, string> = {
	"⌘": "cmd command mod",
	"⇧": "shift",
	"⌥": "alt option opt",
	"⌃": "ctrl control",
	"⌫": "backspace delete",
	"⌦": "delete",
	"←": "left arrow",
	"→": "right arrow",
	"↑": "up arrow",
	"↓": "down arrow",
	"↵": "enter return",
	Ctrl: "control mod",
	Alt: "option",
	Esc: "escape",
};
