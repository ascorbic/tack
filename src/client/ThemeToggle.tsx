import type { ThemePreference } from "./theme.ts";
import { setThemePreference, useTheme } from "./useTheme.ts";

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
 * Light, dark, or follow the system. Icons only in the top bar; with
 * labels in the playground and gallery.
 */
export function ThemeToggle({ labelled = false }: { labelled?: boolean }) {
	const { preference } = useTheme();
	return (
		<div className="theme-toggle" role="radiogroup" aria-label="Theme" data-labelled={labelled}>
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
