import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { type Policy, canManage, roleFor } from "../src/server/boards/access.ts";
import { boardThumbnail } from "../src/server/boards/thumbnail.ts";
import {
	THUMBNAIL_MAX_SHAPES,
	boardIdFromPath,
	boardPath,
	cleanTitle,
	slugify,
} from "../src/shared/boards.ts";
import { addShape } from "../src/shared/shapes.ts";

const OWNER = 1;
const EDITOR = 2;
const VIEWER = 3;
const OTHER = 4;

function policy(overrides: Partial<Policy> = {}): Policy {
	return {
		ownerId: OWNER,
		visibility: "private",
		instanceRole: "editor",
		archived: false,
		members: { [OWNER]: "owner", [EDITOR]: "editor", [VIEWER]: "viewer" },
		...overrides,
	};
}

const allowed = (userId: number | null) => ({ userId, allowed: true });
const outsider = (userId: number | null) => ({ userId, allowed: false });

describe("roleFor", () => {
	it("gives members their role, and nobody else anything, on private boards", () => {
		const p = policy();
		expect(roleFor(p, allowed(OWNER))).toBe("owner");
		expect(roleFor(p, allowed(EDITOR))).toBe("editor");
		expect(roleFor(p, allowed(VIEWER))).toBe("viewer");
		expect(roleFor(p, allowed(OTHER))).toBeNull();
		expect(roleFor(p, allowed(null))).toBeNull();
	});

	it("gives everyone on the instance the instance role, members keeping theirs", () => {
		const p = policy({ visibility: "instance", instanceRole: "viewer" });
		expect(roleFor(p, allowed(OTHER))).toBe("viewer");
		expect(roleFor(p, allowed(EDITOR))).toBe("editor");
		expect(roleFor({ ...p, instanceRole: "editor" }, allowed(OTHER))).toBe("editor");
		expect(roleFor(p, outsider(OTHER))).toBeNull();
	});

	it("lets anyone view public boards, and only view", () => {
		const p = policy({ visibility: "public" });
		expect(roleFor(p, outsider(null))).toBe("viewer");
		expect(roleFor(p, outsider(OTHER))).toBe("viewer");
		expect(roleFor(p, allowed(OTHER))).toBe("editor");
	});

	it("needs instance access for membership to count", () => {
		expect(roleFor(policy(), outsider(EDITOR))).toBeNull();
		expect(roleFor(policy({ visibility: "public" }), outsider(EDITOR))).toBe("viewer");
	});

	it("makes archived boards read-only for everyone", () => {
		const p = policy({ archived: true });
		expect(roleFor(p, allowed(OWNER))).toBe("viewer");
		expect(roleFor(p, allowed(EDITOR))).toBe("viewer");
		expect(roleFor(p, allowed(OTHER))).toBeNull();
	});
});

describe("canManage", () => {
	it("is for owners, even of archived boards", () => {
		expect(canManage(policy(), allowed(OWNER))).toBe(true);
		expect(canManage(policy({ archived: true }), allowed(OWNER))).toBe(true);
		expect(canManage(policy(), allowed(EDITOR))).toBe(false);
		expect(canManage(policy({ visibility: "instance" }), allowed(OTHER))).toBe(false);
	});

	it("falls to editors when a board has no owner", () => {
		const p = policy({ ownerId: null, visibility: "instance", members: {} });
		expect(canManage(p, allowed(null))).toBe(true);
		expect(canManage({ ...p, instanceRole: "viewer" }, allowed(null))).toBe(false);
	});
});

