import { useSyncExternalStore } from "react";
import { type BoardExport, type ExportedImage, serialiseExport } from "../../shared/boardExport.ts";
import {
	type ImageType,
	hashImage,
	isImageHash,
	readImageSize,
	sniffImage,
} from "../../shared/images.ts";
import { type PreparedImage, thumbnail as drawThumbnail } from "../images/prepare.ts";
import type { ImageService } from "../images/service.ts";

// Image files in a board's JSON (#59). A download carries the files its
// image shapes show, base64, fetched through the board's own image service
// (so the playground's in-memory files go too). Importing sends the board
// without them (the server takes 4 MB at most), then uploads each file to
// the new board as it was: the same bytes, so the same hash the shapes name.
// They never go through `prepareImage`, which re-encodes JPEGs and would
// give them new hashes.

/** How many files are fetched or uploaded at once. */
const AT_ONCE = 3;

/** Every file an export's image shapes name, once each, in the file's order. */
export function imageHashes(data: Pick<BoardExport, "shapes">): string[] {
	const hashes = new Set<string>();
	for (const shape of data.shapes) {
		if (shape.type === "image" && isImageHash(shape.image)) hashes.add(shape.image);
	}
	return [...hashes];
}

/** Bytes as base64, a slice at a time (`String.fromCharCode` has an argument limit). */
export function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Run `task` over `items`, a few at a time, in order of starting. */
async function eachAtOnce<T>(items: readonly T[], task: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const item = items[next++] as T;
			await task(item);
		}
	};
	await Promise.all(Array.from({ length: Math.min(AT_ONCE, items.length) }, worker));
}

export interface GatheredImages {
	/** In the order the shapes name them. */
	images: ExportedImage[];
	/** Files that couldn't be fetched (gone, or not a kind boards keep). */
	missing: string[];
}

/**
 * Fetch the files an export's image shapes show, for the download.
 * `onProgress` hears how many are done of how many.
 */
export async function gatherImages(
	data: Pick<BoardExport, "shapes">,
	service: Pick<ImageService, "blob">,
	{
		onProgress,
		signal,
	}: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<GatheredImages> {
	const hashes = imageHashes(data);
	const found = new Map<string, ExportedImage>();
	const missing = new Set<string>();
	let done = 0;
	onProgress?.(0, hashes.length);
	await eachAtOnce(hashes, async (hash) => {
		if (signal?.aborted) return;
		const blob = await service.blob(hash).catch(() => null);
		const bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : null;
		// What the bytes are, never what they claim: the importer checks the same.
		const type = bytes ? sniffImage(bytes) : null;
		if (bytes && type) found.set(hash, { hash, type, data: toBase64(bytes) });
		else missing.add(hash);
		onProgress?.(++done, hashes.length);
	});
	return {
		images: hashes.flatMap((hash) => found.get(hash) ?? []),
		missing: hashes.filter((hash) => missing.has(hash)),
	};
}

/**
 * An export as the pieces of its file: exactly `serialiseExport`'s text,
 * but with each image's base64 a piece of its own, so a board with a lot
 * of pictures becomes a `Blob` without first becoming one enormous string.
 */
export function exportParts(data: BoardExport): string[] {
	const { images, ...rest } = data;
	if (!images?.length) return [serialiseExport(data)];
	// The rest, with `images` last (as `{ ...data, images }` puts it), open at its array.
	const head = serialiseExport({ ...rest, images: [] }).replace(/\[\]\n\}\n$/, "[\n");
	const parts = [head];
	images.forEach((image, i) => {
		parts.push(
			`\t\t{\n\t\t\t"hash": ${JSON.stringify(image.hash)},\n\t\t\t"type": ${JSON.stringify(image.type)},\n\t\t\t"data": "`,
			image.data,
			`"\n\t\t}${i < images.length - 1 ? "," : ""}\n`,
		);
	});
	parts.push("\t]\n}\n");
	return parts;
}

/** Why a file in an import couldn't be put on the new board. */
export interface ImageFailure {
	hash: string;
	message: string;
}

/**
 * A file from an export, ready to upload as it is: checked against the hash
 * it's named by, its kind and size read from its bytes. Null if it's damaged
 * or not a kind boards keep.
 */
