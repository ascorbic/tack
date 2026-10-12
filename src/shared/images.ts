import type * as Y from "yjs";
import type { Point, Rect } from "./geometry.ts";
import { type ShapeProps, addShape, nextZ, shapesMap } from "./shapes.ts";

// Images on boards: the `image` shape, and what the server and every client
// agree about the files behind it. Pure, so the Worker, the browser and
// tests share it.
//
// An image shape holds the SHA-256 of its file (`image`), never the file:
// files live beside the board, in its Durable Object's SQLite storage
// (src/server/images.ts), served only to people who can open the board, and
// the same file twice is stored once. A shape is in the document from the
// moment it's dropped, with `upload` set and a tiny blurred `preview`, so
// everyone sees it arriving; its uploader writes `image` once the file's
// stored, and clears both.

/** The raster formats a board keeps. SVG is drawn into a PNG before upload (never stored). */
export const IMAGE_TYPES = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/avif",
] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/** File extensions for each kind, for downloads and exports. */
export const IMAGE_EXTENSIONS: Record<ImageType, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/avif": "avif",
};

const MB = 1024 * 1024;

export const IMAGE_LIMITS = {
	/** The most one stored file may be, after downscaling. */
	bytes: 10 * MB,
	/** The biggest file people may hand the browser to downscale. */
	inputBytes: 50 * MB,
	/** Longer edges are downscaled to this before upload. */
	edge: 2560,
	/** The server refuses anything wider or taller (a GIF kept as it is may be up to this). */
	side: 4096,
	/** Thumbnails, for board images drawn on the server (embeds, link previews). */
	thumbEdge: 480,
	thumbBytes: 512 * 1024,
	/** What one board may hold. */
	boardCount: 1000,
	boardBytes: 256 * MB,
	/** Longest alt text. */
	alt: 1000,
	/** Longest `preview` data URL, the blurred stand-in others see while it uploads. */
	preview: 2048,
} as const;

/** A file's id: the hex SHA-256 of its bytes. */
export const IMAGE_HASH = /^[0-9a-f]{64}$/;

export function isImageHash(value: unknown): value is string {
	return typeof value === "string" && IMAGE_HASH.test(value);
}

export function isImageType(value: unknown): value is ImageType {
	return typeof value === "string" && (IMAGE_TYPES as readonly string[]).includes(value);
}

/** Who's uploading an image shape's file, and since when. */
export interface ImageUpload {
	/** Their name, as shown while it uploads ("Uploading for Ada…"). */
	by: string;
	/** Their client's Yjs id: theirs to finish. */
	client: number;
	/** When it started, ISO 8601. */
	at: string;
}

/**
 * An upload nobody's finished after this long was abandoned (its tab
 * closed): everyone else shows it as interrupted, with Remove.
 */
export const IMAGE_UPLOAD_STALE_MS = 5 * 60_000;

/** How an image shape draws. */
export type ImageState = "ready" | "uploading" | "interrupted" | "missing";

export function imageState(shape: Pick<ShapeProps, "image" | "upload">, now: number): ImageState {
	if (isImageHash(shape.image)) return "ready";
	const upload = shape.upload;
	if (!upload) return "missing";
	const at = Date.parse(upload.at);
	return Number.isFinite(at) && now - at > IMAGE_UPLOAD_STALE_MS ? "interrupted" : "uploading";
}

/** Smallest an image may be resized to, on its shorter side. */
export const IMAGE_MIN = 24;
/** An image placed at its natural size fits in this, unless asked otherwise. */
export const IMAGE_PLACED_MAX = { w: 480, h: 400 };
/** Size to assume for an image shape with no size (from an older client, say). */
export const IMAGE_DEFAULT = { w: 320, h: 240 };

/** An image shape's box size. */
export function imageSize(shape: Pick<ShapeProps, "w" | "h">): { w: number; h: number } {
	const w = typeof shape.w === "number" && shape.w > 0 ? shape.w : IMAGE_DEFAULT.w;
	const h = typeof shape.h === "number" && shape.h > 0 ? shape.h : IMAGE_DEFAULT.h;
	return { w, h };
}

/**
 * The size to place an image at: its natural size (in CSS pixels at `scale`,
 * so a retina screenshot lands at the size it was on screen), shrunk to fit
 * `max`, and never so small it can't be seen.
 */
