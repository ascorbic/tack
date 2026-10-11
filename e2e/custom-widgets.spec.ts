import type { FrameLocator, Page } from "@playwright/test";
import type { BoardInfo } from "../src/shared/boards.ts";
import { SANDBOX_CHECK } from "../src/client/play/sandboxCheck.ts";
import { expect, openScenario, settleCanvas, test } from "./fixtures.ts";

// Custom widgets (#66): code in a sandboxed iframe, on the playground's
// fake repository and on a real board through the Worker, with its CSP.
// What's checked is what the sandbox promises: the code runs and reads the
// board's data, nothing it tries reaches the network or the app, and the
// board stops code that stops answering.

const run = Date.now().toString(36);

/** A custom widget's sandbox, by its title. */
function sandbox(page: Page, title: string): FrameLocator {
	return page.frameLocator(`iframe[title="${title} (custom widget)"]`);
}

/**
 * Requests from the page or its frames that got past the browser to
 * example.com. (A request the CSP blocks still shows up as a `request`
 * event, failed with ERR_BLOCKED_BY_CSP, so those don't count.)
 */
async function watchOutside(page: Page): Promise<string[]> {
	const outside: string[] = [];
	await page.route(/^https?:\/\/example\.com\//, (route) => {
		outside.push(route.request().url());
		return route.abort();
	});
	return outside;
}

async function expectSealed(frame: FrameLocator) {
	const rows = frame.locator("li[data-check]");
	await expect(rows).toHaveCount(9);
	for (const row of await rows.all()) {
		await expect(row, (await row.getAttribute("data-check")) ?? "").toHaveAttribute(
			"data-result",
			"blocked",
			{ timeout: 10_000 },
		);
	}
}

test("custom widgets draw the board's data, and nothing gets out of the sandbox", async ({
	page,
}) => {
	const outside = await watchOutside(page);
	await openScenario(page, "custom");

	// The examples, over the fake repository.
	await expect(page.locator('iframe.custom-frame[data-status="running"]')).toHaveCount(3, {
		timeout: 15_000,
	});
	await expect(sandbox(page, "Burndown").getByText(/still open in 5\.0/)).toBeVisible();
	await expect(sandbox(page, "Label cloud").locator(".chip").first()).toBeVisible();

	// Every way out is closed, and nothing reached the outside.
	await expectSealed(sandbox(page, "Sandbox check"));
	expect(outside).toEqual([]);

	// Further down, contributors (with avatars, which the board fetches for it).
	await page.mouse.move(940, 600);
	await page.mouse.wheel(0, 420);
	await expect(sandbox(page, "Contributors").locator("li").first()).toBeVisible({
		timeout: 15_000,
	});
	await page.mouse.wheel(0, -420);

	// Until it's selected, the board keeps the pointer.
	const node = page.locator(".react-flow__node", { hasText: "Sandbox check" });
	await expect(node.locator(".custom-shield")).toHaveCount(1);
	await node.locator(".widget-title").click();
	await expect(node.locator(".custom-shield")).toHaveCount(0);

	// Off on the board: nothing runs.
	await page.getByRole("radiogroup", { name: "Custom widgets" }).getByText("Off").click();
	await expect(page.locator("iframe.custom-frame")).toHaveCount(0);
	await expect(page.getByText("Custom widgets are off here").first()).toBeVisible();
});

test("the editor previews a draft as you type, and Apply puts it on the board", async ({
	page,
}) => {
	await openScenario(page, "custom");
	const node = page.locator(".react-flow__node", { hasText: "Draw anything from the board" });
	await node.getByRole("button", { name: "Blank" }).click();
	const editor = page.getByRole("dialog", { name: "Edit custom widget" });
	await expect(editor).toBeVisible();

	await editor.getByLabel("Title").fill("Open count");
	await editor.getByRole("tab", { name: "Settings" }).click();
	await editor.getByLabel("Settings (JSON)").fill('{ "query": "repo:acme/imagekit is:open" }');
	await editor.getByRole("tab", { name: "Code" }).click();
	await editor
		.getByRole("textbox", { name: "Code" })
		.fill(
			'const { total } = await tack.search(tack.config.query);\ndocument.body.innerHTML = `<p id="count">${total} open</p>`;\nconsole.log("counted", total);',
		);
	// The preview runs the draft, and its console shows what it logged.
	const preview = page.frameLocator('.custom-preview iframe[title="Open count (custom widget)"]');
	await expect(preview.locator("#count")).toHaveText(/^\d+ open$/, { timeout: 10_000 });
	await expect(editor.getByRole("list", { name: "Console" })).toContainText("counted");

	// Settings that aren't JSON can't be applied.
	await editor.getByRole("tab", { name: /Settings/ }).click();
	await editor.getByLabel("Settings (JSON)").fill("{ nope");
	await expect(editor.getByRole("button", { name: /^Apply/ })).toBeDisabled();
	await editor.getByLabel("Settings (JSON)").fill('{ "query": "repo:acme/imagekit is:open" }');

	await editor.getByRole("button", { name: /^Apply/ }).click();
	await expect(editor.getByText("Applied")).toBeVisible();
	const widget = page.locator(".react-flow__node", { hasText: "Open count" });
	await expect(
		widget.frameLocator('iframe[title="Open count (custom widget)"]').locator("#count"),
	).toHaveText(/^\d+ open$/);
});

