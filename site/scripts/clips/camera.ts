// The camera: a square crop over the recorded frames, keyframed as data
// (`{ t, x, y, w }` in the page's CSS pixels) and eased between keyframes.
// Zoom is interpolated on a log scale so it feels even, and every frame is
// cropped at subpixel precision (an exact shift, then a Lanczos resize), so
// slow moves glide rather than stepping a pixel at a time.

import sharp from "sharp";
import { type Box, type Recording, SCALE, SIZE } from "./capture.ts";
import { easeInOut } from "./cursor.ts";

/** The output's width and height, in pixels. */
export const OUT = 1080;

/** Where the camera looks at time `t`: a square's top-left corner and width. */
export interface Keyframe {
	t: number;
	x: number;
	y: number;
	w: number;
}

type View = Omit<Keyframe, "t">;

/** The whole page. */
export const WIDE: View = { x: 0, y: 0, w: SIZE };

/** A view `zoom` times closer, centred on a box (or a point), kept inside the page. */
export function closeOn(target: Box | { x: number; y: number }, zoom: number): View {
	const w = SIZE / zoom;
	const cx = "w" in target ? target.x + target.w / 2 : target.x;
	const cy = "h" in target ? target.y + target.h / 2 : target.y;
	const clamp = (v: number) => Math.min(SIZE - w, Math.max(0, v));
	return { x: clamp(cx - w / 2), y: clamp(cy - w / 2), w };
}

/** The smallest square view around some boxes, with a margin, never closer than `max`. */
export function around(boxes: Box[], { margin = 40, max = 2.2 } = {}): View {
	const left = Math.min(...boxes.map((b) => b.x)) - margin;
	const top = Math.min(...boxes.map((b) => b.y)) - margin;
	const right = Math.max(...boxes.map((b) => b.x + b.w)) + margin;
	const bottom = Math.max(...boxes.map((b) => b.y + b.h)) + margin;
	const w = Math.min(SIZE, Math.max(right - left, bottom - top, SIZE / max));
	return closeOn({ x: (left + right) / 2, y: (top + bottom) / 2 }, SIZE / w);
}

/** The view at time `t`: eased from one keyframe to the next, holding before the first and after the last. */
export function viewAt(keys: Keyframe[], t: number): View {
	const next = keys.findIndex((k) => k.t > t);
	if (next === -1) return keys.at(-1) ?? WIDE;
	if (next === 0) return keys[0]!;
	const a = keys[next - 1]!;
	const b = keys[next]!;
	const p = easeInOut((t - a.t) / (b.t - a.t));
	const w = Math.exp(Math.log(a.w) + (Math.log(b.w) - Math.log(a.w)) * p);
	const cx = a.x + a.w / 2 + (b.x + b.w / 2 - (a.x + a.w / 2)) * p;
	const cy = a.y + a.w / 2 + (b.y + b.w / 2 - (a.y + a.w / 2)) * p;
	return { x: cx - w / 2, y: cy - w / 2, w };
}

/** One output frame: the recorded frame cropped to the view, as raw RGB. */
export async function shoot(file: string, view: View): Promise<Buffer> {
	const full = SIZE * SCALE;
	const sx = view.x * SCALE;
	const sy = view.y * SCALE;
	const sw = view.w * SCALE;
	// Cut out whole pixels around the view, with a little to spare.
	const left = Math.max(0, Math.floor(sx) - 1);
	const top = Math.max(0, Math.floor(sy) - 1);
	const width = Math.min(full - left, Math.ceil(sx + sw) + 2 - left);
	const height = Math.min(full - top, Math.ceil(sy + sw) + 2 - top);
	const cut = await sharp(file)
		.extract({ left, top, width, height })
		.removeAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	// Shift by the fraction of a pixel left over, so the view starts exactly at the corner.
	const dx = sx - left;
	const dy = sy - top;
	const shifted = await sharp(cut.data, { raw: { width, height, channels: 3 } })
		.affine([1, 0, 0, 1], { idx: -dx, idy: -dy, interpolator: "bicubic" })
		.extract({ left: 0, top: 0, width: width - 2, height: height - 2 })
		.raw()
		.toBuffer({ resolveWithObject: true });
	// Then scale to the output, filtering properly whether it shrinks or grows.
	const scale = OUT / sw;
	const resized = await sharp(shifted.data, {
		raw: { width: shifted.info.width, height: shifted.info.height, channels: 3 },
	})
		.resize(
			Math.max(OUT, Math.round(shifted.info.width * scale)),
			Math.max(OUT, Math.round(shifted.info.height * scale)),
			{ kernel: "lanczos3", fit: "fill" },
		)
		.extract({ left: 0, top: 0, width: OUT, height: OUT })
		.raw()
		.toBuffer();
	return resized;
}

/** Blend `a` towards `b` by `p` (0 to 1), for the fade back to the start. */
export function blend(a: Buffer, b: Buffer, p: number): Buffer {
	const out = Buffer.alloc(a.length);
	for (let i = 0; i < a.length; i++) out[i] = a[i]! + (b[i]! - a[i]!) * p;
	return out;
}

/**
 * Every output frame, in order: cropped by the camera, and over the last
 * `fade` seconds dissolving back into the first frame, so the clip loops.
 */
export async function* film(
	recording: Recording,
	keys: Keyframe[],
	frameAt: (n: number) => string,
	{ fade = 0.6 } = {},
): AsyncGenerator<Buffer> {
	const total = recording.frames;
	const fadeFrames = Math.round(fade * recording.fps);
	let first: Buffer | null = null;
	for (let n = 0; n < total; n++) {
		const frame = await shoot(frameAt(n), viewAt(keys, n / recording.fps));
		first ??= frame;
		const into = n - (total - fadeFrames);
		yield into >= 0 ? blend(frame, first, easeInOut((into + 1) / (fadeFrames + 1))) : frame;
	}
}
