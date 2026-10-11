import { useSyncExternalStore } from "react";

// Opening the export dialog (#59) from outside the board: the board's menu
// beside its title lives in the page around the canvas, the dialog inside
// it (it needs the canvas to draw).

export type ExportFormat = "png" | "svg" | "json";

export interface ExportRequest {
	format?: ExportFormat;
}

class ExportUI {
	private request: ExportRequest | null = null;
	private readonly listeners = new Set<() => void>();

	open(request: ExportRequest = {}): void {
		this.request = { ...request };
		this.emit();
	}

	close(): void {
		this.request = null;
		this.emit();
	}

	get(): ExportRequest | null {
		return this.request;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

export const exportUI = new ExportUI();

export function useExportRequest(): ExportRequest | null {
	return useSyncExternalStore(
		(listener) => exportUI.subscribe(listener),
		() => exportUI.get(),
	);
}

/** Save a file the browser has, as a download. */
export function download(blob: Blob, name: string): void {
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.rel = "noopener";
	document.body.append(link);
	link.click();
	link.remove();
	// Long enough for the download to start, in every browser.
	setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * The board's title, for file names: the tab's title without the app's
 * name, which the board page keeps current; else what the board's called.
 */
export function boardTitle(fallback: string): string {
	const match = /^(.*\S)\s*·\s*Tack$/.exec(document.title);
	return match?.[1] ?? (fallback.trim() || "Board");
}
