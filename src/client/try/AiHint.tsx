import { useEffect, useState, useSyncExternalStore } from "react";
import type { Fallback } from "./ai.ts";
import type { HintStore } from "./hints.ts";
import "./aiHint.css";

// A quiet word when the demo's stand-in AI answers instead of the real one
// (src/client/try/ai.ts): a small pill above the toolbar for a few
// seconds, saying why in a few words (hints.ts decides when).

const SHOWN_MS = 4500;

const WHY: Record<Fallback, string> = {
	unreachable: "the real one is out of reach",
	rate_limited: "lots of requests just now",
	busy: "the real one has had a busy day",
	failed: "the real one didn’t answer",
	timeout: "the real one took too long",
};

export function AiHint({ store }: { store: HintStore }) {
	const hint = useSyncExternalStore(store.subscribe, store.getSnapshot);
	// Kept for its way out.
	const [shown, setShown] = useState(hint);
	useEffect(() => {
		if (!hint) return;
		setShown(hint);
		const timer = window.setTimeout(store.hide, SHOWN_MS);
		return () => clearTimeout(timer);
	}, [hint, store]);
	if (!shown) return null;
	return (
		<div className="try-ai-hint-wrap" role="status" aria-live="polite">
			<div
				key={shown.at}
				className="try-ai-hint"
				data-leaving={hint ? undefined : ""}
				onAnimationEnd={(event) => {
					if (!hint && event.animationName === "try-ai-hint-out") setShown(null);
				}}
			>
				<span className="try-ai-hint-dot" aria-hidden="true" />
				Using the offline stand-in
				<span className="try-ai-hint-why">· {WHY[shown.why]}</span>
			</div>
		</div>
	);
}
