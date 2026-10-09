import { createContext, useContext } from "react";
import type * as Y from "yjs";
import type { Stager } from "../../shared/changes.ts";
import type { User } from "../presence.ts";
import type { ToastStore } from "../Toasts.tsx";
import type { PushClient, RepoMetaCache } from "./api.ts";
import type { PushSession } from "./session.ts";
import type { ChangesStore } from "./store.ts";

/** What the sheet opens to. */
export type SheetMode = "review" | "history";

/**
 * Everything the changes UI (the top bar button, the panel, the push sheet
 * and the marks on shapes) shares on one board.
 */
export interface ChangesUI {
	doc: Y.Doc;
	store: ChangesStore;
	/** Null where there's nowhere to push to. */
	client: PushClient | null;
	meta: RepoMetaCache | null;
	session: PushSession;
	/** View only: see the changes, but not stage, unstage, toggle or push them. */
	readOnly: boolean;
	user: User;
	/** Where to sign in, coming back here. */
	signInHref: string;
	/** Where to install the app, coming back here. */
	installHref: string;
	toasts: ToastStore | null;
	/** Undo this person's last edit, for "Unstaged · Undo". */
	undo: (() => void) | null;
	panelOpen: boolean;
	setPanelOpen: (open: boolean) => void;
	/** Open the panel with one change picked out. */
	reveal: (changeId: string) => void;
	/** The change the panel should scroll to and flash, if any. */
	revealed: string | null;
	sheet: SheetMode | null;
	openSheet: (mode: SheetMode) => void;
	closeSheet: () => void;
	/** Pan and zoom the board to these shapes. */
	focusShapes: (ids: string[]) => void;
}

export const ChangesContext = createContext<ChangesUI | null>(null);

export function useChangesUI(): ChangesUI | null {
	return useContext(ChangesContext);
}

/** You, as the person staging a change. */
export function stagerFor(user: User): Stager {
	return { login: user.login, name: user.name, color: user.color };
}

export function signedIn(user: User): boolean {
	return Boolean(user.login);
}
