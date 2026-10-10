import { describe, expect, it } from "vite-plus/test";
import { mentionsIn } from "../src/shared/mentions.ts";

describe("mentionsIn", () => {
	const at = { host: "github.com", repo: "acme/widgets", self: "github.com/acme/widgets#40" };

	it("finds bare, cross-repository and linked references, once each", () => {
		expect(
			mentionsIn(
				"See #12 and acme/gears#3, also https://github.com/Acme/Other/issues/9 and #12 again",
				at,
			),
		).toEqual([
			{ key: "github.com/acme/widgets#12", closes: false },
			{ key: "github.com/acme/gears#3", closes: false },
			{ key: "github.com/acme/other#9", closes: false },
		]);
	});

	it("knows closing keywords, which win over a plain mention", () => {
		expect(mentionsIn("Relates to #12.\n\nFixes: #12, closes acme/gears#3", at)).toEqual([
			{ key: "github.com/acme/widgets#12", closes: true },
			{ key: "github.com/acme/gears#3", closes: true },
		]);
	});

	it("ignores code, itself, and things that only look like references", () => {
		expect(mentionsIn("`#12` ```\nfixes #13\n``` #40 abc#14 color: #fff", at)).toEqual([]);
	});
});
