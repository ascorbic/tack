import { type Locator, type Page, test as base, expect } from "@playwright/test";

/**
 * Not an error: the browser's notice that a ResizeObserver callback changed
 * a size it'll report next frame. Safari reports it as an uncaught error
 * where Chromium keeps quiet, so it's let through, and only this message.
 */
const RESIZE_OBSERVER_NOTICE = "ResizeObserver loop completed with undelivered notifications.";

/** Fails any test whose page throws an uncaught error. */
export const test = base.extend<{ pageErrors: Error[] }>({
	pageErrors: [
		async ({ page }, use) => {
			const errors: Error[] = [];
			page.on("pageerror", (error) => {
				if (error.message !== RESIZE_OBSERVER_NOTICE) errors.push(error);
			});
			await use(errors);
			expect(
				errors.map((error) => error.message),
				"uncaught errors in the page",
			).toEqual([]);
		},
		{ auto: true },
	],
});

export { expect };

/** Open a /play scenario and wait for its board to render. */
export async function openScenario(page: Page, scenario: string): Promise<void> {
	await page.goto(`/play?scenario=${scenario}`);
	await expect(page.locator(".react-flow__renderer")).toBeVisible();
	await expect(page.getByLabel("Playground controls")).toBeVisible();
	await settleCanvas(page);
}

/**
 * Wait until every node has been measured (React Flow hides unmeasured
 * nodes) and the viewport has stopped moving, so tests that use screen
 * coordinates don't race the initial fit.
 */
export async function settleCanvas(page: Page): Promise<void> {
	await page.waitForFunction(() =>
		[...document.querySelectorAll(".react-flow__node")].every(
			(node) => getComputedStyle(node).visibility !== "hidden",
		),
	);
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => {
				const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
				let last = viewport?.style.transform;
				let still = 0;
				const started = performance.now();
				const tick = () => {
					const now = viewport?.style.transform;
					still = now === last ? still + 1 : 0;
					last = now;
					if (still >= 5 || performance.now() - started > 3000) resolve();
					else requestAnimationFrame(tick);
				};
				requestAnimationFrame(tick);
			}),
	);
}

/** A node's position in flow coordinates, from React Flow's transform. */
export async function nodePosition(node: Locator): Promise<{ x: number; y: number }> {
	const transform = await node.evaluate((el) => (el as HTMLElement).style.transform);
	const match = /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(transform);
	if (!match) throw new Error(`No translate in "${transform}"`);
	return { x: Number(match[1]), y: Number(match[2]) };
}

/** Drag with real pointer events, in small steps as a person would. */
export async function drag(
	page: Page,
	from: { x: number; y: number },
	by: { x: number; y: number },
	/** Runs while still holding the pointer down, before the drop. */
	beforeDrop?: () => Promise<void>,
): Promise<void> {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	// React Flow starts the drag on the first move, from where that move ends,
	// so nudge first to keep the distance accurate.
	await page.mouse.move(from.x + 1, from.y + 1);
	await page.mouse.move(from.x + by.x, from.y + by.y, { steps: 12 });
	await beforeDrop?.();
	await page.mouse.up();
}
