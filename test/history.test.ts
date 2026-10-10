import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import {
	type Actor,
	HistoryLog,
	MemoryHistoryStore,
	type StepMeta,
	decodeSegment,
	describeChanges,
	editKind,
	encodeSegment,
	groupSteps,
	mergeMetas,
	planMerges,
	spanFor,
	touchesSection,
} from "../src/shared/history.ts";
import { addShape, shapesMap } from "../src/shared/shapes.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 9, 1, 9, 0, 0);

const PEOPLE: Record<string, Actor> = {
	ana: { key: "u:1", name: "Ana", color: "#b4467a", login: "ana" },
	ben: { key: "u:2", name: "Ben", color: "#1f7a6b", login: "ben" },
};

const logs: HistoryLog[] = [];
afterEach(() => {
	for (const log of logs.splice(0)) log.stop();
});

function setup(limits: ConstructorParameters<typeof HistoryLog>[0]["limits"] = {}) {
	const doc = new Y.Doc();
	const store = new MemoryHistoryStore();
	const clock = { now: START };
	const history = new HistoryLog({
		doc,
		store,
		now: () => clock.now,
		attribute: (origin) => {
			const person = typeof origin === "string" ? PEOPLE[origin] : undefined;
			return person ? { key: person.key, actor: person } : { key: "sys:server" };
		},
		limits: { compactEvery: Number.POSITIVE_INFINITY, ...limits },
	});
	history.start();
	logs.push(history);
	const as = (who: string, fn: () => void) => doc.transact(fn, who);
	return { doc, store, clock, history, as };
}

function sticky(doc: Y.Doc, id: string, x = 0, y = 0, text = "") {
	addShape(doc, id, { type: "sticky", x, y, z: `a${id}`, text });
}

const json = (doc: Y.Doc) => shapesMap(doc).toJSON();

describe("recording", () => {
	it("starts with the board as it is, then records each person's edits as steps", () => {
		const { doc, history, as, clock } = setup();
		as("ana", () => sticky(doc, "s1", 10, 20, "Hello"));
		clock.now += 1000;
		as("ben", () => sticky(doc, "s2", 300, 20));
		as("ana", () => shapesMap(doc).get("s1")?.set("text", "Hello there"));
		history.flush();

		const { steps, actors } = history.timeline();
		expect(steps).toHaveLength(3);
		expect(steps[0]!.origin).toBe(true);
		const [, ana, ben] = steps;
		expect(ana!.actors).toEqual(["u:1"]);
		expect(ana!.changes).toEqual([
			{ id: "s1", op: "add", type: "sticky", box: [10, 20, 176, 176], parent: null },
		]);
		expect(ben!.actors).toEqual(["u:2"]);
		expect(ben!.at).toBe(START + 1000);
		expect(actors["u:1"]?.name).toBe("Ana");
		expect(actors["u:2"]?.login).toBe("ben");
	});

	it("says which properties an edit changed, and where a removed shape was", () => {
		const { doc, history, as } = setup();
		as("ana", () => sticky(doc, "s1", 10, 20, "Hello"));
		history.flush();
		as("ben", () => {
			shapesMap(doc).get("s1")?.set("x", 400);
			shapesMap(doc).get("s1")?.set("color", "pink");
		});
		history.flush();
		as("ana", () => shapesMap(doc).delete("s1"));
		history.flush();
		const steps = history.timeline().steps;
		expect(steps[2]!.changes[0]).toMatchObject({ id: "s1", op: "edit", keys: ["x", "color"] });
		expect(steps[3]!.changes[0]).toMatchObject({
			id: "s1",
			op: "remove",
			type: "sticky",
			box: [400, 20, 176, 176],
		});
	});

	it("forgets shapes made and removed before the step was written", () => {
		const { doc, history, as } = setup();
		as("ana", () => sticky(doc, "gone"));
		as("ana", () => shapesMap(doc).delete("gone"));
		history.flush();
		expect(history.timeline().steps[1]!.changes).toEqual([]);
	});

	it("notes edits to other parts of the board", () => {
		const { doc, history, as } = setup();
		as("ana", () => doc.getMap("stamps").set("k", { emoji: "👍" }));
		history.flush();
		expect(history.timeline().steps[1]!.other).toEqual(["stamps"]);
	});

	it("attributes nested edits to their shape", () => {
		const { doc, history, as } = setup();
		as("ana", () => {
			addShape(doc, "d", { type: "decision", x: 0, y: 0, z: "a0", title: "Ship it" });
			shapesMap(doc).get("d")?.set("votes", new Y.Map());
		});
		history.flush();
		const votes = shapesMap(doc).get("d")!.get("votes") as Y.Map<unknown>;
		as("ben", () => votes.set("ben", "agree"));
		history.flush();
		expect(history.timeline().steps[2]!.changes[0]).toMatchObject({
			id: "d",
			op: "edit",
			keys: ["votes"],
		});
	});

	it("catches up with edits made while it wasn't recording", () => {
		const { doc, store, history, as, clock } = setup();
		as("ana", () => sticky(doc, "s1"));
		history.flush();
		history.stop();
		as("ben", () => sticky(doc, "s2"));
		const again = new HistoryLog({
			doc,
			store,
			now: () => clock.now,
			attribute: () => ({ key: "sys:server" }),
		});
		again.start();
		logs.push(again);
		const steps = again.timeline().steps;
		expect(steps.at(-1)!.actors).toEqual(["sys:server"]);
		expect(json(again.docAt(steps.at(-1)!.id))).toEqual(json(doc));
	});
});

