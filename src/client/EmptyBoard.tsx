import { useLinger } from "./useLinger.ts";
import type { Tool } from "./Toolbar.tsx";

const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);

interface Hint {
	keys: string[];
	label: string;
	tool?: Tool;
}

const HINTS: Hint[] = [
	{ keys: [isMac ? "⌘" : "Ctrl", "V"], label: "Paste an issue or PR link" },
	{ keys: ["C"], label: "Find an issue or PR", tool: "card" },
	{ keys: ["S"], label: "Add a sticky", tool: "sticky" },
	{ keys: ["T"], label: "Write some text", tool: "text" },
	{ keys: ["W"], label: "Add a live list of issues", tool: "widget" },
	{ keys: ["/"], label: "Chat by your cursor" },
];

/**
 * A new board: a few notes pinned at jaunty angles, and the handful of
 * things worth knowing first. It steps aside as soon as anything lands.
 */
export function EmptyBoard({ empty, onTool }: { empty: boolean; onTool?: (tool: Tool) => void }) {
	// Linger on `true` so the guide can animate away once the board fills.
	const shown = useLinger(empty ? true : null, 360);
	if (!shown.value) return null;
	return (
		<div className="empty-board" data-leaving={shown.leaving}>
			<div className="empty-board-art" aria-hidden="true">
				<span className="empty-note" data-color="yellow" />
				<span className="empty-note" data-color="pink" />
				<span className="empty-note" data-color="blue" />
				<span className="empty-pin" />
			</div>
			<h2 className="empty-board-title">A blank board</h2>
			<p className="empty-board-lede">Bring in issues and ideas, and plan together.</p>
			<ul className="empty-board-hints">
				{HINTS.map((hint) => {
					const content = (
						<>
							<span className="empty-board-keys">
								{hint.keys.map((key) => (
									<kbd key={key}>{key}</kbd>
								))}
							</span>
							{hint.label}
						</>
					);
					return (
						<li key={hint.label}>
							{hint.tool && onTool ? (
								<button type="button" onClick={() => hint.tool && onTool(hint.tool)}>
									{content}
								</button>
							) : (
								<span>{content}</span>
							)}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
