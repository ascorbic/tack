import type * as Y from "yjs";
import { type AiRequest, type AiResponse, aiError, checkWidget } from "../../shared/ai.ts";
import { collectItems, widgetContext } from "../../shared/aiContext.ts";
import { draftDecision, proposeWidget, summarise } from "../../shared/fakeBoardAi.ts";
import { addShape, nextZ } from "../../shared/shapes.ts";
import { addSection, readShapes } from "../../shared/structure.ts";
import type { AiService } from "../ai/service.ts";
import { cardStore } from "../cardStore.ts";
import { REPO, type SimulatedWidgets, WIDGET_CARDS } from "./widgets.ts";

const VAULT_CARD = "fake.tack/acme/vault#7";

// AI in the playground (#64): a pretend model that answers in the browser,
// so asking for a widget, summarising and drafting decisions can all be
// tried without Workers AI. It reads a selection exactly as the board's
// server does (`collectItems`: face-down stickies and private placeholders
// are counted, never read), checks the widgets it proposes with the same
// `checkWidget`, and previews them over the playground's fake repository.
// What it writes is local dev's stand-in (src/shared/fakeBoardAi.ts), made
// up from keywords: it's for trying the flow, not the model. Modes (the
// playground's AI suggestions switch) slow it down or make it fail.

export type PlayAiMode = "live" | "slow" | "unusable" | "rate_limited" | "failed";

/** How long the pretend model takes, by mode. */
const DELAY: Record<PlayAiMode, number> = {
	live: 1100,
	slow: 4500,
	unusable: 1400,
	rate_limited: 300,
	failed: 2000,
};

export class PlayAi implements AiService {
	mode: PlayAiMode = "live";
	/** The playground's board and widgets, once it's running. */
	doc: Y.Doc | null = null;
	widgets: SimulatedWidgets | null = null;
	login: string | null = null;

	async ask(request: AiRequest, signal?: AbortSignal): Promise<AiResponse> {
		await wait(DELAY[this.mode] * (0.8 + Math.random() * 0.4), signal);
		if (this.mode === "rate_limited") {
			return aiError("rate_limited", { retryAt: Date.now() + 40_000 });
		}
		if (this.mode === "failed") return aiError("failed");
		if (this.mode === "unusable") return aiError("unusable");
		const doc = this.doc;
		if (!doc) return aiError("failed");
		if (request.task === "widget") {
			const proposal = proposeWidget(request.prompt, widgetContext(doc, this.login));
			const check = checkWidget(proposal, { host: proposal.host });
			if (!check.ok) return aiError("unusable");
			return {
				kind: "widget",
				widget: check.widget,
				config: check.config,
				explanation: check.explanation,
			};
		}
		const { items, leftOut } = collectItems(readShapes(doc), request.shapes, (key) => {
			const entry = cardStore.get(key);
			if (!entry) return null;
			if ("missing" in entry) return entry.reason === "private" ? "hidden" : null;
			return { card: entry };
		});
		if (items.length === 0) {
			return aiError("empty", {
				message:
					leftOut.faceDown > 0
						? "Those stickies are face down: reveal them first."
						: "There’s nothing written there yet.",
			});
		}
		const read = items.length;
		return request.task === "summary"
			? { kind: "summary", ...summarise(items), read, leftOut }
			: { kind: "decision", ...draftDecision(items, request.prompt), read, leftOut };
	}

	preview(id: string, widget: string, config: unknown): void {
		this.widgets?.preview(id, widget, config);
	}
}

/** The playground's AI, shared by its board and gallery. */
export const playAi = new PlayAi();

function wait(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		});
	});
}

// --- The scenario ------------------------------------------------------------------

const AUTHORS = [
	{ name: "Priya Shah", color: "#b4467a" },
	{ name: "Kai Andersen", color: "#1f7a6b" },
	{ name: "Tom Okafor", color: "#a35a12" },
	{ name: "Jo Rivera", color: "#5b5fc7" },
];

/**
 * A board to try AI on (`?scenario=ai`): a retro's worth of stickies and
 * cards to summarise (one card from a private repository you can't read,
 * which is left out), a discussion to draft a decision from, and room for
 * widgets over the fake repository.
 */
export function seedAi(doc: Y.Doc): void {
	for (const card of WIDGET_CARDS) cardStore.set(card);
	// A card from a repository you can't read: a placeholder, never read.
	cardStore.set({ key: VAULT_CARD, missing: true, reason: "private" });
	let author = 0;
	const sticky = (text: string, color: string, x: number, y: number) =>
		addShape(doc, crypto.randomUUID(), {
			type: "sticky",
			text,
			color,
			author: AUTHORS[author++ % AUTHORS.length],
			x,
			y,
			z: nextZ(doc),
		});
	const card = (ref: string, x: number, y: number) =>
		addShape(doc, crypto.randomUUID(), { type: "card", ref, x, y, z: nextZ(doc), parent: null });
	doc.transact(() => {
		sticky("Provider docs are hard to find", "pink", 70, 110);
		sticky("CI takes 20 minutes on every PR", "pink", 260, 110);
		sticky("Breaking changes landed without a migration guide", "pink", 450, 110);
		sticky("Generate one docs page per provider", "yellow", 70, 300);
		sticky("Cache the CDN detection", "yellow", 260, 300);
		sticky("Write the migration guide before the code", "yellow", 450, 300);
		card(`fake.tack/${REPO}#431`.toLowerCase(), 660, 110);
		card(`fake.tack/${REPO}#430`.toLowerCase(), 660, 300);
		card(VAULT_CARD, 660, 490);
		addSection(doc, { x: 40, y: 40, w: 920, h: 640 }, { title: "Retro", color: "red" });

		sticky("Search is slow on big repositories", "blue", 1080, 110);
		sticky("Should we rewrite the index or cache results?", "blue", 1270, 110);
		sticky("Rewrite the index: weeks of work, but fast for good", "green", 1080, 300);
		sticky("Cache results for a minute: quick, a little stale", "green", 1270, 300);
		sticky("Add filters first so people search less", "purple", 1460, 300);
		addSection(
			doc,
			{ x: 1050, y: 40, w: 640, h: 460 },
			{ title: "Search discussion", color: "blue" },
		);
	});
}
