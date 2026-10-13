// Short, silent, looping clips of Tack for social media, recorded from the
// playground: each clip seeds a made-up board, plays a little scene on it
// with a drawn pointer, and a camera leans in on the details.
//
//   pnpm --filter site run clips -- [names…] [--still] [--keep] [--base URL] [--out DIR]
//
// With no names it makes every clip. It starts the app's dev server on port
// 5391 (or uses one already there, or --base) and stops it after, records
// frame by frame at 2160px (capture.ts), crops each frame with the camera
// (camera.ts), and writes <name>.mp4 (1080px H.264, 30fps), <name>.gif
// (720px, under 8MB) and <name>.timeline.json (the camera's keyframes, and
// the marks and boxes they came from) to clips-out/ in the main checkout.
// --still only seeds the board and saves <name>.still.png, for framing;
// --keep keeps the recorded frames, in the system's temporary folder.
//
// Recording takes about six times the clip's length. Install the browser
// once with `pnpm exec playwright install chromium`.
//
// A clip is a module like stickies-to-issues.ts (clip.ts says what it
// provides), listed in CLIPS below. Boards are seeded in the playground
// with the app's own helpers and fixtures (`clipImport`), so nothing
// reaches GitHub, and use only made-up boards for the owner's projects.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { film } from "./camera.ts";
import { Recorder } from "./capture.ts";
import type { Clip } from "./clip.ts";
import { encodeGif, encodeMp4 } from "./encode.ts";
import { clip as autoStack } from "./auto-stack.ts";
import { clip as dotVoting } from "./dot-voting.ts";
import { clip as multiplayer } from "./multiplayer.ts";
import { clip as pasteALink } from "./paste-a-link.ts";
import { clip as silentReveal } from "./silent-reveal.ts";
import { clip as stickiesToIssues } from "./stickies-to-issues.ts";

const CLIPS: Clip[] = [
	stickiesToIssues,
	pasteALink,
	silentReveal,
	multiplayer,
	autoStack,
	dotVoting,
];

const PORT = 5391;
const root = path.resolve(import.meta.dirname, "../../..");

/** clips-out/ in the main checkout, even when run from a worktree. */
function defaultOut(): string {
	try {
		const common = execFileSync(
			"git",
			["rev-parse", "--path-format=absolute", "--git-common-dir"],
			{
				cwd: root,
				encoding: "utf8",
			},
		).trim();
		return path.join(path.dirname(common), "clips-out");
	} catch {
		return path.join(root, "clips-out");
	}
}

const { values, positionals } = parseArgs({
	// pnpm passes on the `--` before the clip's own arguments: not the end of the options here.
	args: process.argv.slice(2).filter((arg) => arg !== "--"),
	allowPositionals: true,
	options: {
		base: { type: "string" },
		out: { type: "string" },
		still: { type: "boolean", default: false },
		keep: { type: "boolean", default: false },
	},
});
const names = positionals;
const chosen = names.length ? CLIPS.filter((c) => names.includes(c.name)) : CLIPS;
if (chosen.length === 0) {
	console.error(`No such clip. There are: ${CLIPS.map((c) => c.name).join(", ")}`);
	process.exit(1);
}
const out = values.out ?? defaultOut();
const base = values.base ?? `http://localhost:${PORT}`;

async function up(): Promise<boolean> {
	try {
		return (await fetch(new URL("/play", base))).ok;
	} catch {
		return false;
	}
}

/** The dev server, if there isn't one: started here, and stopped when we're done. */
async function devServer(): Promise<ChildProcess | null> {
	if (await up()) return null;
	if (values.base) throw new Error(`Nothing at ${base}`);
	console.log(`Starting the dev server on port ${PORT}…`);
	const server = spawn("pnpm", ["dev", "--port", String(PORT), "--strictPort"], {
		cwd: root,
		stdio: "ignore",
		detached: true,
	});
	for (let i = 0; i < 120 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
	if (!(await up())) throw new Error("The dev server didn't start");
	return server;
}

async function record(clip: Clip): Promise<void> {
	const frames = path.join(tmpdir(), "tack-clips", clip.name);
	const rec = await Recorder.open({ ...clip.setup, base }, frames);
	try {
		await clip.seed(rec.page);
		// Fit the board, then let entrances and the fit settle.
		await rec.page.keyboard.press("Shift+Digit1");
		await rec.page.waitForTimeout(1500);
		if (clip.framed) {
			await clip.framed(rec.page);
			await rec.page.waitForTimeout(1000);
		}
		if (values.still) {
			await rec.page.screenshot({ path: path.join(out, `${clip.name}.still.png`) });
			return;
		}
		const started = Date.now();
		await rec.start();
		await clip.play(rec);
		const recording = rec.recording();
		console.log(
			`${clip.name}: ${recording.frames} frames in ${Math.round((Date.now() - started) / 1000)}s`,
		);
		await rec.close();

		const keys = clip.camera(recording);
		const { dir: _dir, ...timeline } = recording;
		await writeFile(
			path.join(out, `${clip.name}.timeline.json`),
			`${JSON.stringify({ ...timeline, camera: keys }, null, "\t")}\n`,
		);
		const mp4 = path.join(out, `${clip.name}.mp4`);
		await encodeMp4(
			film(recording, keys, (n) => rec.framePath(n), { fade: clip.fade }),
			recording.fps,
			mp4,
		);
		const gif = await encodeGif(mp4, path.join(out, `${clip.name}.gif`));
		const seconds = (recording.frames / recording.fps).toFixed(1);
		const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)}MB`;
		console.log(`${mp4}: ${seconds}s, ${mb((await stat(mp4)).size)}; GIF ${mb(gif)}`);
		if (values.keep) console.log(`Frames: ${frames}`);
		else await rm(frames, { recursive: true, force: true });
	} finally {
		await rec.close();
	}
}

const server = await devServer();
try {
	for (const clip of chosen) await record(clip);
} finally {
	// The whole process group: pnpm, and the Vite it started.
	if (server?.pid) process.kill(-server.pid);
}
