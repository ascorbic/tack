import { type RefObject, useLayoutEffect, useState } from "react";
import { SECTION_COLORS, type SectionColor } from "../../shared/sections.ts";
import type { Action } from "./ActionBar.tsx";
import { MenuButton } from "./BarMenu.tsx";

// A section selected on its own has one bar (ActionBar.tsx): its own tools
// (colour, how it shows what's in it, facilitation) and what it can become,
// in groups, above every shape. What doesn't fit across the screen, or over
// a section that's small on screen, goes in a "…" menu at its end, rather
// than into a second row.

/** A button in the bar that may go in its "…" menu. */
export interface BarEntry {
	key: string;
	group: "facilitate" | "actions";
	action: Omit<Action, "id"> & { id: string };
	/** Showing its panel. */
	pressed: boolean;
	/** From the bar, or from the menu (with the menu's button, to come back to). */
	run: (event: React.MouseEvent<HTMLElement>, from: HTMLElement | null) => void;
}

const COLOUR_NAMES: Record<SectionColor, string> = {
	grey: "Grey",
	red: "Red",
	orange: "Orange",
	yellow: "Yellow",
	green: "Green",
	blue: "Blue",
	purple: "Purple",
};

/** A thin rule between the bar's groups. */
export function BarDivider() {
	return <span className="bar-divider" aria-hidden="true" />;
}

/** The section's colour: its dot, and the others in a menu. */
export function SectionColour({
	color,
	onColor,
}: {
	color: SectionColor;
	onColor: (color: SectionColor) => void;
}) {
	return (
		<MenuButton
			label="Section colour"
			menuClassName="bar-swatches"
			button={{
				className: "selection-action bar-colour",
				"aria-label": `Colour: ${COLOUR_NAMES[color]}`,
				"data-tooltip": "Colour",
				children: (
					<>
						<span className="section-swatch bar-colour-dot" data-color={color} aria-hidden="true" />
						<Chevron />
					</>
				),
			}}
		>
			{(close) =>
				SECTION_COLORS.map((c) => (
					<button
						key={c}
						type="button"
						role="menuitemradio"
						aria-checked={c === color}
						aria-label={COLOUR_NAMES[c]}
						data-tooltip={COLOUR_NAMES[c]}
						className="section-swatch bar-swatch"
						data-color={c}
						onClick={(event) => {
							event.stopPropagation();
							onColor(c);
							close(event.detail === 0);
						}}
					/>
				))
			}
		</MenuButton>
	);
}

export function Chevron() {
	return (
		<svg className="bar-chevron" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
			<path d="M1.5 3 4 5.5 6.5 3" />
		</svg>
	);
}

function MoreIcon() {
	return (
		<svg className="action-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<circle cx="3.5" cy="8" r="1.3" fill="currentColor" />
			<circle cx="8" cy="8" r="1.3" fill="currentColor" />
			<circle cx="12.5" cy="8" r="1.3" fill="currentColor" />
		</svg>
	);
}

/** What didn't fit in the bar, in a menu at its end. */
export function MoreMenu({
	entries,
	buttonRef,
}: {
	entries: BarEntry[];
	buttonRef: RefObject<HTMLButtonElement | null>;
}) {
	return (
		<MenuButton
			label="More for this section"
			menuClassName="bar-more"
			buttonRef={buttonRef}
			button={{
				className: "selection-action bar-more-button",
				"aria-label": "More",
				"data-tooltip": "More",
				children: <MoreIcon />,
			}}
		>
			{(close) =>
				entries.map((entry, i) => {
					const { action } = entry;
					// The group's first, after the last group's: a rule between them.
					const ruled = i > 0 && entries[i - 1]?.group !== entry.group;
					const name = action.text && !action.quiet ? action.text : action.label;
					return (
						<button
							key={entry.key}
							type="button"
							role="menuitem"
							className="bar-more-item"
							data-ruled={ruled || undefined}
							data-text={action.text && !action.quiet ? true : undefined}
							aria-disabled={action.unavailable ? true : undefined}
							aria-label={action.unavailable ? `${name}: ${action.unavailable}` : undefined}
							title={action.unavailable ?? action.tooltip ?? action.label}
							onClick={(event) => {
								event.stopPropagation();
								if (action.unavailable) return;
								close();
								entry.run(event, event.detail === 0 ? buttonRef.current : null);
							}}
						>
							{action.icon}
							<span>{name}</span>
						</button>
					);
				})
			}
		</MenuButton>
	);
}

/** Room the "…" button takes at the end of the bar, before it's been measured. */
const MORE_ROOM = 40;

/**
 * How many of `keys` fit in the bar within `limit` pixels, the rest going
 * in its "…" menu. Each is measured where it is with all of them showing
 * (a pass that's never painted: it's laid out and measured, then cut down,
 * before the frame is drawn), and measured again when what they say
 * changes (`content`); a changing limit needs no new measurement.
 */
export function useOverflow(
	bar: RefObject<HTMLElement | null>,
	keys: readonly string[],
	content: string,
	limit: number | null,
): number {
	const [measured, setMeasured] = useState<{
		content: string;
		ends: number[];
		trailing: number;
		more: number;
	} | null>(null);
	const measuring = limit !== null && measured?.content !== content;
	useLayoutEffect(() => {
		const el = bar.current;
		if (!measuring || !el) return;
		const ends = keys.map((key) => {
			const item = el.querySelector<HTMLElement>(`[data-overflow="${CSS.escape(key)}"]`);
			return item ? item.offsetLeft + item.offsetWidth : 0;
		});
		const last = ends.at(-1) ?? 0;
		const style = getComputedStyle(el);
		const trailing =
			keys.length > 0
				? el.offsetWidth - last
				: parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth);
		const gap = parseFloat(style.columnGap) || 0;
		// The "…" button is as wide as it's tall, as the bar's icon buttons are.
		const button = el.querySelector<HTMLElement>(".selection-action");
		setMeasured({ content, ends, trailing, more: (button?.offsetHeight ?? MORE_ROOM) + gap });
	});
	if (limit === null || measuring || !measured) return keys.length;
	const { ends, trailing, more } = measured;
	if ((ends.at(-1) ?? 0) + trailing <= limit) return keys.length;
	let shown = 0;
	while (shown < ends.length && (ends[shown] ?? 0) + more + trailing <= limit) shown++;
	return shown;
}