describe("titles and slugs", () => {
	it("tidies titles, with a default", () => {
		expect(cleanTitle("  Q3\n planning  ")).toBe("Q3 planning");
		expect(cleanTitle("")).toBe("Untitled board");
		expect(cleanTitle("x".repeat(500))).toHaveLength(120);
	});

	it("slugs titles to ASCII words", () => {
		expect(slugify("Q3 planning: unpic!")).toBe("q3-planning-unpic");
		expect(slugify("Café déjà vu")).toBe("cafe-deja-vu");
		expect(slugify("🎉🎉")).toBe("board");
		expect(slugify(`${"word ".repeat(30)}`).length).toBeLessThanOrEqual(60);
		expect(slugify(`${"word ".repeat(30)}`)).not.toMatch(/-$/);
	});

	it("round-trips board paths", () => {
		expect(boardPath({ id: "k3j9x2ab7q", slug: "roadmap" })).toBe("/b/k3j9x2ab7q/roadmap");
		expect(boardIdFromPath("/b/k3j9x2ab7q/roadmap")).toBe("k3j9x2ab7q");
		expect(boardIdFromPath("/b/demo")).toBe("demo");
		expect(boardIdFromPath("/b/demo/")).toBe("demo");
		expect(boardIdFromPath("/b/")).toBeNull();
		expect(boardIdFromPath("/play")).toBeNull();
		expect(boardIdFromPath("/b/%E0%A4%A/x")).toBeNull();
	});
});

describe("boardThumbnail", () => {
	it("is null for an empty board", () => {
		expect(boardThumbnail(new Y.Doc())).toBeNull();
	});

	it("sketches shapes normalised to the thumbnail size, with tones", () => {
		const doc = new Y.Doc();
		addShape(doc, "s", { type: "sticky", x: -100, y: -100, z: "a0", color: "blue" });
		addShape(doc, "c", { type: "card", ref: "github.com/a/b#1", x: 900, y: 400, z: "a1" });
		addShape(doc, "t", { type: "text", text: "Hello", x: 0, y: 500, z: "a2", size: "l" });
		const thumbnail = boardThumbnail(doc, (ref) => (ref === "github.com/a/b#1" ? "merged" : ""));
		if (!thumbnail) throw new Error("expected a thumbnail");
		// The board is 1252 wide (-100 to 1152), so it scales to 1000.
		expect(thumbnail.width).toBe(1000);
		expect(thumbnail.height).toBeLessThan(1000);
		const byKind = Object.fromEntries(thumbnail.shapes.map((shape) => [shape[0], shape]));
		expect(byKind.sticky).toEqual(["sticky", 0, 0, 141, 141, "blue"]);
		expect(byKind.card?.[5]).toBe("merged");
		expect(byKind.text?.[5]).toBe("");
		for (const [, x, y, w, h] of thumbnail.shapes) {
			expect(x + w).toBeLessThanOrEqual(thumbnail.width);
			expect(y + h).toBeLessThanOrEqual(thumbnail.height);
		}
	});

	it("draws frames first, and skips shapes it can't place", () => {
		const doc = new Y.Doc();
		addShape(doc, "s", { type: "sticky", x: 50, y: 50, z: "a1" });
		const frame = new Y.Map<unknown>();
		doc.getMap("shapes").set("f", frame);
		for (const [k, v] of Object.entries({ type: "frame", x: 0, y: 0, width: 800, height: 600 })) {
			frame.set(k, v);
		}
		const bad = new Y.Map<unknown>();
		doc.getMap("shapes").set("bad", bad);
		bad.set("type", "sticky");
		bad.set("x", "nope");
		const connector = new Y.Map<unknown>();
		doc.getMap("shapes").set("line", connector);
		connector.set("type", "connector");
		const kinds = boardThumbnail(doc)?.shapes.map(([kind]) => kind);
		expect(kinds).toEqual(["frame", "sticky"]);
	});

	it("keeps only the largest shapes on very busy boards", () => {
		const doc = new Y.Doc();
		for (let i = 0; i < THUMBNAIL_MAX_SHAPES + 30; i++) {
			addShape(doc, `s${i}`, { type: "sticky", x: i * 200, y: 0, z: `a${i}` });
		}
		expect(boardThumbnail(doc)?.shapes).toHaveLength(THUMBNAIL_MAX_SHAPES);
	});
});
