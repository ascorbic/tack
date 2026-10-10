import type { Page } from "@playwright/test";
import { drag, expect, settleCanvas, test } from "./fixtures.ts";

// The M3 exit (#45) through the UI, on real boards on the dev server made
// from the Triage and Release planning templates for a repository on the
// fake forge (fake.tack), whose search, releases and dependencies are
// synthetic: the triage board's inbox collects matches to sort into
// priorities, and the release board picks its milestone, drafts its notes
// and maps what blocks what. Webhooks and days passing are
// test/m3-exit.test.ts's, through the real GitHub adapter; the inbox's live
// arrivals and rules are e2e/automation.spec.ts's, on the playground.

test.use({ reducedMotion: "reduce" });

const run = Date.now().toString(36);
const REPO = "fake.tack/acme/widgets";

test.beforeEach(async ({ page }) => {
	// Hermetic: GitHub avatars fail to load, and fall back to initials.
	await page.route("https://github.com/**", (route) => route.abort());
});

interface Shape {
	id: string;
	type: string;
	title?: string;
	ref?: string;
	parent?: string | null;
	provenance?: { via: string; source: string };
}

/** The board's shapes, from the dev-only `tackBoard` hook. */
function shapes(page: Page): Promise<Shape[]> {
	return page.evaluate(() => {
		const doc = (window as unknown as { tackBoard: { doc: import("yjs").Doc } }).tackBoard.doc;
		return [...doc.getMap("shapes")].map(([id, shape]) => ({
			id,
			...((shape as import("yjs").Map<unknown>).toJSON() as Omit<Shape, "id">),
		}));
	});
}

const widget = (page: Page, title: string) =>
	page
		.locator(".react-flow__node-widget")
		.filter({ has: page.getByRole("heading", { name: title, exact: true }) });

