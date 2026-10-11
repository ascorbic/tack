import { describe, expect, it } from "vite-plus/test";
import { LOOP_GUARD } from "../src/shared/customWidgets.ts";
import { guardLoops } from "../src/client/widgets/custom/guard.ts";

// Custom widgets' loop guards (#66): every loop checks in at the top of each
// turn, the code still means what it did, and code that doesn't parse is
// left for the browser to report.

/** Runs guarded code with a guard that throws after `limit` turns of any one loop. */
function run(code: string, limit = 1000): { result: unknown; turns: number } {
	let turns = 0;
	const guard = (state: { n?: number }, line: number) => {
		turns++;
		state.n = (state.n ?? 0) + 1;
		if (state.n > limit) throw new Error(`loop on line ${line}`);
	};
	// oxlint-disable-next-line no-implied-eval
	const fn = new Function(
		LOOP_GUARD,
		`${guardLoops(code)}\n;return typeof result === "undefined" ? undefined : result;`,
	);
	return { result: fn(guard), turns };
}

describe("guardLoops", () => {
	it("checks in on every turn of every kind of loop", () => {
		const code = `
			let result = 0;
			for (let i = 0; i < 3; i++) result++;
			for (const x of [1, 2]) { result += x; }
			for (const k in { a: 1 }) result += k.length;
			let j = 0;
			while (j < 2) j++;
			do { j--; } while (j > 0);
		`;
		const { result, turns } = run(code);
		expect(result).toBe(7);
		expect(turns).toBe(3 + 2 + 1 + 2 + 2);
	});

	it("stops a loop that never ends, naming its line", () => {
		expect(() => run("let result;\nwhile (true) {}", 50)).toThrow("loop on line 2");
		expect(() => run("for (;;);", 50)).toThrow("loop on line 1");
	});

	it("keeps labels, nested loops and unbraced bodies working", () => {
		const code = `
			let result = 0;
			outer: for (let i = 0; i < 3; i++)
				for (let j = 0; j < 3; j++) {
					if (j === 1) continue outer;
					if (i === 2) break outer;
					result++;
				}
			if (result) while (result < 5) result++;
			else result = -1;
			for (;false;) {}while (false) {}
		`;
		expect(run(code).result).toBe(5);
	});

	it("leaves code that doesn't parse as it is", () => {
		expect(guardLoops("while (true {")).toBe("while (true {");
	});

	it("leaves code without loops as it is", () => {
		const code =
			"const { items } = await tack.search('is:open');\ndocument.body.textContent = items.length;";
		expect(guardLoops(code)).toBe(code);
	});

	it("parses modules: imports, top-level await, for await", () => {
		const guarded = guardLoops("for await (const x of source()) { draw(x); }");
		expect(guarded).toContain(`${LOOP_GUARD}(`);
		expect(guarded).toMatch(/^\{ const __tack\$loop0 = .*for await .* \}$/s);
	});
});
