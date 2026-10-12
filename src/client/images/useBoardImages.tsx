import { useReactFlow } from "@xyflow/react";
import { type ReactNode, useCallback, useMemo, useRef } from "react";
import type * as Y from "yjs";
import { IMAGE_PLACED_MAX } from "../../shared/images.ts";
import type { SizeOf } from "../../shared/sections.ts";
import type { ToastStore } from "../Toasts.tsx";
import type { History } from "../undo.ts";
import { adoptImages, insertImages, markArriving } from "./insert.ts";
import { IMAGE_ACCEPT, isImageFile } from "./prepare.ts";
import type { ImageService } from "./service.ts";

/** Board coordinates. */
type Point = { x: number; y: number };

/**
 * Everything the board does with images: files dropped, pasted or picked
 * (`add`), the file picker (`pick`, with the hidden input it needs as
 * `input`), and shapes pasted from another board bringing their files over
 * (`markPasted` inside the paste's transaction, then `adoptPasted`).
 */
export function useBoardImages({
	doc,
	history,
	images,
	by,
	toasts,
	sizeOf,
	select,
	readOnly,
	centre,
}: {
	doc: Y.Doc;
	history: History;
	images: ImageService;
	/** Who's adding them, as everyone sees while they upload. */
	by: string;
	toasts: ToastStore;
	sizeOf?: SizeOf;
	select: (ids: string[]) => void;
	readOnly: boolean;
	/** The middle of the view, in board coordinates. */
	centre: () => Point;
}) {
	const flow = useReactFlow();
	const input = useRef<HTMLInputElement>(null);
	const pickAt = useRef<Point | null>(null);
	const latest = useRef({ doc, history, images, by, toasts, sizeOf, select });
	latest.current = { doc, history, images, by, toasts, sizeOf, select };

	/** As big as their natural size, but no bigger than about half the view. */
	const maxSize = useCallback(() => {
		const zoom = flow.getZoom();
		const w = Math.max(IMAGE_PLACED_MAX.w, (window.innerWidth * 0.45) / zoom);
		const h = Math.max(IMAGE_PLACED_MAX.h, (window.innerHeight * 0.45) / zoom);
		return { w: Math.min(w, 1600), h: Math.min(h, 1200) };
	}, [flow]);

	const add = useCallback(
		(files: readonly File[], at?: Point): boolean => {
			if (readOnly) return false;
			const usable = files.filter(isImageFile);
			if (usable.length === 0) return false;
			void insertImages(usable, at ?? centre(), latest.current, maxSize());
			return true;
		},
		[readOnly, centre, maxSize],
	);

	const pick = useCallback(
		(at?: Point) => {
			if (readOnly) return;
			pickAt.current = at ?? null;
			const field = input.current;
			if (!field) return;
			field.value = "";
			field.click();
		},
		[readOnly],
	);

	const markPasted = useCallback(
		(ids: readonly string[], from: string | undefined, here: string): string[] =>
			from && from !== here ? markArriving(latest.current.doc, ids, latest.current.by) : [],
		[],
	);

	const adoptPasted = useCallback((from: string, ids: readonly string[]) => {
		if (ids.length === 0) return;
		void adoptImages(from, ids, latest.current);
	}, []);

	const element: ReactNode = useMemo(
		() => (
			<input
				ref={input}
				type="file"
				accept={IMAGE_ACCEPT}
				multiple
				hidden
				tabIndex={-1}
				aria-hidden="true"
				data-image-picker
				onChange={(event) => {
					const files = [...(event.currentTarget.files ?? [])];
					if (files.length > 0) add(files, pickAt.current ?? undefined);
					pickAt.current = null;
				}}
			/>
		),
		[add],
	);

	return { add, pick, input: element, markPasted, adoptPasted };
}

/** The image files in a drag or a paste, if any. */
export function imageFilesOf(data: DataTransfer | null): File[] {
	if (!data) return [];
	const files = [...data.files].filter(isImageFile);
	if (files.length > 0) return files;
	// Some browsers only list a pasted screenshot among the items.
	return [...data.items]
		.filter((item) => item.kind === "file" && item.type.startsWith("image/"))
		.flatMap((item) => item.getAsFile() ?? []);
}

/** Whether a drag carries files (which can't be looked at until they're dropped). */
export function carriesFiles(data: DataTransfer): boolean {
	return [...data.types].includes("Files");
}
