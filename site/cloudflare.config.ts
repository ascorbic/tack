import { defineConfig } from "cf/config";

// The docs site: static files only, served by Workers static assets. There's
// no entrypoint, so no Worker code runs; requests that don't match a file get
// the site's 404 page.
export default defineConfig({
	worker: {
		name: "tack-docs",
		compatibilityDate: "2026-10-06",
		assets: {
			htmlHandling: "auto-trailing-slash",
			notFoundHandling: "404-page",
		},
		observability: {
			enabled: true,
		},
	},
});
