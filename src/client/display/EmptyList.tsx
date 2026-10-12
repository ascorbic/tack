import { type CSSProperties, useEffect, useState } from "react";
import { type SectionLayout, emptyState } from "../../shared/display.ts";
import { scaledDuration } from "../motion.ts";
import type { ZoomTier } from "./DisplayItem.tsx";

// An empty list or grid of mini cards (#72): a few faint placeholder rows (or
// a line of mini cards) in the section's own colour, just where the first
// things dropped in will go, and a line beneath saying what goes here. It's
// as tall as the layout says (`emptyState` in display.ts), so it reads as a
// column waiting to be filled rather than an unfinished strip. Held over, the
// placeholders the drop will take light up; once something lands it fades
// as the list shrinks to its rows.

/** How long the empty state takes to fade once the first thing lands (display.css). */
const LEAVE_MS = 220;

const DROP = "Drop issues, pull requests or stickies here";

export interface EmptyListProps {
	mode: "list" | "mini";
	/** The list's size, as laid out. */
	width: number;
	height: number;
	/** What the section says goes in it (a template's), in place of the usual words. */
	prompt?: string;
	/** Whether the person looking can drop things in: an editor, not on a phone. */
	canDrop: boolean;
	/** How many things are held over it, about to land. */
	dropping: number;
	tier: ZoomTier;
	/** The first thing just landed: fading away. */
	leaving?: boolean;
	/** The last thing just left: coming back. */
	entering?: boolean;
}

/** What an empty list says: its prompt, or what to drop, or (read-only) that it's empty. */
export function emptyWords({
	prompt,
	canDrop,
	dropping,
}: Pick<EmptyListProps, "prompt" | "canDrop" | "dropping">): {
	title: string;
	hint: string | null;
} {
	if (dropping > 0) {
		return {
			title:
				dropping === 1
					? "Let go to add it"
					: dropping === 2
						? "Let go to add both"
						: `Let go to add all ${dropping}`,
			hint: null,
		};
	}
	const told = prompt?.trim();
	if (told) {
		return {
			title: told,
			hint: canDrop
				? "Drop issues, pull requests or stickies, or paste a link"
				: "Nothing here yet",
		};
	}
	return canDrop
		? { title: DROP, hint: "or paste a link" }
		: { title: "Nothing here yet", hint: null };
}

/** The empty state itself, drawn inside its section from the top-left corner. */
export function EmptyList(props: EmptyListProps) {
	const { mode, width, height, dropping, tier, leaving, entering } = props;
	const list: SectionLayout = {
		id: "",
		mode,
		box: { x: 0, y: 0, w: width, h: height },
		order: [],
		nested: false,
		empty: true,
	};
	const state = emptyState(list, dropping);
	if (!state) return null;
	const { title, hint } = emptyWords(props);
	const place = (rect: { x: number; y: number; w: number; h: number }): CSSProperties => ({
		left: rect.x,
		top: rect.y,
		width: rect.w,
		height: rect.h,
	});
	return (
		<div
			className="list-empty"
			data-mode={mode}
			data-tier={tier}
			data-dropping={dropping > 0 || undefined}
			data-leaving={leaving || undefined}
			data-entering={entering || undefined}
			aria-hidden="true"
		>
			{state.placeholders.map((rect, i) => (
				<span
					key={i}
					className="list-empty-slot"
					data-held={i < dropping || undefined}
					style={{ ...place(rect), "--i": i } as CSSProperties}
				>
					<span className="list-empty-bit" />
					<span className="list-empty-bit" />
					{mode === "mini" && <span className="list-empty-bit" />}
				</span>
			))}
			{tier !== "far" && state.note.h >= 24 && (
				<span className="list-empty-note" style={place(state.note)}>
					<span key={title} className="list-empty-title">
						{title}
					</span>
					{tier === "full" && hint && <span className="list-empty-hint">{hint}</span>}
				</span>
			)}
		</div>
	);
}

/**
 * Whether a list's empty state shows, and how: kept a moment after the first
 * thing lands so it can fade as the list shrinks, and marked as coming back
 * when the last thing leaves (not when the board first draws it).
 */
export function useEmptyPresence(empty: boolean): {
	shown: boolean;
	leaving: boolean;
	entering: boolean;
} {
	const [last, setLast] = useState(empty);
	const [phase, setPhase] = useState<"still" | "entering" | "leaving">("still");
	const [shown, setShown] = useState(empty);
	if (last !== empty) {
		setLast(empty);
		if (empty) {
			setShown(true);
			setPhase("entering");
		} else {
			setPhase("leaving");
		}
	}
	useEffect(() => {
		if (phase !== "leaving") return;
		const timer = setTimeout(() => {
			setShown(false);
			setPhase("still");
		}, scaledDuration(LEAVE_MS));
		return () => clearTimeout(timer);
	}, [phase]);
	return { shown, leaving: phase === "leaving", entering: phase === "entering" };
}
