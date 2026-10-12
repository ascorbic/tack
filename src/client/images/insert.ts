import { useSyncExternalStore } from "react";
import type * as Y from "yjs";
import {
	IMAGE_ORIGIN,
	IMAGE_PLACED_MAX,
	type ImageUpload,
	addImageShape,
	finishImage,
	isImageHash,
	layoutImages,
	placedSize,
} from "../../shared/images.ts";
import type { SizeOf } from "../../shared/sections.ts";
import { shapesMap } from "../../shared/shapes.ts";
import { placeInSections, removeShapes } from "../../shared/structure.ts";
import { markFresh } from "../board.ts";
import type { ToastStore } from "../Toasts.tsx";
import { type History, transactLocal } from "../undo.ts";
import { ImageError, type PreparedImage, prepareImage } from "./prepare.ts";
import type { ImageService } from "./service.ts";

// Putting images on the board: files dropped, pasted or picked are prepared
// (prepare.ts), placed at once as one undo step, each marked as uploading
// with a blurred stand-in so everyone sees them arrive, and uploaded in the
// background, a few at a time. Each upload's progress is this tab's alone
// (`uploads`): the person adding them sees their own picture filling in,
// everyone else a shimmer until the file's there.

/** An upload this tab is running, by the shape it's for. */
export interface Upload {
	/** 0 to 1. */
	progress: number;
	/** The file itself, to show while it uploads. */
	local: string;
	/** Its hash, once stored. */
	done?: string;
	error?: string;
}

class Uploads {
	private readonly entries = new Map<string, Upload>();
	private readonly listeners = new Set<() => void>();

	get(id: string): Upload | undefined {
		return this.entries.get(id);
	}

	set(id: string, upload: Upload | null): void {
		const previous = this.entries.get(id);
		if (upload) this.entries.set(id, upload);
		else this.entries.delete(id);
		// A finished upload's own copy of the file goes once the stored one shows.
		if (previous && previous.local !== upload?.local) {
			setTimeout(() => URL.revokeObjectURL(previous.local), 30_000);
		}
		for (const listener of this.listeners) listener();
	}

