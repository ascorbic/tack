import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { REPAIR_ORIGIN } from "../src/shared/repair.ts";
import { closeVote, deleteVote, placeDot, readVotes, startVote } from "../src/shared/dotvotes.ts";
import { applyTimer } from "../src/shared/facilitation.ts";
import {
	type FacilitationYou,
	VoteGuard,
	isFacilitator,
	mayChangeTimer,
	mayControl,
	mayDelete,
} from "../src/shared/facilitator.ts";

const starter: FacilitationYou = { author: "u:1", editor: true, owner: false };
const other: FacilitationYou = { author: "u:2", editor: true, owner: false };
const owner: FacilitationYou = { author: "u:3", editor: true, owner: true };
const viewer: FacilitationYou = { author: "u:4", editor: false, owner: false };
const by = { name: "Someone", color: "" };

describe("who may run what", () => {
	const here = new Set(["u:1", "u:2", "u:3"]);
	it("lets whoever started something, and the owner, control it", () => {
		expect(mayControl(starter, "u:1", here)).toBe(true);
		expect(mayControl(owner, "u:1", here)).toBe(true);
		expect(mayControl(other, "u:1", here)).toBe(false);
		expect(mayControl(viewer, "u:1", new Set())).toBe(false);
		expect(mayControl(null, undefined, here)).toBe(false);
	});

	it("lets any editor take over once its starter has left", () => {
		expect(mayControl(other, "u:1", new Set(["u:2"]))).toBe(true);
		// Things from before starters were recorded are anyone's.
		expect(mayControl(other, undefined, here)).toBe(true);
	});

	it("keeps deleting to whoever started it and the owner, here or not", () => {
		expect(mayDelete(starter, "u:1")).toBe(true);
		expect(mayDelete(owner, "u:1")).toBe(true);
		expect(mayDelete(other, "u:1")).toBe(false);
		expect(mayDelete(viewer, undefined)).toBe(false);
	});

	it("lets anyone start a timer when none is counting down", () => {
		const doc = new Y.Doc();
		applyTimer(doc, { action: "start", ms: 60_000 }, 0, by, null, "u:1");
		const timer = doc.getMap("facilitation").get("timer") as never;
		expect(mayChangeTimer(other, "start", null, here, 0)).toBe(true);
		expect(mayChangeTimer(other, "start", timer, here, 1_000)).toBe(false);
		expect(mayChangeTimer(other, "pause", timer, here, 1_000)).toBe(false);
		expect(mayChangeTimer(owner, "stop", timer, here, 1_000)).toBe(true);
		// Once it's done, a new one is anyone's to start.
		expect(mayChangeTimer(other, "start", timer, here, 61_000)).toBe(true);
	});

	it("counts whoever started something running as facilitating", () => {
		const doc = new Y.Doc();
		expect(isFacilitator(other, doc, 0)).toBe(false);
		expect(isFacilitator(owner, doc, 0)).toBe(true);
		startVote(doc, { scope: null, by, starter: "u:2" });
		expect(isFacilitator(other, doc, Date.now())).toBe(true);
		expect(isFacilitator(starter, doc, Date.now())).toBe(false);
	});
});

/** A document as the server holds it, written to by people with these origins. */
function guarded(present = new Set(["u:1", "u:2", "u:3"])) {
	const doc = new Y.Doc();
	const people = new Map<object, FacilitationYou>();
	const as = (you: FacilitationYou) => {
		const origin = { you };
		people.set(origin, you);
		return (fn: () => void) => doc.transact(fn, origin);
	};
	new VoteGuard({
		doc,
		actor: (origin) => people.get(origin as object) ?? null,
		present: () => present,
	});
	return { doc, as, present };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("VoteGuard", () => {
	it("stamps who started a vote, and puts back anyone else's close or delete", async () => {
		const { doc, as } = guarded();
		let id = "";
		as({ ...starter })(() => {
			id = startVote(doc, { scope: null, by, starter: "u:9" });
		});
		await settle();
		expect(readVotes(doc)[0]?.starter).toBe("u:1");
		as(other)(() => placeDot(doc, id, { name: "Two", login: "two", color: "" }, "s1"));
		as(other)(() => closeVote(doc, id, by));
		await settle();
		expect(readVotes(doc)[0]?.closedAt).toBeUndefined();
		as(other)(() => deleteVote(doc, id));
		await settle();
		expect(readVotes(doc)[0]?.ballots["@two"]?.dots).toEqual({ s1: 1 });
		as(owner)(() => closeVote(doc, id, by));
		await settle();
		expect(readVotes(doc)[0]?.closedAt).toBeDefined();
		as(starter)(() => deleteVote(doc, id));
		await settle();
		expect(readVotes(doc)).toEqual([]);
	});

	it("puts things right as Tack, not as the timer or anyone", async () => {
		const { doc, as } = guarded();
		const origins: unknown[] = [];
		doc.on("afterTransaction", (transaction: Y.Transaction) => origins.push(transaction.origin));
		as({ ...starter })(() => startVote(doc, { scope: null, by, starter: "u:9" }));
		await settle();
		expect(origins.at(-1)).toBe(REPAIR_ORIGIN);
	});

	it("lets the server's own writes through", async () => {
		const { doc } = guarded();
		const id = startVote(doc, { scope: null, by });
		closeVote(doc, id, by);
		await settle();
		expect(readVotes(doc)[0]?.closedAt).toBeDefined();
		expect(readVotes(doc)[0]?.starter).toBeUndefined();
	});
});
