import { NodeToolbar, Position, ViewportPortal, useStore } from "@xyflow/react";
import type { ReactNode } from "react";
import type { ShapeNode } from "./board.ts";
import { type CommandId, isApplePlatform, shortcutHint } from "./shortcuts.ts";
import { unionRect } from "./snapping.ts";

// The frame around a multi-selection, and the small contextual toolbar above
// it for aligning, distributing and tidying.

type Size = { width: number; height: number };

const apple = isApplePlatform();

interface SelectionToolsProps {
	nodes: ShapeNode[];
	selected: Set<string>;
	sizeOf: (id: string) => Size | undefined;
	/** Hidden while dragging, so it doesn't get in the way. */
	dragging: boolean;
	onCommand: (id: CommandId) => void;
}

export function SelectionTools({
	nodes,
	selected,
	sizeOf,
	dragging,
	onCommand,
}: SelectionToolsProps) {
	const zoom = useStore((state) => state.transform[2]);
	if (selected.size < 2) return null;
	const rects = [];
	for (const node of nodes) {
		const size = sizeOf(node.id);
		if (selected.has(node.id) && size) rects.push({ ...node.position, ...size });
	}
	const bounds = unionRect(rects);
	const ids = [...selected];
	const many = selected.size >= 3;

	return (
		<>
			{bounds && (
				<ViewportPortal>
					<div
						className="selection-frame"
						aria-hidden="true"
						style={
							{
								"--zoom": zoom,
								left: bounds.x,
								top: bounds.y,
								width: bounds.width,
								height: bounds.height,
							} as React.CSSProperties
						}
					/>
				</ViewportPortal>
			)}
			<NodeToolbar nodeId={ids} isVisible={!dragging} position={Position.Top} offset={18}>
				<div className="arrange" role="toolbar" aria-label="Arrange selection">
					<span className="arrange-count">{selected.size}</span>
					<ArrangeButton id="alignLeft" label="Align left" onCommand={onCommand}>
						<path d="M3 2.5v13" />
						<rect x="5.5" y="4.5" width="9" height="3" rx="1" />
						<rect x="5.5" y="10.5" width="5.5" height="3" rx="1" />
					</ArrangeButton>
					<ArrangeButton id="alignCenter" label="Align centres horizontally" onCommand={onCommand}>
						<path d="M9 2.5v13" />
						<rect x="4" y="4.5" width="10" height="3" rx="1" />
						<rect x="5.75" y="10.5" width="6.5" height="3" rx="1" />
					</ArrangeButton>
					<ArrangeButton id="alignRight" label="Align right" onCommand={onCommand}>
						<path d="M15 2.5v13" />
						<rect x="3.5" y="4.5" width="9" height="3" rx="1" />
						<rect x="7" y="10.5" width="5.5" height="3" rx="1" />
					</ArrangeButton>
					<span className="arrange-divider" aria-hidden="true" />
					<ArrangeButton id="alignTop" label="Align top" onCommand={onCommand}>
						<path d="M2.5 3h13" />
						<rect x="4.5" y="5.5" width="3" height="9" rx="1" />
						<rect x="10.5" y="5.5" width="3" height="5.5" rx="1" />
					</ArrangeButton>
					<ArrangeButton id="alignMiddle" label="Align centres vertically" onCommand={onCommand}>
						<path d="M2.5 9h13" />
						<rect x="4.5" y="4" width="3" height="10" rx="1" />
						<rect x="10.5" y="5.75" width="3" height="6.5" rx="1" />
					</ArrangeButton>
					<ArrangeButton id="alignBottom" label="Align bottom" onCommand={onCommand}>
						<path d="M2.5 15h13" />
						<rect x="4.5" y="3.5" width="3" height="9" rx="1" />
						<rect x="10.5" y="7" width="3" height="5.5" rx="1" />
					</ArrangeButton>
					<span className="arrange-divider" aria-hidden="true" />
					<ArrangeButton
						id="distributeHorizontal"
						label="Distribute horizontally"
						disabled={!many}
						onCommand={onCommand}
					>
						<path d="M2.5 3v12M15.5 3v12" />
						<rect x="7.5" y="5" width="3" height="8" rx="1" />
					</ArrangeButton>
					<ArrangeButton
						id="distributeVertical"
						label="Distribute vertically"
						disabled={!many}
						onCommand={onCommand}
					>
						<path d="M3 2.5h12M3 15.5h12" />
						<rect x="5" y="7.5" width="8" height="3" rx="1" />
					</ArrangeButton>
					<ArrangeButton id="tidy" label="Tidy up" onCommand={onCommand}>
						<rect x="3" y="3" width="5" height="5" rx="1.2" />
						<rect x="10" y="3" width="5" height="5" rx="1.2" />
						<rect x="3" y="10" width="5" height="5" rx="1.2" />
						<rect x="10" y="10" width="5" height="5" rx="1.2" />
					</ArrangeButton>
				</div>
			</NodeToolbar>
		</>
	);
}

function ArrangeButton({
	id,
	label,
	disabled = false,
	onCommand,
	children,
}: {
	id: CommandId;
	label: string;
	disabled?: boolean;
	onCommand: (id: CommandId) => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			className="arrange-button"
			aria-label={label}
			data-tooltip={label}
			data-shortcut={shortcutHint(id, apple)}
			disabled={disabled}
			onClick={() => onCommand(id)}
		>
			<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
				{children}
			</svg>
		</button>
	);
}