export function placedSize(
	natural: { w: number; h: number },
	max: { w: number; h: number } = IMAGE_PLACED_MAX,
	scale = 1,
): { w: number; h: number } {
	const w0 = Math.max(1, natural.w / Math.max(scale, 1));
	const h0 = Math.max(1, natural.h / Math.max(scale, 1));
	const fit = Math.min(1, max.w / w0, max.h / h0);
	let w = w0 * fit;
	let h = h0 * fit;
	// A sliver (a 4000 × 20 banner) still gets something to grab.
	const grow = Math.max(1, IMAGE_MIN / Math.min(w, h));
	w *= grow;
	h *= grow;
	return { w: Math.round(w), h: Math.round(h) };
}

/** Gap between images dropped together. */
export const IMAGE_GAP = 24;

/**
 * Lay several images out together, centred on `at`: rows of up to
 * `columns` (about square), each row as tall as its tallest, every image
 * top-aligned in its row. Returns each one's top-left, in order.
 */
export function layoutImages(sizes: readonly { w: number; h: number }[], at: Point): Point[] {
	if (sizes.length === 0) return [];
	const columns = Math.ceil(Math.sqrt(sizes.length));
	const rows: { start: number; w: number; h: number }[] = [];
	for (let i = 0; i < sizes.length; i += columns) {
		const row = sizes.slice(i, i + columns);
		rows.push({
			start: i,
			w: row.reduce((sum, size) => sum + size.w, 0) + IMAGE_GAP * (row.length - 1),
			h: Math.max(...row.map((size) => size.h)),
		});
	}
	const width = Math.max(...rows.map((row) => row.w));
	const height = rows.reduce((sum, row) => sum + row.h, 0) + IMAGE_GAP * (rows.length - 1);
	const out: Point[] = [];
	let y = at.y - height / 2;
	for (const row of rows) {
		// Rows centred under each other, so a short last row sits in the middle.
		let x = at.x - width / 2 + (width - row.w) / 2;
		for (let i = row.start; i < Math.min(row.start + columns, sizes.length); i++) {
			const size = sizes[i] as { w: number; h: number };
			out.push({ x: Math.round(x), y: Math.round(y) });
			x += size.w + IMAGE_GAP;
		}
		y += row.h + IMAGE_GAP;
	}
	return out;
}

/** What makes a new image shape. */
export interface NewImage {
	x: number;
	y: number;
	w: number;
	h: number;
	/** Its file's natural size, once downscaled. */
	iw: number;
	ih: number;
	mime: ImageType;
	/** Its file's hash, if it's already stored (a copy, an import). */
	image?: string;
	/** Who's uploading it, otherwise. */
	upload?: ImageUpload;
	preview?: string;
	alt?: string;
}

/** Add an image shape on top of everything (call inside a transaction). */
export function addImageShape(doc: Y.Doc, id: string, image: NewImage): void {
	addShape(doc, id, {
		type: "image",
		x: Math.round(image.x),
		y: Math.round(image.y),
		w: Math.round(image.w),
		h: Math.round(image.h),
		iw: image.iw,
		ih: image.ih,
		mime: image.mime,
		image: image.image,
		upload: image.image ? undefined : image.upload,
		preview:
			!image.image && image.preview && image.preview.length <= IMAGE_LIMITS.preview
				? image.preview
				: undefined,
		alt: image.alt ? cleanAlt(image.alt) : undefined,
		z: nextZ(doc),
	});
}

/**
 * The upload's done: the shape shows its file, and stops saying it's
 * uploading. False if the shape's gone (undone, or someone removed it).
 */
export function finishImage(doc: Y.Doc, id: string, hash: string): boolean {
	const shape = shapesMap(doc).get(id);
	if (!shape || shape.get("type") !== "image" || !isImageHash(hash)) return false;
	doc.transact(() => {
		if (shape.get("image") !== hash) shape.set("image", hash);
		if (shape.has("upload")) shape.delete("upload");
		if (shape.has("preview")) shape.delete("preview");
	});
	return true;
}

/** Alt text as kept: one paragraph's worth, trimmed. */
export function cleanAlt(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, IMAGE_LIMITS.alt);
}

