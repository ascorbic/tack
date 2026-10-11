import { useSyncExternalStore } from "react";

// Whether custom widgets (#66) run on the board that's open, and whether
// the person looking can change that. The board's page keeps it in step
// with the board (and the server's `custom-widgets` message when the owner
// flips it); the playground sets it itself.

export interface CustomWidgetsState {
	/** The owner turned custom widgets on for this board. */
	enabled: boolean;
	/** The person looking can turn them on or off (the owner). */
	canManage: boolean;
	/** Opens the board's custom widgets setting, for those who can change it. */
	openSettings: (() => void) | null;
}

const OFF: CustomWidgetsState = { enabled: false, canManage: false, openSettings: null };

class CustomWidgetsStore {
	private state: CustomWidgetsState = OFF;
	private listeners = new Set<() => void>();

	get = (): CustomWidgetsState => this.state;

	set(next: Partial<CustomWidgetsState>): void {
		const merged = { ...this.state, ...next };
		if (
			merged.enabled === this.state.enabled &&
			merged.canManage === this.state.canManage &&
			merged.openSettings === this.state.openSettings
		) {
			return;
		}
		this.state = merged;
		for (const listener of this.listeners) listener();
	}

	reset(): void {
		this.set(OFF);
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
}

export const customWidgets = new CustomWidgetsStore();

export function useCustomWidgets(): CustomWidgetsState {
	return useSyncExternalStore(customWidgets.subscribe, customWidgets.get);
}
