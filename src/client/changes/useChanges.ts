import { useCallback, useEffect, useMemo, useState } from "react";
import type * as Y from "yjs";
import { signInHref } from "../auth/me.ts";
import type { User } from "../presence.ts";
import type { ToastStore } from "../Toasts.tsx";
import { type PushClient, RepoMetaCache } from "./api.ts";
import type { ChangesUI, SheetMode } from "./context.ts";
import { PushSession } from "./session.ts";
import { ChangesStore } from "./store.ts";

/** Where to install the GitHub App, coming back to this page. */
export function installHref(returnTo = location.pathname + location.search): string {
	return `/setup/install?state=${encodeURIComponent(returnTo)}`;
}

/** Set up the changes UI for a board: its store, push session and open panels. */
export function useChangesState({
	doc,
	client,
	readOnly,
	user,
	toasts,
	undo,
	focusShapes,
}: {
	doc: Y.Doc;
	client: PushClient | null;
	readOnly: boolean;
	user: User;
	toasts: ToastStore | null;
	undo: (() => void) | null;
	focusShapes: (ids: string[]) => void;
}): ChangesUI {
	const store = useMemo(() => new ChangesStore(doc), [doc]);
	useEffect(() => () => store.destroy(), [store]);
	const meta = useMemo(() => (client ? new RepoMetaCache(client) : null), [client]);
	const session = useMemo(() => new PushSession(client), [client]);
	const [panelOpen, setPanelOpen] = useState(false);
	const [sheet, setSheet] = useState<SheetMode | null>(null);
	const [revealed, setRevealed] = useState<string | null>(null);

	const reveal = useCallback((id: string) => {
		setPanelOpen(true);
		// A fresh object each time, so revealing the same change again flashes it again.
		setRevealed(null);
		requestAnimationFrame(() => setRevealed(id));
	}, []);

	return useMemo(
		() => ({
			doc,
			store,
			client,
			meta,
			session,
			readOnly,
			user,
			signInHref: signInHref(),
			installHref: installHref(),
			toasts,
			undo,
			panelOpen,
			setPanelOpen,
			reveal,
			revealed,
			sheet,
			openSheet: (mode: SheetMode) => setSheet(mode),
			closeSheet: () => setSheet(null),
			focusShapes,
		}),
		[
			doc,
			store,
			client,
			meta,
			session,
			readOnly,
			user,
			toasts,
			undo,
			panelOpen,
			reveal,
			revealed,
			sheet,
			focusShapes,
		],
	);
}
