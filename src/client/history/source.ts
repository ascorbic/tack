import { type Segment, type Timeline, decodeSegment } from "../../shared/history.ts";

// Where a board's history comes from: the Worker's history routes for a live
// board (src/server/history.ts), or the playground's pretend server.

export interface HistorySource {
	/** Every step, who made them, and how much room history takes. */
	timeline(): Promise<Timeline>;
	/** The keyframe at or before `step`, and every step's update from there to the next keyframe. */
	segment(step: number): Promise<Segment>;
}

export class HistoryError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

/** History for a live board, over HTTP. */
export function liveHistory(board: string): HistorySource {
	const base = `/api/boards/${encodeURIComponent(board)}/history`;
	const get = async (url: string) => {
		const response = await fetch(url, { credentials: "same-origin" });
		if (!response.ok) {
			throw new HistoryError(
				response.status === 404
					? "History isn’t available for this board."
					: "Couldn’t load the board’s history.",
				response.status,
			);
		}
		return response;
	};
	return {
		timeline: async () => (await (await get(base)).json()) as Timeline,
		segment: async (step) =>
			decodeSegment(
				new Uint8Array(await (await get(`${base}/segment?step=${step}`)).arrayBuffer()),
			),
	};
}