describe("seeking", () => {
	it("rebuilds the board as it was after any step", () => {
		const { doc, history, as, clock } = setup({ keyframeMin: 200 });
		const states: { id: number; shapes: unknown }[] = [];
		for (let i = 0; i < 40; i++) {
			clock.now += 5000;
			as(i % 2 ? "ana" : "ben", () => {
				sticky(doc, `s${i}`, i * 10, 0, "x".repeat(20));
				if (i > 3) shapesMap(doc).delete(`s${i - 3}`);
			});
			history.flush();
			states.push({ id: history.timeline().steps.at(-1)!.id, shapes: json(doc) });
		}
		for (const { id, shapes } of states) expect(json(history.docAt(id))).toEqual(shapes);
	});

	it("writes keyframes as updates add up, so a seek never replays much", () => {
		const { doc, store, history, as, clock } = setup({ keyframeMin: 300 });
		for (let i = 0; i < 30; i++) {
			clock.now += 5000;
			as("ana", () => sticky(doc, `s${i}`, 0, 0, "y".repeat(40)));
			history.flush();
		}
		const frames = store.keyframes();
		expect(frames.length).toBeGreaterThan(2);
		// Every segment starts at a keyframe and runs to the next.
		const segment = history.segment(frames[1]!.step + 1)!;
		expect(segment.base.step).toBe(frames[1]!.step);
		expect(segment.steps.at(-1)!.id).toBe(frames[2]!.step);
		const replayed = new Y.Doc();
		Y.applyUpdate(replayed, segment.base.state);
		for (const step of segment.steps) if (step.update) Y.applyUpdate(replayed, step.update);
		expect(json(replayed)).toEqual(json(history.docAt(frames[2]!.step)));
	});

	it("sends segments as bytes", () => {
		const { doc, history, as } = setup();
		as("ana", () => sticky(doc, "s1"));
		history.flush();
		const segment = history.segment(1)!;
		const decoded = decodeSegment(encodeSegment(segment));
		expect(decoded.base.step).toBe(segment.base.step);
		expect(decoded.steps.map((s) => s.id)).toEqual(segment.steps.map((s) => s.id));
		expect([...decoded.steps[0]!.update!]).toEqual([...segment.steps[0]!.update!]);
	});
});

