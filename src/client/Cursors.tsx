import { useStore } from "@xyflow/react";
import type { RemotePresence } from "./presence.ts";

/**
 * Other people's cursors, kept at a constant size. They're drawn in their own
 * layer above the whole canvas, not inside React Flow's viewport, where
 * selected and dragged nodes are raised above everything and would cover the
 * cursor of the person moving them. The layer mirrors the viewport transform
 * so cursors stay locked to the board.
 */
export function Cursors({ people }: { people: RemotePresence[] }) {
	const [x, y, zoom] = useStore((state) => state.transform);
	return (
		<div className="cursors-layer" aria-hidden="true">
			<div
				className="cursors-viewport"
				style={{ transform: `translate(${x}px, ${y}px) scale(${zoom})` }}
			>
				{people.map(({ clientId, user, cursor }) => (
					<div
						key={clientId}
						className="cursor"
						style={
							{
								transform: `translate(${cursor.x}px, ${cursor.y}px) scale(${1 / zoom})`,
								"--cursor": user.color,
							} as React.CSSProperties
						}
					>
						<svg width="18" height="18" viewBox="0 0 18 18">
							<path d="M2 2l12 6-5 1.5L7 15z" />
						</svg>
						<span className="cursor-name">{user.name}</span>
					</div>
				))}
			</div>
		</div>
	);
}
