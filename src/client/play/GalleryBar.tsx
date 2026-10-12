import { type ReactNode, useRef } from "react";
import type { Action } from "../actions/ActionBar.tsx";
import { BarItems, barEntries, useOverflow } from "../actions/BarParts.tsx";

const noop = () => {};

/**
 * A selection bar as the board draws it (ActionBar.tsx), for the galleries:
 * the same layout, words and emphasis, and, given a `limit` across, the
 * same "…" menu for what doesn't fit.
 */
export function GalleryBar({
	actions,
	leading,
	open,
	install,
	limit,
	section,
	label = "Stage changes",
}: {
	actions: (Omit<Action, "id"> & { id: string })[];
	/** A section's colour and display, before its groups. */
	leading?: ReactNode[];
	/** The action whose panel is showing. */
	open?: string;
	/** Cards without the app: the link to install it. */
	install?: boolean;
	/** How far across it may go before what doesn't fit goes in "…". */
	limit?: number;
	section?: boolean;
	label?: string;
}) {
	const bar = useRef<HTMLDivElement>(null);
	const more = useRef<HTMLButtonElement>(null);
	const entries = barEntries(
		actions.map((action) => ({ action, pressed: open === action.id, run: noop })),
	);
	const hidden = useOverflow(
		bar,
		entries,
		entries.map((entry) => `${entry.key}:${entry.action.text ?? ""}`).join("|"),
		limit ?? null,
	);
	return (
		<div
			ref={bar}
			className="selection-actions"
			role="toolbar"
			aria-label={label}
			data-section={section || undefined}
		>
			<BarItems
				leading={leading}
				entries={entries}
				hidden={hidden}
				more={more}
				menuLabel={section ? "More for this section" : "More for the selection"}
			/>
			{install && (
				<a className="selection-actions-install" href="#install">
					Install the app
				</a>
			)}
		</div>
	);
}
