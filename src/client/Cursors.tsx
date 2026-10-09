import { useStore } from "@xyflow/react";
import { memo } from "react";
import type { Status } from "./activity.ts";
import { CHAT_FADE_MS, type Chat } from "./chat.ts";
import { ChatBubble } from "./CursorChat.tsx";
import type { RemotePresence, User } from "./presence.ts";
import { useLinger } from "./useLinger.ts";

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
				{people.map(
					({ clientId, user, cursor, chat, status }) =>
						cursor && (
							<Cursor
								key={clientId}
								user={user}
								x={cursor.x}
								y={cursor.y}
								zoom={zoom}
								chat={chat}
								status={status}
							/>
						),
				)}
			</div>
		</div>
	);
}

const Cursor = memo(function Cursor({
	x,
	y,
	zoom,
	...view
}: {
	user: User;
	x: number;
	y: number;
	zoom: number;
	chat: Chat | null;
	status: Status;
}) {
	return (
		<CursorView {...view} style={{ transform: `translate(${x}px, ${y}px) scale(${1 / zoom})` }} />
	);
});

/** A cursor with its name tag, or a chat bubble while they're talking. */
export function CursorView({
	user,
	chat,
	status = "active",
	style,
}: {
	user: User;
	chat: Chat | null;
	status?: Status;
	style?: React.CSSProperties;
}) {
	const bubble = useLinger(chat, CHAT_FADE_MS);
	return (
		<div
			className="cursor"
			data-status={status}
			style={{ ...style, "--cursor": user.color } as React.CSSProperties}
		>
			<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
				<path d="M2 2l12 6-5 1.5L7 15z" />
			</svg>
			{bubble.value ? (
				<ChatBubble name={user.name} chat={bubble.value} leaving={bubble.leaving} />
			) : (
				<span className="cursor-name">
					{user.name}
					{status !== "active" && <span className="cursor-status"> · {status}</span>}
				</span>
			)}
		</div>
	);
}
