import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import { openScenario } from "./fixtures.ts";

// Client errors: the error boundary's fallback, and reports from the boundary,
// window.onerror and unhandled rejections reaching the Worker's logs. These
// pages throw on purpose, so they use the plain `test`, which doesn't fail on
// page errors.

const ENDPOINT = "/api/client-errors";

function nextReport(page: Page) {
	return page.waitForResponse(
		(response) => response.url().endsWith(ENDPOINT) && response.request().method() === "POST",
	);
}

/**
 * Find a `client.error` event in the dev server's captured Worker logs, via
 * the Cloudflare Vite plugin's local explorer. Returns null if that API isn't
 * available.
 */
async function loggedClientError(request: APIRequestContext, message: string) {
	const response = await request.post("/cdn-cgi/local/explorer/api/local/observability/query", {
		data: {
			sql: `SELECT message FROM logs WHERE message LIKE '%client.error%' ORDER BY ts_ms DESC LIMIT 50`,
		},
	});
	if (!response.ok()) return null;
	const { result } = (await response.json()) as { result: { rows: [string][] } };
	for (const [raw] of result.rows) {
		// Each row's message is the JSON-encoded list of console arguments.
		const [line] = JSON.parse(raw) as [string];
		const entry = JSON.parse(line) as Record<string, unknown>;
		if (entry.message === message) return entry;
	}
	return undefined;
}

test("a render error shows the fallback and is logged", async ({ page, request }) => {
	const report = nextReport(page);
	await page.goto("/play/crash");

	await expect(page.getByRole("heading", { name: "Something came unstuck" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();

	const response = await report;
	expect(response.status()).toBe(204);
	expect(response.request().postDataJSON()).toMatchObject({
		source: "boundary",
		name: "Error",
		message: "Deliberate crash from /play/crash",
		path: "/play/crash",
	});

	const message = "Deliberate crash from /play/crash";
	const available = await loggedClientError(request, message);
	test.skip(available === null, "The dev server's log explorer isn't available");
	await expect
		.poll(() => loggedClientError(request, message))
		.toMatchObject({ level: "error", event: "client.error", source: "boundary", message });
});

test("uncaught errors and rejections are reported", async ({ page }) => {
	await page.goto("/play/cards");
	await expect(page.getByRole("heading", { name: "Gallery", exact: true })).toBeVisible();

	let report = nextReport(page);
	await page.evaluate(() => {
		setTimeout(() => {
			throw new Error("Thrown on purpose");
		});
	});
	expect((await report).request().postDataJSON()).toMatchObject({
		source: "error",
		message: "Thrown on purpose",
	});

	report = nextReport(page);
	await page.evaluate(() => {
		void Promise.reject(new Error("Rejected on purpose"));
	});
	expect((await report).request().postDataJSON()).toMatchObject({
		source: "unhandledrejection",
		message: "Rejected on purpose",
	});
});

test("a shape that can't be drawn says so in its place, and the board carries on", async ({
	page,
}) => {
	await openScenario(page, "sections");
	await expect(page.getByText("Drop Node 18 support", { exact: true })).toBeVisible();
	const has412 = () =>
		page.evaluate(() => {
			const { doc } = (window as unknown as { tackPlayground: { doc: import("yjs").Doc } })
				.tackPlayground;
			return [...doc.getMap<import("yjs").Map<unknown>>("shapes").values()].some((shape) =>
				String(shape.get("ref")).endsWith("#412"),
			);
		});

	// A malformed card from the forge: its title isn't text.
	const breakCard = () =>
		page.evaluate(() => {
			const { doc } = (window as unknown as { tackPlayground: { doc: import("yjs").Doc } })
				.tackPlayground;
			const store = (window as unknown as { tackCards: { get(k: string): any; set(c: any): void } })
				.tackCards;
			const key = [...doc.getMap<import("yjs").Map<unknown>>("shapes").values()]
				.map((shape) => String(shape.get("ref")))
				.find((ref) => ref.endsWith("#412"))!;
			const card = store.get(key);
			store.set({ ...card, title: { not: "text" } });
			return card;
		});
	const report = nextReport(page);
	const original = await breakCard();
	const broken = page.getByRole("alert").filter({ hasText: "This shape couldn’t be shown" });
	await expect(broken).toBeVisible();
	expect((await report).request().postDataJSON()).toMatchObject({ source: "boundary" });
	// Everything else is still there.
	await expect(page.getByText("Custom domains aren’t detected for Skyfold")).toBeVisible();
	await expect(page.getByRole("toolbar", { name: "Tools" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Something came unstuck" })).toHaveCount(0);

	// Fixed (say, by the next webhook), it comes back on trying again.
	await page.evaluate((card) => {
		(window as unknown as { tackCards: { set(c: unknown): void } }).tackCards.set(card);
	}, original);
	await broken.getByRole("button", { name: "Try again" }).click();
	await expect(broken).toHaveCount(0);
	await expect(page.getByText("Drop Node 18 support", { exact: true })).toBeVisible();

	// Or it can be deleted.
	await breakCard();
	await broken.getByRole("button", { name: "Delete" }).click();
	await expect.poll(has412).toBe(false);
	await expect(broken).toHaveCount(0);
});
