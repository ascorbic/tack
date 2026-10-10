import type { Locator, Page } from "@playwright/test";
import { expect, settleCanvas, test } from "./fixtures.ts";

// The M2 exit (#36) through the UI, on a real board on the dev server (not
// the playground): sign in, lay out a planning session, stage everything
// with the selection actions and the decision's write-back, push through
// the push sheet, then backlink every card and push again. The board's
// repository is on the fake forge (fake.tack), whose writes succeed without
// GitHub, so the whole flow runs locally; test/m2-exit.test.ts is the same
// session through the real GitHub adapter, and docs/m2-exit.md the manual
// run against GitHub itself.

test.use({ reducedMotion: "reduce" });

const run = Date.now().toString(36);
const REPO = "fake.tack/demo/app";
const DECISION = "Store boards as Yjs documents";

test.beforeEach(async ({ page }) => {
	// Keep the tests hermetic: GitHub avatars fail to load, and fall back to initials.
	await page.route("https://github.com/**", (route) => route.abort());
});

/** The session's starting point, pasted onto the board as copied shapes. */
const LAYOUT = {
	tack: 1,
	shapes: [
		{ id: "card", props: { type: "card", ref: `${REPO}#1`, x: 820, y: 0 } },
		{
			id: "section",
			props: { type: "section", x: 0, y: 0, w: 700, h: 300, title: "Resizing" },
		},
		{
			id: "s1",
			props: { type: "sticky", x: 40, y: 80, parent: "section", text: "Wobble on resize" },
		},
		{
			id: "s2",
			props: { type: "sticky", x: 380, y: 80, parent: "section", text: "Snap back after a drag" },
		},
		{ id: "l1", props: { type: "sticky", x: 0, y: 420, text: "Faster cold starts" } },
		{ id: "l2", props: { type: "sticky", x: 380, y: 420, text: "Cache the manifest" } },
		{
			id: "link",
			props: {
				type: "connector",
				x: 0,
				y: 0,
				from: { x: 0, y: 420, shape: "l1" },
				to: { x: 380, y: 420, shape: "l2" },
				arrow: "end",
			},
		},
		{
			id: "decision",
			props: {
				type: "decision",
				x: 820,
				y: 300,
				title: DECISION,
				text: "Boards need offline edits that merge.",
				status: "proposed",
			},
		},
	],
};

interface Change {
	id: string;
	status: string;
	op: { kind: string; body?: string; [key: string]: unknown };
	result?: { key?: string };
}

interface Shape {
	id: string;
	type: string;
	ref?: string;
	x: number;
	y: number;
	w?: number;
	from?: { shape?: string };
	to?: { shape?: string };
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

/** The board's changes, from the dev-only `tackBoard` hook. */
function changes(page: Page): Promise<Change[]> {
	return page.evaluate(() => {
		const doc = (window as unknown as { tackBoard: { doc: import("yjs").Doc } }).tackBoard.doc;
		return [...doc.getMap("changes").values()].map(
			(change) => (change as import("yjs").Map<unknown>).toJSON() as Change,
		);
	});
}

const bar = (page: Page) => page.getByRole("toolbar", { name: "Stage changes" });
const sticky = (page: Page, text: string) =>
	page.locator(".react-flow__node-sticky", { hasText: text });
const cards = (page: Page) => page.locator(".react-flow__node-card");

async function select(page: Page, nodes: Locator[]) {
	for (const [i, node] of nodes.entries()) {
		await node.click({ position: { x: 24, y: 14 }, modifiers: i > 0 ? ["Shift"] : [] });
	}
	await expect(bar(page)).toBeVisible();
}

/** Open the changes panel, review, push everything, and wait for it all to land. */
async function pushAll(page: Page, count: number) {
	await page.getByRole("button", { name: /^Changes/ }).click();
	const panel = page.getByRole("complementary", { name: "Pending changes" });
	await panel.getByRole("button", { name: `Review and push ${count}` }).click();
	const sheet = page.locator(".push-dialog");
	await expect(sheet.getByRole("heading", { name: "Push to the test forge" })).toBeVisible();
	await sheet.getByRole("button", { name: `Push ${count} changes` }).click();
	await expect(sheet.locator(".push-meter-title")).toHaveText(
		`All ${count} changes are on the test forge`,
		{
			timeout: 30_000,
		},
	);
	await expect(sheet.locator(".push-step[data-status=applied]")).toHaveCount(count);
	await sheet.getByRole("button", { name: "Done" }).click();
	await expect(sheet).toBeHidden();
	// Everything's pushed, so the review button is disabled, but focus stays
	// in the panel: Escape closes it.
	await page.keyboard.press("Escape");
	await expect(panel).toBeHidden();
}

test("one session: stickies to issues, triage, blocked-by, an ADR and backlinks", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await page.goto(`/auth/dev?login=e2e-m2-${run}&name=M2%20Tester&return_to=/`);
	await page.getByRole("button", { name: "Create your first board" }).click();
	await expect(page.getByRole("textbox", { name: "Board title" })).toBeFocused();
	await page.keyboard.type("M2 exit");
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/b\/[a-z0-9]{10}\/m2-exit$/);
	const boardId = new URL(page.url()).pathname.split("/")[2] ?? "";

