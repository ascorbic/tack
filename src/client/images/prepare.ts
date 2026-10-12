import {
	IMAGE_EXTENSIONS,
	IMAGE_LIMITS,
	type ImageType,
	describeBytes,
	hashImage,
	looksLikeSvg,
	sniffImage,
} from "../../shared/images.ts";

// Getting a file ready for a board, in the browser, before anything's sent:
// what it is (from its bytes), drawn into a picture if it's SVG (nothing in
// an SVG ever runs or is stored), downscaled if it's huge, re-encoded if
// it's a JPEG (which drops its metadata: a phone's photo says where it was
// taken), a thumbnail for board images drawn on the server, a tiny blurred
// stand-in for everyone else while it uploads, and its hash. Animated GIFs
// are kept as they are, so they keep moving, unless they're too big.

/** What file pickers offer. */
export const IMAGE_ACCEPT =
	"image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml,.png,.jpg,.jpeg,.gif,.webp,.avif,.svg";

/** A problem with a file, in words people can act on. */
export class ImageError extends Error {
	override name = "ImageError";
}

export interface PreparedImage {
	/** The file to store. */
	blob: Blob;
	type: ImageType;
	/** Its size in pixels. */
	width: number;
	height: number;
	/** The hex SHA-256 of its bytes. */
	hash: string;
	/** A PNG or JPEG no bigger than `IMAGE_LIMITS.thumbEdge`, for board images drawn on the server. */
	thumb?: Blob;
	/** A tiny blurred data URL, for everyone else while it uploads. */
	preview?: string;
	/** Something to say about what was done to it ("Big GIFs are added as a still picture"). */
	note?: string;
}

/** Whether a dropped or pasted file looks like one to try as an image. */
export function isImageFile(file: { type: string; name?: string }): boolean {
	if (file.type.startsWith("image/")) return true;
	return /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(file.name ?? "");
}

/** JPEG and WebP quality when re-encoding. */
const QUALITY = 0.9;

export async function prepareImage(file: Blob): Promise<PreparedImage> {
	if (file.size === 0) throw new ImageError("That file is empty.");
	if (file.size > IMAGE_LIMITS.inputBytes) {
		throw new ImageError(
			`That image is ${describeBytes(file.size)}: images up to ${describeBytes(IMAGE_LIMITS.inputBytes)} can be added.`,
		);
	}
	const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
	const sniffed = sniffImage(head);
	if (!sniffed) {
		if (file.type === "image/svg+xml" || looksLikeSvg(head)) return finish(await fromSvg(file));
		// Something else the browser can draw (HEIC in Safari, BMP): drawn into a PNG or JPEG.
		if (file.type.startsWith("image/")) {
			const bitmap = await decode(file).catch(() => null);
			if (bitmap) return finish(await reencode(bitmap, "image/jpeg", file.size));
			throw new ImageError("This browser can’t read that kind of image.");
		}
		throw new ImageError("Boards take PNG, JPEG, GIF, WebP, AVIF and SVG images.");
	}
	const bitmap = await decode(file);
	const longest = Math.max(bitmap.width, bitmap.height);
	const fits = file.size <= IMAGE_LIMITS.bytes && longest <= IMAGE_LIMITS.edge;
	if (sniffed === "image/gif") {
		// Kept as it is, so it keeps moving, if the server will take it.
		if (file.size <= IMAGE_LIMITS.bytes && longest <= IMAGE_LIMITS.side) {
			return finish(decoded(file, sniffed, bitmap));
		}
		return finish({
			...(await reencode(bitmap, "image/png", file.size)),
			note: "Big GIFs are added as a still picture.",
		});
	}
	// Re-encoded whatever its size: a JPEG's metadata (where it was taken) goes.
	if (sniffed === "image/jpeg") return finish(await reencode(bitmap, "image/jpeg", file.size));
	if (fits) return finish(decoded(file, sniffed, bitmap));
	// WebP and AVIF become WebP: canvases can't write AVIF.
	return finish(
		await reencode(bitmap, sniffed === "image/png" ? "image/png" : "image/webp", file.size),
	);
}

/** A file, and something to draw its thumbnail and preview from. */
interface Drawn {
	blob: Blob;
	type: ImageType;
	source: CanvasImageSource;
	width: number;
	height: number;
	note?: string;
}

function decoded(blob: Blob, type: ImageType, bitmap: ImageBitmap): Drawn {
	return { blob, type, source: bitmap, width: bitmap.width, height: bitmap.height };
}

async function finish(drawn: Drawn): Promise<PreparedImage> {
	const { blob, type, source, width, height } = drawn;
	try {
		if (blob.size > IMAGE_LIMITS.bytes) {
			throw new ImageError(
				`That image is still ${describeBytes(blob.size)} once it’s made smaller: images up to ${describeBytes(IMAGE_LIMITS.bytes)} can be added.`,
			);
		}
		const [hash, thumb, preview] = await Promise.all([
			blob.arrayBuffer().then(hashImage),
			thumbnail(source, width, height).catch(() => undefined),
			blurred(source, width, height).catch(() => undefined),
		]);
		return { blob, type, width, height, hash, thumb, preview, note: drawn.note };
	} finally {
		if (source instanceof ImageBitmap) source.close();
	}
}

async function decode(file: Blob): Promise<ImageBitmap> {
	try {
		return await createImageBitmap(file);
	} catch {
		throw new ImageError("That image couldn’t be read. Is it damaged?");
	}
}

