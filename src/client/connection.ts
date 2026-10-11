import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import YProvider from "y-partyserver/provider";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { BoardMessage, Role } from "../shared/boards.ts";
import type { BoardRequest, CardMessage } from "../shared/cards.ts";
import type { WidgetMessage } from "../shared/widgets.ts";
import type { CommentEvent } from "../shared/comments.ts";
import type { SinceEvent } from "../shared/since.ts";
import { cardStore } from "./cardStore.ts";
import type { WidgetRequest } from "../shared/widgets.ts";
import { type FacilitationIncoming, facilitation } from "./facilitation/store.ts";
import { isPileMessage, pileStore } from "./piles/store.ts";
import { inboxStore } from "./inbox/store.ts";
import { widgetStore } from "./widgets/store.ts";
import { boardPeople, peopleSource } from "./comments/people.ts";
import { commentStore } from "./comments/store.ts";
import { sinceStore } from "./since/store.ts";
import { setFlash } from "./flash.ts";
import { PendingEdits } from "./pending.ts";

/** Everything a board needs to render, whether live or simulated. */
export interface BoardSource {
	doc: Y.Doc;
	awareness: Awareness;
	synced: boolean;
	/**
	 * Edits made while disconnected that haven't reached the server yet
	 * (bursts of typing count once). Kept on this device meanwhile.
	 */
	waiting?: number;
}

/** What the board's server tells a live connection about the board itself. */
export interface LiveBoardEvents {
	/** Your role changed (someone shared the board with you differently). */
	onRole?: (role: Role) => void;
	/** Someone renamed the board. */
	onRenamed?: (title: string, slug: string) => void;
	/** You lost access, and the server closed the connection. It won't reconnect. */
	onRevoked?: () => void;
}

/** The server's close code for a connection whose access was taken away. */
const ACCESS_REVOKED = 4403;
/**
 * The server's close code for a connection holding the board's document
 * from before it was rebuilt (compacted, src/shared/compaction.ts): it
 * can't merge with the new one, so the page starts again from what's saved.
 */
const DOCUMENT_REBUILT = 4410;
/** Reloading again this soon after the last means something else is wrong: stop. */
const RESTART_GUARD_MS = 30_000;

/**
 * Load the board again from the server, once: everything local was made on
 * the old document. Edits that were still waiting are lost, and the page
 * that loads says so.
 */
function startAgain(board: string, lost: number): void {
	const key = `tack:restarted:${board}`;
	try {
		const last = Number(sessionStorage.getItem(key));
		if (Date.now() - last < RESTART_GUARD_MS) return;
		sessionStorage.setItem(key, String(Date.now()));
	} catch {
		// Without storage there's no way to tell a loop: reload anyway.
	}
	if (lost > 0) {
		setFlash({
			message:
				lost === 1
					? "This board was tidied up while you were offline, so an edit made then couldn’t be kept."
					: `This board was tidied up while you were offline, so ${lost} edits made then couldn’t be kept.`,
		});
	}
	location.reload();
}

function isCommentEvent(message: { type: string }): message is CommentEvent {
	return message.type.startsWith("comment");
}