/** A board from a template, made for the fake forge's repository, opened and settled. */
async function fromTemplate(page: Page, template: string, name: string, first = false) {
	await page.goto(`/auth/dev?login=e2e-m3-${run}&return_to=/`);
	await page.getByRole("button", { name: first ? "Create your first board" : "New board" }).click();
	const picker = page.getByRole("dialog", { name: "New board" });
	await picker.locator(`[data-template="${template}"]`).click();
	await picker.getByLabel("Name").fill(`${name} ${run}`);
	await picker.getByLabel(/^Repositor/).fill(REPO);
	await picker.getByLabel(/^Repositor/).press("Enter");
	await expect(picker.locator(".repo-chip")).toHaveText(/acme\/widgets/);
	await picker.getByRole("button", { name: "Create board" }).click();
	await expect(page).toHaveURL(/\/b\/[a-z0-9]{10}\//, { timeout: 15_000 });
	await expect(page.locator(".react-flow__minimap-node.minimap-section").first()).toBeVisible({
		timeout: 15_000,
	});
	// Fitted to its shapes once it's loaded.
	await page.waitForTimeout(800);
	await settleCanvas(page);
}

test.describe.serial("the M3 exit on real boards", () => {
	test("a triage board collects what matches, to sort into priorities", async ({ page }) => {
		test.setTimeout(90_000);
		await fromTemplate(page, "tack:triage", "Triage", true);
		await expect(page.getByRole("button", { name: /^Rules/ })).toContainText("2");

		// Every fake issue has a label, so the inbox starts empty: collect the
		// open bugs instead.
		const tray = page.getByRole("complementary", { name: "Inbox: Incoming" });
		await tray.getByRole("button", { name: "Edit query" }).first().click();
		await tray.getByRole("textbox").fill("repo:acme/widgets is:issue is:open label:bug");
		await expect(tray.locator(".inbox-count")).toContainText(/\d+ match/);
		await tray.getByRole("button", { name: "Save" }).click();
		const items = tray.getByRole("list", { name: "New matches" }).locator("li");
		await expect(items.first()).toBeVisible({ timeout: 15_000 });
		const waiting = await items.count();
		expect(waiting).toBeGreaterThan(3);

		// Drag the newest into P1: a card that remembers the inbox brought it.
		const first = items.first();
		const title = (await first.locator(".inbox-item-title").textContent()) ?? "";
		const from = (await first.boundingBox())!;
		const p1 = (await page.locator(".section", { hasText: "P1 · This cycle" }).boundingBox())!;
		await drag(
			page,
			{ x: from.x + 40, y: from.y + 20 },
			{ x: p1.x + 60 - from.x - 40, y: p1.y + p1.height / 2 - from.y - 20 },
		);
		await expect(items).toHaveCount(waiting - 1);
		const card = page.locator(".react-flow__node-card", { hasText: title });
		await expect(card).toBeVisible();
		const all = await shapes(page);
		const incoming = all.find((shape) => shape.title === "Incoming")!;
		const section = all.find((shape) => shape.title === "P1 · This cycle")!;
		expect(all.filter((shape) => shape.provenance?.via === "inbox")).toEqual([
			expect.objectContaining({
				parent: section.id,
				provenance: { via: "inbox", source: incoming.id },
			}),
		]);
		await card.click();
		await expect(card).toContainText("From the “Incoming” inbox");
	});

	test("a release board follows its milestone, drafts notes and maps what blocks what", async ({
		page,
	}) => {
		test.setTimeout(90_000);
		await fromTemplate(page, "tack:release", "Release");

		// The milestone: picked on the widget, from the repository's.
		const milestone = page.locator(".react-flow__node-widget", { hasText: "Which milestone?" });
		await milestone.getByRole("listitem").filter({ hasText: "v1" }).click();
		await expect(widget(page, "v1")).toBeVisible({ timeout: 15_000 });

		// The draft: what's merged since the last release, and what comes next.
		const draft = widget(page, "Next widgets release");
		await expect(draft.locator(".release-version").first()).toHaveText("v1.4.0", {
			timeout: 15_000,
		});
		await expect(draft.locator(".release-version-next")).toHaveText(/^v1\.\d+\.\d+$/);
		await expect(draft.locator(".release-section").first()).toBeVisible();

		// Two issues for this release, in Now: the map shows the second blocks the first.
		const now = (await page.locator(".section", { hasText: "Now · this release" }).boundingBox())!;
		await page.evaluate(
			({ repo }) => {
				const data = new DataTransfer();
				data.setData(
					"application/x-tack+json",
					JSON.stringify({
						tack: 1,
						shapes: [
							{ id: "a", props: { type: "card", ref: `${repo}#1`, x: 0, y: 0 } },
							{ id: "b", props: { type: "card", ref: `${repo}#6`, x: 320, y: 0 } },
						],
					}),
				);
				window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }));
			},
			{ repo: REPO },
		);
		await expect(page.locator(".react-flow__node-card")).toHaveCount(2);
		// Pasted where the pointer was: drag them into Now together.
		const pasted = (await page.locator(".react-flow__node-card").first().boundingBox())!;
		await drag(
			page,
			{ x: pasted.x + 30, y: pasted.y + 20 },
			{ x: now.x + 80 - pasted.x - 30, y: now.y + now.height / 2 - pasted.y - 20 },
		);
		await expect
			.poll(async () => {
				const all = await shapes(page);
				const section = all.find((shape) => shape.title === "Now · this release")?.id;
				return all.filter((shape) => shape.type === "card" && shape.parent === section).length;
			})
			.toBe(2);
		const map = widget(page, "What blocks what");
		await expect(map.locator(".depmap-node")).not.toHaveCount(0, { timeout: 15_000 });
		await expect(map.getByRole("button", { name: /^#1 / })).toBeVisible();
		await expect(map.getByRole("button", { name: /^#6 / })).toBeVisible();
		await expect(map.locator(".depmap-edge")).not.toHaveCount(0);
	});
});