/** Every file the document's image shapes show. */
export function imageRefs(doc: Y.Doc): Set<string> {
	const refs = new Set<string>();
	for (const shape of shapesMap(doc).values()) {
		if (shape.get("type") !== "image") continue;
		const hash = shape.get("image");
		if (isImageHash(hash)) refs.add(hash);
	}
	return refs;
}

/**
 * A resize that keeps the image's proportions, from the corner or edge
 * being dragged (`handle`: n, ne, e, se, s, sw, w, nw), with the opposite
 * corner or edge staying put. Edges scale the other dimension about the
 * middle, as design tools do.
 */
export function keepAspect(start: Rect, raw: Rect, handle: string, min = IMAGE_MIN): Rect {
	const ratio = start.w / Math.max(start.h, 1);
	const horizontal = handle.includes("e") || handle.includes("w");
	const vertical = handle.includes("n") || handle.includes("s");
	let w: number;
	let h: number;
	if (horizontal && vertical) {
		// A corner: whichever way it was pulled further.
		const scale = Math.max(raw.w / start.w, raw.h / start.h);
		w = start.w * scale;
		h = start.h * scale;
	} else if (horizontal) {
		w = raw.w;
		h = w / ratio;
	} else {
		h = raw.h;
		w = h * ratio;
	}
	const floor = Math.max(min / w, min / h, 1);
	if (floor > 1) {
		w *= floor;
		h *= floor;
	}
	let x = handle.includes("w") ? start.x + start.w - w : start.x;
	let y = handle.includes("n") ? start.y + start.h - h : start.y;
	if (!horizontal) x = start.x + (start.w - w) / 2;
	if (!vertical) y = start.y + (start.h - h) / 2;
	return { x, y, w, h };
}

// --- Files ----------------------------------------------------------------------

/** What kind of image some bytes are, from their first bytes (never what they claim). */
export function sniffImage(bytes: Uint8Array): ImageType | null {
	const at = (i: number) => bytes[i] ?? -1;
	const ascii = (start: number, text: string) => {
		for (let i = 0; i < text.length; i++) if (at(start + i) !== text.charCodeAt(i)) return false;
		return true;
	};
	if (
		at(0) === 0x89 &&
		ascii(1, "PNG") &&
		at(4) === 0x0d &&
		at(5) === 0x0a &&
		at(6) === 0x1a &&
		at(7) === 0x0a
	) {
		return "image/png";
	}
	if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
	if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
	if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
	if (ascii(4, "ftyp")) {
		// ISO BMFF: the major brand, or any compatible brand, says AVIF.
		const size = readU32(bytes, 0);
		const end = Math.min(size > 8 ? size : 32, bytes.length, 256);
		for (let i = 8; i + 4 <= end; i += 4) {
			if (i === 12) continue; // The minor version.
			if (ascii(i, "avif") || ascii(i, "avis")) return "image/avif";
		}
	}
	return null;
}

/** Whether some bytes look like SVG (or any XML), which boards never store. */
export function looksLikeSvg(bytes: Uint8Array): boolean {
	const head = new TextDecoder().decode(bytes.subarray(0, 1024)).trimStart().toLowerCase();
	return head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"));
}

/**
 * An image's width and height from its header, without decoding it: PNG,
 * GIF, JPEG, WebP and AVIF. Null when they can't be read, which the server
 * takes as a refusal.
 */
export function readImageSize(
	bytes: Uint8Array,
	type: ImageType,
): { width: number; height: number } | null {
	const size = (width: number, height: number) =>
		width > 0 && height > 0 ? { width, height } : null;
	switch (type) {
		case "image/png":
			// IHDR is always first.
			if (bytes.length < 24) return null;
			return size(readU32(bytes, 16), readU32(bytes, 20));
		case "image/gif":
			if (bytes.length < 10) return null;
			return size(readU16le(bytes, 6), readU16le(bytes, 8));
		case "image/jpeg":
			return jpegSize(bytes, size);
		case "image/webp":
			return webpSize(bytes, size);
		case "image/avif":
			return avifSize(bytes, size);
	}
}

type SizeOrNull = (width: number, height: number) => { width: number; height: number } | null;