/** A live board, synced with its Durable Object. */
export function useLiveBoard(name: string, events: LiveBoardEvents = {}): BoardSource {
	const handlers = useRef(events);
	handlers.current = events;

	const [connection] = useState(() => {
		const doc = new Y.Doc();
		const provider = new YProvider(location.host, name, doc, { party: "board" });
		// Edits not yet surely on the server, kept on this device, and any kept
		// from before a reload put back (before anything arrives from the server).
		const pending = new PendingEdits(
			doc,
			name,
			provider,
			undefined,
			undefined,
			undefined,
			(update) => provider._updateHandler(update, pending),
		);
		provider.on("custom-message", (raw: string) => {
			const message = JSON.parse(raw) as
				| CardMessage
				| BoardMessage
				| WidgetMessage
				| FacilitationIncoming
				| CommentEvent
				| SinceEvent;
			if (isCommentEvent(message)) {
				commentStore.apply(message);
				return;
			}
			if (isPileMessage(message)) {
				pileStore.apply(message);
				return;
			}
			switch (message.type) {
				case "since":
					sinceStore.apply(message);
					return;
				case "access":
					handlers.current.onRole?.(message.role);
					return;
				case "renamed":
					handlers.current.onRenamed?.(message.title, message.slug);
					return;
				case "widget-data":
					// Widgets and inbox frames each pick out their own ids.
					widgetStore.apply(message);
					inboxStore.apply(message);
					return;
				case "clock":
				case "spotlight":
				case "silent-texts":
				case "silent-refused":
				case "facilitation-refused":
				case "facilitation-you":
				case "facilitation-present":
				case "timer-changed":
					facilitation.apply(message);
					return;
				default:
					cardStore.apply(message);
			}
		});
		provider.on("connection-close", (event: CloseEvent) => {
			if (event.code === DOCUMENT_REBUILT) {
				provider.disconnect();
				startAgain(name, pending.discard());
				return;
			}
			if (event.code !== ACCESS_REVOKED) return;
			provider.disconnect();
			handlers.current.onRevoked?.();
		});
		cardStore.recheck = () =>
			provider.sendMessage(JSON.stringify({ type: "recheck" } satisfies BoardRequest));
		inboxStore.channel = { send: (request) => provider.sendMessage(JSON.stringify(request)) };
		// Widgets ask for their data over the same connection (#37). Until it's
		// open, nothing is sent: everything wanted is asked for once it is.
		const request = (message: WidgetRequest) => {
			if (provider.wsconnected) provider.sendMessage(JSON.stringify(message));
		};
		widgetStore.connect({
			watch: (ids) => request({ type: "widget-watch", ids }),
			unwatch: (ids) => request({ type: "widget-unwatch", ids }),
			refresh: (id) => request({ type: "widget-refresh", id }),
		});
		provider.on("status", ({ status }: { status: string }) => {
			if (status === "connected") widgetStore.rewatch();
		});
		facilitation.channel = { send: (request) => provider.sendMessage(JSON.stringify(request)) };
		// Piles' suggestions and "Group these" (#73).
		pileStore.reset();
		pileStore.channel = { send: (request) => provider.sendMessage(JSON.stringify(request)) };
		// Comments and "since you were here" (#51, #46) travel on the same channel.
		commentStore.reset();
		commentStore.channel = { send: (request) => provider.sendMessage(JSON.stringify(request)) };
		peopleSource.reset(boardPeople(name));
		sinceStore.reset();
		sinceStore.board = name;
		sinceStore.channel = { send: (request) => provider.sendMessage(JSON.stringify(request)) };
		return { doc, provider, pending };
	});
	const [synced, setSynced] = useState(false);

	useEffect(() => {
		const { provider } = connection;
		let asked = false;
		const onSync = (isSynced: boolean) => {
			connection.pending.setSynced(isSynced);
			setSynced(isSynced);
			// A new connection knows nothing of what this one was watching.
			if (isSynced) {
				inboxStore.rewatch();
				facilitation.connected();
			}
			// What changed since you were last here: once a visit.
			if (isSynced && !asked) {
				asked = true;
				sinceStore.request();
			}
		};
		provider.on("sync", onSync);
		// Still here: signed-out visits carry on (signed-in ones are kept by the server).
		const touch = setInterval(() => sinceStore.touch(), 30_000);
		const onHide = () => {
			sinceStore.touch();
			connection.pending.flush();
		};
		window.addEventListener("pagehide", onHide);
		// Leaving with edits that never reached the server asks first.
		const onLeave = (event: BeforeUnloadEvent) => {
			connection.pending.flush();
			if (connection.pending.waiting > 0) event.preventDefault();
		};
		window.addEventListener("beforeunload", onLeave);
		return () => {
			clearInterval(touch);
			window.removeEventListener("pagehide", onHide);
			window.removeEventListener("beforeunload", onLeave);
			connection.pending.destroy();
			sinceStore.touch();
			provider.off("sync", onSync);
			widgetStore.connect(null);
			facilitation.disconnected();
			pileStore.reset();
			pileStore.channel = null;
			provider.destroy();
		};
	}, [connection]);

	const { pending } = connection;
	const waiting = useSyncExternalStore(pending.subscribe, () => pending.waiting);
	return { doc: connection.doc, awareness: connection.provider.awareness, synced, waiting };
}
