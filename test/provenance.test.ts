import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { copyShapes, pasteShapes } from "../src/client/clipboard.ts";
import {
	addCardShape,
	describeProvenance,
	keepCard,
	provenanceOf,
	provenanceSourceName,
	unmatchedSince,
	updateMatches,
	whenUnmatched,
} from "../src/shared/provenance.ts";
import { addShape, readShape, shapesMap } from "../src/shared/shapes.ts";
import type { Provenance } from "../src/shared/widgets.ts";

const KEY = (n: number) => `github.com/acme/app#${n}`;

function shape(doc: Y.Doc, id: string) {
	const raw = shapesMap(doc).get(id);
	if (!raw) throw new Error(`no shape ${id}`);
	return readShape(raw);
}

function board() {
	const doc = new Y.Doc();
	addShape(doc, "triage", {
		type: "section",
		x: 0,
		y: 0,
		z: "a0",
		w: 600,
		h: 400,
		title: "Triage",
	});
	addShape(doc, "bugs", {
		type: "widget",
		widget: "list",
		config: { title: "Bugs" },
		x: 700,
		y: 0,
		z: "a1",
	});
	doc.getMap("rules").set("beside", { name: "PRs beside their issues" });
	addCardShape(doc, "placed", { ref: KEY(1), x: 0, y: 0 });
	addCardShape(doc, "listed", { ref: KEY(2), x: 0, y: 0 }, { via: "list", source: "bugs" });
	addCardShape(doc, "inboxed", { ref: KEY(3), x: 0, y: 0 }, { via: "inbox", source: "triage" });
	addCardShape(doc, "ruled", { ref: KEY(4), x: 0, y: 0 }, { via: "rule", source: "beside" });
	addCardShape(doc, "other", { ref: KEY(5), x: 0, y: 0 }, { via: "inbox", source: "elsewhere" });
	return doc;
}

describe("provenance", () => {
	it("isn't stored for cards people place, and reads as manual", () => {
		const doc = board();
		expect(shapesMap(doc).get("placed")?.has("provenance")).toBe(false);
		expect(provenanceOf(shape(doc, "placed"))).toEqual({ via: "manual" });
		expect(provenanceOf(shape(doc, "inboxed"))).toEqual({ via: "inbox", source: "triage" });
	});

	it("reads anything malformed as manual", () => {
		for (const junk of [null, "inbox", { via: "inbox" }, { via: "wat", source: "x" }, 4]) {
			expect(provenanceOf({ provenance: junk as unknown as Provenance })).toEqual({
				via: "manual",
			});
		}
	});

	it("decides what happens when a card stops matching", () => {
		expect(whenUnmatched({ via: "manual" })).toBe("keep");
		expect(whenUnmatched({ via: "list", source: "w" })).toBe("keep");
		expect(whenUnmatched({ via: "inbox", source: "s" })).toBe("mark");
		expect(whenUnmatched({ via: "rule", source: "r" })).toBe("mark");
	});

	it("marks and unmarks only the cards a source brought, and never removes them", () => {
		const doc = board();
		const at = "2026-10-09T12:00:00.000Z";
		// Everything stops matching, as far as this source can tell.
		const first = updateMatches(doc, "triage", () => false, { at });
		expect(first).toEqual({ marked: ["inboxed"], cleared: [] });
		expect(unmatchedSince(shape(doc, "inboxed"))).toBe(at);
		for (const id of ["placed", "listed", "ruled", "other"]) {
			expect(unmatchedSince(shape(doc, id))).toBeNull();
		}
		expect(shapesMap(doc).size).toBe(7);

		// Asking again changes nothing; unknown leaves it be.
		expect(updateMatches(doc, "triage", () => false)).toEqual({ marked: [], cleared: [] });
		expect(updateMatches(doc, "triage", () => undefined)).toEqual({ marked: [], cleared: [] });
		expect(unmatchedSince(shape(doc, "inboxed"))).toBe(at);

		// It matches again.
		expect(updateMatches(doc, "triage", (key) => key === KEY(3))).toEqual({
			marked: [],
			cleared: ["inboxed"],
		});
		expect(unmatchedSince(shape(doc, "inboxed"))).toBeNull();

		// Rules too; lists never.
		expect(updateMatches(doc, "beside", () => false).marked).toEqual(["ruled"]);
		expect(updateMatches(doc, "bugs", () => false).marked).toEqual([]);
	});

	it("writes with the origin it's given, in one transaction", () => {
		const doc = board();
		const origins: unknown[] = [];
		doc.on("afterTransaction", (transaction: Y.Transaction) => origins.push(transaction.origin));
		updateMatches(doc, "triage", () => false, { origin: "inbox" });
		expect(origins).toEqual(["inbox"]);
	});

	it("keeping a card makes it the person's own", () => {
		const doc = board();
		updateMatches(doc, "triage", () => false);
		keepCard(doc, "inboxed");
		expect(provenanceOf(shape(doc, "inboxed"))).toEqual({ via: "manual" });
		expect(unmatchedSince(shape(doc, "inboxed"))).toBeNull();
		// Never marked again.
		expect(updateMatches(doc, "triage", () => false).marked).toEqual([]);
	});

	it("names what brought a card, and says so", () => {
		const doc = board();
		const text = (id: string) => {
			const provenance = provenanceOf(shape(doc, id));
			return describeProvenance(provenance, provenanceSourceName(doc, provenance));
		};
		expect(text("placed")).toBeNull();
		expect(text("listed")?.label).toBe("From the “Bugs” list");
		expect(text("inboxed")).toEqual({
			label: "From the “Triage” inbox",
			unmatched: "No longer matches the “Triage” inbox",
		});
		expect(text("ruled")?.label).toBe("Placed by rule: PRs beside their issues");
		// Its source is gone.
		expect(text("other")?.label).toBe("From an inbox");
	});

	it("names who asked for a card in a comment, and never marks it", () => {
		const doc = board();
		const source = "https://github.com/acme/app/issues/6#issuecomment-9";
		addCardShape(
			doc,
			"asked",
			{ ref: KEY(6), x: 0, y: 0 },
			{ via: "comment", source, by: "alice" },
		);
		const provenance = provenanceOf(shape(doc, "asked"));
		expect(provenance).toEqual({ via: "comment", source, by: "alice" });
		expect(describeProvenance(provenance, provenanceSourceName(doc, provenance))?.label).toBe(
			"Added from GitHub by @alice",
		);
		expect(describeProvenance({ via: "comment", source }, null)?.label).toBe(
			"Added from a comment on GitHub",
		);
		expect(whenUnmatched(provenance)).toBe("keep");
		expect(updateMatches(doc, source, () => false).marked).toEqual([]);
		// Only links, and only logins.
		for (const junk of [
			{ via: "comment", source: "javascript:alert(1)" },
			{ via: "comment", source: "" },
		]) {
			expect(provenanceOf({ provenance: junk as Provenance })).toEqual({ via: "manual" });
		}
		expect(
			provenanceOf({ provenance: { via: "comment", source, by: "<b>" } as Provenance }),
		).toEqual({ via: "comment", source });
	});

	it("stays with the original when a card is copied", () => {
		const doc = board();
		updateMatches(doc, "triage", () => false);
		const [copy] = pasteShapes(doc, copyShapes(doc, ["inboxed"]), { x: 20, y: 20 });
		const pasted = shape(doc, copy ?? "");
		expect(pasted.ref).toBe(KEY(3));
		expect(pasted.provenance).toBeUndefined();
		expect(pasted.unmatched).toBeUndefined();
		expect(provenanceOf(shape(doc, "inboxed")).via).toBe("inbox");
	});
});
