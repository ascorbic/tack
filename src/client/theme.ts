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
