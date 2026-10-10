import { useId } from "react";
import type { ThemePreference } from "./theme.ts";
import { setThemePreference, toggleTheme, useTheme } from "./useTheme.ts";

const OPTIONS: { value: ThemePreference; label: string; icon: React.ReactNode }[] = [
	{
		value: "light",
		label: "Light",
		icon: (
			<>
				<circle cx="8" cy="8" r="2.75" />
				<path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05" />
			</>
		),
	},
	{
		value: "dark",
		label: "Dark",
		icon: <path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1z" />,
	},
	{
		value: "system",
		label: "System",
		icon: (
			<>
				<rect x="2" y="3" width="12" height="8.5" rx="1.5" />
				<path d="M6 14h4M8 11.5V14" />
			</>
		),
	},
];

/**
 * The top bar gets a two-state switch: it shows the theme you're seeing and
 * flips to the other one. "System" is the default rather than a choice you
 * press (see toggledPreference). The playground and gallery, which are
 * settings-like, get the explicit three-way control with labels.
 */
export function ThemeToggle({ labelled = false }: { labelled?: boolean }) {
	if (!labelled) return <ThemeSwitch />;
	return <ThemeChoice />;
}

function ThemeSwitch() {
	const { preference, theme } = useTheme();
	const target = theme === "dark" ? "light" : "dark";
	const following = preference === "system" ? " (following your system)" : "";
	return (
		<button
			type="button"
			className="theme-switch"
			data-theme-shown={theme}
			aria-label={`Switch to ${target} theme`}
			title={`${theme === "dark" ? "Dark" : "Light"} theme${following}. Switch to ${target}`}
			onClick={toggleTheme}
		>
			<svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
				<g className="theme-switch-sun">{OPTIONS[0]?.icon}</g>
				<g className="theme-switch-moon">{OPTIONS[1]?.icon}</g>
			</svg>
		</button>
	);
}

/**
 * Theme in the account menu: a set-once preference, so it lives there
 * rather than in the top bar. Light, dark, or following the system.
 */
export function ThemeMenuRow() {
	const id = useId();
	return (
		<div className="account-theme">
			<span id={id}>Theme</span>
			<ThemeChoice labelled={false} labelledBy={id} />
		</div>
	);
}

function ThemeChoice({ labelled = true, labelledBy }: { labelled?: boolean; labelledBy?: string }) {
	const { preference } = useTheme();
	return (
		<div
			className="theme-toggle"
			role="radiogroup"
			aria-label={labelledBy ? undefined : "Theme"}
			aria-labelledby={labelledBy}
			data-labelled={labelled}
		>
			{OPTIONS.map((option) => (
				<button
					key={option.value}
					type="button"
					role="radio"
					aria-checked={preference === option.value}
					aria-label={labelled ? undefined : `${option.label} theme`}
					title={labelled ? undefined : option.label}
					onClick={() => setThemePreference(option.value)}
				>
					<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
						{option.icon}
					</svg>
					{labelled && option.label}
				</button>
			))}
		</div>
	);
}
