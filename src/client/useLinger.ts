import { useEffect, useState } from "react";
import { scaledDuration } from "./motion.ts";

/**
 * Keep showing the last value for a moment after it goes away, so it can
 * animate out. Returns the value to show and whether it's leaving.
 */
export function useLinger<T>(value: T | null, ms: number): { value: T | null; leaving: boolean } {
	const [shown, setShown] = useState<{ value: T | null; leaving: boolean }>({
		value,
		leaving: false,
	});

	useEffect(() => {
		if (value !== null) {
			setShown({ value, leaving: false });
			return;
		}
		setShown((current) => (current.value === null ? current : { ...current, leaving: true }));
		const timer = setTimeout(() => setShown({ value: null, leaving: false }), scaledDuration(ms));
		return () => clearTimeout(timer);
	}, [value, ms]);

	// Show a new value straight away, without waiting for the effect.
	return value !== null ? { value, leaving: false } : shown;
}
