import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import {
	TIMER_MAX_MS,
	applyTimer,
	clockOffset,
	formatClock,
	highFives,
	readTimer,
	stampCounts,
	stampRowWidth,
	stampsMap,
	timeLeft,
	timerDone,
	timerExpired,
	toggleStamp,
} from "../src/shared/facilitation.ts";

const BY = { name: "Priya", color: "#b4467a" };

describe("the shared timer", () => {
	it("starts, pauses, resumes, gains time and stops, in server time", () => {
		const doc = new Y.Doc();
		expect(applyTimer(doc, { action: "start", ms: 60_000 }, 1_000, BY)).toBe(true);
		const started = readTimer(doc)!;
		expect(started).toMatchObject({ state: "running", duration: 60_000, endsAt: 61_000, by: BY });
		expect(timeLeft(started, 31_000)).toBe(30_000);

		applyTimer(doc, { action: "pause" }, 31_000, BY);
		const paused = readTimer(doc)!;
		expect(paused).toMatchObject({ state: "paused", remaining: 30_000 });
		expect(paused.endsAt).toBeUndefined();
		// Time stands still while paused.
		expect(timeLeft(paused, 500_000)).toBe(30_000);

		applyTimer(doc, { action: "resume" }, 100_000, BY);
		expect(readTimer(doc)).toMatchObject({ state: "running", endsAt: 130_000, id: started.id });

		applyTimer(doc, { action: "add", ms: 60_000 }, 100_000, BY);
		expect(readTimer(doc)).toMatchObject({ endsAt: 190_000, duration: 120_000 });

		applyTimer(doc, { action: "stop" }, 100_000, BY);
		expect(readTimer(doc)).toBeNull();
	});

	it("says when it's done, and tidies away a while after", () => {
		const doc = new Y.Doc();
		applyTimer(doc, { action: "start", ms: 10_000 }, 0, BY);
		const timer = readTimer(doc)!;
		expect(timerDone(timer, 9_999)).toBe(false);
		expect(timerDone(timer, 10_000)).toBe(true);
		expect(timeLeft(timer, 20_000)).toBe(0);
		expect(timerExpired(timer, 60_000)).toBe(false);
		expect(timerExpired(timer, 10_000 + 3 * 60_000)).toBe(true);
		// A finished timer can't be paused, but adding time starts it again from zero.
		expect(applyTimer(doc, { action: "pause" }, 20_000, BY)).toBe(false);
		applyTimer(doc, { action: "add", ms: 60_000 }, 20_000, BY);
		expect(readTimer(doc)).toMatchObject({ state: "running", endsAt: 80_000, duration: 60_000 });
	});

	it("keeps lengths sensible", () => {
		const doc = new Y.Doc();
		applyTimer(doc, { action: "start", ms: 1 }, 0, BY);
		expect(readTimer(doc)?.duration).toBe(5_000);
		applyTimer(doc, { action: "start", ms: 10 * TIMER_MAX_MS }, 0, BY);
		expect(readTimer(doc)?.duration).toBe(TIMER_MAX_MS);
		expect(applyTimer(doc, { action: "start", ms: Number.NaN }, 0, BY)).toBe(false);
		// A new start is a new run, so clients chime again.
		const first = readTimer(doc)!.id;
		applyTimer(doc, { action: "start", ms: 60_000 }, 0, BY);
		expect(readTimer(doc)!.id).not.toBe(first);
	});

	it("formats like a clock", () => {
		expect(formatClock(0)).toBe("0:00");
		expect(formatClock(4_001)).toBe("0:05");
		expect(formatClock(245_000)).toBe("4:05");
		expect(formatClock(3_725_000)).toBe("1:02:05");
	});
});

describe("the server's clock", () => {
	it("trusts the ping with the shortest round trip", () => {
		const offset = clockOffset([
			{ sent: 0, received: 400, server: 5_300 },
			{ sent: 1_000, received: 1_040, server: 6_020 },
			{ sent: 2_000, received: 2_300, server: 7_000 },
		]);
		expect(offset).toBe(5_000);
		expect(clockOffset([])).toBe(0);
	});
});

describe("stamps", () => {
	const kai = { name: "Kai", color: "#1f7a6b", login: "Kai" };
	it("are per person, merge, and count", () => {
		const a = new Y.Doc();
		const b = new Y.Doc();
		toggleStamp(a, "s1", "👍", BY);
		toggleStamp(b, "s1", "👍", kai);
		toggleStamp(b, "s1", "🎉", kai);
		Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
		const counts = stampCounts(stampsMap(a), kai).get("s1")!;
		expect(counts.map((c) => [c.emoji, c.count, c.mine])).toEqual([
			["👍", 2, true],
			["🎉", 1, true],
		]);
		expect(stampCounts(stampsMap(a), BY).get("s1")?.[1]?.mine).toBe(false);
	});

	it("say who, you first, then in the order they stamped", () => {
		const doc = new Y.Doc();
		const jo = { name: "Jo Rivera", color: "#5b5fc7", login: "jo" };
		toggleStamp(doc, "s1", "👍", jo, "2026-10-10T10:00:02Z");
		toggleStamp(doc, "s1", "👍", BY, "2026-10-10T10:00:01Z");
		toggleStamp(doc, "s1", "👍", kai, "2026-10-10T10:00:03Z");
		const [thumbs] = stampCounts(stampsMap(doc), { ...kai, login: "kai" }).get("s1")!;
		expect(thumbs!.people.map((p) => [p.name, p.login, p.you ?? false])).toEqual([
			["Kai", "Kai", true],
			["Priya", undefined, false],
			["Jo Rivera", "jo", false],
		]);
	});

	it("toggle off, and logins match whatever their case", () => {
		const doc = new Y.Doc();
		expect(toggleStamp(doc, "s1", "❤️", kai)).toBe(true);
		expect(toggleStamp(doc, "s1", "❤️", { ...kai, login: "kai" })).toBe(false);
		expect(stampsMap(doc).size).toBe(0);
	});

	// As Chromium and WebKit draw them: Geist Mono, and an emoji's box.
	it("take the room in a row their pills do, to within half a pixel", () => {
		expect(stampRowWidth([])).toBe(0);
		expect(stampRowWidth([{ count: 1 }])).toBeCloseTo(31.5, 0);
		expect(stampRowWidth([{ count: 2 }])).toBeCloseTo(42.4, 0);
		expect(stampRowWidth([{ count: 2 }, { count: 1 }])).toBeCloseTo(42.4 + 4 + 31.5, 0);
		expect(stampRowWidth([{ count: 12 }])).toBeGreaterThan(stampRowWidth([{ count: 9 }]));
	});
});

describe("high-fives", () => {
	it("pair raised hands that meet, once each", () => {
		const hands = [
			{ id: 3, at: 1, x: 0, y: 0 },
			{ id: 1, at: 1, x: 10, y: 0 },
			{ id: 2, at: 1, x: 12, y: 2 },
			{ id: 4, at: 1, x: 500, y: 0 },
		];
		expect(highFives(hands, 20)).toEqual([[1, 2]]);
		expect(highFives(hands, 0)).toEqual([]);
	});
});
