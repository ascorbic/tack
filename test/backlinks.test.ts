import { describe, expect, it } from "vite-plus/test";
import {
	PUBLIC_AUDIENCE,
	audienceOf,
	backlinkBody,
	groupByAudience,
	hiddenFrom,
} from "../src/shared/backlinks.ts";

const pub = (key: string) => ({ key, public: true });
const priv = (key: string) => ({ key, public: false });

describe("snapshot audiences", () => {
	const site = pub("github.com/acme/site#1");
	const secret = priv("github.com/acme/secret#2");
	const board = [site, secret, priv("github.com/acme/secret#3"), priv("github.com/other/vault#4")];

	it("hides every private card from a public item's audience", () => {
		expect(audienceOf(site)).toBe(PUBLIC_AUDIENCE);
		expect([...hiddenFrom(PUBLIC_AUDIENCE, board)]).toEqual([
			"github.com/acme/secret#2",
			"github.com/acme/secret#3",
			"github.com/other/vault#4",
		]);
	});

	it("shows a private item's own repository, but not other private ones", () => {
		const audience = audienceOf(secret);
		expect(audience).toBe("github.com/acme/secret");
		expect([...hiddenFrom(audience, board)]).toEqual(["github.com/other/vault#4"]);
	});

	it("groups items that can share a snapshot", () => {
		const groups = groupByAudience([site, secret, board[2], pub("github.com/x/y#9")].flatMap((i) => (i ? [i] : [])));
		expect([...groups.keys()]).toEqual([PUBLIC_AUDIENCE, "github.com/acme/secret"]);
		expect(groups.get(PUBLIC_AUDIENCE)).toHaveLength(2);
	});
});

describe("backlinkBody", () => {
	it("links back to the board, with the snapshot", () => {
		expect(
			backlinkBody({
				boardUrl: "https://tack.example/b/abc/plan",
				boardTitle: "5.0 [planning]\nboard",
				snapshotUrl: "https://tack.example/snapshots/f00.png",
				note: " Grouped under 5.0 ",
			}),
		).toBe(
			[
				"Grouped under 5.0",
				"This is on [**5.0 planning board**](https://tack.example/b/abc/plan) in Tack.",
				"[![The board around this item](https://tack.example/snapshots/f00.png)](https://tack.example/b/abc/plan)",
			].join("\n\n"),
		);
	});

	it("works without a title or snapshot", () => {
		expect(backlinkBody({ boardUrl: "https://t/b/1" })).toBe(
			"This is on [a Tack board](https://t/b/1).",
		);
	});
});
