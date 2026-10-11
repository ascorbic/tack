// The Deploy to Cloudflare button (#55) reads wrangler.jsonc, which is
// generated from cloudflare.config.ts. These keep the two, and the button's
// other inputs, in step with the Worker.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { WRANGLER_CONFIG, wranglerConfig } from "../scripts/wrangler-config.ts";

describe("what the Deploy to Cloudflare button reads", () => {
	it("wrangler.jsonc matches cloudflare.config.ts (run `node scripts/wrangler-config.ts`)", async () => {
		expect(readFileSync(WRANGLER_CONFIG, "utf8")).toBe(await wranglerConfig());
	});

	it("asks for exactly the secrets a new instance needs, with guidance", async () => {
		const text = await wranglerConfig();
		const config = JSON.parse(text.replace(/^\/\/.*$/gm, "")) as {
			name: string;
			secrets?: { required?: string[] };
		};
		const required = config.secrets?.required ?? [];
		expect(required).toEqual(["TACK_SECRET"]);

		// The button prompts for what's in .dev.vars.example: the same secrets,
		// with no value filled in, so nobody deploys with an example's.
		const example = readFileSync(".dev.vars.example", "utf8");
		const vars = [...example.matchAll(/^([A-Z_]+)=(.*)$/gm)];
		expect(vars.map((match) => match[1])).toEqual(required);
		for (const match of vars) expect(match[2]?.replace(/#.*/, "").trim()).toBe("");

		// And package.json describes each one for the button's form.
		const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
			cloudflare?: { bindings?: Record<string, { description?: string }> };
		};
		for (const name of required) {
			expect(pkg.cloudflare?.bindings?.[name]?.description).toMatch(/openssl rand/);
		}
	});

	it("deploys with cf, from the scripts the button pre-fills", () => {
		const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
			scripts: Record<string, string>;
		};
		expect(pkg.scripts.deploy).toMatch(/cf deploy/);
		expect(pkg.scripts.build).toBeTruthy();
	});
});