export async function preparedFromExport(
	image: ExportedImage,
	thumbnail?: (blob: Blob, size: { width: number; height: number }) => Promise<Blob | undefined>,
): Promise<PreparedImage | null> {
	let bytes: Uint8Array;
	try {
		bytes = fromBase64(image.data);
	} catch {
		return null;
	}
	if ((await hashImage(bytes)) !== image.hash) return null;
	const type: ImageType | null = sniffImage(bytes);
	const size = type ? readImageSize(bytes, type) : null;
	if (!type || !size) return null;
	const blob = new Blob([bytes as BlobPart], { type });
	const thumb = await thumbnail?.(blob, size).catch(() => undefined);
	return { blob, type, width: size.width, height: size.height, hash: image.hash, thumb };
}

/**
 * A thumbnail for board images drawn on the server (embeds, link previews),
 * drawn small from the file in the browser. A convenience: undefined if the
 * browser can't.
 */
export async function thumbnailOf(blob: Blob): Promise<Blob | undefined> {
	const bitmap = await createImageBitmap(blob).catch(() => null);
	if (!bitmap) return undefined;
	try {
		return await drawThumbnail(bitmap, bitmap.width, bitmap.height);
	} finally {
		bitmap.close();
	}
}

/** How far an import's uploads have got. */
export interface UploadProgress {
	/** 0 to 1, by what's been sent. */
	fraction: number;
	done: number;
	total: number;
}

/**
 * Upload an import's files to its new board, a few at a time: only those its
 * image shapes name, once each. Resolves to how many there were, and what
 * couldn't be uploaded and why.
 */
export async function uploadImages(
	data: Pick<BoardExport, "shapes">,
	images: readonly ExportedImage[],
	service: Pick<ImageService, "upload">,
	{
		onProgress,
		thumbnail,
	}: {
		onProgress?: (progress: UploadProgress) => void;
		thumbnail?: (blob: Blob, size: { width: number; height: number }) => Promise<Blob | undefined>;
	} = {},
): Promise<{ total: number; failures: ImageFailure[] }> {
	const wanted = new Set(imageHashes(data));
	const files = [...new Map(images.map((image) => [image.hash, image])).values()].filter((image) =>
		wanted.has(image.hash),
	);
	const fractions = new Map<string, number>();
	const failures: ImageFailure[] = [];
	let done = 0;
	const report = () => {
		let sum = 0;
		for (const fraction of fractions.values()) sum += fraction;
		onProgress?.({ fraction: files.length ? sum / files.length : 1, done, total: files.length });
	};
	report();
	await eachAtOnce(files, async (image) => {
		try {
			const prepared = await preparedFromExport(image, thumbnail);
			if (!prepared) {
				failures.push({ hash: image.hash, message: "Its file in the export is damaged." });
				return;
			}
			await service.upload(prepared, (fraction) => {
				fractions.set(image.hash, fraction);
				report();
			});
		} catch (error) {
			failures.push({
				hash: image.hash,
				message:
					error instanceof Error && error.name === "ImageError"
						? error.message
						: "It couldn’t be uploaded.",
			});
		} finally {
			fractions.set(image.hash, 1);
			done++;
			report();
		}
	});
	return { total: files.length, failures };
}

/** What didn't make it onto an imported board, in words, for the board to say as it opens. */
export function describeUploadFailures(failures: readonly ImageFailure[], total: number): string {
	const which =
		failures.length === total
			? total === 1
				? "Its image couldn’t be added"
				: `None of its ${total} images could be added`
			: `${failures.length} of its ${total} images couldn’t be added`;
	const reasons = new Set(failures.map((failure) => failure.message));
	const [reason] = reasons;
	return `${which}, so ${failures.length === 1 ? "it shows" : "they show"} as unavailable.${reasons.size === 1 && reason ? ` ${reason}` : ""}`;
}

// --- How far an import's got, for the New board picker ---------------------------

class ImportProgressStore {
	private value: UploadProgress | null = null;
	private readonly listeners = new Set<() => void>();

	set(value: UploadProgress | null): void {
		this.value = value;
		for (const listener of this.listeners) listener();
	}

	get(): UploadProgress | null {
		return this.value;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

/**
 * An import's uploads under way: the home page uploads the files once the
 * board's made, and the picker (`ImportDetails`) says how far it's got.
 */
export const importProgress = new ImportProgressStore();

export function useImportProgress(): UploadProgress | null {
	return useSyncExternalStore(
		(listener) => importProgress.subscribe(listener),
		() => importProgress.get(),
	);
}
