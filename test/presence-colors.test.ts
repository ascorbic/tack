import { describe, expect, it } from "vite-plus/test";
import { COLORS, pickColor, yieldsColor } from "../src/client/presence.ts";

describe("people's colours on a board", () => {
	it("has twelve distinct colours", () => {
		expect(COLORS).toHaveLength(12);
		expect(new Set(COLORS).size).toBe(12);
	});

	it("keeps your colour while nobody else has it", () => {
		expect(pickColor([COLORS[3]], [COLORS[0]!, COLORS[1]!])).toBe(COLORS[3]);
	});

	it("takes the least used, in palette order, when yours is taken", () => {
		expect(pickColor([COLORS[0]], [COLORS[0]!, COLORS[1]!])).toBe(COLORS[2]);
		// The one you had here last time comes first.
		expect(pickColor([COLORS[5], COLORS[0]], [COLORS[0]!])).toBe(COLORS[5]);
	});

	it("gives eight people eight colours, whatever they'd have liked", () => {
		const taken: string[] = [];
		for (let i = 0; i < 8; i++) taken.push(pickColor([COLORS[0]], taken));
		expect(new Set(taken).size).toBe(8);
	});

	it("shares as evenly as it can past twelve", () => {
		const taken = [...COLORS];
		expect(pickColor([COLORS[4]], taken)).toBe(COLORS[4]);
		expect(pickColor([COLORS[4]], [...taken, COLORS[4]!])).toBe(COLORS[0]);
	});

	it("leaves a clash to whoever arrived second", () => {
		const first = { clientId: 9, color: COLORS[0]!, since: 100, who: "@kai" };
		const second = { clientId: 1, color: COLORS[0]!, since: 200, who: "@tom" };
		expect(yieldsColor(second, [first])).toBe(true);
		expect(yieldsColor(first, [second])).toBe(false);
		// Arriving at the same moment: the lower client id keeps it.
		expect(yieldsColor({ ...first, since: 200 }, [second])).toBe(true);
	});

	it("lets the same person share a colour across tabs", () => {
		const tab = { clientId: 2, color: COLORS[0]!, since: 100, who: "@kai" };
		expect(yieldsColor({ ...tab, clientId: 3, since: 200 }, [tab])).toBe(false);
	});

	it("doesn't shuffle colours when every one is taken", () => {
		const others = COLORS.map((color, i) => ({ clientId: i, color, since: 0, who: `~${i}` }));
		expect(yieldsColor({ clientId: 99, color: COLORS[0]!, since: 1, who: "@me" }, others)).toBe(
			false,
		);
	});
});
