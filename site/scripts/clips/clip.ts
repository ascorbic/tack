import type { Page } from "@playwright/test";
import type { Keyframe } from "./camera.ts";
import type { Recorder, Recording, Setup } from "./capture.ts";

/** One clip: a board to start from, what happens on it, and where the camera looks. */
export interface Clip {
	name: string;
	setup: Omit<Setup, "base">;
	/** Put the board together, before the clock stops (the playground's machinery is all there). */
	seed(page: Page): Promise<void>;
	/** What happens, frame by frame: pointer moves, clicks, waits, and marks and boxes for the camera. */
	play(rec: Recorder): Promise<void>;
	/** The camera's keyframes, from the marks and boxes `play` recorded. */
	camera(recording: Recording): Keyframe[];
}
