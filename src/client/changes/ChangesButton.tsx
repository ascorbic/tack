import { useEffect, useRef, useState } from "react";
import { useChangesUI } from "./context.ts";
import { isInFlight, isPending } from "./describe.ts";
import { OutboxIcon } from "./icons.tsx";
import { useChangeList } from "./store.ts";

/**
 * The way into the changes panel, in the top bar: a tray with a count of
 * what's staged. Something new drops into the tray; failures turn the badge
 * red; while a push is going, a ring runs round it.
 */
export function ChangesButton() {
	const ui = useChangesUI();
	const changes = useChangeList(ui?.store ?? null);
	const pending = changes.filter(isPending);
	const failed = pending.some((change) => change.status === "failed");
	const pushing = changes.some(isInFlight);
	const count = pending.length;

	// Drop something into the tray whenever the count goes up.
	const previous = useRef(count);
	const [drops, setDrops] = useState(0);
	useEffect(() => {
		if (count > previous.current) setDrops((n) => n + 1);
		previous.current = count;
	}, [count]);

	if (!ui) return null;
	const label = [
		"Changes",
		count > 0 ? `${count} staged` : null,
		failed ? "some failed" : null,
		pushing ? "pushing" : null,
	]
		.filter(Boolean)
		.join(", ");

	return (
		<button
			type="button"
			className="changes-button"
			aria-label={label}
			aria-expanded={ui.panelOpen}
			data-open={ui.panelOpen || undefined}
			data-pushing={pushing || undefined}
			data-failed={failed || undefined}
			onClick={() => ui.setPanelOpen(!ui.panelOpen)}
		>
			<span className="changes-button-icon" key={drops} data-drop={drops > 0 || undefined}>
				<OutboxIcon />
			</span>
			Changes
			{count > 0 && (
				<span className="changes-badge" key={`b${count}`} aria-hidden="true">
					{count}
				</span>
			)}
		</button>
	);
}
