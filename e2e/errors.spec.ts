import { type APIRequestContext, type Page, expect, test } from "@playwright/test";

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
