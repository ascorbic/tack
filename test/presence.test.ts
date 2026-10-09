import { describe, expect, it } from "vite-plus/test";
import { IDLE_AFTER_MS, activityStatus, statusLabel } from "../src/client/activity.ts";
import { CHAT_MAX_LENGTH, cleanChat, opensChat } from "../src/client/chat.ts";
import { sameView, viewOf, viewportFor } from "../src/client/viewport.ts";

describe("viewOf and viewportFor", () => {
	it("round-trips a view for a window of the same size", () => {
		const view = viewOf([-300, -120, 2], 1200, 800);
		expect(view).toEqual({ x: 150, y: 60, width: 600, height: 400 });
		expect(viewportFor(view, 1200, 800)).toEqual({ x: -300, y: -120, zoom: 2 });
	});

	it("fits the whole view into a smaller window, centred", () => {
		const view = { x: 0, y: 0, width: 1600, height: 1000 };
		// Half size, with the view's centre (800, 500) in the window's (400, 400).
		expect(viewportFor(view, 800, 800)).toEqual({ x: 0, y: 150, zoom: 0.5 });
	});

	it("clamps zoom to the board's limits", () => {
		const tiny = { x: 0, y: 0, width: 10, height: 10 };
		expect(viewportFor(tiny, 1000, 1000, { maxZoom: 2 }).zoom).toBe(2);
		const huge = { x: 0, y: 0, width: 1e6, height: 1e6 };
		expect(viewportFor(huge, 1000, 1000, { minZoom: 0.1 }).zoom).toBe(0.1);
	});

	it("ignores sub-pixel differences", () => {
		const a = { x: 10, y: 10, width: 500, height: 300 };
		expect(sameView(a, { ...a, x: 10.4 })).toBe(true);
		expect(sameView(a, { ...a, width: 502 })).toBe(false);
		expect(sameView(a, null)).toBe(false);
		expect(sameView(null, null)).toBe(true);
	});
});

describe("activityStatus", () => {
	const now = 1_000_000;

	it("is away whenever the tab is hidden", () => {
		expect(activityStatus({ hidden: true, lastActive: now, now })).toBe("away");
	});

	it("goes idle after a while without input", () => {
		expect(activityStatus({ hidden: false, lastActive: now - 1000, now })).toBe("active");
		expect(activityStatus({ hidden: false, lastActive: now - IDLE_AFTER_MS, now })).toBe("idle");
		expect(activityStatus({ hidden: false, lastActive: now - 5000, now, idleAfter: 5000 })).toBe(
			"idle",
		);
	});

	it("labels only the quiet states", () => {
		expect(statusLabel("active")).toBeNull();
		expect(statusLabel("idle")).toBe("Idle");
		expect(statusLabel("away")).toBe("Away");
	});
});

describe("cursor chat", () => {
	const key = (
		k: string,
		mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey", boolean>> = {},
	) => ({
		key: k,
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		...mods,
	});

	it("opens on a bare slash, but not while typing or with modifiers", () => {
		expect(opensChat(key("/"), false)).toBe(true);
		expect(opensChat(key("/"), true)).toBe(false);
		expect(opensChat(key("/", { metaKey: true }), false)).toBe(false);
		expect(opensChat(key("?"), false)).toBe(false);
	});

	it("keeps messages to one short line", () => {
		expect(cleanChat("hello\n  there ")).toBe("hello there ");
		expect(cleanChat("x".repeat(500))).toHaveLength(CHAT_MAX_LENGTH);
	});
});