describe("thinning", () => {
	it("keeps the last hour as recorded and coarsens older history by age", () => {
		expect(spanFor(10 * MINUTE)).toBe(0);
		expect(spanFor(2 * HOUR)).toBe(5 * MINUTE);
		expect(spanFor(2 * DAY)).toBe(HOUR);
		expect(spanFor(10 * DAY)).toBe(DAY);
		expect(spanFor(100 * DAY)).toBe(7 * DAY);
	});

	it("plans merges within each bucket, never across the origin", () => {
		const step = (id: number, at: number, extra: Partial<StepMeta> = {}): StepMeta => ({
			id,
			at,
			until: at,
			actors: ["u:1"],
			changes: [],
			span: 0,
			bytes: 1,
			...extra,
		});
		const now = START + 3 * HOUR;
		const steps = [
			step(1, START, { origin: true }),
			step(2, START + 1000),
			step(3, START + 2000),
			step(4, START + 6 * MINUTE),
			step(5, now - MINUTE),
			step(6, now - 30_000),
		];
		expect(planMerges(steps, now)).toEqual([[1, 2]]);
	});

	it("merges old steps, keeping every state that's left and who took part", () => {
		const { doc, history, as, clock } = setup({ keyframeMin: 1 });
		const states = new Map<number, unknown>();
		for (let i = 0; i < 24; i++) {
			clock.now = START + i * MINUTE;
			as(i % 3 ? "ana" : "ben", () => {
				const id = `s${i % 6}`;
				if (shapesMap(doc).has(id))
					shapesMap(doc)
						.get(id)
						?.set("text", "z".repeat(i * 10));
				else sticky(doc, id, i * 20, 0);
			});
			history.flush();
			states.set(history.timeline().steps.at(-1)!.id, json(doc));
		}
		const before = history.timeline().steps.length;
		const result = history.compact(START + 3 * HOUR);
		const { steps } = history.timeline();
		expect(result.merged).toBeGreaterThan(0);
		expect(steps.length).toBeLessThan(before);
		// Five-minute buckets: 0–4, 5–9, … minutes.
		expect(steps.slice(1).every((step) => step.span === 5 * MINUTE)).toBe(true);
		expect(steps[1]!.actors.sort()).toEqual(["u:1", "u:2"]);
		for (const step of steps) {
			const expected = states.get(step.id);
			if (expected) expect(json(history.docAt(step.id))).toEqual(expected);
		}
		expect(json(history.docAt(steps.at(-1)!.id))).toEqual(json(doc));
		expect(history.timeline().generation).toBe(1);
	});

	it("garbage-collects text that was typed over within a merged step", () => {
		const { doc, store, history, as, clock } = setup({ keyframeMin: 1e9 });
		as("ana", () => sticky(doc, "s1"));
		history.flush();
		let text = "";
		for (let i = 0; i < 100; i++) {
			clock.now += 1000;
			text += "typing ";
			as("ana", () => shapesMap(doc).get("s1")?.set("text", text));
			history.flush();
		}
		const typed = store.steps().slice(2);
		const raw = typed.reduce((n, step) => n + step.bytes, 0);
		const mergedLikeYjs = Y.mergeUpdates(typed.map((step) => store.update(step.id)!)).byteLength;
		history.compact(clock.now + 2 * HOUR);
		const after = store.steps().slice(1);
		const kept = after.reduce((n, step) => n + step.bytes, 0);
		expect(kept).toBeLessThan(mergedLikeYjs / 10);
		expect(kept).toBeLessThan(raw / 10);
		expect(json(history.docAt(after.at(-1)!.id))).toEqual(json(doc));
	});

	it("drops the oldest history to stay within its budget", () => {
		const { doc, store, history, as, clock } = setup({ budget: 20_000, keyframeMin: 2_000 });
		for (let i = 0; i < 200; i++) {
			clock.now += 30_000;
			as("ana", () => {
				sticky(doc, `s${i}`, i, i, "w".repeat(200));
				if (i >= 10) shapesMap(doc).delete(`s${i - 10}`);
			});
			history.flush();
		}
		const result = history.compact(clock.now);
		expect(result.trimmed).toBeGreaterThan(0);
		expect(result.bytes).toBeLessThanOrEqual(20_000);
		const steps = store.steps();
		expect(steps[0]!.origin).toBe(true);
		expect(store.keyframe(steps[0]!.id)).not.toBeNull();
		expect(json(history.docAt(steps.at(-1)!.id))).toEqual(json(doc));
		// The new origin is the board as it was then.
		expect(Object.keys(json(history.docAt(steps[0]!.id))).length).toBe(10);
	});

	it("thins history on its own, as steps are written", () => {
		const { doc, history, as, clock } = setup({ compactEvery: HOUR });
		for (let i = 0; i < 10; i++) {
			clock.now += MINUTE;
			as("ana", () => sticky(doc, `s${i}`));
			history.flush();
		}
		clock.now += 3 * HOUR;
		as("ben", () => sticky(doc, "late"));
		history.flush();
		expect(history.timeline().steps.length).toBeLessThan(12);
	});
});

