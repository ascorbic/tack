import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { onGesture } from "./facilitation/gestures.ts";
import type { Awareness } from "y-protocols/awareness";
import {
	CHAT_FADE_MS,
	CHAT_IDLE_MS,
	CHAT_LINGER_MS,
	CHAT_MAX_LENGTH,
	type Chat,
	cleanChat,
	opensChat,
} from "./chat.ts";
import { isEditableTarget } from "./keys.ts";
import type { User } from "./presence.ts";
import { useLinger } from "./useLinger.ts";

/** Where the bubble sits relative to the pointer: below and to the right. */
const OFFSET = { x: 14, y: 18 };

/**
 * Your own cursor chat. Press "/" (when not typing in something else) and a
 * bubble opens by your pointer; what you type is shared live. Enter sends
 * it and it lingers for a few seconds, Escape clears it, and a bubble left
 * alone sends itself.
 */
export function CursorChat({ awareness, user }: { awareness: Awareness; user: User }) {
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const [sent, setSent] = useState<string | null>(null);
	const bubble = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const pointer = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
	// Set once the bubble is closing, so the input's blur on the way out
	// doesn't send it again.
	const closing = useRef(false);

	const place = useCallback(() => {
		const el = bubble.current;
		if (el) {
			el.style.transform = `translate(${pointer.current.x + OFFSET.x}px, ${pointer.current.y + OFFSET.y}px)`;
		}
	}, []);

	// Follow the pointer without re-rendering.
	useEffect(() => {
		const onMove = (event: PointerEvent) => {
			pointer.current = { x: event.clientX, y: event.clientY };
			place();
		};
		window.addEventListener("pointermove", onMove, { passive: true });
		return () => window.removeEventListener("pointermove", onMove);
	}, [place]);

	const shown = useLinger(sent, CHAT_FADE_MS);
	const visible = open || shown.value !== null;
	useLayoutEffect(() => {
		if (visible) place();
	}, [visible, place]);

	useEffect(() => {
		if (open) input.current?.focus();
	}, [open]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (!opensChat(event, isEditableTarget(event.target))) return;
			event.preventDefault();
			closing.current = false;
			setSent(null);
			setText("");
			setOpen(true);
		};
		window.addEventListener("keydown", onKey);
		const stop = onGesture("chat", (at) => {
			pointer.current = at;
			closing.current = false;
			setSent(null);
			setText("");
			setOpen(true);
		});
		return () => {
			window.removeEventListener("keydown", onKey);
			stop();
		};
	}, []);

	const latest = useRef(text);
	latest.current = text;
	const send = useCallback(() => {
		if (closing.current) return;
		closing.current = true;
		const message = latest.current.trim();
		setOpen(false);
		setText("");
		setSent(message || null);
	}, []);
	const cancel = useCallback(() => {
		closing.current = true;
		setOpen(false);
		setText("");
		setSent(null);
	}, []);

	// A bubble left open without typing sends itself; a sent message stays
	// a few seconds, then fades.
	useEffect(() => {
		if (!open) return;
		const timer = setTimeout(send, CHAT_IDLE_MS);
		return () => clearTimeout(timer);
	}, [open, text, send]);
	useEffect(() => {
		if (sent === null) return;
		const timer = setTimeout(() => setSent(null), CHAT_LINGER_MS);
		return () => clearTimeout(timer);
	}, [sent]);

	const chatText = open ? text : (sent ?? undefined);
	useEffect(() => {
		const chat: Chat | null = chatText === undefined ? null : { text: chatText, typing: open };
		awareness.setLocalStateField("chat", chat);
	}, [awareness, chatText, open]);

	if (!visible) return null;
	// The anchor follows the pointer; the bubble inside it animates.
	return (
		<div ref={bubble} className="cursor-chat-anchor">
			<div
				className="cursor-chat"
				style={{ "--cursor": user.color } as React.CSSProperties}
				data-leaving={!open && shown.leaving}
			>
				{open ? (
					<input
						ref={input}
						aria-label="Cursor chat: Enter to send, Escape to cancel"
						placeholder="Say something"
						maxLength={CHAT_MAX_LENGTH}
						value={text}
						size={Math.max(11, text.length + 1)}
						onChange={(event) => setText(cleanChat(event.target.value))}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								send();
							} else if (event.key === "Escape") {
								event.preventDefault();
								event.stopPropagation();
								cancel();
							}
						}}
						onBlur={send}
					/>
				) : (
					<span className="cursor-chat-text">{shown.value}</span>
				)}
			</div>
		</div>
	);
}

/** Someone else's chat bubble, beside their cursor. */
export function ChatBubble({
	name,
	chat,
	leaving = false,
}: {
	name: string;
	chat: Chat;
	leaving?: boolean;
}) {
	return (
		<div className="cursor-chat" data-leaving={leaving} data-typing={chat.typing}>
			<span className="cursor-chat-name">{name}</span>
			<span className="cursor-chat-text">
				{chat.text}
				{chat.typing &&
					(chat.text ? (
						<span className="cursor-chat-caret" aria-hidden="true" />
					) : (
						<span className="cursor-chat-dots" role="img" aria-label="typing">
							<span />
							<span />
							<span />
						</span>
					))}
			</span>
		</div>
	);
}
