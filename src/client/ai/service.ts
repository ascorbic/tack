import { useContext } from "react";
import {
	type AiRequest,
	type AiResponse,
	type WidgetPreviewRequest,
	aiError,
} from "../../shared/ai.ts";
import { useMe } from "../auth/me.ts";
import { ReadOnlyContext } from "../DocContext.ts";
import { ServicesContext } from "../actions/services.ts";

// AI in the client (#64): asking the board's server (or the playground's
// stand-in), and previewing a proposed widget's results. Everything it
// answers is a proposal: the panels show it, people edit it, and placing it
// is their own edit, one undo step.

export interface AiService {
	/** Asked of the Worker: whether `/api/me` must say AI's on before it's offered. */
	live: boolean;
	/** Ask; never throws. */
	ask(request: AiRequest, signal?: AbortSignal): Promise<AiResponse>;
	/** Run what a proposed widget would, answered as `widget-data` for `widgetPreviewId(id)`. */
	preview(id: string, widget: string, config: unknown): void;
}

/** Where previews go: the board's live connection, or the playground's simulation. */
export const previewChannel: { send: ((request: WidgetPreviewRequest) => void) | null } = {
	send: null,
};

/** AI through the Worker's `POST /api/boards/:id/ai`. */
export function liveAi(boardId: string): AiService {
	return {
		live: true,
		async ask(request, signal) {
			try {
				const response = await fetch(`/api/boards/${encodeURIComponent(boardId)}/ai`, {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify(request),
					signal,
				});
				const body = (await response.json().catch(() => null)) as AiResponse | null;
				if (body && typeof body === "object" && "kind" in body) return body;
				return aiError(response.status === 429 ? "rate_limited" : "failed");
			} catch (error) {
				if (signal?.aborted) throw error;
				return aiError("failed", { message: "Couldn’t reach the server." });
			}
		},
		preview(id, widget, config) {
			previewChannel.send?.({ type: "widget-preview", id, widget, config });
		},
	};
}

/**
 * AI on this board, if it's offered here: on for the instance (or the
 * playground's), and the board's editable by whoever's looking.
 */
export function useAi(): AiService | null {
	const services = useContext(ServicesContext);
	const readOnly = useContext(ReadOnlyContext);
	const me = useMe();
	const ai = services?.ai;
	if (!ai || readOnly) return null;
	if (ai.live && !(me.status === "ready" && me.me.ai?.state === "on")) return null;
	return ai;
}
