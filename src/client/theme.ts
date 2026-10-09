// Light and dark themes. The viewer picks light, dark, or "system" (follow
// the operating system), and the choice is kept in localStorage. The tokens
// for each theme live in styles.css under [data-theme].

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

export const THEME_PREFERENCES: readonly ThemePreference[] = ["light", "dark", "system"];

export const THEME_STORAGE_KEY = "tack:theme";

/** A stored preference, or "system" for anything unrecognised. */
export function parsePreference(value: unknown): ThemePreference {
	return THEME_PREFERENCES.includes(value as ThemePreference)
		? (value as ThemePreference)
		: "system";
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
	if (preference === "system") return systemDark ? "dark" : "light";
	return preference;
}

/**
 * What a two-state theme switch should store when pressed, following Lea
 * Verou's pattern (https://lea.verou.me/blog/2026/dark-mode-toggles/): it
 * shows the theme you're seeing and switches to the opposite. The override is
 * only stored when it differs from the system, so switching back returns to
 * following the system rather than pinning a theme that happens to match.
 */
export function toggledPreference(current: Theme, systemDark: boolean): ThemePreference {
	const next: Theme = current === "dark" ? "light" : "dark";
	const system: Theme = systemDark ? "dark" : "light";
	return next === system ? "system" : next;
}
