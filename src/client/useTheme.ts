import { useSyncExternalStore } from "react";
import { scaledDuration } from "./motion.ts";
import {
	THEME_STORAGE_KEY,
	type Theme,
	type ThemePreference,
	parsePreference,
	resolveTheme,
	toggledPreference,
} from "./theme.ts";

// The theme is page-wide state outside React: a preference in localStorage,
// the system setting from a media query, and the resolved theme applied as
// `data-theme` on the root element.

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function readPreference(): ThemePreference {
	try {
		return parsePreference(localStorage.getItem(THEME_STORAGE_KEY));
	} catch {
		return "system";
	}
}

let state = snapshot(readPreference());

function snapshot(preference: ThemePreference) {
	return { preference, theme: resolveTheme(preference, darkQuery.matches) };
}

function apply() {
	document.documentElement.dataset.theme = state.theme;
}

function update(preference: ThemePreference) {
	const next = snapshot(preference);
	if (next.preference === state.preference && next.theme === state.theme) return;
	state = next;
	apply();
	for (const listener of listeners) listener();
}

/**
 * Apply the saved theme before the first render, so the board never
 * flashes the wrong one, and keep following the system and other tabs.
 */
export function initTheme(): void {
	apply();
	darkQuery.addEventListener("change", () => update(state.preference));
	window.addEventListener("storage", (event) => {
		if (event.key === THEME_STORAGE_KEY) update(parsePreference(event.newValue));
	});
}

/** Choose a theme. The change cross-fades, unless motion is reduced. */
export function setThemePreference(preference: ThemePreference): void {
	try {
		if (preference === "system") localStorage.removeItem(THEME_STORAGE_KEY);
		else localStorage.setItem(THEME_STORAGE_KEY, preference);
	} catch {}
	const changes = resolveTheme(preference, darkQuery.matches) !== state.theme;
	if (changes && "startViewTransition" in document && scaledDuration(1) > 0) {
		document.startViewTransition(() => update(preference));
	} else {
		update(preference);
	}
}

/** Switch to the opposite of the theme being shown (see toggledPreference). */
export function toggleTheme(): void {
	setThemePreference(toggledPreference(state.theme, darkQuery.matches));
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useTheme(): { preference: ThemePreference; theme: Theme } {
	return useSyncExternalStore(subscribe, () => state);
}
