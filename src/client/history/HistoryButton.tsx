import { isApplePlatform, shortcutHint } from "../shortcuts.ts";
import { HistoryIcon } from "./parts.tsx";

/** The top bar's History button: the clock's hands sweep back when it opens. */
export function HistoryButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
	return (
		<button
			type="button"
			className="history-button"
			aria-pressed={open}
			data-tooltip="History"
			data-shortcut={shortcutHint("history", isApplePlatform())}
			onClick={onToggle}
		>
			<HistoryIcon />
			<span className="history-button-label topbar-label">History</span>
		</button>
	);
}
