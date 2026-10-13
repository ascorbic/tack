// Paste a link: a pull request's address pasted onto an empty spot of a
// small unpic board becomes its card, with CI still running. The camera
// leans in on the card's checks: they tick over to all passed, the bar
// filling green, and then a reviewer approves.

import type { Page } from "@playwright/test";
import { type Keyframe, around, closeOn } from "./camera.ts";
import { type Box, type Recorder, type Recording, SIZE } from "./capture.ts";
import type { Clip } from "./clip.ts";

type AppImport = <T>(path: string) => Promise<T>;
type Shapes = typeof import("../../../src/shared/shapes.ts");
type Provenance = typeof import("../../../src/shared/provenance.ts");
type Fixtures = typeof import("../../../src/client/play/fixtures.ts");
type Ci = typeof import("../../../src/client/play/ci.ts");
type Card = import("../../../src/shared/cards.ts").Card;

/** The pull request, as its address on the playground's pretend forge. */
const URL = "https://fake.tack/acme/unpic/pull/437";
const KEY = "fake.tack/acme/unpic#437";
/** How many checks it has, and how many have passed when it's pasted. */
const CHECKS = 12;
const PASSED = 3;

interface Window {
	tackPlayground: { doc: import("yjs").Doc };
	tackCards: { set(card: Card): void; get(key: string): Card | { missing: true } | undefined };
	clipImport: AppImport;
}

async function seed(page: Page): Promise<void> {
	await page.evaluate(
		async ({ checks, passed }) => {
			const { tackPlayground, tackCards, clipImport } = window as unknown as Window;
			const { addShape, nextZ } = await clipImport<Shapes>("/src/shared/shapes.ts");
			const { addCardShape } = await clipImport<Provenance>("/src/shared/provenance.ts");
			const { fixture, LABELS } = await clipImport<Fixtures>("/src/client/play/fixtures.ts");
			const { pullDetails, makeChecks, reviewer, PEOPLE } =
				await clipImport<Ci>("/src/client/play/ci.ts");
			const doc = tackPlayground.doc;
			const issue = fixture({
				repo: "acme/unpic",
				item: "#429",
				title: "Responsive images for the Astro component",
				labels: [LABELS.enhancement],
				comments: 4,
				reactions: 7,
			});
			tackCards.set(issue);
			// Known to the forge already, so it's a card as soon as it's pasted.
			tackCards.set(
				fixture({
					repo: "acme/unpic",
					item: "#437",
					kind: "pull",
					title: "Astro component: srcset and sizes for every CDN",
					labels: [LABELS.enhancement],
					author: PEOPLE.priya,
					comments: 2,
					pull: pullDetails({
						head: "8c1e04b",
						checks: makeChecks({ passed, pending: checks - passed }),
						review: "review_required",
						reviewers: [reviewer("kai", "requested")],
					}),
				}),
			);
			doc.transact(() => {
				addShape(doc, "clip-title", {
					type: "text",
					text: "Astro support",
					size: "l",
					x: 0,
					y: -84,
					z: nextZ(doc),
				});
				addCardShape(doc, "clip-issue", { ref: issue.key, x: 0, y: 0 });
				addShape(doc, "clip-sticky", {
					type: "sticky",
					text: "Docs page before we release",
					color: "yellow",
					author: { name: "Kai Andersen", color: "#1f7a6b" },
					x: 36,
					y: 168,
					z: nextZ(doc),
				});
			});
		},
		{ checks: CHECKS, passed: PASSED },
	);
}

/** Paste the address where the pointer is, as Cmd+V would (the e2e tests' trick). */
async function paste(page: Page, text: string): Promise<void> {
	await page.evaluate((text) => {
		const data = new DataTransfer();
		data.setData("text/plain", text);
		window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }));
	}, text);
}