	// Lay the session out: paste it, as if copied from another board.
	await expect(page.locator(".react-flow__renderer")).toBeVisible();
	await page.evaluate((payload) => {
		const data = new DataTransfer();
		data.setData("application/x-tack+json", JSON.stringify(payload));
		window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }));
	}, LAYOUT);
	await expect(page.locator(".react-flow__node")).toHaveCount(7);
	await page.keyboard.press("Shift+Digit1");
	await settleCanvas(page);
	await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });

	// Loose stickies become issues.
	await select(page, [sticky(page, "Faster cold starts"), sticky(page, "Cache the manifest")]);
	await page.keyboard.press("Alt+KeyI");
	const issues = page.getByRole("dialog", { name: "Make issues from stickies" });
	await expect(issues.getByRole("option", { selected: true })).toContainText("demo/app");
	// Labelled as they're made, so they need no second push for it.
	await issues
		.getByRole("group", { name: "Start with" })
		.getByRole("button", { name: "Labels" })
		.click();
	await page.keyboard.type("enhance");
	await page.keyboard.press("Enter");
	await issues.getByRole("button", { name: "Stage 2 issues" }).click();
	await expect(issues).toHaveCount(0);

	// The section becomes a parent issue, its stickies sub-issues.
	await page.locator(".section-handle").first().click();
	await bar(page).getByRole("button", { name: "Make a parent issue from this section" }).click();
	const parent = page.getByRole("dialog");
	await expect(parent.getByRole("textbox", { name: "Title" })).toHaveValue("Resizing");
	await parent.getByRole("button", { name: "Stage with 2 sub-issues" }).click();
	await expect(parent).toHaveCount(0);

	// The connector between the loose stickies: blocked-by.
	await page.locator(".connector-hit").first().click({ force: true });
	await page.getByRole("button", { name: "Blocked by", exact: true }).click();
	const blocked = page.getByRole("dialog", { name: "Blocked by" });
	await expect(blocked).toContainText(
		"Cache the manifest will be marked as blocked by Faster cold starts.",
	);
	await blocked.getByRole("button", { name: /^Stage/ }).click();
	await expect(blocked).toHaveCount(0);

	// Triage the card that was already there: it's writable on the fake forge.
	await select(page, [cards(page).first()]);
	await expect(bar(page).getByRole("link", { name: "Install the app" })).toHaveCount(0);
	await page.keyboard.press("Alt+KeyL");
	const labels = page.getByRole("dialog", { name: "Labels" });
	await labels.getByRole("combobox").fill("docs");
	await page.keyboard.press("Enter");
	await page.keyboard.press("ControlOrMeta+Enter");
	await expect(labels).toHaveCount(0);
	await page.keyboard.press("Alt+KeyM");
	await page.getByRole("dialog", { name: "Milestone" }).getByRole("option", { name: /v1/ }).click();

	// Decide, and write it back as an ADR pull request.
	const decision = page.locator(".react-flow__node-decision");
	await decision.getByRole("button", { name: "Decide" }).click();
	await expect(decision.locator(".decision")).toHaveAttribute("data-status", "decided");
	await decision.getByRole("button", { name: "Write back" }).click();
	const writeBack = page.getByRole("dialog", { name: DECISION });
	await expect(writeBack.locator(".writeback-path")).toHaveText(
		"docs/decisions/0001-store-boards-as-yjs-documents.md",
	);
	await writeBack.getByRole("button", { name: "Stage write-back" }).click();
	await expect(writeBack).toHaveCount(0);
	await expect(decision.locator(".decision-writeback")).toHaveText(/ADR 0001 · Staged/);

	const staged = await changes(page);
	const kinds: Record<string, number> = {};
	for (const change of staged) kinds[change.op.kind] = (kinds[change.op.kind] ?? 0) + 1;
	expect(kinds).toEqual({
		"issue.create": 5,
		"item.subIssue": 2,
		"item.blockedBy": 1,
		"item.labels": 1,
		"item.milestone": 1,
		"pr.create": 1,
	});
	const labelled = staged.filter((change) => (change.op.labels as string[] | undefined)?.length);
	expect(Object.fromEntries(labelled.map((change) => [change.op.title, change.op.labels]))).toEqual(
		{
			"Cache the manifest": ["enhancement"],
			"Faster cold starts": ["enhancement"],
		},
	);

	// Push it all through the push sheet.
	await pushAll(page, 11);
	expect((await changes(page)).every((change) => change.status === "applied")).toBe(true);
	// Every sticky is now its issue's card, the parent issue has a card above
	// its section, joined to it, and the decision shows its pull request.
	// (Fit the board to see it all: only what's on screen is drawn.)
	await page.keyboard.press("Shift+Digit1");
	await settleCanvas(page);
	await expect(page.locator(".react-flow__node-sticky")).toHaveCount(0);
	await expect(cards(page)).toHaveCount(6);
	await expect(decision.locator(".decision-record")).toContainText("ADR 0001");
	const resizing = (await changes(page)).find(
		(change) => change.op.kind === "issue.create" && change.op.title === "Resizing",
	);
	const board = await shapes(page);
	const section = board.find((shape) => shape.type === "section")!;
	const parentCard = board.find((shape) => shape.ref && shape.ref === resizing?.result?.key)!;
	expect(parentCard).toBeTruthy();
	expect(parentCard.y).toBeLessThan(section.y);
	expect(parentCard.x + 126).toBe(section.x + (section.w ?? 0) / 2);
	expect(
		board.some(
			(shape) =>
				shape.type === "connector" &&
				shape.from?.shape === parentCard.id &&
				shape.to?.shape === section.id,
		),
	).toBe(true);
	await expect(page.locator(`.react-flow__node[data-id="${parentCard.id}"] .card`)).toBeVisible();

	// Backlinks on every card, the parent's included, with a snapshot of the
	// board (which is opt-in: they're only a link unless it's asked for).
	await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
	await select(page, await cards(page).all());
	await page.keyboard.press("Alt+KeyK");
	const backlinks = page.getByRole("dialog", { name: "Comment with a link to this board" });
	const include = backlinks.getByRole("checkbox", { name: "Include a snapshot of the board" });
	await expect(include).not.toBeChecked();
	await include.check();
	await expect(backlinks.locator(".backlink-snapshot img")).toBeVisible({ timeout: 15_000 });
	await backlinks.getByRole("button", { name: "Stage 6 comments" }).click();
	await expect(backlinks).toHaveCount(0);
	await pushAll(page, 6);

	// Each comment links the board and shows a snapshot the server serves publicly.
	const comments = (await changes(page)).filter((change) => change.op.kind === "item.comment");
	expect(comments).toHaveLength(6);
	expect(comments.map((change) => (change.op.target as { key: string }).key)).toContain(
		resizing?.result?.key,
	);
	const urls = new Set(
		comments.map(
			(change) =>
				/\((https?:\/\/[^)]+\/snapshots\/[0-9a-f]{96}\.png)\)/.exec(change.op.body ?? "")?.[1],
		),
	);
	expect(urls.size).toBe(1);
	const [snapshot] = [...urls];
	expect(snapshot).toBeTruthy();
	for (const change of comments) expect(change.op.body).toContain(`/b/${boardId}/m2-exit`);
	const image = await page.request.get(snapshot!);
	expect(image.status()).toBe(200);
	expect(image.headers()["content-type"]).toBe("image/png");

	// The board's history has both pushes, every change applied.
	await page.getByRole("button", { name: /^Changes/ }).click();
	await page
		.getByRole("complementary", { name: "Pending changes" })
		.getByRole("button", { name: "History", exact: true })
		.click();
	const history = await page.request.get(`/api/boards/${boardId}/pushes`);
	const log = (await history.json()) as { changes: { status: string }[] }[];
	expect(log.map((entry) => entry.changes.length)).toEqual([6, 11]);
	expect(log.flatMap((entry) => entry.changes).every((c) => c.status === "applied")).toBe(true);
	const sheet = page.locator(".push-dialog");
	await expect(sheet.getByRole("heading", { name: "Push history" })).toBeVisible();
	await expect(sheet).toContainText("You pushed 6 changes");
	await expect(sheet).toContainText("You pushed 11 changes");
});
