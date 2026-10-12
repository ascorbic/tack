import { createContext, useContext, useSyncExternalStore } from "react";
import { IMAGE_EXTENSIONS, type ImageType } from "../../shared/images.ts";
import { ImageError, type PreparedImage } from "./prepare.ts";

// Where a board's image files go and come from. A live board's are the
// Worker's (src/server/images.ts), loaded straight from its own origin; the
// playground keeps them in memory, and the demo in this browser's IndexedDB
// (src/client/try/images.ts): nothing leaves the browser.

export interface ImageService {
	/**
	 * Where the browser loads a file from: a URL, undefined while it's still
	 * being found (an offline store reading it), or null if it isn't here.
	 */
	src(hash: string): string | null | undefined;
	/** Called when `src` might answer differently. */
	subscribe: (listener: () => void) => () => void;
	/**
	 * Store a prepared file; resolves once it's stored, rejects with an
	 * `ImageError` saying why it couldn't be. Files already here aren't sent again.
	 */
	upload(
		image: PreparedImage,
		onProgress?: (fraction: number) => void,
		signal?: AbortSignal,
	): Promise<void>;
	/**
	 * Files copied from another board (pasting shapes from one board into
	 * another): resolves to the hashes that couldn't be brought over.
	 */
	adopt(from: string, hashes: string[]): Promise<string[]>;
	/** A file's bytes, for exports, or null if it isn't here. */
	blob(hash: string): Promise<Blob | null>;
}

export const ImagesContext = createContext<ImageService | null>(null);

export function useImages(): ImageService | null {
	return useContext(ImagesContext);
}

const never = () => () => {};

/** Where an image's file loads from (see `ImageService.src`). */
export function useImageSrc(hash: string | undefined): string | null | undefined {
	const images = useImages();
	return useSyncExternalStore(images?.subscribe ?? never, () =>
		hash && images ? images.src(hash) : null,
	);
}

const ERRORS: Record<string, string> = {
	forbidden: "Only editors can add images to this board.",
	not_found: "This board isn’t there any more, or you can’t open it.",
	quota: "This board has no room for more images. Remove some, then try again.",
};

/** A live board's files, through the Worker. */
export function liveImages(boardId: string): ImageService {
	const base = `/api/boards/${encodeURIComponent(boardId)}/images`;
	return {
		src: (hash) => `${base}/${hash}`,
		subscribe: never,
		async upload(image, onProgress, signal) {
			// The same file twice is stored once: don't send it again.
			const there = await fetch(`${base}/${image.hash}`, { method: "HEAD", signal }).catch(
				() => null,
			);
			if (there?.ok) {
				onProgress?.(1);
				return;
			}
			const form = new FormData();
			form.set("image", image.blob, `image.${IMAGE_EXTENSIONS[image.type]}`);
			if (image.thumb) form.set("thumb", image.thumb, "thumb");
			await send(base, form, onProgress, signal);
		},
		async adopt(from, hashes) {
			try {
				const response = await fetch(`${base}/copy`, {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify({ from, hashes }),
				});
				const body = (await response.json().catch(() => null)) as {
					copied?: string[];
					missing?: string[];
				} | null;
				if (!response.ok || !body) return hashes;
				return body.missing ?? [];
			} catch {
				return hashes;
			}
		},
		async blob(hash) {
			const response = await fetch(`${base}/${hash}`).catch(() => null);
			return response?.ok ? response.blob() : null;
		},
	};
}

/** Upload a form with progress (fetch can't report it), as XHR. */
function send(
	url: string,
	form: FormData,
	onProgress?: (fraction: number) => void,
	signal?: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = new XMLHttpRequest();
		request.open("POST", url);
		request.setRequestHeader("accept", "application/json");
		request.upload.onprogress = (event) => {
			if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
		};
		request.onload = () => {
			if (request.status >= 200 && request.status < 300) {
				onProgress?.(1);
				resolve();
				return;
			}
			const body = readError(request.responseText);
			reject(
				new ImageError(
					body?.message ??
						ERRORS[body?.error ?? ""] ??
						"The image couldn’t be uploaded. Try again?",
				),
			);
		};
		request.onerror = () =>
			reject(new ImageError("Couldn’t reach the server to upload the image."));
		request.onabort = () => reject(new DOMException("Aborted", "AbortError"));
		signal?.addEventListener("abort", () => request.abort(), { once: true });
		request.send(form);
	});
}

function readError(text: string): { error?: string; message?: string } | null {
	try {
		return JSON.parse(text) as { error?: string; message?: string };
	} catch {
		// Not ours: say something general.
		return null;
	}
}

/**
 * Files kept in this page's memory (the playground, galleries): blob URLs,
 * with uploads that take a moment, so progress shows. `adopt` finds nothing
 * new: there's only ever one store.
 */
export function memoryImages(options: { delayMs?: () => number } = {}): ImageService & {
	put(hash: string, blob: Blob): string;
} {
	const files = new Map<string, { blob: Blob; url: string }>();
	const listeners = new Set<() => void>();
	const put = (hash: string, blob: Blob) => {
		const existing = files.get(hash);
		if (existing) return existing.url;
		const url = URL.createObjectURL(blob);
		files.set(hash, { blob, url });
		for (const listener of listeners) listener();
		return url;
	};
	return {
		put,
		src: (hash) => files.get(hash)?.url ?? null,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async upload(image, onProgress, signal) {
			if (!files.has(image.hash))
				await pretendToSend(options.delayMs?.() ?? 900, onProgress, signal);
			put(image.hash, image.blob);
			onProgress?.(1);
		},
		async adopt(_from, hashes) {
			return hashes.filter((hash) => !files.has(hash));
		},
		async blob(hash) {
			return files.get(hash)?.blob ?? null;
		},
	};
}

/** An upload's progress, in steps over `ms`, as a network would report it. */
export async function pretendToSend(
	ms: number,
	onProgress?: (fraction: number) => void,
	signal?: AbortSignal,
): Promise<void> {
	const steps = 12;
	for (let i = 1; i <= steps; i++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		await new Promise((resolve) => setTimeout(resolve, ms / steps));
		onProgress?.(Math.min(0.98, i / steps));
	}
}

/** A data type's extension, for file names. */
export function extensionOf(type: string): string {
	return IMAGE_EXTENSIONS[type as ImageType] ?? "png";
}