function jpegSize(bytes: Uint8Array, size: SizeOrNull) {
	let i = 2;
	while (i + 9 < bytes.length) {
		if (bytes[i] !== 0xff) return null;
		const marker = bytes[i + 1] ?? 0;
		// Fill bytes, and markers without a length.
		if (marker === 0xff) {
			i++;
			continue;
		}
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			i += 2;
			continue;
		}
		const length = readU16(bytes, i + 2);
		// Start of frame: every SOFn but DHT (c4), JPG (c8) and DAC (cc).
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return size(readU16(bytes, i + 7), readU16(bytes, i + 5));
		}
		if (length < 2) return null;
		i += 2 + length;
	}
	return null;
}

function webpSize(bytes: Uint8Array, size: SizeOrNull) {
	if (bytes.length < 30) return null;
	const chunk = String.fromCharCode(...bytes.subarray(12, 16));
	if (chunk === "VP8 ") {
		return size(readU16le(bytes, 26) & 0x3fff, readU16le(bytes, 28) & 0x3fff);
	}
	if (chunk === "VP8L") {
		const b0 = bytes[21] ?? 0;
		const b1 = bytes[22] ?? 0;
		const b2 = bytes[23] ?? 0;
		const b3 = bytes[24] ?? 0;
		return size(1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0xf) << 10) | (b2 << 2) | (b1 >> 6)));
	}
	if (chunk === "VP8X") {
		return size(1 + readU24le(bytes, 24), 1 + readU24le(bytes, 27));
	}
	return null;
}

function avifSize(bytes: Uint8Array, size: SizeOrNull) {
	// The first `ispe` (image spatial extents) property: version and flags, then width and height.
	const end = Math.min(bytes.length - 16, 64 * 1024);
	for (let i = 4; i < end; i++) {
		if (
			bytes[i] === 0x69 &&
			bytes[i + 1] === 0x73 &&
			bytes[i + 2] === 0x70 &&
			bytes[i + 3] === 0x65
		) {
			return size(readU32(bytes, i + 8), readU32(bytes, i + 12));
		}
	}
	return null;
}

function readU16(bytes: Uint8Array, i: number): number {
	return ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0);
}

function readU16le(bytes: Uint8Array, i: number): number {
	return (bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8);
}

function readU24le(bytes: Uint8Array, i: number): number {
	return (bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8) | ((bytes[i + 2] ?? 0) << 16);
}

function readU32(bytes: Uint8Array, i: number): number {
	return (
		(((bytes[i] ?? 0) << 24) >>> 0) +
		((bytes[i + 1] ?? 0) << 16) +
		((bytes[i + 2] ?? 0) << 8) +
		(bytes[i + 3] ?? 0)
	);
}

/** The hex SHA-256 of some bytes: an image file's id. */
export async function hashImage(bytes: ArrayBuffer | Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Why a file can't be stored, in words people can act on. */
export type ImageProblem =
	| { reason: "type"; message: string }
	| { reason: "size"; message: string }
	| { reason: "dimensions"; message: string }
	| { reason: "unreadable"; message: string };

/** Megabytes, for messages: "12.4 MB". */
export function describeBytes(bytes: number): string {
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	const mb = bytes / (1024 * 1024);
	return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

/**
 * Check a file the server's about to store: a format boards keep, no bigger
 * than the limit, with dimensions that can be read and aren't too big (a
 * small file can decode to a huge image, which would stall everyone's
 * browser). Its type and size when it's fine.
 */
export function checkImageFile(
	bytes: Uint8Array,
): { type: ImageType; width: number; height: number } | ImageProblem {
	if (bytes.byteLength > IMAGE_LIMITS.bytes) {
		return {
			reason: "size",
			message: `Images can be up to ${describeBytes(IMAGE_LIMITS.bytes)}; that one’s ${describeBytes(bytes.byteLength)}.`,
		};
	}
	const type = sniffImage(bytes);
	if (!type) {
		return {
			reason: "type",
			message: looksLikeSvg(bytes)
				? "SVG files are drawn into a picture before they’re added."
				: "Boards take PNG, JPEG, GIF, WebP and AVIF images.",
		};
	}
	const size = readImageSize(bytes, type);
	if (!size) return { reason: "unreadable", message: "That image couldn’t be read." };
	if (size.width > IMAGE_LIMITS.side || size.height > IMAGE_LIMITS.side) {
		return {
			reason: "dimensions",
			message: `Images can be up to ${IMAGE_LIMITS.side} pixels a side.`,
		};
	}
	return { type, ...size };
}
