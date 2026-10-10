import { useEffect, useRef, useState } from "react";
import YProvider from "y-partyserver/provider";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { BoardMessage, Role } from "../shared/boards.ts";
import type { BoardRequest, CardMessage } from "../shared/cards.ts";
import type { WidgetMessage } from "../shared/widgets.ts";
import { cardStore } from "./cardStore.ts";
import type { WidgetRequest } from "../shared/widgets.ts";
import { type FacilitationIncoming, facilitation } from "./facilitation/store.ts";
import { inboxStore } from "./inbox/store.ts";
import { widgetStore } from "./widgets/store.ts";

/** Everything a board needs to render, whether live or simulated. */
export interface BoardSource {
	doc: Y.Doc;
	awareness: Awareness;
	synced: boolean;
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

/** A live board, synced with its Durable Object. */
export function useLiveBoard(name: string, events: LiveBoardEvents = {}): BoardSource {
	const handlers = useRef(events);
	handlers.current = events;

	const [connection] = useState(() => {
		const doc = new Y.Doc();
		const provider = new YProvider(location.host, name, doc, { party: "board" });
		provider.on("custom-message", (raw: string) => {
			const message = JSON.parse(raw) as
				| CardMessage
				| BoardMessage
				| WidgetMessage
				| FacilitationIncoming;
			switch (message.type) {
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
					facilitation.apply(message);
					return;
				default:
					cardStore.apply(message);
			}
		});
		provider.on("connection-close", (event: CloseEvent) => {
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
		return { doc, provider };
	});
	const [synced, setSynced] = useState(false);

	useEffect(() => {
		const { provider } = connection;
		const onSync = (isSynced: boolean) => {
			setSynced(isSynced);
			// A new connection knows nothing of what this one was watching.
			if (isSynced) {
				inboxStore.rewatch();
				facilitation.connected();
			}
		};
		provider.on("sync", onSync);
		return () => {
			provider.off("sync", onSync);
			widgetStore.connect(null);
			facilitation.disconnected();
			provider.destroy();
		};
	}, [connection]);

	return { doc: connection.doc, awareness: connection.provider.awareness, synced };
}
