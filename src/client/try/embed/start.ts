import { THEME_STORAGE_KEY } from "../../theme.ts";
import { initTheme, setThemePreference } from "../../useTheme.ts";
import { startDemo } from "../start.ts";
import { hearPage } from "./bridge.ts";
import { keepThePageStill } from "./focus.ts";
import { type Feature, isFeature } from "./loop.ts";

/**
 * Make this page a live embed: the demo's promise (nothing leaves the
 * browser), and stricter, as the landing page mustn't spend the demo's AI
 * budget: it posts nowhere at all, so the stand-in always answers.
 */
export function startEmbed(): void {
	startDemo();
	keepThePageStill();
	const fetch = window.fetch;
	window.fetch = (input, init) => {
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		if (method !== "GET") {
			return Promise.reject(new TypeError("A live embed only reads its own files."));
		}
		return fetch(input, init);
	};
}

/** Which feature, from `?feature=`. */
export function featureOf(search = location.search): Feature {
	const asked = new URLSearchParams(search).get("feature");
	return isFeature(asked) ? asked : "stacks";
}

/**
 * The page's theme, from `?theme=` (the landing page's, as it was when the
 * embed was made), then whatever the page says as it changes, crossfading.
 * Without one, the system's.
 */
export function followPageTheme(search = location.search): void {
	const asked = new URLSearchParams(search).get("theme");
	if (asked === "light" || asked === "dark") {
		// The embed's storage is its own, and forgotten with it (sandbox.ts).
		localStorage.setItem(THEME_STORAGE_KEY, asked);
	}
	initTheme();
	if (asked === "light" || asked === "dark") setThemePreference(asked);
	hearPage((message) => {
		if (message.type === "theme") setThemePreference(message.theme);
	});
}