	update(id: string, change: Partial<Upload>): void {
		const current = this.entries.get(id);
		if (current) this.set(id, { ...current, ...change });
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
}

export const uploads = new Uploads();

export function useUpload(id: string): Upload | undefined {
	return useSyncExternalStore(uploads.subscribe, () => uploads.get(id));
}

/** At most this many files go up at once. */
const PARALLEL = 3;
let running = 0;
const queue: (() => void)[] = [];

async function inTurn<T>(fn: () => Promise<T>): Promise<T> {
	if (running >= PARALLEL) await new Promise<void>((resolve) => queue.push(resolve));
	running++;
	try {
		return await fn();
	} finally {
		running--;
		queue.shift()?.();
	}
}

export interface InsertContext {
	doc: Y.Doc;
	history: History;
	images: ImageService;
	/** Who's adding them, as everyone sees while they upload. */
	by: string;
	toasts: ToastStore;
	sizeOf?: SizeOf;
	/** Select what was added. */
	select?: (ids: string[]) => void;
}

/**
 * Add image files to the board, centred on `at` (board coordinates), each
 * no bigger than `max`. Resolves to the new shapes' ids, once they're on the
 * board (their uploads carry on).
 */
export async function insertImages(
	files: readonly Blob[],
	at: { x: number; y: number },
	context: InsertContext,
	max: { w: number; h: number } = IMAGE_PLACED_MAX,
): Promise<string[]> {
	if (files.length === 0) return [];
	const results = await Promise.allSettled(files.map((file) => prepareImage(file)));
	const prepared: PreparedImage[] = [];
	const problems: string[] = [];
	for (const result of results) {
		if (result.status === "fulfilled") prepared.push(result.value);
		else
			problems.push(
				result.reason instanceof ImageError
					? result.reason.message
					: "That image couldn’t be read.",
			);
	}
	if (problems.length > 0) {
		const count = problems.length;
		context.toasts.show({
			message:
				count === 1 && files.length === 1
					? (problems[0] as string)
					: `${count} of ${files.length} images couldn’t be added. ${problems[0]}`,
		});
	} else {
		const note = prepared.find((image) => image.note)?.note;
		if (note) context.toasts.show({ message: note });
	}
	return place(prepared, at, context, max);
}

function place(
	prepared: readonly PreparedImage[],
	at: { x: number; y: number },
	context: InsertContext,
	max: { w: number; h: number },
	positions?: readonly { x: number; y: number }[],
): string[] {
	if (prepared.length === 0) return [];
	const { doc, history } = context;
	const sizes = prepared.map((image) => placedSize({ w: image.width, h: image.height }, max));
	const spots = positions ?? layoutImages(sizes, at);
	const upload: ImageUpload = {
		by: context.by,
		client: doc.clientID,
		at: new Date().toISOString(),
	};
	const ids = prepared.map(() => crypto.randomUUID());
	markFresh(ids);
	transactLocal(doc, () => {
		prepared.forEach((image, i) => {
			const size = sizes[i] as { w: number; h: number };
			const spot = spots[i] as { x: number; y: number };
			addImageShape(doc, ids[i] as string, {
				...spot,
				...size,
				iw: image.width,
				ih: image.height,
				mime: image.type,
				upload,
				preview: image.preview,
			});
		});
		placeInSections(doc, ids, context.sizeOf);
	});
	const step = history.top();
	context.select?.(ids);
	const failed: { image: PreparedImage; spot: { x: number; y: number }; message: string }[] = [];
	let left = prepared.length;
	prepared.forEach((image, i) => {
		const id = ids[i] as string;
		uploads.set(id, { progress: 0, local: URL.createObjectURL(image.blob) });
		void inTurn(() => context.images.upload(image, (progress) => uploads.update(id, { progress })))
			.then(
				() => {
					uploads.update(id, { progress: 1, done: image.hash });
					finish(doc, history, step, id, image.hash);
				},
				(error: unknown) => {
					const message =
						error instanceof ImageError ? error.message : "The image couldn’t be uploaded.";
					uploads.set(id, null);
					const shape = shapesMap(doc).get(id);
					const spot = shape
						? { x: Number(shape.get("x")), y: Number(shape.get("y")) }
						: (spots[i] as { x: number; y: number });
					// Gone, untracked: the step that added it stays, for the others.
					doc.transact(() => removeShapes(doc, [id], context.sizeOf), IMAGE_ORIGIN);
					failed.push({ image, spot, message });
				},
			)
			.finally(() => {
				if (--left > 0 || failed.length === 0) return;
				const retry = failed.slice();
				context.toasts.show({
					message:
						retry.length === 1
							? (retry[0]?.message ?? "")
							: `${retry.length} images couldn’t be uploaded. ${retry[0]?.message ?? ""}`,
					action: {
						label: "Try again",
						run: () =>
							place(
								retry.map((each) => each.image),
								at,
								context,
								max,
								retry.map((each) => each.spot),
							),
					},
				});
			});
	});
	return ids;
}

/**
 * Show a stored file on its shape: as part of the step that added it while
 * that's still the latest (so undo takes the image away whole), otherwise
 * on its own, never undone.
 */
function finish(
	doc: Y.Doc,
	history: History,
	step: ReturnType<History["top"]>,
	id: string,
	hash: string,
): void {
	if (!shapesMap(doc).has(id)) return;
	if (history.amend(step, () => void finishImage(doc, id, hash))) return;
	doc.transact(() => finishImage(doc, id, hash), IMAGE_ORIGIN);
}

/**
 * An image of this tab's that came back (redone) still saying it's
 * uploading, though its file's stored: say so. Call from its node.
 */
export function settleUpload(doc: Y.Doc, id: string): void {
	const shape = shapesMap(doc).get(id);
	const upload = shape?.get("upload") as ImageUpload | undefined;
	const done = uploads.get(id)?.done;
	if (!shape || !upload || upload.client !== doc.clientID || !done) return;
	doc.transact(() => finishImage(doc, id, done), IMAGE_ORIGIN);
}

// --- Copies from other boards --------------------------------------------------------

/**
 * Pasted image shapes whose files are on another board: marked as arriving
 * (call inside the paste's transaction), so everyone sees them come rather
 * than broken. Returns the ids marked.
 */
export function markArriving(doc: Y.Doc, ids: readonly string[], by: string): string[] {
	const shapes = shapesMap(doc);
	const upload: ImageUpload = { by, client: doc.clientID, at: new Date().toISOString() };
	const marked: string[] = [];
	for (const id of ids) {
		const shape = shapes.get(id);
		if (shape?.get("type") !== "image" || !isImageHash(shape.get("image"))) continue;
		shape.set("upload", upload);
		marked.push(id);
	}
	return marked;
}

/** Bring pasted images' files over from the board they were copied from, then show them. */
export async function adoptImages(
	from: string,
	ids: readonly string[],
	context: Pick<InsertContext, "doc" | "history" | "images" | "toasts">,
): Promise<void> {
	const { doc, history, images } = context;
	const step = history.top();
	const shapes = shapesMap(doc);
	const hashes = [...new Set(ids.map((id) => shapes.get(id)?.get("image")).filter(isImageHash))];
	const missing = new Set(await images.adopt(from, hashes));
	for (const id of ids) {
		const shape = shapes.get(id);
		const hash = shape?.get("image");
		if (!shape || !isImageHash(hash)) continue;
		// Arrived or not, it stops saying it's on its way: one that didn't is shown as missing.
		if (!missing.has(hash)) {
			finish(doc, history, step, id, hash);
		} else {
			const clear = () => {
				if (shape.has("upload")) shape.delete("upload");
			};
			if (!history.amend(step, clear)) doc.transact(clear, IMAGE_ORIGIN);
		}
	}
	if (missing.size > 0) {
		context.toasts.show({
			message:
				missing.size === 1
					? "One image couldn’t be brought over from the board it was copied from."
					: `${missing.size} images couldn’t be brought over from the board they were copied from.`,
		});
	}
}
