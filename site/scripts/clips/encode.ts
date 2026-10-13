// Encoding: raw frames into an H.264 MP4 for social media, then a GIF for
// READMEs from that. Uses ffmpeg from FFMPEG or the PATH, or else the one
// ffmpeg-static downloaded.

import { spawn, spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import ffmpegStatic from "ffmpeg-static";
import { OUT } from "./camera.ts";

function ffmpeg(): string {
	if (process.env.FFMPEG) return process.env.FFMPEG;
	if (spawnSync("ffmpeg", ["-version"]).status === 0) return "ffmpeg";
	if (!ffmpegStatic) throw new Error("No ffmpeg: install it, or set FFMPEG to one");
	return ffmpegStatic as unknown as string;
}

function run(args: string[], input?: AsyncIterable<Buffer>): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(ffmpeg(), ["-hide_banner", "-loglevel", "error", "-y", ...args], {
			stdio: [input ? "pipe" : "ignore", "inherit", "inherit"],
		});
		child.on("error", reject);
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg: ${code}`))));
		if (input && child.stdin) {
			const stdin = child.stdin;
			void (async () => {
				for await (const frame of input) {
					if (!stdin.write(frame)) await new Promise((r) => stdin.once("drain", r));
				}
				stdin.end();
			})().catch(reject);
		}
	});
}

/** Raw RGB frames into a square H.264 MP4 that starts playing before it's all downloaded. */
export function encodeMp4(frames: AsyncIterable<Buffer>, fps: number, file: string): Promise<void> {
	return run(
		[
			...["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${OUT}x${OUT}`, "-r", String(fps)],
			...["-i", "-"],
			...["-vf", "scale=out_color_matrix=bt709:out_range=tv"],
			...["-c:v", "libx264", "-preset", "slow", "-crf", "16", "-tune", "animation"],
			...["-pix_fmt", "yuv420p", "-profile:v", "high"],
			...["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"],
			...["-movflags", "+faststart", "-an", file],
		],
		frames,
	);
}

/** GitHub shows GIFs up to 10MB; this leaves room. */
const GIF_LIMIT = 8e6;

/**
 * A GIF from the MP4 at 720px, with a palette made for it. It tries
 * smoother settings first and steps down until it fits under the limit.
 */
export async function encodeGif(mp4: string, file: string): Promise<number> {
	const tries = [
		{ fps: 15, width: 720 },
		{ fps: 12, width: 720 },
		{ fps: 10, width: 720 },
		{ fps: 10, width: 600 },
	];
	let size = 0;
	for (const { fps, width } of tries) {
		await run([
			...["-i", mp4],
			...[
				"-vf",
				`fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];` +
					"[a]palettegen=max_colors=192:stats_mode=diff[p];" +
					"[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
			],
			...["-loop", "0", file],
		]);
		size = (await stat(file)).size;
		if (size <= GIF_LIMIT) break;
	}
	return size;
}
