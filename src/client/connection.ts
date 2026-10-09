import { useEffect, useState } from "react";
import YProvider from "y-partyserver/provider";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { CardMessage } from "../shared/cards.ts";
import { cardStore } from "./cardStore.ts";

/** Everything a board needs to render, whether live or simulated. */
export interface BoardSource {
	doc: Y.Doc;
	awareness: Awareness;
	synced: boolean;
}

/** A live board, synced with its Durable Object. */
export function useLiveBoard(name: string): BoardSource {
	const [connection] = useState(() => {
		const doc = new Y.Doc();
		const provider = new YProvider(location.host, name, doc, { party: "board" });
		provider.on("custom-message", (message: string) => {
			cardStore.apply(JSON.parse(message) as CardMessage);
		});
		return { doc, provider };
	});
	const [synced, setSynced] = useState(false);

	useEffect(() => {
		const { provider } = connection;
		const onSync = (isSynced: boolean) => setSynced(isSynced);
		provider.on("sync", onSync);
		return () => {
			provider.off("sync", onSync);
			provider.destroy();
		};
	}, [connection]);

	return { doc: connection.doc, awareness: connection.provider.awareness, synced };
}
