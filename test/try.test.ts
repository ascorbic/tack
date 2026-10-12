import { describe, expect, it } from "vite-plus/test";
import { staysHere } from "../src/client/try/network.ts";
import { forgeName, forgeNameOf, nameForge } from "../src/shared/refs.ts";

// The public demo's pure parts (#75): what counts as staying in the browser,
// and the pretend forge named as such in copy. (On the page, end to end, in
// e2e/try.spec.ts.)

const FILES = "https://tack.social/try/";

describe("staying in the browser", () => {
	it("allows the demo's own files and data it made", () => {
		expect(staysHere("https://tack.social/try/assets/geist.woff2", FILES)).toBe(true);
		expect(staysHere("assets/index.css", FILES)).toBe(true);
		expect(staysHere("/try/", FILES)).toBe(true);
		expect(staysHere("data:image/png;base64,AAAA", FILES)).toBe(true);
		expect(staysHere("blob:https://tack.social/0b7c", FILES)).toBe(true);
	});

	it("refuses anywhere else, the rest of its own site included", () => {
		expect(staysHere("https://example.com/try/", FILES)).toBe(false);
		expect(staysHere("https://tack.social/api/boards", FILES)).toBe(false);
		expect(staysHere("/start/tour/", FILES)).toBe(false);
		expect(staysHere("https://tack.social.example.com/try/", FILES)).toBe(false);
		expect(staysHere("//example.com/try/x", FILES)).toBe(false);
		expect(staysHere("wss://tack.social/try/", FILES)).toBe(false);
		expect(staysHere("http://[", FILES)).toBe(false);
	});
});

describe("the demo forge", () => {
	it("is what copy calls the pretend forge, and what it names when nothing says", () => {
		expect(forgeNameOf([])).toBe("GitHub");
		nameForge("fake.tack", "the demo forge", { byDefault: true });
		expect(forgeName("fake.tack")).toBe("the demo forge");
		expect(forgeNameOf(["fake.tack/ascorbic/tack#1"])).toBe("the demo forge");
		expect(forgeNameOf([])).toBe("the demo forge");
		expect(forgeName("github.com")).toBe("GitHub");
	});
});
