// Copy embed (#57): the dialog and the region picker share this store. The
// dialog (opened from Share) closes while someone picks a part of the board
// on the canvas, and opens again with what they picked.

import { useSyncExternalStore } from "react";
import type { EmbedRegion } from "../../shared/embed.ts";

export interface EmbedUiState {
	open: boolean;
	/** Choosing a region on the canvas. */
	picking: boolean;
	region: EmbedRegion;
	/** A section's title, when the region is one: to say which. */
	sectionTitle: string | null;
	/**
	 * Bumped when someone asks for the dialog (Share's Embed button), which
	 * opens it starting from what's selected: see `EmbedDialog`.
	 */
	requested: number;
}

const INITIAL: EmbedUiState = {
	open: false,
	picking: false,
	region: { kind: "board" },
	sectionTitle: null,
	requested: 0,
};

/** A store of the embed dialog's state; one per board page, or per gallery frame. */
export function createEmbedUi() {
	let state = INITIAL;
	const listeners = new Set<() => void>();
	const set = (next: Partial<EmbedUiState>) => {
		state = { ...state, ...next };
		for (const listener of listeners) listener();
	};
	return {
		get: () => state,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** Ask for the dialog: the board opens it, from a section if one's selected. */
		request() {
			set({ requested: state.requested + 1 });
		},
		/** Open the dialog, starting from a region (a selected section, say) if given. */
		open(start?: { region: EmbedRegion; sectionTitle?: string | null }) {
			set({
				open: true,
				picking: false,
				...(start ? { region: start.region, sectionTitle: start.sectionTitle ?? null } : {}),
			});
		},
		close() {
			set({ open: false, picking: false });
		},
		setRegion(region: EmbedRegion, sectionTitle: string | null = null) {
			set({ region, sectionTitle });
		},
		/** Close the dialog and pick on the canvas. */
		startPicking() {
			set({ open: false, picking: true });
		},
		/** Picked: back to the dialog with it. */
		picked(region: EmbedRegion, sectionTitle: string | null = null) {
			set({ open: true, picking: false, region, sectionTitle });
		},
		/** Changed their mind: back to the dialog as it was. */
		cancelPicking() {
			set({ open: true, picking: false });
		},
	};
}

export type EmbedUi = ReturnType<typeof createEmbedUi>;

export function useEmbedUi(store: EmbedUi): EmbedUiState {
	return useSyncExternalStore(store.subscribe, store.get, store.get);
}
