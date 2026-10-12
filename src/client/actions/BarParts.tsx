import { Fragment, type ReactNode, type RefObject, useLayoutEffect, useState } from "react";
import { SECTION_COLORS, type SectionColor } from "../../shared/sections.ts";
import { isApplePlatform, shortcutHint } from "../shortcuts.ts";
import type { Action } from "./ActionBar.tsx";
import { MenuButton } from "./BarMenu.tsx";
import { type BarGroup, GROUPS, arrange, overflowing } from "./barLayout.ts";

// The parts every selection bar is made of (ActionBar.tsx): its buttons, in
// groups with a rule between them (barLayout.ts says which and in what
// order), a section's colour, and the "…" menu at its end for what doesn't
// fit across the canvas, rather than a second row.

const apple = isApplePlatform();

/** A button in the bar, which may go in its "…" menu. */
export interface BarEntry {
	key: string;
	group: BarGroup;
	action: Omit<Action, "id"> & { id: string };
	/** Showing its panel. */
	pressed: boolean;
	/** From the bar, or from the menu (with the menu's button, to come back to). */
	run: (event: React.MouseEvent<HTMLElement>, from: HTMLElement | null) => void;
	/** Never in the "…" menu: a setting, or the main action. */
	pinned: boolean;
	/** How much it matters: lower stays in the bar longer (barLayout.ts). */
	rank: number;
}

/** What a bar offers, before it's laid out. */
export interface BarSource {
	action: Omit<Action, "id"> & { id: string };
	pressed: boolean;
	run: BarEntry["run"];
}

/** A bar's buttons laid out: in groups, with their words and emphasis (barLayout.ts). */
export function barEntries(sources: readonly BarSource[]): BarEntry[] {
	return arrange(sources.map((source, index) => ({ ...source.action, index }))).map(
		({ item: { index, ...action }, group, pinned, rank }) => {
			const source = sources[index] as BarSource;
			return {
				key: `${action.id}-${index}`,
				group,
				action,
				pressed: source.pressed,
				run: source.run,
				pinned,
				rank,
			};
		},
	);
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

/** What didn't fit in the bar, in a menu at its end, each with its word. */
export function MoreMenu({
	entries,
	label,
	buttonRef,
}: {
	entries: BarEntry[];
	/** The menu's name, e.g. "More for this section". */
	label: string;
	buttonRef: RefObject<HTMLButtonElement | null>;
}) {
	return (
		<MenuButton
			label={label}
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
					return (
						<button
							key={entry.key}
							type="button"
							role="menuitem"
							className="bar-more-item"
							data-ruled={ruled || undefined}
							data-text={action.text && !action.quiet ? true : undefined}
							aria-disabled={action.unavailable ? true : undefined}
							aria-label={
								action.unavailable ? `${action.label}: ${action.unavailable}` : action.label
							}
							title={action.unavailable ?? action.tooltip ?? action.label}
							onClick={(event) => {
								event.stopPropagation();
								if (action.unavailable) return;
								close();
								entry.run(event, event.detail === 0 ? buttonRef.current : null);
							}}
						>
							{action.icon}
							<span>{action.text ?? action.label}</span>
						</button>
					);
				})
			}
		</MenuButton>
	);
}

/**
 * A bar's contents: what always leads it (a section's colour and display),
 * then its groups with a rule between each, then "…" with what's `hidden`.
 */
export function BarItems({
	leading = [],
	entries,
	hidden,
	more,
	menuLabel,
}: {
	leading?: ReactNode[];
	entries: readonly BarEntry[];
	hidden: ReadonlySet<string>;
	more: RefObject<HTMLButtonElement | null>;
	menuLabel: string;
}) {
	const visible = entries.filter((entry) => !hidden.has(entry.key));
	const overflow = entries.filter((entry) => hidden.has(entry.key));
	const parts: { key: string; node: ReactNode }[] = [
		...leading.map((node, i) => ({ key: `leading-${i}`, node })),
		...GROUPS.flatMap((group) => {
			const these = visible.filter((entry) => entry.group === group);
			return these.length === 0
				? []
				: [
						{
							key: group,
							node: these.map((entry) => (
								<ActionButton
									key={entry.key}
									action={entry.action}
									pressed={entry.pressed}
									overflow={entry.key}
									onClick={(event) => entry.run(event, null)}
								/>
							)),
						},
					];
		}),
	];
	return (
		<>
			{parts.map((part, i) => (
				<Fragment key={part.key}>
					{i > 0 && <BarDivider />}
					{part.node}
				</Fragment>
			))}
			{overflow.length > 0 && <MoreMenu entries={overflow} label={menuLabel} buttonRef={more} />}
		</>
	);
}