test("a loop that never ends is stopped, and the board carries on", async ({
	page,
	pageErrors,
}) => {
	await openScenario(page, "custom");
	const node = page.locator(".react-flow__node", { hasText: "Draw anything from the board" });
	await node.getByRole("button", { name: "Blank" }).click();
	const editor = page.getByRole("dialog", { name: "Edit custom widget" });
	await editor.getByLabel("Title").fill("Spinner");
	await editor
		.getByRole("textbox", { name: "Code" })
		.fill(
			'document.body.innerHTML = "<p id=spin>spinning</p>";\nsetTimeout(() => {\nfor (;;) {}\n}, 300);',
		);
	// The preview's loop is stopped, and its console says where.
	await expect(editor.getByRole("list", { name: "Console" })).toContainText("The loop on line 3", {
		timeout: 10_000,
	});
	await editor.getByRole("button", { name: /^Apply/ }).click();
	await editor.getByLabel("Title").press("Escape");
	await expect(editor).toHaveCount(0);

	// On the board, the widget keeps going, with its error counted.
	const widget = page.locator(".react-flow__node", { hasText: "Spinner" });
	await expect(widget.getByRole("button", { name: "1 error" })).toBeVisible({ timeout: 10_000 });
	await expect(sandbox(page, "Spinner").locator("#spin")).toHaveText("spinning");
	await expect(sandbox(page, "Burndown").getByText(/still open/)).toBeVisible();

	// The widget's own errors are its business (the frames' errors reach Playwright too).
	const theirs = (error: Error) => error.message.startsWith("The loop on line");
	expect(pageErrors.filter(theirs).length).toBeGreaterThan(0);
	pageErrors.splice(0, pageErrors.length, ...pageErrors.filter((error) => !theirs(error)));
});

test("on a real board: off until the owner allows them, then sealed under the app's policy", async ({
	page,
}) => {
	test.slow();
	const outside = await watchOutside(page);
	await page.goto(`/auth/dev?login=e2e-custom-${run}&return_to=/`);
	const board = await page.evaluate(async () => {
		const response = await fetch("/api/boards", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "Custom widgets", visibility: "private" }),
		});
		return (await response.json()) as BoardInfo;
	});
	expect(board.customWidgets).toBe(false);
	await page.goto(`/b/${board.id}/${board.slug}`);
	await expect(page.locator(".status")).toHaveText("Synced", { timeout: 15_000 });

	// A sandbox check, and a widget that tries to navigate its frame away.
	const shapes = [
		{
			id: "check",
			props: {
				type: "widget",
				widget: "custom",
				config: { title: "Sandbox check", code: SANDBOX_CHECK, data: "{}" },
				x: 0,
				y: 0,
				w: 420,
				h: 380,
			},
		},
		{
			id: "away",
			props: {
				type: "widget",
				widget: "custom",
				config: {
					title: "Away",
					code: 'document.body.innerHTML = "<p id=here>here</p>";\nsetTimeout(() => { location.href = "https://example.com/?leak=1"; }, 300);',
					data: "{}",
				},
				x: 460,
				y: 0,
				w: 360,
				h: 300,
			},
		},
	];
	await page.evaluate(
		(payload) => {
			const data = new DataTransfer();
			data.setData("application/x-tack+json", JSON.stringify(payload));
			window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }));
		},
		{ tack: 1, shapes },
	);
	await settleCanvas(page);
	await expect(page.getByText("Custom widgets are off here")).toHaveCount(2);
	await expect(page.locator("iframe.custom-frame")).toHaveCount(0);

	// The owner turns them on, from the board's menu.
	await page.getByRole("button", { name: "Board menu" }).click();
	await page.getByRole("menuitem", { name: /Custom widgets/ }).click();
	const dialog = page.getByRole("dialog", { name: "Custom widgets" });
	await expect(dialog.getByText(/Only turn this on if you trust everyone/)).toBeVisible();
	await dialog.getByRole("switch", { name: /Run custom widgets/ }).check({ force: true });
	await expect(dialog.getByText("On: their code runs for everyone here.")).toBeVisible();
	await dialog.getByRole("button", { name: "Done" }).click();

	await expectSealed(sandbox(page, "Sandbox check"));
	// The frame can't take itself anywhere else: the app's frame-src stops
	// it (and the board then stops the widget, which no longer answers).
	const awayNode = page.locator(".react-flow__node", { hasText: "Away" });
	await expect(awayNode.getByText("This widget stopped", { exact: true })).toBeVisible({
		timeout: 20_000,
	});
	expect(page.frames().some((frame) => frame.url().includes("example.com"))).toBe(false);
	expect(outside).toEqual([]);

	// The setting is the board's: it's on for the next visit too.
	const saved = await page.evaluate(
		async (id) => ((await (await fetch(`/api/boards/${id}`)).json()) as BoardInfo).customWidgets,
		board.id,
	);
	expect(saved).toBe(true);
});
