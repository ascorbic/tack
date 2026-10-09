import { useCallback, useEffect, useRef, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import type { User } from "./presence.ts";

// In-progress gestures (resizing a section, drawing a connector) travel as
// awareness state, like drags in usePresence: other people see them live,
// and only the result is written to the document.

export interface Remote<T> {
	clientId: number;
	user?: User;
	value: T;
}

/**
 * One awareness field: everyone else's values, and a setter for ours that
 * publishes at most once a frame.
 */
export function useAwarenessField<T>(
	awareness: Awareness,
	field: string,
): [Remote<T>[], (value: T | null) => void] {
	const [remote, setRemote] = useState<Remote<T>[]>([]);

	useEffect(() => {
		let last = "";
		const onChange = () => {
			const next: Remote<T>[] = [];
			for (const [clientId, state] of awareness.getStates()) {
				if (clientId === awareness.clientID) continue;
				const value = (state as Record<string, unknown>)[field];
				if (value === null || value === undefined) continue;
				next.push({ clientId, user: (state as { user?: User }).user, value: value as T });
			}
			// Awareness changes for every cursor move; only re-render when this
			// field actually changed.
			const key = JSON.stringify(next);
			if (key === last) return;
			last = key;
			setRemote(next);
		};
		onChange();
		awareness.on("change", onChange);
		return () => awareness.off("change", onChange);
	}, [awareness, field]);

	const frame = useRef(0);
	const publish = useCallback(
		(value: T | null) => {
			cancelAnimationFrame(frame.current);
			if (value === null) {
				awareness.setLocalStateField(field, null);
				return;
			}
			frame.current = requestAnimationFrame(() => awareness.setLocalStateField(field, value));
		},
		[awareness, field],
	);

	useEffect(
		() => () => {
			cancelAnimationFrame(frame.current);
			if (awareness.getLocalState()) awareness.setLocalStateField(field, null);
		},
		[awareness, field],
	);

	return [remote, publish];
}