export function ActionButton({
	action,
	pressed,
	tabStop = true,
	overflow,
	onClick,
}: {
	action: Omit<Action, "id"> & { id: string };
	pressed: boolean;
	/** Whether Tab lands here: one button in the bar is (a roving tab stop). */
	tabStop?: boolean;
	/** Its key, where it may go in the bar's "…" menu. */
	overflow?: string;
	onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
	const hint = shortcutHint(action.id, apple);
	return (
		<button
			type="button"
			className="selection-action"
			data-text={action.text ? true : undefined}
			data-quiet={action.quiet || undefined}
			aria-label={action.unavailable ? `${action.label}: ${action.unavailable}` : action.label}
			aria-expanded={action.unavailable ? undefined : pressed}
			aria-haspopup={action.unavailable ? undefined : "dialog"}
			aria-disabled={action.unavailable ? true : undefined}
			data-tooltip={action.unavailable ?? action.tooltip ?? action.label}
			data-bar-item
			data-overflow={overflow}
			data-shortcut={action.unavailable ? "" : hint}
			tabIndex={tabStop ? 0 : -1}
			onClick={onClick}
		>
			{action.icon}
			{action.text && <span>{action.text}</span>}
		</button>
	);
}

/** Room the "…" button takes at the end of the bar, before it's been measured. */
const MORE_ROOM = 40;

/** Across, with its margins. */
function across(el: Element): number {
	const style = getComputedStyle(el);
	return (
		(el as HTMLElement).offsetWidth + parseFloat(style.marginLeft) + parseFloat(style.marginRight)
	);
}

const NONE: ReadonlySet<string> = new Set();

/**
 * Which of a bar's entries go in its "…" menu for it to fit within `limit`
 * pixels (barLayout.ts's `overflowing`). Each is measured with all of them
 * showing (a pass that's never painted: it's laid out and measured, then
 * cut down, before the frame is drawn), and measured again when what they
 * say changes (`content`); a changing limit needs no new measurement.
 */
export function useOverflow(
	bar: RefObject<HTMLElement | null>,
	entries: readonly BarEntry[],
	content: string,
	limit: number | null,
): ReadonlySet<string> {
	const [measured, setMeasured] = useState<{
		content: string;
		total: number;
		widths: Map<string, number>;
		divider: number;
		dividers: number;
		more: number;
	} | null>(null);
	const measuring = limit !== null && measured?.content !== content;
	useLayoutEffect(() => {
		const el = bar.current;
		if (!measuring || !el) return;
		const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
		const widths = new Map(
			entries.map((entry) => {
				const item = el.querySelector(`[data-overflow="${CSS.escape(entry.key)}"]`);
				return [entry.key, item ? across(item) + gap : 0] as const;
			}),
		);
		const rules = el.querySelectorAll(":scope > .bar-divider");
		const rule = rules[0];
		// The "…" button is as wide as it's tall, as the bar's icon buttons are.
		const button = el.querySelector<HTMLElement>(".selection-action");
		setMeasured({
			content,
			total: el.offsetWidth,
			widths,
			divider: rule ? across(rule) + gap : 0,
			dividers: rules.length,
			more: (button?.offsetHeight ?? MORE_ROOM) + gap,
		});
	});
	if (limit === null || measuring || !measured) return NONE;
	return overflowing({
		total: measured.total,
		limit,
		items: entries.map((entry) => ({
			key: entry.key,
			group: entry.group,
			width: measured.widths.get(entry.key) ?? 0,
			pinned: entry.pinned,
			rank: entry.rank,
		})),
		divider: measured.divider,
		dividers: measured.dividers,
		more: measured.more,
	});
}