/** The pull request's card, changed as the forge's webhooks would. */
async function update(page: Page, change: { passed?: number; approved?: boolean }): Promise<void> {
	await page.evaluate(
		async ({ key, checks, change }) => {
			const { tackCards, clipImport } = window as unknown as Window;
			const { makeChecks, reviewer } = await clipImport<Ci>("/src/client/play/ci.ts");
			const card = tackCards.get(key);
			if (!card || "missing" in card || !card.pull) return;
			const pull = { ...card.pull };
			if (change.passed !== undefined) {
				pull.checks = makeChecks({ passed: change.passed, pending: checks - change.passed });
			}
			if (change.approved) {
				pull.reviewers = [reviewer("kai", "approved")];
				pull.review = "approved";
			}
			tackCards.set({ ...card, pull, updatedAt: new Date().toISOString() });
		},
		{ key: KEY, checks: CHECKS, change },
	);
}

async function play(rec: Recorder): Promise<void> {
	const { page } = rec;
	const issue = await rec.box("issue", page.locator(".react-flow__node-card").first());
	await rec.box("sticky", page.locator(".react-flow__node-sticky").first());
	await rec.box("title", page.locator(".react-flow__node-text").first());
	// The empty spot, beside the issue; the pointer starts below the board.
	const spot = { x: issue.x + issue.w + 170, y: issue.y + 90 };
	await rec.place({ x: spot.x - 130, y: spot.y + 260 });

	// The board, still.
	await rec.wait(1.2);

	// To the empty spot, and paste. The pointer hides as you type, as it does on a Mac.
	await rec.moveTo(spot, 0.95);
	await rec.wait(0.4);
	rec.mark("paste");
	await paste(page, URL);
	// Not left selected: no selection bar under it.
	await page.keyboard.press("Escape");
	rec.pointer.visible = false;
	// And the real mouse off the card, onto empty board in view (outside it, the card stays hovered).
	await page.mouse.move(60, 600);
	const pull = page.locator(".react-flow__node-card", { hasText: "#437" });
	await rec.until(pull);
	// Its entrance, then hold on it.
	await rec.wait(0.45);
	await rec.box("pull", pull);
	await rec.box("checks", pull.locator(".ci"));
	await rec.box("review", pull.locator(".review-row"));
	rec.mark("landed");
	await rec.wait(1.8);

	// The camera leans in on the checks; once it's there, they finish, one by one.
	rec.mark("lean");
	await rec.wait(1.2);
	rec.mark("ci");
	for (let passed = PASSED + 1; passed <= CHECKS; passed++) {
		await update(page, { passed });
		await rec.wait(passed === CHECKS ? 0 : 0.13);
	}
	rec.mark("passed");
	// The green sweep, then hold.
	await rec.wait(0.35);
	await rec.wait(1.8);

	// Approved.
	rec.mark("approve");
	await update(page, { approved: true });
	await rec.wait(0.3);
	await rec.wait(1.8);
	rec.mark("end");
	// Still, while it fades back to the first frame.
	await rec.wait(1.0);
}

/** The board, with room for the card; then in on its checks and review. */
function camera({ marks, boxes }: Recording): Keyframe[] {
	const m = (name: string) => marks[name] ?? 0;
	const board = around(
		["issue", "sticky", "title", "pull"].map((name) => boxes[name] as Box),
		{ margin: 44, max: 2.4 },
	);
	// The whole card across the frame, a little below its middle: the checks and the review.
	const pull = boxes.pull!;
	const checks = boxes.checks!;
	const details = closeOn(
		{ x: pull.x + pull.w / 2, y: (pull.y + pull.h / 2 + checks.y + checks.h / 2) / 2 },
		SIZE / (pull.w + 56),
	);
	return [
		{ t: 0, ...board },
		{ t: m("lean"), ...board },
		{ t: m("lean") + 1.15, ...details },
	];
}

export const clip: Clip = {
	name: "paste-a-link",
	setup: {
		url: "/play?scenario=empty",
		title: "unpic 5.0 planning",
		you: { name: "Jo Rivera", color: "#5b5fc7" },
	},
	seed,
	// At 100%, with room beside the board for the card.
	framed: (page) => page.keyboard.press("Shift+Digit0"),
	play,
	camera,
};
