import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { redeliver, redeliverFailedWebhooks } from "../src/server/github/redeliver.ts";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function delivery(id: number, guid: string, status_code: number, minutes: number) {
	return {
		id,
		guid,
		status_code,
		delivered_at: minutesAgo(minutes),
		redelivery: false,
		event: "x",
	};
}

/** A fake of GitHub's app delivery endpoints, newest first, paged. */
function stubGitHub(pages: ReturnType<typeof delivery>[][]) {
	const posts: string[] = [];
	const fetch = vi.fn(async (input: string, init?: RequestInit) => {
		const url = new URL(input);
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer app-jwt");
		if (init?.method === "POST") {
			posts.push(url.pathname);
			return new Response(null, { status: 202 });
		}
		const page = Number(url.searchParams.get("cursor") ?? 0);
		const headers = new Headers();
		if (page + 1 < pages.length) {
			headers.set(
				"link",
				`<https://api.github.com/app/hook/deliveries?per_page=100&cursor=${page + 1}>; rel="next"`,
			);
		}
		return Response.json(pages[page] ?? [], { headers });
	});
	vi.stubGlobal("fetch", fetch);
	return { fetch, posts };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("webhook redelivery", () => {
	it("redelivers failures, once they're worth retrying", async () => {
		const { posts } = stubGitHub([
			[
				delivery(10, "fails-once", 500, 5),
				// Failed, then a redelivery succeeded.
				delivery(9, "recovered", 200, 6),
				delivery(8, "recovered", 502, 20),
				// Never reached us.
				delivery(7, "timeout", 0, 30),
			],
			[
				// Failed every time: give up.
				delivery(6, "hopeless", 500, 40),
				delivery(5, "hopeless", 500, 50),
				delivery(4, "hopeless", 500, 60),
				// Rejected on purpose, e.g. a bad signature.
				delivery(3, "rejected", 401, 70),
				delivery(2, "fine", 202, 80),
			],
		]);

		const report = await redeliver("app-jwt", { now: NOW });
		expect(report).toEqual({
			status: "done",
			checked: 6,
			failed: 3,
			redelivered: ["fails-once", "timeout"],
			gaveUp: ["hopeless"],
		});
		expect(posts).toEqual(["/app/hook/deliveries/10/attempts", "/app/hook/deliveries/7/attempts"]);
	});

	it("only looks back as far as its window", async () => {
		const { fetch, posts } = stubGitHub([
			[delivery(3, "recent", 200, 10), delivery(2, "old", 500, 9 * 60)],
			[delivery(1, "older", 500, 10 * 60)],
		]);
		const report = await redeliver("app-jwt", { now: NOW, windowMs: 6 * 60 * 60_000 });
		expect(report).toMatchObject({ checked: 1, redelivered: [] });
		expect(posts).toEqual([]);
		// The first page reached past the window, so the second wasn't read.
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("reports a failure to list deliveries", async () => {
		vi.stubGlobal("fetch", async () => new Response("nope", { status: 401 }));
		expect(await redeliver("app-jwt", { now: NOW })).toEqual({
			status: "error",
			reason: "listing deliveries: 401",
		});
	});

	it("skips without a GitHub App, without calling GitHub", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		expect(await redeliverFailedWebhooks({} as Env)).toEqual({
			status: "skipped",
			reason: "no GitHub App configured",
		});
		expect(fetch).not.toHaveBeenCalled();
	});
});
