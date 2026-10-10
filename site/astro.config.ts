import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";

export default defineConfig({
	site: "https://tack-docs.ascorbic.workers.dev",
	integrations: [
		starlight({
			title: "Tack",
			plugins: [starlightLinksValidator()],
		}),
	],
});