describe("reading history", () => {
	it("groups a person's steps into entries, keeping removals apart", () => {
		const step = (id: number, at: number, extra: Partial<StepMeta> = {}): StepMeta => ({
			id,
			at,
			until: at,
			actors: ["u:1"],
			changes: [{ id: `s${id}`, op: "add", type: "sticky" }],
			span: 0,
			bytes: 1,
			...extra,
		});
		const groups = groupSteps([
			step(1, START, { origin: true, actors: [], changes: [] }),
			step(2, START + 1000),
			step(3, START + 2000),
			step(4, START + 3000, { changes: [{ id: "s3", op: "remove", type: "sticky" }] }),
			step(5, START + 4000, { actors: ["u:2"] }),
			step(6, START + 5000, { actors: ["u:2"] }),
			step(7, START + HOUR, { actors: ["u:2"] }),
		]);
		expect(groups.map((g) => g.steps.map((s) => s.id))).toEqual([[1], [2, 3], [4], [5, 6], [7]]);
		expect(describeChanges(groups[1]!.merged)).toBe("added 2 stickies");
		expect(groups[1]!.merged.id).toBe(3);
	});

	it("describes steps in words", () => {
		const step = {
			changes: [
				{ id: "a", op: "add" as const, type: "sticky" },
				{ id: "b", op: "add" as const, type: "sticky" },
				{ id: "c", op: "edit" as const, type: "card", keys: ["x", "y"] },
				{ id: "d", op: "remove" as const, type: "section" },
			],
		};
		expect(describeChanges(step)).toBe("added 2 stickies, removed a section and moved a card");
		expect(describeChanges({ changes: [], other: ["dotVotes"] })).toBe("voted");
		expect(editKind(["text"])).toBe("edited");
		expect(editKind(["x", "y", "parent"])).toBe("moved");
		expect(editKind(["w", "h", "x"])).toBe("resized");
	});

	it("describes one person's part of a merged step", () => {
		const step = mergeMetas(
			[
				{
					id: 1,
					at: 0,
					until: 0,
					actors: ["u:1"],
					changes: [{ id: "a", op: "add", type: "sticky" }],
					span: 0,
					bytes: 0,
				},
				{
					id: 2,
					at: 1,
					until: 1,
					actors: ["u:2"],
					changes: [{ id: "b", op: "add", type: "card" }],
					span: 0,
					bytes: 0,
				},
			],
			HOUR,
			100,
		);
		expect(step.actors).toEqual(["u:1", "u:2"]);
		expect(describeChanges(step, "u:2")).toBe("added a card");
	});

	it("filters steps to a section's area", () => {
		const step: StepMeta = {
			id: 2,
			at: 0,
			until: 0,
			actors: [],
			changes: [{ id: "x", op: "add", type: "sticky", box: [50, 50, 10, 10], parent: null }],
			span: 0,
			bytes: 0,
		};
		expect(touchesSection(step, "sec", { x: 0, y: 0, w: 100, h: 100 })).toBe(true);
		expect(touchesSection(step, "sec", { x: 200, y: 0, w: 100, h: 100 })).toBe(false);
		expect(
			touchesSection({ ...step, changes: [{ id: "y", op: "edit", parent: "sec" }] }, "sec", null),
		).toBe(true);
	});
});
