import { useEffect, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { shapesMap } from "../../shared/shapes.ts";
import { DotsIcon, HushIcon } from "./icons.tsx";

// Picking a section to start something on (silent mode or a dot vote) from
// the Facilitate menu: the board outlines its sections, and clicking one
// (or anything inside one) starts it there. A board without sections
// offers to make one in view.

export type PickKind = "silent" | "vote";

class SectionPicker {
	private kind: PickKind | null = null;
	private listeners = new Set<() => void>();

	start = (kind: PickKind): void => {
		this.kind = kind;
		this.emit();
	};

	cancel = (): void => {
		if (this.kind === null) return;
		this.kind = null;
		this.emit();
	};

	get = (): PickKind | null => this.kind;

	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

export const sectionPicker = new SectionPicker();

export function useSectionPicker(): PickKind | null {
	return useSyncExternalStore(sectionPicker.subscribe, sectionPicker.get);
}

/** The section a click picks: the shape itself, or the innermost section around it. */
export function sectionAt(doc: Y.Doc, id: string): string | null {
	const shapes = shapesMap(doc);
	const seen = new Set<string>();
	let current: string | null = id;
	while (current && !seen.has(current)) {
		seen.add(current);
		const shape = shapes.get(current);
		if (!shape) return null;
		if (shape.get("type") === "section") return current;
		const parent = shape.get("parent");
		current = typeof parent === "string" ? parent : null;
	}
	return null;
}

const WORDS: Record<PickKind, { verb: string; title: string }> = {
	silent: { verb: "start silent mode", title: "Silent writing" },
	vote: { verb: "vote on what’s in it", title: "Vote" },
};

/**
 * The hint while picking: what a click does, a way out, and, on a board
 * without sections, a way to make one.
 */
export function SectionPickerHint({
	kind,
	hasSections,
	onMake,
}: {
	kind: PickKind;
	hasSections: boolean;
	/** Make a section in view, titled for what's starting, and start it there. */
	onMake: (title: string) => void;
}) {
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.stopPropagation();
			sectionPicker.cancel();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, []);
	const Icon = kind === "silent" ? HushIcon : DotsIcon;
	const words = WORDS[kind];
	return (
		<div className="section-picker" role="status" data-chrome>
			<span className="section-picker-icon" aria-hidden="true">
				<Icon size={15} />
			</span>
			<span className="section-picker-text">
				{hasSections ? (
					<>Click a section to {words.verb}</>
				) : (
					<>No sections yet: make one to {words.verb}</>
				)}
			</span>
			{!hasSections && (
				<button
					type="button"
					className="section-picker-make"
					onClick={() => {
						sectionPicker.cancel();
						onMake(words.title);
					}}
				>
					Make one here
				</button>
			)}
			<button type="button" onClick={sectionPicker.cancel}>
				Cancel
				<kbd>Esc</kbd>
			</button>
		</div>
	);
}
