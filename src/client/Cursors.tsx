import { ViewportPortal, useStore } from "@xyflow/react";
import type { RemotePresence } from "./presence.ts";

/** Other people's cursors, drawn in flow space but kept at a constant size. */
export function Cursors({ people }: { people: RemotePresence[] }) {
	const zoom = useStore((state) => state.transform[2]);
	return (
		<ViewportPortal>
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
					<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
						<path d="M2 2l12 6-5 1.5L7 15z" />
					</svg>
					<span className="cursor-name">{user.name}</span>
				</div>
			))}
		</ViewportPortal>
	);
}