/** Draw a picture at no more than `IMAGE_LIMITS.edge`, as `type` (smaller, if it must be). */
async function reencode(
	bitmap: ImageBitmap,
	type: "image/png" | "image/jpeg" | "image/webp",
	original: number,
): Promise<Drawn> {
	const { width, height } = bitmap;
	let scale = Math.min(1, IMAGE_LIMITS.edge / Math.max(width, height));
	let kind = type;
	try {
		for (let attempt = 0; attempt < 4; attempt++) {
			const w = Math.max(1, Math.round(width * scale));
			const h = Math.max(1, Math.round(height * scale));
			const canvas = draw(bitmap, w, h, kind === "image/jpeg");
			const blob = await toBlob(canvas, kind, QUALITY);
			if (blob.size <= IMAGE_LIMITS.bytes) {
				// A browser that can't write WebP writes PNG.
				const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
				return { blob, type: sniffImage(head) ?? "image/png", source: canvas, width: w, height: h };
			}
			// Too big still: a PNG tries WebP, then everything gets smaller.
			if (kind === "image/png") kind = "image/webp";
			else scale *= 0.75;
		}
	} finally {
		bitmap.close();
	}
	throw new ImageError(
		`That image is ${describeBytes(original)} and couldn’t be made small enough to add.`,
	);
}

/** SVG, drawn into a PNG: loaded as an image, where nothing in it can run or fetch. */
async function fromSvg(file: Blob): Promise<Drawn> {
	const url = URL.createObjectURL(new Blob([file], { type: "image/svg+xml" }));
	try {
		const image = new Image();
		image.src = url;
		await image.decode().catch(() => {
			throw new ImageError("That SVG couldn’t be drawn.");
		});
		// Vector art is drawn crisp: twice its size, at least 1024 pixels, at most the limit.
		const natural = { w: image.naturalWidth || 300, h: image.naturalHeight || 150 };
		const longest = Math.max(natural.w, natural.h);
		const target = Math.min(IMAGE_LIMITS.edge, Math.max(1024, longest * 2));
		const scale = target / longest;
		const canvas = draw(image, Math.round(natural.w * scale), Math.round(natural.h * scale), false);
		let blob: Blob;
		try {
			blob = await toBlob(canvas, "image/png");
		} catch {
			throw new ImageError("That SVG couldn’t be drawn.");
		}
		return { blob, type: "image/png", source: canvas, width: canvas.width, height: canvas.height };
	} finally {
		URL.revokeObjectURL(url);
	}
}

function draw(
	source: CanvasImageSource,
	width: number,
	height: number,
	opaque: boolean,
): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d", { alpha: !opaque });
	if (!context) throw new ImageError("This browser can’t draw images.");
	context.imageSmoothingEnabled = true;
	context.imageSmoothingQuality = "high";
	// A JPEG has no transparency: what was transparent is white, not black.
	if (opaque) {
		context.fillStyle = "#fff";
		context.fillRect(0, 0, width, height);
	}
	context.drawImage(source, 0, 0, width, height);
	return canvas;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
	return new Promise((resolve, reject) =>
		canvas.toBlob(
			(blob) => (blob ? resolve(blob) : reject(new ImageError("That image couldn’t be drawn."))),
			type,
			quality,
		),
	);
}

/** A thumbnail the server's renderer can draw: PNG if anything's see-through, else JPEG. */
export async function thumbnail(
	source: CanvasImageSource,
	width: number,
	height: number,
): Promise<Blob | undefined> {
	const scale = Math.min(1, IMAGE_LIMITS.thumbEdge / Math.max(width, height));
	const w = Math.max(1, Math.round(width * scale));
	const h = Math.max(1, Math.round(height * scale));
	const canvas = draw(source, w, h, false);
	const pixels = canvas.getContext("2d")?.getImageData(0, 0, w, h).data;
	let seeThrough = false;
	if (pixels) {
		for (let i = 3; i < pixels.length; i += 4) {
			if ((pixels[i] ?? 255) < 250) {
				seeThrough = true;
				break;
			}
		}
	}
	if (seeThrough) {
		const png = await toBlob(canvas, "image/png");
		if (png.size <= IMAGE_LIMITS.thumbBytes) return png;
	}
	const jpeg = await toBlob(draw(source, w, h, true), "image/jpeg", 0.82);
	return jpeg.size <= IMAGE_LIMITS.thumbBytes ? jpeg : undefined;
}

/** A dozen pixels across, as a data URL: blurred, it's a fair idea of what's coming. */
async function blurred(
	source: CanvasImageSource,
	width: number,
	height: number,
): Promise<string | undefined> {
	const scale = 12 / Math.max(width, height);
	const canvas = draw(
		source,
		Math.max(1, Math.round(width * scale)),
		Math.max(1, Math.round(height * scale)),
		false,
	);
	for (const type of ["image/webp", "image/png"]) {
		const url = canvas.toDataURL(type, 0.6);
		if (url.startsWith(`data:${type}`) && url.length <= IMAGE_LIMITS.preview) return url;
	}
	return undefined;
}

/** A file name for a stored image: `image-1a2b3c4d.png`. */
export function imageFileName(hash: string, type: string, alt?: string): string {
	const extension = IMAGE_EXTENSIONS[type as ImageType] ?? "png";
	const slug = (alt ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return `${slug || "image"}-${hash.slice(0, 8)}.${extension}`;
}
